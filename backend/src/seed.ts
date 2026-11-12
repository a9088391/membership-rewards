import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createDatabase } from './database.js';
import { PointSource, Prisma, Role } from './generated/client.js';
import { hashPassword } from './password.js';
import { appendPointMovement, lockPointAccount } from './points.js';

const accounts = [
  { username: 'demo_member', displayName: '示範會員', role: Role.MEMBER },
  { username: 'group_admin', displayName: '集團管理員', role: Role.GROUP_ADMIN },
  { username: 'brand_admin_a', displayName: '品牌管理員 A', role: Role.BRAND_ADMIN },
  { username: 'brand_admin_b', displayName: '品牌管理員 B', role: Role.BRAND_ADMIN },
] as const;

const brandAssignments = [
  { seedKey: 'coffee', name: '咖啡', username: 'brand_admin_a' },
  { seedKey: 'dining', name: '餐飲', username: 'brand_admin_b' },
] as const;

async function seed(): Promise<void> {
  const passwords = JSON.parse(await readFile('/run/membership-app/demo-passwords.json', 'utf8'));
  if (Object.keys(passwords).length !== accounts.length
      || accounts.some(({ username }) => typeof passwords[username] !== 'string'
        || !/^[A-Za-z0-9_-]{32}$/.test(passwords[username]))) {
    throw new Error('示範密碼檔格式錯誤');
  }

  const db = createDatabase();
  try {
    const where = { username: { in: accounts.map(({ username }) => username) } };
    const existing = await db.account.findMany({ where, select: { username: true } });
    const names = new Set(existing.map(({ username }) => username));
    const missing: Prisma.AccountCreateManyInput[] = [];
    for (const account of accounts) {
      if (names.has(account.username)) continue;
      missing.push({
        ...account,
        id: randomUUID(),
        memberNumber: account.role === Role.MEMBER ? randomUUID() : null,
        passwordHash: await hashPassword(passwords[account.username]),
      });
    }
    await db.$transaction(async (tx) => {
      if (missing.length > 0) {
        const { count } = await tx.account.createMany({ data: missing, skipDuplicates: true });
        // 並行初始化可以先建帳號，其他唯一鍵衝突則不能讓必要帳號缺漏。
        if (count < missing.length && await tx.account.count({ where }) !== accounts.length) {
          throw new Error('必要示範帳號未建立');
        }
      }
      await tx.brand.createMany({
        data: brandAssignments.map(({ seedKey, name }) => ({ id: randomUUID(), seedKey, name })),
        skipDuplicates: true,
      });

      const pairs = Prisma.join(brandAssignments.map(({ username, seedKey }) => Prisma.sql`(${username}, ${seedKey})`));
      // 寫入新授權前鎖住符合角色的帳號，保留已存在的授權及帳號變更。
      await tx.$executeRaw`
        INSERT INTO "BrandAdminGrant" ("accountId", "brandId")
        SELECT a."id", b."id"
        FROM (VALUES ${pairs}) AS assignment("username", "seedKey")
        JOIN "Account" a ON a."username" = assignment."username"
        JOIN "Brand" b ON b."seedKey" = assignment."seedKey"
        WHERE a."role" = 'BRAND_ADMIN'
        FOR SHARE OF a
        ON CONFLICT DO NOTHING
      `;
      const granted = await tx.brandAdminGrant.count({
        where: { OR: brandAssignments.map(({ username, seedKey }) => ({
          account: { username }, brand: { seedKey },
        })) },
      });
      if (granted !== brandAssignments.length) {
        throw new Error('必要示範品牌授權未建立');
      }

      const member = await tx.account.findUniqueOrThrow({
        where: { username: 'demo_member' }, select: { id: true, role: true },
      });
      const coffee = await tx.brand.findUniqueOrThrow({ where: { seedKey: 'coffee' }, select: { id: true } });
      const pointAccount = { brandId: coffee.id, memberId: member.id };
      const balance = await lockPointAccount(tx, pointAccount);
      // 以同一帳戶鎖保護種子流水的存在檢查及加點，重跑初始化只補缺少的流水。
      const seeded = await tx.pointLedger.findFirst({
        where: { ...pointAccount, source: PointSource.SEED }, select: { id: true },
      });
      if (!seeded) {
        const admin = await tx.account.findUniqueOrThrow({
          where: { username: 'group_admin', role: Role.GROUP_ADMIN }, select: { id: true },
        });
        if (member.role !== Role.MEMBER) throw new Error('示範會員角色錯誤');
        await appendPointMovement(tx, pointAccount, {
          actorId: admin.id, amount: 100, reason: '示範初始點數', source: PointSource.SEED,
        }, balance + 100);
      }
    });
  } finally {
    await db.$disconnect();
  }
}

try {
  await seed();
} catch {
  console.error('示範資料初始化失敗，請確認密碼檔、資料庫及遷移狀態。');
  process.exitCode = 1;
}
