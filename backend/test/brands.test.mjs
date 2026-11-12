import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { jest } from '@jest/globals';
import request from 'supertest';

const origin = process.env.APP_ORIGIN;
const target = URL.parse(process.env.DATABASE_URL ?? '');
if (process.env.MEMBERSHIP_TEST !== 'membership-rewards-test'
    || origin !== 'http://membership-rewards-test.localhost:18442'
    || target?.host !== 'db:5432'
    || target?.pathname !== '/membership') {
  throw new Error('品牌測試僅能在隔離的 membership-rewards-test Compose 專案執行');
}

const { createApp } = await import('../dist/app.js');
const { createDatabase } = await import('../dist/database.js');
const host = new URL(origin).host;
const headers = { Host: host, Origin: origin };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
let app;
let db;
let http;
let logs;
let passwords;
let now;
const fixtureBrandIds = [];
const runNode = promisify(execFile);

beforeAll(async () => {
  logs = jest.spyOn(console, 'info').mockImplementation(() => {});
  db = createDatabase();
  passwords = JSON.parse(await readFile('/run/membership-app/demo-passwords.json', 'utf8'));
  app = await createApp({ clock: () => now });
  await app.listen(0, '127.0.0.1');
  http = request(app.getHttpServer());
});

beforeEach(async () => {
  now = new Date('2030-06-01T00:00:00.000Z');
  logs.mockClear();
  await db.attemptWindow.deleteMany({ where: { kind: 'LOGIN_SOURCE', key: '127.0.0.1' } });
});

afterEach(async () => {
  if (fixtureBrandIds.length > 0) {
    await db.brand.deleteMany({ where: { id: { in: fixtureBrandIds } } });
    fixtureBrandIds.length = 0;
  }
});

afterAll(async () => {
  await app?.close();
  await db?.$disconnect();
  logs?.mockRestore();
});

async function login(username) {
  const response = await http.post('/api/auth/login').set(headers)
    .send({ username, password: passwords[username] }).expect(200);
  return response.headers['set-cookie'][0].split(';', 1)[0];
}

const list = (cookie, query = '') => http.get('/api/brands' + query).set('Host', host).set('Cookie', cookie ?? '');

const write = (method, path, cookie) => http[method](path).set(headers).set('Cookie', cookie ?? '').type('application/json');
const post = (cookie, body) => write('post', '/api/brands', cookie).send(body);
const patch = (cookie, id, body) => write('patch', '/api/brands/' + id, cookie).send(body);
const expectError = (response, code) => {
  expect(response.body).toEqual({ code, message: expect.any(String), traceId: expect.stringMatching(uuid) });
  expect(response.headers['x-trace-id']).toBe(response.body.traceId);
  expect(response.headers['cache-control']).toBe('private, no-store');
};
async function createBrand(cookie, name) {
  const response = await post(cookie, { name }).expect(201);
  fixtureBrandIds.push(response.body.id);
  return response;
}

test('任何已登入角色可查看示範品牌基本資料，未登入回應不可快取', async () => {
  expectError(await list().expect(401), 'UNAUTHENTICATED');
  let expected;
  for (const username of ['demo_member', 'group_admin', 'brand_admin_a', 'brand_admin_b']) {
    const response = await list(await login(username)).expect(200).expect('Cache-Control', 'private, no-store');
    expect(response.body).toEqual({
      items: expect.arrayContaining([
        { id: expect.stringMatching(uuid), name: '咖啡' },
        { id: expect.stringMatching(uuid), name: '餐飲' },
      ]),
      hasNext: false,
    });
    for (const item of response.body.items) {
      expect(item).toEqual({ id: expect.stringMatching(uuid), name: expect.any(String) });
    }
    expected ??= response.body;
    expect(response.body).toEqual(expected);
  }
});

