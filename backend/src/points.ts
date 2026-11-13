import { randomUUID } from 'node:crypto';
import { invalidInput, readBody } from './auth.js';
import { forbidden, missingResource, requireBrand, resourceIdPattern } from './brand-access.js';
import { PointSource, Prisma, Role, type PrismaClient } from './generated/client.js';
import { readOperationKey, runIdempotent } from './idempotency.js';

const maxBalance = 2147483647;

export function isPositivePoints(points: unknown): points is number {
  return typeof points === 'number' && Number.isInteger(points) && points >= 1 && points <= maxBalance;
}

type Transaction = Prisma.TransactionClient;
type PointAccount = { brandId: string; memberId: string };
type PointActor = {
  accountId: string;
  identity: { role: Role; memberNumber: string | null; displayName: string };
};
type Authenticate = (tx: Transaction) => Promise<PointActor>;
type PointTarget = { brandId: string; memberNumber?: string };
type Page = { skip: number; pageSize: number };

export async function pointSubject(tx: Transaction, actor: PointActor, target: PointTarget, lock = false) {
  const own = target.memberNumber === undefined;
  const { role, memberNumber, displayName } = actor.identity;
  if (own ? role !== Role.MEMBER : role === Role.MEMBER) throw forbidden();
  if (!resourceIdPattern.test(target.brandId)) throw invalidInput();
  const brandId = await requireBrand(tx, actor, target.brandId, lock);
  const lockAuthorization = lock ? Prisma.sql`FOR SHARE` : Prisma.empty;

  if (target.memberNumber === undefined) {
    return { account: { brandId, memberId: actor.accountId }, memberNumber, displayName };
  }
  if (!resourceIdPattern.test(target.memberNumber)) throw missingResource();
  const [member] = await tx.$queryRaw<{ id: string; memberNumber: string; displayName: string }[]>`
    SELECT "id", "memberNumber", "displayName" FROM "Account"
    WHERE "memberNumber" = ${target.memberNumber}::uuid AND "role" = 'MEMBER'
    ${lockAuthorization}
  `;
  if (!member) throw missingResource();
  return { account: { brandId, memberId: member.id }, memberNumber: member.memberNumber, displayName: member.displayName };
}

