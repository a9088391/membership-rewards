import { randomUUID } from 'node:crypto';
import { invalidInput, readBody, type AuthService } from './auth.js';
import { forbidden, missingResource, requireBrand, resourceIdPattern } from './brand-access.js';
import { Prisma, Role, type PrismaClient } from './generated/client.js';
import { isPositivePoints } from './points.js';

type Transaction = Prisma.TransactionClient;
type Authenticate = (tx: Transaction) => ReturnType<AuthService['me']>;
type Clock = () => Date;
type Page = { skip: number; pageSize: number };

const offerFields = {
  id: true, name: true, description: true, points: true, startsAt: true, endsAt: true, stoppedAt: true,
} as const;
type Offer = Prisma.CouponOfferGetPayload<{ select: typeof offerFields }>;

const markup = /<(?:\/?[a-z]|[!?])[^>]*>/i;
const basicZonedTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2}(?:[.,]\d+)?)?(Z|[+-]\d{2}(?:\d{2})?)$/;
const zonedTime = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:[.,](\d+))?)?(?:Z|([+-])(\d{2})(?::?(\d{2}))?)$/;

function offerText(input: unknown, maxLength: number) {
  if (typeof input !== 'string' || !input.isWellFormed() || /\p{Cc}/u.test(input)) throw invalidInput();
  const text = input.trim();
  if (text.length === 0 || [...text].length > maxLength) throw invalidInput();
  return text;
}

function instant(input: unknown) {
  if (typeof input !== 'string') throw invalidInput();
  // 基本格式只補上日期與時間分隔符，日曆、偏移及精度沿用同一組驗證。
  const extended = input.replace(basicZonedTime, (_match, year, month, day, hours, minutes, seconds, zone) =>
    `${year}-${month}-${day}T${hours}:${minutes}${seconds ? ':' + seconds : ''}${zone}`);
  const match = zonedTime.exec(extended);
  if (!match || match[0] !== extended) throw invalidInput();
  const [, minutes, seconds = '00', fraction = '', sign, hours = '00', offsetMinutes = '00'] = match;
  if (Number(hours) > 23 || Number(offsetMinutes) > 59 || /[1-9]/.test(fraction.slice(3))) throw invalidInput();

  // 先用原時區的日期欄位往返檢查，避免 Date 把不存在的日期自動換算成下一月。
  const local = minutes + ':' + seconds + '.' + fraction.slice(0, 3).padEnd(3, '0') + 'Z';
  const time = new Date(local);
  if (!Number.isFinite(time.getTime()) || time.toISOString() !== local) throw invalidInput();
  const offset = (Number(hours) * 60 + Number(offsetMinutes)) * (sign === '-' ? -1 : 1);
  const utc = new Date(time.getTime() - offset * 60_000);
  // Prisma PostgreSQL 轉接器的西元年格式須能無損寫入並讀回。
  if (utc.getUTCFullYear() < 1 || utc.getUTCFullYear() > 9999) throw invalidInput();
  return utc;
}

function readOffer(input: unknown) {
  const { name, description, points, startsAt, endsAt } = readBody(input, [
    'name', 'description', 'points', 'startsAt', 'endsAt',
  ]);
  const text = offerText(description, 500);
  if (!isPositivePoints(points) || markup.test(text)) throw invalidInput();
  return { name: offerText(name, 80), description: text, points, startsAt: instant(startsAt), endsAt: instant(endsAt) };
}

function offerView(offer: Offer, now: Date) {
  const status = offer.stoppedAt ? 'STOPPED'
    : now < offer.startsAt ? 'UPCOMING'
      : now >= offer.endsAt ? 'EXPIRED' : 'ACTIVE';
  return { ...offer, status };
}

export function listOffers(db: PrismaClient, authenticate: Authenticate, brandId: string, pagination: () => Page, clock: Clock) {
  // 品牌授權與方案讀取共用同一份快照，同頁的時間狀態也採同一時刻。
  return db.$transaction(async (tx) => {
    const id = await requireBrand(tx, await authenticate(tx), brandId, false);
    const { skip, pageSize } = pagination();
    const rows = await tx.couponOffer.findMany({
      where: { brandId: id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip,
      take: pageSize + 1,
      select: offerFields,
    });
    const now = clock();
    return { items: rows.slice(0, pageSize).map((offer) => offerView(offer, now)), hasNext: rows.length > pageSize };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export function createOffer(db: PrismaClient, authenticate: Authenticate, brandId: string, input: unknown, clock: Clock) {
  return db.$transaction(async (tx) => {
    const actor = await authenticate(tx);
    if (actor.identity.role === Role.MEMBER) throw forbidden();
    const id = await requireBrand(tx, actor, brandId, true);
    const offer = readOffer(input);
    // 先確認目前授權並完成驗證，再用當下時間判斷是否還能上架。
    const now = clock();
    if (offer.startsAt >= offer.endsAt || offer.endsAt <= now) throw invalidInput();
    const created = await tx.couponOffer.create({
      data: { ...offer, id: randomUUID(), brandId: id }, select: offerFields,
    });
    return offerView(created, now);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export function stopOffer(
  db: PrismaClient, authenticate: Authenticate, brandId: string, offerId: string, input: unknown, clock: Clock,
) {
  return db.$transaction(async (tx) => {
    const actor = await authenticate(tx);
    if (actor.identity.role === Role.MEMBER) throw forbidden();
    const id = await requireBrand(tx, actor, brandId, true);
    if (!resourceIdPattern.test(offerId)) throw missingResource();
    readBody(input, []);
    // 先鎖定所屬品牌的方案，再判斷是否已停發。並行請求讀取同一筆停發事實。
    const [offer] = await tx.$queryRaw<Offer[]>`
      SELECT "id", "name", "description", "points", "startsAt", "endsAt", "stoppedAt"
      FROM "CouponOffer" WHERE "brandId" = ${id}::uuid AND "id" = ${offerId}::uuid FOR UPDATE
    `;
    if (!offer) throw missingResource();
    if (offer.stoppedAt) return offerView(offer, offer.stoppedAt);

    const now = clock();
    const stopped = await tx.couponOffer.update({
      where: { id: offer.id }, data: { stoppedAt: now }, select: offerFields,
    });
    return offerView(stopped, now);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
