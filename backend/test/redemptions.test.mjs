import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { jest } from '@jest/globals';
import request from 'supertest';

const origin = process.env.APP_ORIGIN;
const target = URL.parse(process.env.DATABASE_URL ?? '');
if (process.env.MEMBERSHIP_TEST !== 'membership-rewards-test'
    || origin !== 'http://membership-rewards-test.localhost:18442'
    || target?.host !== 'db:5432' || target.pathname !== '/membership') {
  throw new Error('核銷測試僅能在隔離的 membership-rewards-test Compose 專案執行');
}

const { createApp } = await import('../dist/app.js');
const { AuthService } = await import('../dist/auth.js');
const { createDatabase } = await import('../dist/database.js');
const { createRedemption, resolveRedemption } = await import('../dist/redemptions.js');
const headers = { Host: new URL(origin).host, Origin: origin };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const start = '2031-05-01T00:00:00.000Z';
const terms = {
  name: '核銷測試優惠', description: '結帳折扣', points: 80,
  startsAt: start, endsAt: '2031-05-01T00:20:00.000Z',
};
const brands = [];
const keys = [];
const accounts = [];
let app;
let db;
let http;
let logs;
let now;
let passwords;
let member;
let admin;
let adminId;
let memberId;
let memberNumber;
let brandId;

beforeAll(async () => {
  logs = jest.spyOn(console, 'info').mockImplementation(() => {});
  db = createDatabase();
  passwords = JSON.parse(await readFile('/run/membership-app/demo-passwords.json', 'utf8'));
  ({ id: memberId, memberNumber } = await db.account.findUniqueOrThrow({ where: { username: 'demo_member' } }));
  ({ id: adminId } = await db.account.findUniqueOrThrow({ where: { username: 'group_admin' } }));
  app = await createApp({ clock: () => now });
  await app.listen(0, '127.0.0.1');
  http = request(app.getHttpServer());
});

beforeEach(async () => {
  now = new Date(start);
  logs.mockClear();
  await db.attemptWindow.deleteMany({ where: { kind: 'LOGIN_SOURCE', key: '127.0.0.1' } });
  await db.attemptWindow.deleteMany({ where: { kind: 'REDEMPTION_ACCOUNT', key: adminId } });
  brandId = await createBrand();
  admin = await login('group_admin');
  member = await login('demo_member');
});

afterEach(async () => {
  const where = { brandId: { in: brands } };
  await db.$transaction([
    db.redemptionRequest.deleteMany({ where }),
    db.voucher.deleteMany({ where }),
    db.pointLedger.deleteMany({ where }),
    db.pointAccount.deleteMany({ where }),
    db.couponOffer.deleteMany({ where }),
    db.brandAdminGrant.deleteMany({ where }),
    db.idempotentOperation.deleteMany({ where: { key: { in: keys } } }),
    db.attemptWindow.deleteMany({ where: { kind: 'REDEMPTION_ACCOUNT', key: { in: [...accounts, adminId] } } }),
    db.brand.deleteMany({ where: { id: { in: brands } } }),
    db.session.deleteMany({ where: { accountId: { in: accounts } } }),
    db.account.deleteMany({ where: { id: { in: accounts } } }),
  ]);
  brands.length = keys.length = accounts.length = 0;
});

afterAll(async () => {
  await app?.close();
  await db?.$disconnect();
  logs?.mockRestore();
});

const brandPath = (brand = brandId) => '/api/brands/' + brand;
const requestPath = (id) => '/api/redemption-requests/' + id;
const memberPath = (brand = brandId, number = memberNumber) => brandPath(brand) + '/members/' + number;
const listPath = '/api/me/redemption-requests';
const ledgerPath = () => brandPath() + '/me/ledger';
const read = (path, cookie = member) => http.get(path).set('Host', headers.Host).set('Cookie', cookie);
const post = (path, cookie = admin) => http.post(path).set(headers).set('Cookie', cookie).type('application/json');
function key() {
  const value = randomUUID();
  keys.push(value);
  return value;
}
const propose = (code, id = key(), cookie = admin, brand = brandId) =>
  post(brandPath(brand) + '/redemption-requests', cookie).set('Idempotency-Key', id).send({ code });
const act = (requestId, action, id = key(), cookie = action === 'cancel' ? admin : member) =>
  post(requestPath(requestId) + '/' + action, cookie).set('Idempotency-Key', id).send({});
const exchange = (offerId, id = key(), cookie = member, brand = brandId) =>
  post(brandPath(brand) + '/offers/' + offerId + '/exchanges', cookie).set('Idempotency-Key', id).send({});
const grant = (points, id = key(), cookie = admin, brand = brandId, number = memberNumber) =>
  post(memberPath(brand, number) + '/grants', cookie).set('Idempotency-Key', id).send({ points, reason: '核銷測試加點' });

function authenticate(cookie) {
  const auth = app.get(AuthService);
  const token = cookie.slice(cookie.indexOf('=') + 1);
  return (tx) => auth.me(token, tx, true);
}

const runCreate = (code, id = key(), cookie = admin) =>
  createRedemption(db, authenticate(cookie), brandId, id, { code }, () => now);
const runResolve = (requestId, action, id = key()) =>
  resolveRedemption(db, authenticate(action === 'cancel' ? admin : member), action, requestId, id, {}, () => now);