export function readPoints(db: PrismaClient, authenticate: Authenticate, target: PointTarget, pagination?: () => Page) {
  // 權限、餘額和頁面流水共用一份已提交快照，避免讀到跨交易的帳務差額。
  return db.$transaction(async (tx) => {
    const subject = await pointSubject(tx, await authenticate(tx), target);
    const account = await tx.pointAccount.findUnique({
      where: { brandId_memberId: subject.account }, select: { balance: true },
    });
    const balance = account?.balance ?? 0;
    if (!pagination) {
      return target.memberNumber === undefined ? { balance } : {
        memberNumber: subject.memberNumber, displayName: subject.displayName, balance,
      };
    }

    const { skip, pageSize } = pagination();
    const rows = await tx.pointLedger.findMany({
      where: subject.account,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip,
      take: pageSize + 1,
      select: {
        id: true, amount: true, reason: true, source: true, createdAt: true, reversalOfId: true,
        actor: { select: { displayName: true } },
      },
    });
    const items = rows.slice(0, pageSize).map(({ actor, reversalOfId, ...row }) => ({
      ...row, actorDisplayName: actor.displayName, ...(reversalOfId === null ? {} : { reversalOfId }),
    }));
    return { balance, items, hasNext: rows.length > pageSize };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function lockPointAccount(tx: Transaction, { brandId, memberId }: PointAccount) {
  // 先以唯一鍵收斂首次並行建立，再於同一交易鎖定實際要異動的帳戶列。
  await tx.$executeRaw`
    INSERT INTO "PointAccount" ("brandId", "memberId")
    VALUES (${brandId}::uuid, ${memberId}::uuid)
    ON CONFLICT ("brandId", "memberId") DO NOTHING
  `;
  const balance = await findLockedPointBalance(tx, { brandId, memberId });
  if (balance === null) throw new Error('建立後找不到品牌點數帳戶');
  return balance;
}

export async function findLockedPointBalance(tx: Transaction, { brandId, memberId }: PointAccount) {
  const [account] = await tx.$queryRaw<{ balance: number }[]>`
    SELECT "balance" FROM "PointAccount"
    WHERE "brandId" = ${brandId}::uuid AND "memberId" = ${memberId}::uuid FOR UPDATE
  `;
  return account?.balance ?? null;
}

export async function appendPointMovement(
  tx: Transaction,
  account: PointAccount,
  movement: { actorId: string; amount: number; reason: string | null; source: PointSource; reversalOfId?: string },
  balance: number,
  createdAt = new Date(),
) {
  await tx.pointAccount.update({ where: { brandId_memberId: account }, data: { balance } });
  return tx.pointLedger.create({
    data: { ...account, ...movement, id: randomUUID(), createdAt }, select: { id: true },
  });
}

function readPointReason(reason: unknown) {
  if (typeof reason !== 'string' || !reason.isWellFormed()) throw invalidInput();
  const normalized = reason.trim();
  if (normalized.length === 0 || [...normalized].length > 200 || /\p{Cc}/u.test(normalized)) throw invalidInput();
  return normalized;
}

const balanceLimit = { code: 'BALANCE_LIMIT_EXCEEDED', message: '加點後的餘額會超過上限。' };
export function grantPoints(
  db: PrismaClient,
  authenticate: Authenticate,
  target: PointTarget & { memberNumber: string },
  keyInput: string | undefined,
  body: unknown,
) {
  return runIdempotent(db, '加點', async (tx) => {
    const actor = await authenticate(tx);
    const { account } = await pointSubject(tx, actor, target, true);
    const key = readOperationKey(keyInput);
    const { points, reason: inputReason } = readBody(body, ['points', 'reason']);
    if (!isPositivePoints(points)) throw invalidInput();
    const reason = readPointReason(inputReason);
    const { accountId: actorId } = actor;
    return {
      actorId, key, content: ['GRANT', account.brandId, account.memberId, points, reason],
      async execute(operationId) {
        const balance = await lockPointAccount(tx, account) + points;
        if (balance > maxBalance) return { status: 409, result: balanceLimit };
        const { id: grantId } = await appendPointMovement(
          tx, account, { actorId, amount: points, reason, source: PointSource.GRANT }, balance,
        );
        return { status: 201, result: { operationId, grantId, balance } };
      },
    };
  });
}

const alreadyReversed = { code: 'ALREADY_REVERSED', message: '這筆加點已撤回。' };
const insufficient = { code: 'INSUFFICIENT_POINTS', message: '此品牌的可用點數不足。' };

export function reverseGrant(
  db: PrismaClient,
  authenticate: Authenticate,
  target: { brandId: string; grantId: string },
  keyInput: string | undefined,
  body: unknown,
) {
  return runIdempotent(db, '撤回加點', async (tx) => {
    const actor = await authenticate(tx);
    if (actor.identity.role === Role.MEMBER) throw forbidden();
    if (!resourceIdPattern.test(target.brandId)) throw invalidInput();
    const brandId = await requireBrand(tx, actor, target.brandId, true);
    if (!resourceIdPattern.test(target.grantId)) throw missingResource();
    const key = readOperationKey(keyInput);
    const reason = readPointReason(readBody(body, ['reason']).reason);
    const grantId = target.grantId.toLowerCase();
    const where = { id: grantId, brandId, source: PointSource.GRANT };

    // 回放前僅查可見的原人工加點及其固定帳戶，保留帳務判斷至冪等檢查後。
    const locator = await tx.pointLedger.findUnique({ where, select: { memberId: true } });
    if (!locator) throw missingResource();
    const account = { brandId, memberId: locator.memberId };
    const { accountId: actorId } = actor;
    return {
      actorId, key, content: ['REVERSAL', brandId, grantId, reason],
      async execute(operationId) {
        // 在同一帳戶鎖下重讀原流水和撤回狀態，已撤回優先於餘額不足。
        const currentBalance = await findLockedPointBalance(tx, account);
        if (currentBalance === null) throw missingResource();
        const original = await tx.pointLedger.findUnique({
          where: { ...where, memberId: account.memberId },
          select: { amount: true, reversal: { select: { id: true } } },
        });
        if (!original || !isPositivePoints(original.amount)) throw missingResource();
        if (original.reversal) return { status: 409, result: alreadyReversed };
        if (currentBalance < original.amount) return { status: 409, result: insufficient };

        const balance = currentBalance - original.amount;
        const { id: reversalId } = await appendPointMovement(tx, account, {
          actorId, amount: -original.amount, reason, source: PointSource.REVERSAL, reversalOfId: grantId,
        }, balance);
        return { status: 201, result: { operationId, reversalId, balance } };
      },
    };
  });
}
