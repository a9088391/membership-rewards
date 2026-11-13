import { randomUUID } from 'node:crypto';
import { invalidInput, readBody, type AuthService } from './auth.js';
import { forbidden, missingResource, requireBrand, resourceIdPattern } from './brand-access.js';
import { Prisma, RedemptionStatus, Role, type PrismaClient } from './generated/client.js';
import { readOperationKey, runIdempotent } from './idempotency.js';

type Tx = Prisma.TransactionClient;
type Authenticate = (tx: Tx) => ReturnType<AuthService['me']>;
type Actor = Awaited<ReturnType<Authenticate>>;
type Clock = () => Date;
type Page = { skip: number; pageSize: number };

const voucherUnavailable = { code: 'VOUCHER_UNAVAILABLE', message: '此持有券目前無法核銷。' };
const alreadyPending = { code: 'REDEMPTION_PENDING', message: '此持有券已有待確認的核銷請求。' };
const notPending = { code: 'REDEMPTION_NOT_PENDING', message: '此核銷請求已結束或已到期。' };

const view = {
  id: true, brandId: true, voucherId: true, status: true, createdAt: true, expiresAt: true, resolvedAt: true,
  initiator: { select: { displayName: true } },
  voucher: { select: { offer: { select: { id: true, name: true, brand: { select: { name: true } } } } } },
} satisfies Prisma.RedemptionRequestSelect;

type RequestView = Prisma.RedemptionRequestGetPayload<{ select: typeof view }>;

function present(row: RequestView, member: boolean, now: Date) {
  const expired = row.status === RedemptionStatus.PENDING && now >= row.expiresAt;
  return {
    requestId: row.id,
    status: expired ? RedemptionStatus.EXPIRED : row.status,
    brandId: row.brandId,
    brandName: row.voucher.offer.brand.name,
    voucherId: row.voucherId,
    offerId: row.voucher.offer.id,
    offerName: row.voucher.offer.name,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    resolvedAt: (expired ? row.expiresAt : row.resolvedAt)?.toISOString() ?? null,
    ...(member ? { initiatorDisplayName: row.initiator.displayName } : {}),
  };
}

export function requireRedemptionAdmin(actor: Actor) {
  if (actor.identity.role !== Role.GROUP_ADMIN && actor.identity.role !== Role.BRAND_ADMIN) throw forbidden();
}

async function requestSubject(tx: Tx, actor: Actor, id: string, lock: boolean) {
  if (!resourceIdPattern.test(id)) throw missingResource();
  const member = actor.identity.role === Role.MEMBER;
  const row = await tx.redemptionRequest.findUnique({
    where: { id: id.toLowerCase(), ...(member ? { memberId: actor.accountId } : { initiatorId: actor.accountId }) },
    select: { id: true, brandId: true, voucherId: true, initiatorId: true },
  });
  if (!row) throw missingResource();
  if (!member) await requireBrand(tx, actor, row.brandId, lock);
  return row;
}