async function createBrand() {
  const id = randomUUID();
  await db.brand.create({ data: { id, name: '核銷測試品牌' } });
  brands.push(id);
  return id;
}

async function login(username, password = passwords[username]) {
  return (await post('/api/auth/login', '').send({ username, password }).expect(200))
    .headers['set-cookie'][0].split(';', 1)[0];
}

async function actorFor(brand) {
  const username = randomUUID().replaceAll('-', '');
  const password = '核銷測試會員密碼僅供測試';
  await db.attemptWindow.deleteMany({ where: { kind: 'REGISTER_SOURCE', key: '127.0.0.1' } });
  const { body: { memberNumber: number } } = await post('/api/auth/register', '').send({
    username, password, displayName: '核銷測試身分',
  }).expect(201);
  const { id } = await db.account.findUniqueOrThrow({ where: { username }, select: { id: true } });
  accounts.push(id);
  const assignment = { accountId: id, brandId: brand };
  if (brand) {
    await db.account.update({ where: { id }, data: { role: 'BRAND_ADMIN', memberNumber: null } });
    await db.brandAdminGrant.create({ data: assignment });
  }
  return { id, number, username, assignment, cookie: await login(username, password), relogin: () => login(username, password) };
}

async function issue({ brand = brandId, offer = terms, points = 80 } = {}) {
  const { body: { id: offerId } } = await post(brandPath(brand) + '/offers').send(offer).expect(201);
  await grant(points, key(), admin, brand).expect(201);
  const { body: { voucherId } } = await exchange(offerId, key(), member, brand).expect(201);
  const { body: { items } } = await read('/api/me/vouchers?brandId=' + brand).expect(200);
  return items.find(({ id }) => id === voucherId);
}

async function voucherStatus(voucher, status) {
  for (const [path, cookie] of [['/api/me/vouchers?brandId=' + voucher.brandId, member],
    [memberPath(voucher.brandId) + '/vouchers', admin]]) {
    const { body: { items } } = await read(path, cookie).expect(200);
    expect(items.find(({ id }) => id === voucher.id)?.status).toBe(status);
  }
}

async function expectError(response, status, code, retryAfterSeconds) {
  const result = await response.expect(status);
  expect(result.body).toEqual({
    code, message: expect.any(String), traceId: expect.stringMatching(uuid),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  });
  expect(result.headers['x-trace-id']).toBe(result.body.traceId);
  expect(result.headers['cache-control']).toBe('private, no-store');
  if (retryAfterSeconds !== undefined) expect(result.headers['retry-after']).toBe(String(retryAfterSeconds));
  return result;
}

async function noKey(operationKey) {
  expect(await db.idempotentOperation.count({ where: { key: operationKey } })).toBe(0);
}

test('原管理員提出、原會員在停發後確認，雙方讀回同一次核銷且不重扣點', async () => {
  const voucher = await issue();
  const original = (await read(ledgerPath()).expect(200)).body;
  await post(brandPath() + '/offers/' + voucher.offerId + '/stop').send({}).expect(200);
  const { body: { operationId, ...pending } } = await propose(voucher.code).expect(201);
  expect(operationId).toMatch(uuid);
  expect(pending).toEqual({
    requestId: expect.stringMatching(uuid), status: 'PENDING', brandId, brandName: '核銷測試品牌',
    voucherId: voucher.id, offerId: voucher.offerId, offerName: terms.name, createdAt: start,
    expiresAt: '2031-05-01T00:05:00.000Z', resolvedAt: null,
  });
  await voucherStatus(voucher, 'UNUSED');
  const memberView = { ...pending, initiatorDisplayName: '集團管理員' };
  expect((await read(listPath + '?brandId=' + brandId).expect(200)).body)
    .toEqual({ items: [memberView], hasNext: false });
  expect((await read(requestPath(pending.requestId)).expect(200)).body).toEqual(memberView);
  expect((await read(requestPath(pending.requestId), admin).expect(200)).body).toEqual(pending);

  now = new Date('2031-05-01T00:00:01.000Z');
  const { body: { operationId: confirmId, ...completed } } = await act(pending.requestId, 'confirm').expect(201);
  expect(confirmId).toMatch(uuid);
  expect(completed).toEqual({ ...memberView, status: 'COMPLETED', resolvedAt: now.toISOString() });
  expect((await read(requestPath(pending.requestId), admin).expect(200)).body)
    .toEqual({ ...pending, status: 'COMPLETED', resolvedAt: now.toISOString() });
  expect((await read(requestPath(pending.requestId)).expect(200)).body).toEqual(completed);
  await voucherStatus(voucher, 'USED');
  expect((await read(ledgerPath()).expect(200)).body).toEqual(original);
});

