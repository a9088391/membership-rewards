import { ApiError } from './auth.js';
import { Prisma, Role } from './generated/client.js';

export const resourceIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export const missingResource = () => new ApiError(404, 'NOT_FOUND', '找不到此資源。');
export const forbidden = () => new ApiError(403, 'FORBIDDEN', '沒有權限執行此操作。');

type BrandActor = { accountId: string; identity: { role: Role } };

export async function requireBrand(tx: Prisma.TransactionClient, actor: BrandActor, input: string, lock: boolean) {
  if (!resourceIdPattern.test(input)) throw missingResource();
  const brandId = input.toLowerCase();
  // 寫入者的品牌授權須保留至提交，讓並行移除授權與業務異動有明確順序。
  const brand = actor.identity.role === Role.BRAND_ADMIN
    ? (await tx.$queryRaw<{ brandId: string }[]>`
        SELECT "brandId" FROM "BrandAdminGrant"
        WHERE "accountId" = ${actor.accountId}::uuid AND "brandId" = ${brandId}::uuid
        ${lock ? Prisma.sql`FOR SHARE` : Prisma.empty}
      `)[0]
    : await tx.brand.findUnique({ where: { id: brandId }, select: { id: true } });
  if (!brand) throw missingResource();
  return brandId;
}