test('集團管理員可以新增同名品牌、改名並保留原識別，日誌不包含請求內容', async () => {
  const admin = await login('group_admin');
  const created = await createBrand(admin, '　咖啡 ');
  expect(created.body).toEqual({ id: expect.stringMatching(uuid), name: '咖啡' });
  const longName = '𠮷'.repeat(80);
  const another = await createBrand(admin, '　' + longName + ' ');
  expect(another.body).toEqual({ id: expect.stringMatching(uuid), name: longName });
  expect(created.body.id).not.toBe(another.body.id);

  const renamed = await patch(admin, created.body.id.toUpperCase(), { name: ' ' + longName + '　' }).expect(200);
  expect(renamed.body).toEqual({ id: created.body.id, name: longName });
  const readback = await list(await login('demo_member'), '?pageSize=100').expect(200);
  expect(readback.body.items).toEqual(expect.arrayContaining([renamed.body, another.body]));
  expect(await db.brandAdminGrant.count({ where: { brandId: { in: fixtureBrandIds } } })).toBe(0);

  const { id: accountId } = await db.account.findUniqueOrThrow({ where: { username: 'group_admin' } });
  const records = logs.mock.calls.map(([entry]) => JSON.parse(entry));
  for (const [response, operation, status] of [[created, 'createBrand', 201], [renamed, 'renameBrand', 200]]) {
    expect(records).toContainEqual({
      traceId: response.headers['x-trace-id'], operation, status, accountId, brandId: created.body.id,
    });
  }
  for (const sensitive of [admin, passwords.group_admin, longName]) {
    expect(JSON.stringify(records)).not.toContain(sensitive);
  }
});

test('品牌寫入每次重查有效工作階段和目前角色，拒絕後資料不變', async () => {
  const admin = await login('group_admin');
  const before = (await list(admin, '?pageSize=100').expect(200)).body;
  const { id } = before.items[0];
  for (const username of ['demo_member', 'brand_admin_a', 'brand_admin_b']) {
    const cookie = await login(username);
    expectError(await post(cookie, { name: '未授權', role: 'GROUP_ADMIN' }).expect(403), 'FORBIDDEN');
    expectError(await patch(cookie, id, { name: '未授權' }).expect(403), 'FORBIDDEN');
  }
  expectError(await post(undefined, { name: '未登入' }).expect(401), 'UNAUTHENTICATED');
  expectError(await patch(undefined, id, { name: '未登入' }).expect(401), 'UNAUTHENTICATED');

  const where = { username: 'group_admin' };
  await db.account.update({ where, data: { role: 'BRAND_ADMIN' } });
  try {
    expectError(await post(admin, { name: '角色已變更' }).expect(403), 'FORBIDDEN');
    expectError(await patch(admin, id, { name: '角色已變更' }).expect(403), 'FORBIDDEN');
    expect((await list(admin, '?pageSize=100').expect(200)).body).toEqual(before);
  } finally {
    await db.account.update({ where, data: { role: 'GROUP_ADMIN' } });
  }

  const expired = await login('group_admin');
  now = new Date(now.getTime() + 1800000);
  expectError(await list(expired).expect(401), 'UNAUTHENTICATED');
  expectError(await post(expired, { name: '已到期' }).expect(401), 'UNAUTHENTICATED');
  expectError(await patch(expired, id, { name: '已到期' }).expect(401), 'UNAUTHENTICATED');

  const revoked = await login('group_admin');
  await http.post('/api/auth/logout').set(headers).set('Cookie', revoked).send({}).expect(204);
  expectError(await list(revoked).expect(401), 'UNAUTHENTICATED');
  expectError(await post(revoked, { name: '已撤銷' }).expect(401), 'UNAUTHENTICATED');
  expectError(await patch(revoked, id, { name: '已撤銷' }).expect(401), 'UNAUTHENTICATED');

  expect((await list(await login('group_admin'), '?pageSize=100').expect(200)).body).toEqual(before);
});