test('列表只回原會員，依時間及識別碼穩定分頁與品牌篩選；指定請求只回原雙方', async () => {
  const otherBrand = await createBrand();
  const outsider = await actorFor(brandId);
  const otherMember = await actorFor();
  const first = await issue();
  const second = await issue();
  const other = await issue({ brand: otherBrand });
  const { body: a } = await propose(first.code).expect(201);
  const { body: b } = await propose(second.code).expect(201);
  now = new Date(Date.parse(start) + 1);
  const { body: c } = await propose(other.code, key(), admin, otherBrand).expect(201);
  const ids = [a.requestId, b.requestId].sort().reverse();
  const { body: filtered } = await read(listPath + '?brandId=' + brandId.toUpperCase()).expect(200);
  expect(filtered.items.map(({ requestId }) => requestId)).toEqual(ids);
  expect((await read(listPath + '?pageSize=1').expect(200)).body).toMatchObject({
    items: [{ requestId: c.requestId }], hasNext: true,
  });
  expect((await read(listPath + '?pageSize=1&page=2').expect(200)).body).toEqual({
    items: [filtered.items[0]], hasNext: true,
  });
  expect((await read(listPath + '?pageSize=1&page=3').expect(200)).body).toEqual({
    items: [filtered.items[1]], hasNext: false,
  });
  expect((await read(listPath, otherMember.cookie).expect(200)).body).toEqual({ items: [], hasNext: false });
  await expectError(read(listPath + '?brandId=' + brandId + '&brandId=' + otherBrand), 400, 'INVALID_INPUT');
  await expectError(read(listPath + '?pageSize=101'), 400, 'INVALID_INPUT');
  await expectError(read(listPath, admin), 403, 'FORBIDDEN');
  await expectError(read(listPath, ''), 401, 'UNAUTHENTICATED');
  await expectError(read(requestPath(a.requestId), ''), 401, 'UNAUTHENTICATED');
  for (const cookie of [outsider.cookie, otherMember.cookie]) {
    await expectError(read(requestPath(a.requestId), cookie), 404, 'NOT_FOUND');
  }
  await expectError(read(requestPath(a.requestId.slice(0, 8))), 404, 'NOT_FOUND');
  await expectError(read(requestPath(randomUUID())), 404, 'NOT_FOUND');
  await expectError(propose(other.code, key(), outsider.cookie), 404, 'NOT_FOUND');
  const cancelKey = key();
  await expectError(act(a.requestId, 'cancel', cancelKey, outsider.cookie), 404, 'NOT_FOUND');
  await noKey(cancelKey);
  for (const action of ['confirm', 'reject']) {
    const deniedKey = key();
    await expectError(act(a.requestId, action, deniedKey, otherMember.cookie), 404, 'NOT_FOUND');
    await expectError(act(a.requestId, action, deniedKey, admin), 403, 'FORBIDDEN');
    await noKey(deniedKey);
  }
  await expectError(act(a.requestId, 'cancel', key(), member), 403, 'FORBIDDEN');
});

test('四種寫入拒絕未登入、缺 Key 及格式錯誤；不保留無效業務 Key', async () => {
  const voucher = await issue();
  const url = brandPath() + '/redemption-requests';
  const invalidKey = key();
  await expectError(propose(voucher.code, invalidKey, ''), 401, 'UNAUTHENTICATED');
  await expectError(propose(voucher.code, invalidKey, member), 403, 'FORBIDDEN');
  await expectError(post(url).send({ code: voucher.code }), 400, 'INVALID_INPUT');
  await expectError(propose(voucher.code, 'invalid-key'), 400, 'INVALID_INPUT');
  await expectError(propose(voucher.code, invalidKey).unset('Origin'), 403, 'INVALID_ORIGIN');
  await expectError(propose(voucher.code, invalidKey).set('X-Membership-Actor', 'demo_member'), 403, 'FORBIDDEN');
  for (const body of [{}, { code: voucher.code.slice(0, 8) }, { code: 5 }, { code: voucher.code, memberId }]) {
    await expectError(post(url).set('Idempotency-Key', invalidKey).send(body), 400, 'INVALID_INPUT');
  }
  await expectError(propose(randomUUID(), invalidKey), 404, 'NOT_FOUND');
  await noKey(invalidKey);
  const { body: { requestId } } = await propose(voucher.code, invalidKey).expect(201);
  for (const action of ['confirm', 'reject', 'cancel']) {
    const path = requestPath(requestId) + '/' + action;
    const cookie = action === 'cancel' ? admin : member;
    const nextKey = key();
    await expectError(act(requestId, action, nextKey, ''), 401, 'UNAUTHENTICATED');
    await expectError(post(path, cookie).send({}), 400, 'INVALID_INPUT');
    await expectError(act(requestId, action, 'invalid-key'), 400, 'INVALID_INPUT');
    await expectError(post(path, cookie).set('Idempotency-Key', nextKey).set('Content-Length', '0'), 400, 'INVALID_INPUT');
    await expectError(post(path, cookie).set('Idempotency-Key', nextKey).send({ voucherId: voucher.id }), 400, 'INVALID_INPUT');
    await noKey(nextKey);
  }
  await act(requestId, 'reject').expect(201);
  await voucherStatus(voucher, 'UNUSED');
});

