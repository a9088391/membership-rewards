import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createDatabase } from './database.js';
import { Role } from './generated/client.js';
import { hashPassword } from './password.js';

const accounts = [
  { username: 'demo_member', displayName: '示範會員', role: Role.MEMBER },
  { username: 'group_admin', displayName: '集團管理員', role: Role.GROUP_ADMIN },
  { username: 'brand_admin_a', displayName: '品牌管理員 A', role: Role.BRAND_ADMIN },
  { username: 'brand_admin_b', displayName: '品牌管理員 B', role: Role.BRAND_ADMIN },
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
    const missing = [];
    for (const account of accounts) {
      if (names.has(account.username)) continue;
      missing.push({
        ...account,
        id: randomUUID(),
        memberNumber: account.role === Role.MEMBER ? randomUUID() : null,
        passwordHash: await hashPassword(passwords[account.username]),
      });
    }
    if (missing.length > 0) {
      const { count } = await db.account.createMany({ data: missing, skipDuplicates: true });
      // 並行初始化可以先建帳號，其他唯一鍵衝突則不能讓必要帳號缺漏。
      if (count < missing.length && await db.account.count({ where }) !== accounts.length) {
        throw new Error('必要示範帳號未建立');
      }
    }
  } finally {
    await db.$disconnect();
  }
}

try {
  await seed();
} catch {
  console.error('示範帳號初始化失敗，請確認密碼檔、資料庫及遷移狀態。');
  process.exitCode = 1;
}