test('新增和改名驗證名稱、JSON、精確 Origin 與識別碼', async () => {
  const cookie = await login('group_admin');
  const before = (await list(cookie, '?pageSize=100').expect(200)).body;
  const { id } = before.items[0];
  const loneSurrogate = JSON.stringify({ name: String.fromCharCode(0xd800) });
  expect(loneSurrogate).toBe('{"name":"\\ud800"}');
  for (const invalid of [
    {}, { name: 1 }, { name: ' ' }, { name: '咖\n啡' }, { name: '咖\u0085啡' },
    { name: '𠮷'.repeat(81) }, { name: '測試', extra: false }, [{ name: '測試' }],
    loneSurrogate, 'null', '{"name":', ' '.repeat(16 * 1024 + 1),
  ]) {
    expectError(await post(cookie, invalid).expect(400), 'INVALID_INPUT');
    expectError(await patch(cookie, id, invalid).expect(400), 'INVALID_INPUT');
  }
  expectError(await patch(cookie, 'invalid-id', { name: '測試' }).expect(400), 'INVALID_INPUT');
  expectError(await patch(cookie, '%FF', { name: '測試' }).expect(400), 'INVALID_INPUT');
  expectError(await patch(cookie, randomUUID(), { name: '測試' }).expect(404), 'NOT_FOUND');

  for (const [method, path] of [['post', '/api/brands'], ['patch', '/api/brands/' + id]]) {
    const requestWithCookie = () => http[method](path).set('Cookie', cookie);
    expectError(await requestWithCookie().set('Host', host).send({ name: '測試' }).expect(403), 'INVALID_ORIGIN');
    expectError(await requestWithCookie().set({ ...headers, Origin: origin + '/' })
      .send({ name: '測試' }).expect(403), 'INVALID_ORIGIN');
    expectError(await requestWithCookie().set({ ...headers, Host: 'localhost:18442' })
      .send({ name: '測試' }).expect(403), 'UNTRUSTED_HOST');
    expectError(await requestWithCookie().set(headers).type('text/plain')
      .send('{"name":"測試"}').expect(400), 'INVALID_INPUT');
  }
  expect((await list(cookie, '?pageSize=100').expect(200)).body).toEqual(before);

  const created = await createBrand(cookie, ' 測 ');
  const json = '{"name":"改"}';
  const body = json + ' '.repeat(16 * 1024 - Buffer.byteLength(json));
  expect(Buffer.byteLength(body)).toBe(16384);
  const renamed = await patch(cookie, created.body.id, body).expect(200);
  expect(renamed.body).toEqual({ id: created.body.id, name: '改' });
});

test('品牌分頁以建立時間及識別碼排序，預設 20 筆且最大 100 筆', async () => {
  const cookie = await login('brand_admin_a');
  const baseline = (await list(cookie, '?pageSize=100').expect(200)).body;
  expect(baseline.hasNext).toBe(false);

  const fixtures = Array.from({ length: 101 }, (_, index) => ({
    id: randomUUID(), name: '分頁測試 ' + index, createdAt: new Date('2000-01-02T00:00:00Z'),
  })).sort((a, b) => a.id.localeCompare(b.id));
  const earlier = fixtures.pop();
  earlier.createdAt = new Date('2000-01-01T00:00:00Z');
  fixtures.unshift(earlier);
  await db.brand.createMany({ data: fixtures });
  fixtureBrandIds.push(...fixtures.map(({ id }) => id));
  const expected = [...fixtures.map(({ id, name }) => ({ id, name })), ...baseline.items];

  expect((await list(cookie).expect(200)).body).toEqual({ items: expected.slice(0, 20), hasNext: true });
  expect((await list(cookie, '?page=2').expect(200)).body).toEqual({ items: expected.slice(20, 40), hasNext: true });
  expect((await list(cookie, '?pageSize=100').expect(200)).body).toEqual({
    items: expected.slice(0, 100), hasNext: true,
  });
  expect((await list(cookie, '?page=2&pageSize=100').expect(200)).body).toEqual({
    items: expected.slice(100), hasNext: false,
  });
  expect((await list(cookie, '?page=' + expected.length + '&pageSize=1').expect(200)).body).toEqual({
    items: expected.slice(-1), hasNext: false,
  });
  expect((await list(cookie, '?page=9007199254740991&pageSize=1').expect(200)).body).toEqual({
    items: [], hasNext: false,
  });
  for (const query of [
    '?page=0', '?page=-1', '?page=1.5', '?page=1e2', '?page=%201', '?page=1&page=2',
    '?pageSize=0', '?pageSize=101', '?pageSize=1.5', '?pageSize=1&pageSize=2',
    '?page=9007199254740992', '?page=9007199254740991&pageSize=2',
  ]) {
    expectError(await list(cookie, query).expect(400), 'INVALID_INPUT');
  }
});