export function listRedemptions(db: PrismaClient, authenticate: Authenticate, brand: unknown, pagination: () => Page, clock: Clock) {
  return db.$transaction(async (tx) => {
    const actor = await authenticate(tx);
    if (actor.identity.role !== Role.MEMBER) throw forbidden();
    let brandId: string | undefined;
    if (brand !== undefined) {
      if (typeof brand !== 'string' || !resourceIdPattern.test(brand)) throw invalidInput();
      brandId = await requireBrand(tx, actor, brand, false);
    }
    const { skip, pageSize } = pagination();
    const rows = await tx.redemptionRequest.findMany({
      where: { memberId: actor.accountId, brandId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip, take: pageSize + 1, select: view,
    });
    const now = clock();
    return { items: rows.slice(0, pageSize).map((row) => present(row, true, now)), hasNext: rows.length > pageSize };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export function readRedemption(db: PrismaClient, authenticate: Authenticate, requestId: string, clock: Clock) {
  // 歸屬、當下授權及顯示資料共用同一份快照；過期只做讀取投影。
  return db.$transaction(async (tx) => {
    const actor = await authenticate(tx);
    const { id } = await requestSubject(tx, actor, requestId, false);
    const row = await tx.redemptionRequest.findUniqueOrThrow({ where: { id }, select: view });
    return present(row, actor.identity.role === Role.MEMBER, clock());
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

async function lockVoucher(tx: Tx, id: string) {
  // 核銷共用持有券列鎖，方案期間上架後不變，停發也不影響已發券。
  const [voucher] = await tx.$queryRaw<{
    id: string; brandId: string; memberId: string; usedAt: Date | null; startsAt: Date; endsAt: Date;
  }[]>`
    SELECT v."id", v."brandId", v."memberId", v."usedAt", o."startsAt", o."endsAt"
    FROM "Voucher" v JOIN "CouponOffer" o ON o."id" = v."offerId"
    WHERE v."id" = ${id}::uuid FOR UPDATE OF v
  `;
  if (!voucher) throw missingResource();
  return voucher;
}

function usable(voucher: Awaited<ReturnType<typeof lockVoucher>>, now: Date) {
  return !voucher.usedAt && now >= voucher.startsAt && now < voucher.endsAt;
}

type LockedRequest = { id: string; status: RedemptionStatus; expiresAt: Date };

export function createRedemption(
  db: PrismaClient, authenticate: Authenticate, brand: string, keyInput: string | undefined, body: unknown, clock: Clock,
) {
  return runIdempotent(db, '提出核銷請求', async (tx) => {
    const actor = await authenticate(tx);
    requireRedemptionAdmin(actor);
    const brandId = await requireBrand(tx, actor, brand, true);
    const key = readOperationKey(keyInput);
    const { code } = readBody(body, ['code']);
    if (typeof code !== 'string' || !resourceIdPattern.test(code)) throw invalidInput();
    const target = await tx.voucher.findUnique({ where: { code: code.toLowerCase(), brandId }, select: { id: true } });
    if (!target) throw missingResource();

    return {
      actorId: actor.accountId, key, content: ['CREATE_REDEMPTION', brandId, target.id],
      async execute(operationId) {
        const voucher = await lockVoucher(tx, target.id);
        const [pending] = await tx.$queryRaw<LockedRequest[]>`
          SELECT "id", "status", "expiresAt" FROM "RedemptionRequest"
          WHERE "voucherId" = ${voucher.id}::uuid AND "status" = 'PENDING' FOR UPDATE
        `;
        const now = clock();
        if (pending && now >= pending.expiresAt) {
          // 在同一把券鎖下結束舊請求，讓唯一索引只保留新的待確認請求。
          await tx.redemptionRequest.update({
            where: { id: pending.id }, data: { status: RedemptionStatus.EXPIRED, resolvedAt: pending.expiresAt },
          });
        }
        if (!usable(voucher, now)) return { status: 409, result: voucherUnavailable };
        if (pending && now < pending.expiresAt) return { status: 409, result: alreadyPending };
        const expiresAt = new Date(Math.min(now.getTime() + 5 * 60000, voucher.endsAt.getTime()));
        const row = await tx.redemptionRequest.create({
          data: {
            id: randomUUID(), brandId, memberId: voucher.memberId, voucherId: voucher.id,
            initiatorId: actor.accountId, createdAt: now, expiresAt,
          },
          select: view,
        });
        return { status: 201, result: { operationId, ...present(row, false, now) } };
      },
    };
  });
}

const resolvedStatus = {
  confirm: RedemptionStatus.COMPLETED,
  cancel: RedemptionStatus.CANCELLED,
  reject: RedemptionStatus.REJECTED,
};
type Resolution = keyof typeof resolvedStatus;

async function requireCurrentInitiator(tx: Tx, subject: { initiatorId: string; brandId: string }) {
  // 只鎖發起者的角色與授權，既有請求不依賴其原登入工作階段。
  const [initiator] = await tx.$queryRaw<{ role: Role }[]>`
    SELECT "role" FROM "Account" WHERE "id" = ${subject.initiatorId}::uuid FOR SHARE
  `;
  if (!initiator || initiator.role === Role.MEMBER) throw missingResource();
  await requireBrand(tx, { accountId: subject.initiatorId, identity: initiator }, subject.brandId, true);
}

export function resolveRedemption(
  db: PrismaClient, authenticate: Authenticate, action: Resolution, requestId: string,
  keyInput: string | undefined, body: unknown, clock: Clock,
) {
  return runIdempotent(db, '更新核銷請求', async (tx) => {
    const actor = await authenticate(tx);
    const member = actor.identity.role === Role.MEMBER;
    if (action === 'cancel') requireRedemptionAdmin(actor);
    else if (!member) throw forbidden();
    const key = readOperationKey(keyInput);
    readBody(body, []);
    const subject = await requestSubject(tx, actor, requestId, true);
    if (action === 'confirm') await requireCurrentInitiator(tx, subject);

    return {
      actorId: actor.accountId, key, content: [action, subject.brandId, subject.id],
      async execute(operationId) {
        const voucher = await lockVoucher(tx, subject.voucherId);
        const [pending] = await tx.$queryRaw<LockedRequest[]>`
          SELECT "id", "status", "expiresAt" FROM "RedemptionRequest"
          WHERE "id" = ${subject.id}::uuid FOR UPDATE
        `;
        const now = clock();
        if (pending.status !== RedemptionStatus.PENDING || now >= pending.expiresAt) {
          return { status: 409, result: notPending };
        }
        if (action === 'confirm') {
          if (!usable(voucher, now)) return { status: 409, result: voucherUnavailable };
          await tx.voucher.update({ where: { id: voucher.id }, data: { usedAt: now } });
        }
        const row = await tx.redemptionRequest.update({
          where: { id: subject.id }, data: { status: resolvedStatus[action], resolvedAt: now }, select: view,
        });
        return { status: 201, result: { operationId, ...present(row, member, now) } };
      },
    };
  });
}