test('發起者登出不撤銷請求，當下角色和品牌授權限制確認與已提交結果的回放', async () => {
  const brandAdmin = await actorFor(brandId);
  const voucher = await issue();
  const creationKey = key();
  const confirmKey = key();
  const { body: original } = await propose(voucher.code, creationKey, brandAdmin.cookie).expect(201);
  const { requestId } = original;
  await post('/api/auth/logout', brandAdmin.cookie).send({}).expect(204);
  await expectError(read(requestPath(requestId), brandAdmin.cookie), 401, 'UNAUTHENTICATED');
  const fresh = await brandAdmin.relogin();
  await db.brandAdminGrant.delete({ where: { accountId_brandId: brandAdmin.assignment } });
  await expectError(propose(voucher.code, creationKey, fresh), 404, 'NOT_FOUND');
  await expectError(read(requestPath(requestId), fresh), 404, 'NOT_FOUND');
  const cancelKey = key();
  await expectError(act(requestId, 'cancel', cancelKey, fresh), 404, 'NOT_FOUND');
  await noKey(cancelKey);
  await expectError(act(requestId, 'confirm', confirmKey), 404, 'NOT_FOUND');
  await noKey(confirmKey);
  await db.brandAdminGrant.create({ data: brandAdmin.assignment });
  await db.account.update({ where: { id: brandAdmin.id }, data: { role: 'MEMBER', memberNumber: brandAdmin.number } });
  await expectError(propose(voucher.code, creationKey, fresh), 403, 'FORBIDDEN');
  await expectError(act(requestId, 'confirm', confirmKey), 404, 'NOT_FOUND');
  await noKey(confirmKey);
  await db.account.update({ where: { id: brandAdmin.id }, data: { role: 'BRAND_ADMIN', memberNumber: null } });
  await post('/api/auth/logout', fresh).send({}).expect(204);
  const { body: completed } = await act(requestId, 'confirm', confirmKey).expect(201);
  await voucherStatus(voucher, 'USED');
  await db.brandAdminGrant.delete({ where: { accountId_brandId: brandAdmin.assignment } });
  await expectError(act(requestId, 'confirm', confirmKey), 404, 'NOT_FOUND');
  expect((await read(requestPath(requestId)).expect(200)).body).toMatchObject({ status: 'COMPLETED' });
  await db.brandAdminGrant.create({ data: brandAdmin.assignment });
  await db.account.update({ where: { id: brandAdmin.id }, data: { role: 'MEMBER', memberNumber: brandAdmin.number } });
  await expectError(act(requestId, 'confirm', confirmKey), 404, 'NOT_FOUND');
  await db.account.update({ where: { id: brandAdmin.id }, data: { role: 'BRAND_ADMIN', memberNumber: null } });
  expect((await act(requestId, 'confirm', confirmKey).expect(201)).body).toEqual(completed);
  const restored = await brandAdmin.relogin();
  expect((await propose(voucher.code, creationKey, restored).expect(201)).body).toEqual(original);
});

test('核銷與加點／兌換共用操作者 Key，雙向衝突且不同操作者的 Key 獨立', async () => {
  const secondAdmin = await actorFor(brandId);
  const voucher = await issue();
  const second = await issue();
  const before = (await read(ledgerPath()).expect(200)).body;
  const grantFirst = key();
  await grant(1, grantFirst).expect(201);
  await expectError(propose(voucher.code, grantFirst), 409, 'IDEMPOTENCY_CONFLICT');
  const createFirst = key();
  const { body: a } = await propose(voucher.code.toUpperCase(), createFirst.toUpperCase()).expect(201);
  expect((await propose(voucher.code, createFirst).expect(201)).body).toEqual(a);
  await expectError(grant(1, createFirst), 409, 'IDEMPOTENCY_CONFLICT');
  await expectError(propose(second.code, createFirst), 409, 'IDEMPOTENCY_CONFLICT');
  const { body: b } = await propose(second.code, createFirst, secondAdmin.cookie).expect(201);
  expect(b.requestId).not.toBe(a.requestId);
  expect(b.operationId).not.toBe(a.operationId);

  await grant(80).expect(201);
  const exchangeFirst = key();
  const { body: bought } = await exchange(voucher.offerId, exchangeFirst).expect(201);
  await expectError(act(a.requestId, 'confirm', exchangeFirst), 409, 'IDEMPOTENCY_CONFLICT');
  const confirmFirst = key();
  const { body: result } = await act(a.requestId, 'confirm', confirmFirst).expect(201);
  await expectError(exchange(voucher.offerId, confirmFirst), 409, 'IDEMPOTENCY_CONFLICT');
  await expectError(act(a.requestId, 'reject', confirmFirst), 409, 'IDEMPOTENCY_CONFLICT');
  await expectError(act(b.requestId, 'confirm', confirmFirst), 409, 'IDEMPOTENCY_CONFLICT');
  expect((await act(a.requestId, 'confirm', confirmFirst).expect(201)).body).toEqual(result);
  expect((await exchange(voucher.offerId, exchangeFirst).expect(201)).body).toEqual(bought);
  const after = (await read(ledgerPath()).expect(200)).body;
  expect(after.balance - before.balance).toBe(1);
  expect(after.items).toHaveLength(before.items.length + 3);
  await voucherStatus(voucher, 'USED');
  await voucherStatus(second, 'UNUSED');
});

