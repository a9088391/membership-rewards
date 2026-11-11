import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupSecrets } from '../setup-secrets.mjs';

const hex = () => randomBytes(32).toString('hex');
const demo = () => JSON.stringify(Object.fromEntries(
  ['demo_member', 'group_admin', 'brand_admin_a', 'brand_admin_b']
    .map((name) => [name, randomBytes(24).toString('base64url')]),
));
const write = (path, value) => writeFile(path, value, { mode: 0o600 });
const read = (path) => readFile(path, 'utf8');
let root;
let app;
let db;
let key;
let passwords;
let password;
let pairing;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'membership-pair-test-'));
  app = join(root, 'app');
  db = join(root, 'db');
  key = join(app, 'jwt-key');
  passwords = join(app, 'demo-passwords.json');
  password = join(db, 'password');
  pairing = join(db, 'app-secret-pair');
  await Promise.all([mkdir(app), mkdir(db)]);
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

test('全新並行初始化只發布一組私有檔案，重跑保留原值', async () => {
  await Promise.all([setupSecrets(app, db), setupSecrets(app, db)]);
  const paths = [key, passwords, pairing, password];
  const original = await Promise.all(paths.map(read));
  expect(/^[a-f0-9]{64}$/.test(original[2])).toBe(true);
  await setupSecrets(app, db);
  for (const [index, path] of paths.entries()) {
    expect(await read(path) === original[index]).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  }
});

test('既有完整資料卷首次補登配對，保留原本的三份密鑰檔', async () => {
  const existing = [[key, hex()], [passwords, demo()], [password, hex()]];
  await Promise.all(existing.map(([path, value]) => write(path, value)));
  await setupSecrets(app, db);
  await setupSecrets(app, db);
  expect(/^[a-f0-9]{64}$/.test(await read(pairing))).toBe(true);
  for (const [path, value] of existing) expect(await read(path) === value).toBe(true);
});

test.each(['jwt-key', 'demo-passwords.json'])('舊版資料庫缺少 %s 時拒絕補登與重生', async (missing) => {
  const original = hex();
  await write(password, original);
  const other = missing === 'jwt-key' ? [passwords, demo()] : [key, hex()];
  await write(...other);
  await expect(setupSecrets(app, db)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(join(app, missing))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(pairing)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await read(password) === original).toBe(true);
  expect(await read(other[0]) === other[1]).toBe(true);
});

test.each(['jwt-key', 'demo-passwords.json'])('配對後 %s 遺失或有效內容不符都拒絕', async (name) => {
  await setupSecrets(app, db);
  const savedPair = await read(pairing);
  const savedPassword = await read(password);
  const changed = join(app, name);
  const original = await read(changed);
  await rm(changed);
  await expect(setupSecrets(app, db)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(changed)).rejects.toMatchObject({ code: 'ENOENT' });
  const alternative = name === 'jwt-key' ? hex() : demo();
  await write(changed, alternative);
  await expect(setupSecrets(app, db)).rejects.toThrow();
  expect(await read(changed) === alternative).toBe(true);
  expect(await read(pairing) === savedPair).toBe(true);
  expect(await read(password) === savedPassword).toBe(true);
  await write(changed, original);
  await setupSecrets(app, db);
});

test('初次初始化中斷後保留已發布檔案，先確認配對才補建 DB 密碼', async () => {
  const original = hex();
  await write(key, original);
  await setupSecrets(app, db);
  const savedDemo = await read(passwords);
  const savedPair = await read(pairing);
  expect(await read(key) === original).toBe(true);

  // 模擬配對已發布、DB 密碼尚未發布的中斷點。
  await rm(password);
  await rm(passwords);
  await expect(setupSecrets(app, db)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(password)).rejects.toMatchObject({ code: 'ENOENT' });
  await write(passwords, savedDemo);
  await setupSecrets(app, db);
  expect(await read(pairing) === savedPair).toBe(true);
  expect(await read(key) === original).toBe(true);
  expect(/^[a-f0-9]{64}$/.test(await read(password))).toBe(true);
});

test.each(['jwt-key', 'demo-passwords.json', 'app-secret-pair', 'password'])('拒絕權限過寬或格式不合法的 %s', async (name) => {
  await setupSecrets(app, db);
  const path = [key, passwords, pairing, password].find((entry) => entry.endsWith('/' + name));
  const original = await read(path);
  await chmod(path, 0o644);
  await expect(setupSecrets(app, db)).rejects.toThrow();
  expect((await stat(path)).mode & 0o777).toBe(0o644);
  expect(await read(path) === original).toBe(true);
  await chmod(path, 0o600);
  await write(path, 'invalid');
  await expect(setupSecrets(app, db)).rejects.toThrow();
  expect(await read(path)).toBe('invalid');
});

test('不同應用密鑰卷並行配對同一 DB 時只有一方能成功', async () => {
  const directories = [app, join(root, 'other-app')];
  const results = await Promise.allSettled(directories.map((directory) => setupSecrets(directory, db)));
  expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
  for (const [index, directory] of directories.entries()) {
    if (results[index].status === 'fulfilled') await setupSecrets(directory, db);
    else await expect(setupSecrets(directory, db)).rejects.toThrow();
  }
});
