import { constants } from 'node:fs';
import { link, mkdir, open, unlink } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';

const accounts = ['demo_member', 'group_admin', 'brand_admin_a', 'brand_admin_b'];
const hexKey = (value) => /^[a-f0-9]{64}$/.test(value);

function demoPasswords(value) {
  const passwords = JSON.parse(value);
  return Object.keys(passwords).length === accounts.length
    && accounts.every((account) => typeof passwords[account] === 'string'
      && /^[A-Za-z0-9_-]{32}$/.test(passwords[account]));
}

async function validate(path, isValid) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > 1024) {
      throw new Error('密鑰檔格式或權限錯誤');
    }
    const value = await file.readFile('utf8');
    if (!isValid(value)) throw new Error('密鑰檔格式或配對錯誤');
    return value;
  } finally {
    await file.close();
  }
}

async function readExisting(path, isValid) {
  try {
    return await validate(path, isValid);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

async function ensurePrivateFile(path, create, isValid) {
  const existing = await readExisting(path, isValid);
  if (existing !== null) return existing;

  // 完整寫入後才發布，並行初始化不會覆寫已存在的密鑰。
  const pending = path + '.' + randomUUID();
  const file = await open(pending, 'wx', 0o600);
  try {
    try {
      await file.writeFile(create());
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(pending, path);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    return await validate(path, isValid);
  } finally {
    await unlink(pending);
  }
}

export async function setupSecrets(appDirectory, dbDirectory) {
  await mkdir(appDirectory, { recursive: true, mode: 0o700 });
  await mkdir(dbDirectory, { recursive: true, mode: 0o700 });
  const dbPath = join(dbDirectory, 'password');
  const pairPath = join(dbDirectory, 'app-secret-pair');
  const keyPath = join(appDirectory, 'jwt-key');
  const demoPath = join(appDirectory, 'demo-passwords.json');
  const dbPassword = await readExisting(dbPath, hexKey);
  const existingPair = await readExisting(pairPath, hexKey);
  const established = dbPassword !== null || existingPair !== null;

  // 已有資料庫密碼或配對紀錄時，缺失的應用密鑰只能從原資料卷恢復。
  const key = established
    ? await validate(keyPath, hexKey)
    : await ensurePrivateFile(keyPath, () => randomBytes(32).toString('hex'), hexKey);
  const demo = established
    ? await validate(demoPath, demoPasswords)
    : await ensurePrivateFile(demoPath, () => JSON.stringify(Object.fromEntries(
      accounts.map((account) => [account, randomBytes(24).toString('base64url')]),
    )), demoPasswords);
  const fingerprint = createHash('sha256')
    .update('membership-rewards:app-secret-pair:v1\0').update(key).update(demo).digest('hex');

  // 先發布配對，再發布首次 DB 密碼。並行初始化以已發布的配對為準。
  await ensurePrivateFile(pairPath, () => fingerprint, (value) => value === fingerprint);
  if (dbPassword === null) await ensurePrivateFile(dbPath, () => randomBytes(32).toString('hex'), hexKey);
}

if (import.meta.main) {
  try {
    await setupSecrets('/run/membership-app', '/run/membership-db');
  } catch {
    console.error('本機密鑰初始化失敗，請確認原本配對的專屬資料卷及密鑰檔格式與權限。');
    process.exitCode = 1;
  }
}