test('管理員券碼限流涵蓋無效輸入、跨品牌、回放；帳號隔離且最早事件到期才釋出額度', async () => {
  const actor = await actorFor(brandId);
  const outsider = await actorFor(brandId);
  const voucher = await issue();
  const other = await issue({ brand: await createBrand() });
  const requestKey = key();
  const { body: original } = await propose(voucher.code, requestKey, actor.cookie).expect(201);
  now = new Date(Date.parse(start) + 1);
  expect((await propose(voucher.code, requestKey, actor.cookie).expect(201)).body).toEqual(original);
  const path = brandPath() + '/redemption-requests';
  await expectError(post(path, actor.cookie).send({ code: voucher.code }), 400, 'INVALID_INPUT');
  await expectError(post(path, actor.cookie).send('{'), 400, 'INVALID_INPUT');
  await expectError(post(path, actor.cookie).type('text/plain').send('no code'), 400, 'INVALID_INPUT');
  await expectError(propose(other.code, key(), actor.cookie), 404, 'NOT_FOUND');
  await expectError(propose('not-a-code', key(), actor.cookie), 400, 'INVALID_INPUT');
  const missingKey = key();
  await expectError(propose(randomUUID(), missingKey, actor.cookie), 404, 'NOT_FOUND');
  const batch = await Promise.all(Array.from({ length: 4 }, () => propose(voucher.code, requestKey, actor.cookie)));
  expect(batch.map(({ status }) => status).sort()).toEqual([201, 201, 429, 429]);
  expect(batch.filter(({ status }) => status === 201).map(({ body }) => body)).toEqual([original, original]);
  expect(batch.filter(({ status }) => status === 429).map(({ headers }) => headers['retry-after'])).toEqual(['60', '60']);
  const blockedKey = key();
  await expectError(propose(voucher.code, blockedKey, actor.cookie), 429, 'RATE_LIMITED', 60);
  // 非契約路徑不能避開入口限流並落入同一個建立命令。
  for (const variant of [path + '/', path.replace('redemption-requests', 'Redemption-requests')]) {
    await expectError(post(variant, actor.cookie).set('Idempotency-Key', blockedKey).send({ code: voucher.code }),
      404, 'NOT_FOUND');
  }
  await noKey(missingKey);
  await noKey(blockedKey);
  await expectError(propose(voucher.code, key(), outsider.cookie), 409, 'REDEMPTION_PENDING');
  expect((await db.attemptWindow.findUniqueOrThrow({
    where: { kind_key: { kind: 'REDEMPTION_ACCOUNT', key: actor.id } },
  })).attempted).toHaveLength(10);
  now = new Date(Date.parse(start) + 59999);
  await expectError(propose(voucher.code, requestKey, actor.cookie), 429, 'RATE_LIMITED', 1);
  now = new Date(Date.parse(start) + 60000);
  expect((await propose(voucher.code, requestKey, actor.cookie).expect(201)).body).toEqual(original);
  await expectError(propose(voucher.code, blockedKey, actor.cookie), 429, 'RATE_LIMITED', 1);
  now = new Date(Date.parse(start) + 60001);
  await expectError(propose(voucher.code, blockedKey, actor.cookie), 409, 'REDEMPTION_PENDING');
  expect(await db.redemptionRequest.count({ where: { voucherId: voucher.id } })).toBe(1);
});

test('核銷開始含、券截止不含，GET 投影到期；新請求取代到期待確認但舊 Key 不變', async () => {
  const shortEnd = '2031-05-01T00:02:00.000Z';
  const startsAt = '2031-05-01T00:00:00.001Z';
  now = new Date(startsAt);
  const voucher = await issue();
  const short = await issue({ offer: { ...terms, startsAt, endsAt: shortEnd } });
  now = new Date(start);
  const earlyKey = key();
  await expect(runCreate(short.code, earlyKey)).rejects.toMatchObject({ status: 409, code: 'VOUCHER_UNAVAILABLE' });
  now = new Date(startsAt);
  await expectError(propose(short.code, earlyKey), 409, 'VOUCHER_UNAVAILABLE');
  const shortRequest = await runCreate(short.code);
  expect(shortRequest.expiresAt).toBe(shortEnd);
  const firstKey = key();
  const { body: first } = await propose(voucher.code, firstKey).expect(201);
  expect(first.expiresAt).toBe('2031-05-01T00:05:00.001Z');
  const lastInstant = await issue({ offer: { ...terms, startsAt, endsAt: shortEnd } });
  const { body: lastRequest } = await propose(lastInstant.code).expect(201);
  const original = (await read(ledgerPath()).expect(200)).body;

  now = new Date(Date.parse(shortEnd) - 1);
  expect((await runResolve(lastRequest.requestId, 'confirm')).status).toBe('COMPLETED');
  expect((await read(requestPath(shortRequest.requestId)).expect(200)).body.status).toBe('PENDING');
  now = new Date(shortEnd);
  expect((await read(requestPath(shortRequest.requestId)).expect(200)).body).toMatchObject({
    status: 'EXPIRED', resolvedAt: shortEnd,
  });
  expect((await db.redemptionRequest.findUniqueOrThrow({ where: { id: shortRequest.requestId } })).status).toBe('PENDING');
  await expectError(act(shortRequest.requestId, 'confirm'), 409, 'REDEMPTION_NOT_PENDING');
  await expectError(propose(short.code), 409, 'VOUCHER_UNAVAILABLE');
  await voucherStatus(short, 'EXPIRED');
  await voucherStatus(lastInstant, 'USED');

  now = new Date(first.expiresAt);
  expect((await read(listPath).expect(200)).body.items.find(({ requestId }) => requestId === first.requestId))
    .toMatchObject({ status: 'EXPIRED', resolvedAt: first.expiresAt });
  expect((await db.redemptionRequest.findUniqueOrThrow({ where: { id: first.requestId } })).status).toBe('PENDING');
  expect((await propose(voucher.code, firstKey).expect(201)).body).toEqual(first);
  const { body: fresh } = await propose(voucher.code).expect(201);
  expect(fresh.requestId).not.toBe(first.requestId);
  expect(fresh.createdAt).toBe(first.expiresAt);
  expect((await db.redemptionRequest.findUniqueOrThrow({ where: { id: first.requestId } })).status).toBe('EXPIRED');
  await expectError(act(first.requestId, 'reject'), 409, 'REDEMPTION_NOT_PENDING');
  await voucherStatus(voucher, 'UNUSED');
  expect((await read(ledgerPath()).expect(200)).body).toEqual(original);
});

