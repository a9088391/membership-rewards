import { randomUUID } from 'node:crypto';
import { invalidInput, readBody, type AuthService } from './auth.js';
import { forbidden, missingResource, resourceIdPattern } from './brand-access.js';
import { PointSource, Prisma, Role, type PrismaClient } from './generated/client.js';
import { readOperationKey, runIdempotent } from './idempotency.js';
import { lockOffer } from './offers.js';
import { appendPointMovement, findLockedPointBalance, pointSubject } from './points.js';

type Authenticate = (tx: Prisma.TransactionClient) => ReturnType<AuthService['me']>;
type Clock = () => Date;
type Page = { skip: number; pageSize: number };
type VoucherTarget = { brandId: string; memberNumber: string } | { brandId?: unknown; memberNumber?: never };

const unavailable = { code: 'OFFER_UNAVAILABLE', message: '此方案目前無法兌換。' };
const insufficient = { code: 'INSUFFICIENT_POINTS', message: '此品牌的可用點數不足。' };

export function exchangeOffer(
  db: PrismaClient,
  authenticate: Authenticate,
  target: { brandId: string; offerId: string },
  keyInput: string | undefined,
  body: unknown,
  clock: Clock,
) {
  return runIdempotent(db, '兌換', async (tx) => {
    const actor = await authenticate(tx);
    const { account } = await pointSubject(tx, actor, { brandId: target.brandId }, true);
    if (!resourceIdPattern.test(target.offerId)) throw missingResource();
    const key = readOperationKey(keyInput);
    readBody(body, []);

    // 先確認方案歸屬才能回放。方案的品牌固定，鎖留給通過冪等檢查的新操作。
    const offerId = target.offerId.toLowerCase();
    const visible = await tx.couponOffer.findUnique({ where: { id: offerId, brandId: account.brandId }, select: { id: true } });
    if (!visible) throw missingResource();

    return {
      actorId: actor.accountId, key, content: ['EXCHANGE', account.brandId, offerId],
      async execute(operationId) {
        const offer = await lockOffer(tx, account.brandId, offerId);
        const currentBalance = await findLockedPointBalance(tx, account);
        // 取得方案及點數帳戶的必要鎖後重新取時，涵蓋任一鎖等待跨過截止的情況。
        const now = clock();
        if (offer.stoppedAt || now < offer.startsAt || now >= offer.endsAt) {
          return { status: 409, result: unavailable };
        }
        if (currentBalance === null || currentBalance < offer.points) {
          return { status: 409, result: insufficient };
        }

        const balance = currentBalance - offer.points;
        const { id: ledgerId } = await appendPointMovement(tx, account, {
          actorId: actor.accountId, amount: -offer.points, reason: null, source: PointSource.EXCHANGE,
        }, balance, now);
        const voucherId = randomUUID();
        await tx.voucher.create({ data: {
          ...account, id: voucherId, code: randomUUID(), offerId, ledgerId, createdAt: now,
        } });
        return { status: 201, result: { operationId, voucherId, balance } };
      },
    };
  });
}

export function readVouchers(
  db: PrismaClient, authenticate: Authenticate, target: VoucherTarget, pagination: () => Page, clock: Clock,
) {
  // 目前授權、精確會員查詢、持有券與方案條件共用同一份已提交快照。
  return db.$transaction(async (tx) => {
    const actor = await authenticate(tx);
    const { brandId, memberNumber } = target;
    if (memberNumber === undefined && actor.identity.role !== Role.MEMBER) throw forbidden();
    if (brandId !== undefined && typeof brandId !== 'string') throw invalidInput();
    const where = brandId === undefined
      ? { memberId: actor.accountId }
      : (await pointSubject(tx, actor, { brandId, memberNumber })).account;
    const { skip, pageSize } = pagination();
    const rows = await tx.voucher.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip,
      take: pageSize + 1,
      select: {
        id: true, code: true, brandId: true, offerId: true, createdAt: true,
        offer: { select: { name: true, description: true, points: true, startsAt: true, endsAt: true } },
      },
    });
    const now = clock();
    return {
      items: rows.slice(0, pageSize).map(({ offer, ...row }) => ({
        ...row, ...offer, status: now >= offer.endsAt ? 'EXPIRED' : 'UNUSED',
      })),
      hasNext: rows.length > pageSize,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
