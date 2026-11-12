import { createHash, randomUUID } from 'node:crypto';
import { ApiError, invalidInput, readBody } from './auth.js';
import { forbidden, missingResource, requireBrand, resourceIdPattern } from './brand-access.js';
import { PointSource, Prisma, Role, type PrismaClient } from './generated/client.js';

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

async function pointSubject(tx: Transaction, actor: PointActor, target: PointTarget, lock = false) {
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
        id: true, amount: true, reason: true, source: true, createdAt: true, actor: { select: { displayName: true } },
      },
    });
    const items = rows.slice(0, pageSize).map(({ actor, ...row }) => ({ ...row, actorDisplayName: actor.displayName }));
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
  const [account] = await tx.$queryRaw<{ balance: number }[]>`
    SELECT "balance" FROM "PointAccount"
    WHERE "brandId" = ${brandId}::uuid AND "memberId" = ${memberId}::uuid FOR UPDATE
  `;
  return account.balance;
}

export async function appendPointCredit(
  tx: Transaction,
  account: PointAccount,
  credit: { actorId: string; amount: number; reason: string; source: PointSource },
  balance: number,
) {
  await tx.pointAccount.update({ where: { brandId_memberId: account }, data: { balance } });
  return tx.pointLedger.create({
    data: { ...account, ...credit, id: randomUUID(), createdAt: new Date() }, select: { id: true },
  });
}

function readGrant(key: string | undefined, body: unknown) {
  if (key === undefined || !resourceIdPattern.test(key)) throw invalidInput();
  const { points, reason } = readBody(body, ['points', 'reason']);
  if (!isPositivePoints(points) || typeof reason !== 'string' || !reason.isWellFormed()) throw invalidInput();
  const normalized = reason.trim();
  if (normalized.length === 0 || [...normalized].length > 200 || /\p{Cc}/u.test(normalized)) throw invalidInput();
  return { key: key.toLowerCase(), points, reason: normalized };
}

const balanceLimit = { code: 'BALANCE_LIMIT_EXCEEDED', message: '加點後的餘額會超過上限。' };
const temporaryGrantError = () => new ApiError(
  503, 'SERVICE_UNAVAILABLE', '加點結果尚未確認，請使用相同的操作識別碼重試。',
);

function rolledBackByContention(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && (
    error.code === 'P2034'
    || (error.code === 'P2010' && (error.meta?.code === '40001' || error.meta?.code === '40P01'))
  );
}

export async function grantPoints(
  db: PrismaClient,
  authenticate: Authenticate,
  target: PointTarget & { memberNumber: string },
  keyInput: string | undefined,
  body: unknown,
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const outcome = await db.$transaction(async (tx) => {
        const actor = await authenticate(tx);
        const { account } = await pointSubject(tx, actor, target, true);
        const { key, points, reason } = readGrant(keyInput, body);
        const { accountId: actorId } = actor;
        const fingerprint = createHash('sha256')
          .update(JSON.stringify(['GRANT', account.brandId, account.memberId, points, reason])).digest('hex');
        const operationId = randomUUID();
        // 授權與格式檢查完成後先取得冪等唯一鍵，再取得帳戶鎖。
        const inserted = await tx.$executeRaw`
          INSERT INTO "IdempotentOperation" ("id", "actorId", "key", "fingerprint")
          VALUES (${operationId}::uuid, ${actorId}::uuid, ${key}::uuid, ${fingerprint})
          ON CONFLICT ("actorId", "key") DO NOTHING
        `;
        if (!inserted) {
          const prior = await tx.idempotentOperation.findUniqueOrThrow({ where: { actorId_key: { actorId, key } } });
          if (prior.fingerprint !== fingerprint) {
            throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '此操作識別碼已用於不同的內容。');
          }
          return prior;
        }

        const balance = await lockPointAccount(tx, account) + points;
        if (balance > maxBalance) {
          return tx.idempotentOperation.update({
            where: { id: operationId }, data: { status: 409, result: balanceLimit },
          });
        }
        const { id: grantId } = await appendPointCredit(
          tx, account, { actorId, amount: points, reason, source: PointSource.GRANT }, balance,
        );
        return tx.idempotentOperation.update({
          where: { id: operationId }, data: { status: 201, result: { operationId, grantId, balance } },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

      // 業務拒絕須提交後再交給 HTTP 錯誤處理，重送回放原錯誤與新追蹤識別。
      const { status, result } = outcome;
      if (status === 201 && result) return result;
      if (status !== null && result && typeof result === 'object' && !Array.isArray(result)
          && typeof result.code === 'string' && typeof result.message === 'string') {
        throw new ApiError(status, result.code, result.message);
      }
      throw temporaryGrantError();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // 只有資料庫已確認整筆回滾的競爭錯誤可由伺服器有限重試。
      if (attempt >= 2 || !rolledBackByContention(error)) throw temporaryGrantError();
    }
  }
}