async function withVoucherLock(voucherId, run) {
  const ready = Promise.withResolvers();
  const release = Promise.withResolvers();
  const holder = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Voucher" WHERE "id" = ${voucherId}::uuid FOR UPDATE`;
    ready.resolve();
    await release.promise;
  });
  await Promise.race([ready.promise, holder]);
  const attempts = [];
  try {
    await run((attempt) => {
      // 立刻接住業務拒絕，等放開資料庫鎖後再一起斷言。
      attempts.push(attempt.then(
        (value) => ({ value }),
        (error) => ({ error }),
      ));
    });
  } finally {
    release.resolve();
    await holder;
    await Promise.allSettled(attempts);
  }
  return Promise.all(attempts);
}

async function expectWaiters(pattern, count) {
  const deadline = performance.now() + 4000;
  do {
    const [row] = await db.$queryRaw`
      SELECT COUNT(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE ${pattern}
    `;
    if (row.count === count) return;
    await delay(15);
  } while (performance.now() < deadline);
  throw new Error('未觀察到預期 PostgreSQL 等鎖數：' + count);
}

const voucherLock = '%FROM "Voucher" v%FOR UPDATE OF v%';
const keyLock = '%INSERT INTO "IdempotentOperation"%';

test.each([false, true])('實際並行提出同券只有一筆待確認（同操作者且同 Key：%s）', async (sameKey) => {
  const voucher = await issue();
  const other = await actorFor(brandId);
  const before = (await read(ledgerPath()).expect(200)).body;
  const firstKey = key();
  const [first, second] = await withVoucherLock(voucher.id, async (startOperation) => {
    startOperation(runCreate(voucher.code, firstKey));
    await expectWaiters(voucherLock, 1);
    startOperation(runCreate(voucher.code, sameKey ? firstKey : key(), sameKey ? admin : other.cookie));
    await expectWaiters(sameKey ? keyLock : voucherLock, sameKey ? 1 : 2);
  });
  expect(first.value).toMatchObject({ requestId: expect.stringMatching(uuid), status: 'PENDING' });
  if (sameKey) {
    expect(second.value).toEqual(first.value);
  } else {
    expect(second.error).toMatchObject({ status: 409, code: 'REDEMPTION_PENDING' });
  }
  expect((await propose(voucher.code, firstKey).expect(201)).body).toEqual(first.value);
  expect(await db.redemptionRequest.findMany({ where: { voucherId: voucher.id }, select: { id: true, status: true } }))
    .toEqual([{ id: first.value.requestId, status: 'PENDING' }]);
  await voucherStatus(voucher, 'UNUSED');
  expect((await read(ledgerPath()).expect(200)).body).toEqual(before);
});

test.each([
  ['confirm', 'cancel', 'COMPLETED'],
  ['cancel', 'confirm', 'CANCELLED'],
  ['reject', 'confirm', 'REJECTED'],
  ['confirm', 'reject', 'COMPLETED'],
  ['confirm', 'confirm', 'COMPLETED'],
])('實際等券鎖：%s 先於 %s，唯一終態為 %s', async (winner, loser, status) => {
  const voucher = await issue();
  const { body: { requestId } } = await propose(voucher.code).expect(201);
  const before = (await read(ledgerPath()).expect(200)).body;
  const winnerKey = key();
  const loserKey = key();
  const [first, second] = await withVoucherLock(voucher.id, async (startOperation) => {
    startOperation(runResolve(requestId, winner, winnerKey));
    await expectWaiters(voucherLock, 1);
    startOperation(runResolve(requestId, loser, loserKey));
    await expectWaiters(voucherLock, 2);
  });
  expect(first.value).toMatchObject({ requestId, status });
  expect(second.error).toMatchObject({ status: 409, code: 'REDEMPTION_NOT_PENDING' });
  expect((await act(requestId, winner, winnerKey).expect(201)).body).toEqual(first.value);
  await expectError(act(requestId, loser, loserKey), 409, 'REDEMPTION_NOT_PENDING');
  if (status === 'COMPLETED') {
    await expectError(act(requestId, 'cancel'), 409, 'REDEMPTION_NOT_PENDING');
    await expectError(propose(voucher.code), 409, 'VOUCHER_UNAVAILABLE');
  }
  expect((await read(requestPath(requestId)).expect(200)).body).toMatchObject({ status, resolvedAt: start });
  expect((await db.voucher.findUniqueOrThrow({ where: { id: voucher.id } })).usedAt)
    .toEqual(status === 'COMPLETED' ? new Date(start) : null);
  await voucherStatus(voucher, status === 'COMPLETED' ? 'USED' : 'UNUSED');
  expect((await read(ledgerPath()).expect(200)).body).toEqual(before);
});