test('資料庫維持兩位品牌管理員各自授權，重新初始化保留改名、新品牌及既有授權', async () => {
  const cookie = await login('group_admin');
  const a = await db.account.findUniqueOrThrow({ where: { username: 'brand_admin_a' } });
  const b = await db.account.findUniqueOrThrow({ where: { username: 'brand_admin_b' } });
  const coffee = await db.brand.findUniqueOrThrow({ where: { seedKey: 'coffee' } });
  const dining = await db.brand.findUniqueOrThrow({ where: { seedKey: 'dining' } });
  const pairA = { accountId: a.id, brandId: coffee.id };
  const pairB = { accountId: b.id, brandId: dining.id };
  const grants = () => db.brandAdminGrant.findMany();
  expect([a.role, b.role]).toEqual(['BRAND_ADMIN', 'BRAND_ADMIN']);
  expect(await grants()).toEqual(expect.arrayContaining([pairA, pairB]));
  expect(await grants()).not.toEqual(expect.arrayContaining([{ accountId: a.id, brandId: dining.id }]));
  expect(await grants()).not.toEqual(expect.arrayContaining([{ accountId: b.id, brandId: coffee.id }]));

  await expect(db.brandAdminGrant.create({ data: pairA })).rejects.toMatchObject({ code: 'P2002' });
  await expect(db.brandAdminGrant.create({ data: { accountId: a.id, brandId: randomUUID() } }))
    .rejects.toMatchObject({ code: 'P2003' });
  await expect(db.brandAdminGrant.create({ data: { accountId: randomUUID(), brandId: dining.id } }))
    .rejects.toMatchObject({ code: 'P2003' });

  const created = await createBrand(cookie, coffee.name);
  const extraGrant = { accountId: a.id, brandId: created.body.id };
  await db.brandAdminGrant.create({ data: extraGrant });
  try {
    await patch(cookie, coffee.id, { name: '保留改過的名稱' }).expect(200);
    const before = (await list(cookie, '?pageSize=100').expect(200)).body;
    const beforeGrants = await grants();
    await runNode(process.execPath, ['dist/seed.js']);
    expect((await list(cookie, '?pageSize=100').expect(200)).body).toEqual(before);
    expect(await grants()).toHaveLength(beforeGrants.length);
    expect(await grants()).toEqual(expect.arrayContaining(beforeGrants));
    expect((await db.brand.findUniqueOrThrow({ where: { seedKey: 'coffee' } })).id).toBe(coffee.id);
  } finally {
    await db.$transaction([
      db.brand.update({ where: { id: coffee.id }, data: { name: coffee.name } }),
      db.brandAdminGrant.deleteMany({ where: extraGrant }),
    ]);
  }
});

test('必要授權缺少且示範帳號角色不符時，seed 失敗並回滾本次新增品牌', async () => {
  const account = await db.account.findUniqueOrThrow({ where: { username: 'brand_admin_b' } });
  const coffee = await db.brand.findUniqueOrThrow({ where: { seedKey: 'coffee' } });
  const dining = await db.brand.findUniqueOrThrow({ where: { seedKey: 'dining' } });
  const pair = { accountId: account.id, brandId: dining.id };
  try {
    await db.$transaction([
      db.brand.update({ where: { id: coffee.id }, data: { seedKey: null } }),
      db.account.update({ where: { id: account.id }, data: { role: 'GROUP_ADMIN' } }),
      db.brandAdminGrant.delete({ where: { accountId_brandId: pair } }),
    ]);
    const count = await db.brand.count();
    await expect(runNode(process.execPath, ['dist/seed.js'])).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining('示範資料初始化失敗'),
    });
    expect(await db.brand.count()).toBe(count);
    expect(await db.brand.findUnique({ where: { seedKey: 'coffee' } })).toBeNull();
    expect(await db.brandAdminGrant.findUnique({ where: { accountId_brandId: pair } })).toBeNull();
    expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).role).toBe('GROUP_ADMIN');
  } finally {
    await db.$transaction([
      db.brand.update({ where: { id: coffee.id }, data: { seedKey: 'coffee' } }),
      db.account.update({ where: { id: account.id }, data: { role: account.role } }),
      db.brandAdminGrant.createMany({ data: pair, skipDuplicates: true }),
    ]);
  }
});