test.each(['create', 'confirm'])('%s 等券鎖到截止時刻後拒絕，以取得必要鎖後的時間判定', async (action) => {
  const voucher = await issue({ offer: { ...terms, endsAt: '2031-05-01T00:01:00.000Z' } });
  const before = (await read(ledgerPath()).expect(200)).body;
  const pending = action === 'confirm' ? (await propose(voucher.code).expect(201)).body : null;
  const operationKey = key();
  const [result] = await withVoucherLock(voucher.id, async (startOperation) => {
    now = new Date(Date.parse(voucher.endsAt) - 1);
    startOperation(pending ? runResolve(pending.requestId, action, operationKey) : runCreate(voucher.code, operationKey));
    await expectWaiters(voucherLock, 1);
    now = new Date(voucher.endsAt);
  });
  expect(result.error).toMatchObject({
    status: 409, code: pending ? 'REDEMPTION_NOT_PENDING' : 'VOUCHER_UNAVAILABLE',
  });
  expect(await db.redemptionRequest.count({ where: { voucherId: voucher.id } })).toBe(pending ? 1 : 0);
  expect((await db.voucher.findUniqueOrThrow({ where: { id: voucher.id } })).usedAt).toBeNull();
  if (pending) expect((await read(requestPath(pending.requestId)).expect(200)).body.status).toBe('EXPIRED');
  expect((await read(ledgerPath()).expect(200)).body).toEqual(before);
});

test('資料庫拒絕同券第二筆待確認及錯綁品牌或會員的核銷請求', async () => {
  const voucher = await issue();
  const outsider = await actorFor();
  const wrongBrand = await createBrand();
  await propose(voucher.code).expect(201);
  const rows = [
    [brandId, memberId, '23505', 'RedemptionRequest_pending_voucher_key'],
    [wrongBrand, memberId, '23503', 'RedemptionRequest_voucher_owner_fkey'],
    [brandId, outsider.id, '23503', 'RedemptionRequest_voucher_owner_fkey'],
  ];
  for (const [brand, member, originalCode, constraint] of rows) {
    // 歸屬驗證使用終態測試列，避免先被待確認唯一索引攔截。
    const status = originalCode === '23505' ? 'PENDING' : 'CANCELLED';
    const resolved = originalCode === '23505' ? null : now;
    await expect(db.$executeRaw`
      INSERT INTO "RedemptionRequest" ("id", "brandId", "memberId", "voucherId", "initiatorId",
          "status", "createdAt", "expiresAt", "resolvedAt")
      VALUES (${randomUUID()}::uuid, ${brand}::uuid, ${member}::uuid, ${voucher.id}::uuid, ${adminId}::uuid,
          ${status}::"RedemptionStatus", ${now}, ${new Date(Date.parse(start) + 60000)}, ${resolved}::timestamptz)
    `).rejects.toMatchObject({
      code: 'P2010',
      meta: { driverAdapterError: { cause: { originalCode, originalMessage: expect.stringContaining(constraint) } } },
    });
  }
  expect(await db.redemptionRequest.count({ where: { voucherId: voucher.id } })).toBe(1);
});

const recoveryCases = [
  ['create', 'PENDING', 'createRedemption'],
  ['confirm', 'COMPLETED', 'confirmRedemption'],
  ['cancel', 'CANCELLED', 'cancelRedemption'],
  ['reject', 'REJECTED', 'rejectRedemption'],
];

async function recoveryFixture(action) {
  const voucher = await issue();
  const original = action === 'create' ? null : (await propose(voucher.code).expect(201)).body;
  const operationKey = key();
  const submit = () => original ? act(original.requestId, action, operationKey) : propose(voucher.code, operationKey);
  const owner = action === 'create' || action === 'cancel' ? adminId : memberId;
  const before = (await read(ledgerPath()).expect(200)).body;
  return { voucher, original, operationKey, submit, owner, before };
}

async function expectRecoveryState(fixture, requestId, status) {
  const { voucher, before } = fixture;
  expect(await db.redemptionRequest.findMany({ where: { voucherId: voucher.id }, select: { id: true, status: true } }))
    .toEqual(requestId ? [{ id: requestId, status }] : []);
  expect((await db.voucher.findUniqueOrThrow({ where: { id: voucher.id } })).usedAt)
    .toEqual(status === 'COMPLETED' ? now : null);
  if (requestId) {
    for (const cookie of [member, admin]) {
      expect((await read(requestPath(requestId), cookie).expect(200)).body).toMatchObject({ status });
    }
  }
  await voucherStatus(voucher, status === 'COMPLETED' ? 'USED' : 'UNUSED');
  expect((await read(ledgerPath()).expect(200)).body).toEqual(before);
}

test.each(recoveryCases)('%s 提交前資料庫故障整筆回滾，移除故障後沿用原 Key', async (action, status, operation) => {
  const fixture = await recoveryFixture(action);
  const { original, operationKey, submit, owner } = fixture;
  await db.$executeRaw`CREATE SEQUENCE redemptions_test_commit_calls`;
  try {
    await db.$executeRaw`
      CREATE FUNCTION redemptions_test_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM "Brand" WHERE "id" = NEW."brandId" AND "name" = '核銷測試品牌'
        ) AND EXISTS (
          SELECT 1 FROM "IdempotentOperation"
          WHERE "status" = 201 AND "result"->>'requestId' = NEW."id"::text
              AND "result"->>'status' = NEW."status"::text
        ) THEN
          PERFORM nextval('redemptions_test_commit_calls');
          RAISE EXCEPTION 'test-only deferred redemption failure';
        END IF;
        RETURN NULL;
      END;
      $$
    `;
    // 觸發器在提交時才執行；序列不會被回滾，可證明已寫入完整結果並抵達故障點。
    await db.$executeRaw`
      CREATE CONSTRAINT TRIGGER redemptions_test_fail_commit AFTER INSERT OR UPDATE ON "RedemptionRequest"
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION redemptions_test_fail_commit()
    `;
    const pending = original
      ? runResolve(original.requestId, action, operationKey)
      : runCreate(fixture.voucher.code, operationKey);
    await expect(pending).rejects.toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
    expect(await db.$queryRaw`SELECT last_value, is_called FROM redemptions_test_commit_calls`)
      .toEqual([{ last_value: 1n, is_called: true }]);
    await noKey(operationKey);
    await expectRecoveryState(fixture, original?.requestId, 'PENDING');
    const failed = await expectError(submit(), 503, 'SERVICE_UNAVAILABLE');
    expect(await db.$queryRaw`SELECT last_value, is_called FROM redemptions_test_commit_calls`)
      .toEqual([{ last_value: 2n, is_called: true }]);
    await noKey(operationKey);
    await expectRecoveryState(fixture, original?.requestId, 'PENDING');
    if (action === 'create') {
      expect((await db.attemptWindow.findUniqueOrThrow({
        where: { kind_key: { kind: 'REDEMPTION_ACCOUNT', key: owner } },
      })).attempted).toEqual([now]);
    }
    expect(logs.mock.calls.map(([line]) => JSON.parse(line)).filter(({ traceId }) => traceId === failed.body.traceId))
      .toEqual([{ traceId: failed.body.traceId, operation, status: 503, accountId: owner }]);
  } finally {
    await db.$executeRaw`DROP TRIGGER IF EXISTS redemptions_test_fail_commit ON "RedemptionRequest"`;
    await db.$executeRaw`DROP FUNCTION IF EXISTS redemptions_test_fail_commit()`;
    await db.$executeRaw`DROP SEQUENCE redemptions_test_commit_calls`;
  }
  const { body: result } = await submit().expect(201);
  expect((await submit().expect(201)).body).toEqual(result);
  expect(await db.idempotentOperation.count({ where: { key: operationKey } })).toBe(1);
  await expectRecoveryState(fixture, result.requestId, status);
});

test.each(recoveryCases)('%s 已提交後中斷真 HTTP 回應，沿用原 Key 且稽核各一次', async (action, status, operation) => {
  const fixture = await recoveryFixture(action);
  const { voucher, operationKey, submit, owner } = fixture;
  const server = app.getHttpServer();
  const interrupted = Promise.withResolvers();
  const loseResponse = (_request, response) => {
    // 等正常路徑完成提交並嘗試送出 201，再關閉實際 socket。
    response.end = function () {
      interrupted.resolve({ status: this.statusCode, traceId: this.getHeader('X-Trace-Id'), headersSent: this.headersSent });
      return this.destroy();
    };
  };
  server.prependOnceListener('request', loseResponse);
  try {
    await expect(submit()).rejects.toMatchObject({ code: 'ECONNRESET' });
  } finally {
    server.removeListener('request', loseResponse);
  }
  const sent = await Promise.race([interrupted.promise, delay(1000, null, { ref: false })]);
  expect(sent).toEqual({ status: 201, traceId: expect.stringMatching(uuid), headersSent: false });
  const stored = await db.idempotentOperation.findUniqueOrThrow({ where: { actorId_key: { actorId: owner, key: operationKey } } });
  expect(stored).toMatchObject({ status: 201, result: { requestId: expect.stringMatching(uuid), status } });
  await expectRecoveryState(fixture, stored.result.requestId, status);

  const replay = await submit().expect(201);
  expect(replay.body).toEqual(stored.result);
  expect(replay.headers['x-trace-id']).not.toBe(sent.traceId);
  await expectRecoveryState(fixture, stored.result.requestId, status);
  expect(await db.idempotentOperation.count({ where: { key: operationKey } })).toBe(1);
  const audit = logs.mock.calls.map(([line]) => JSON.parse(line));
  for (const traceId of [sent.traceId, replay.headers['x-trace-id']]) {
    expect(audit.filter((entry) => entry.traceId === traceId)).toEqual([{
      traceId, operation, status: 201, accountId: owner, requestId: replay.body.requestId,
    }]);
  }
  const recorded = JSON.stringify(audit);
  for (const value of [voucher.code, operationKey, member, admin]) expect(recorded).not.toContain(value);
});
