import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request as sendHttp } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { jest } from '@jest/globals';
import request from 'supertest';

const origin = process.env.APP_ORIGIN;
const target = URL.parse(process.env.DATABASE_URL ?? '');
if (process.env.MEMBERSHIP_TEST !== 'membership-rewards-test'
    || origin !== 'http://membership-rewards-test.localhost:18442'
    || target?.host !== 'db:5432' || target.pathname !== '/membership') {
  throw new Error('點數測試僅能在隔離的 membership-rewards-test Compose 專案執行');
}

const { createApp } = await import('../dist/app.js');
const { createDatabase } = await import('../dist/database.js');
const { AuthService } = await import('../dist/auth.js');
const { grantPoints, readPoints } = await import('../dist/points.js');
const headers = { Host: new URL(origin).host, Origin: origin };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const runNode = promisify(execFile);
const validGrant = { points: 17, reason: '活動加點' };
const maxPoints = 2147483647;
let app;
let db;
let http;
let logs;
let passwords;
let now;
let brandId;
let memberNumber;
let memberId;
const fixtureBrands = [];
const fixtureKeys = [];
const fixtureMembers = [];

beforeAll(async () => {
  logs = jest.spyOn(console, 'info').mockImplementation(() => {});
  db = createDatabase();
  passwords = JSON.parse(await readFile('/run/membership-app/demo-passwords.json', 'utf8'));
  ({ id: memberId, memberNumber } = await db.account.findUniqueOrThrow({ where: { username: 'demo_member' } }));
  app = await createApp({ clock: () => now });
  await app.listen(0, '127.0.0.1');
  http = request(app.getHttpServer());
});

beforeEach(async () => {
  now = new Date('2030-07-01T00:00:00.000Z');
  logs.mockClear();
  await db.attemptWindow.deleteMany({ where: { kind: 'LOGIN_SOURCE', key: '127.0.0.1' } });
  brandId = await createBrand();
});

afterEach(async () => {
  const where = { brandId: { in: fixtureBrands } };
  // 只清除本次測試擁有的暫存資料，保留示範點數及其他套件的資料。
  await db.$transaction([
    db.idempotentOperation.deleteMany({ where: { key: { in: fixtureKeys } } }),
    db.pointLedger.deleteMany({ where }),
    db.pointAccount.deleteMany({ where }),
    db.brandAdminGrant.deleteMany({ where }),
    db.brand.deleteMany({ where: { id: { in: fixtureBrands } } }),
    db.session.deleteMany({ where: { accountId: { in: fixtureMembers } } }),
    db.account.deleteMany({ where: { id: { in: fixtureMembers } } }),
  ]);
  fixtureBrands.length = fixtureKeys.length = fixtureMembers.length = 0;
});

afterAll(async () => {
  await app?.close();
  await db?.$disconnect();
  logs?.mockRestore();
});

async function login(username, password = passwords[username]) {
  const response = await http.post('/api/auth/login').set(headers).send({ username, password }).expect(200);
  return response.headers['set-cookie'][0].split(';', 1)[0];
}

async function createBrand() {
  const id = randomUUID();
  await db.brand.create({ data: { id, name: '點數隔離測試' } });
  fixtureBrands.push(id);
  return id;
}

function operationKey() {
  const key = randomUUID();
  fixtureKeys.push(key);
  return key;
}

async function registerMember() {
  const username = randomUUID().replaceAll('-', '');
  const password = '點數測試會員密碼僅供測試';
  await db.attemptWindow.deleteMany({ where: { kind: 'REGISTER_SOURCE', key: '127.0.0.1' } });
  const registered = await http.post('/api/auth/register').set(headers)
    .send({ username, password, displayName: '點數測試會員' }).expect(201);
  const { id } = await db.account.findUniqueOrThrow({ where: { username }, select: { id: true } });
  fixtureMembers.push(id);
  return { cookie: await login(username, password), memberNumber: registered.body.memberNumber };
}

const pointsPath = (id = brandId) => '/api/brands/' + id;
const memberPath = (id = brandId, number = memberNumber) => pointsPath(id) + '/members/' + number;
const read = (path, cookie) => http.get(path).set('Host', headers.Host).set('Cookie', cookie ?? '');
const grant = (cookie, key, body = validGrant, path = memberPath()) => {
  const req = http.post(path + '/grants').set(headers).set('Cookie', cookie ?? '').type('application/json');
  return (key === undefined ? req : req.set('Idempotency-Key', key)).send(body);
};

function expectError(response, code) {
  expect(response.body).toEqual({ code, message: expect.any(String), traceId: expect.stringMatching(uuid) });
  expect(response.headers['x-trace-id']).toBe(response.body.traceId);
  expect(response.headers['cache-control']).toBe('private, no-store');
}

const pointAccount = () => ({ brandId, memberId });
const storedOperations = () => db.idempotentOperation.findMany({ where: { key: { in: fixtureKeys } } });

async function assertBalance(amount, expectedCount) {
  const account = await db.pointAccount.findUnique({ where: { brandId_memberId: pointAccount() } });
  const { _sum, _count } = await db.pointLedger.aggregate({ where: pointAccount(), _sum: { amount: true }, _count: true });
  expect(account?.balance ?? 0).toBe(amount);
  expect(_sum.amount ?? 0).toBe(amount);
  expect(_count).toBe(expectedCount);
}

test('沒有點數帳戶讀為零，精確查詢只回傳本品牌與安全欄位', async () => {
  const member = await login('demo_member');
  const admin = await login('group_admin');
  expect((await read(pointsPath() + '/me/points', member).expect(200)).body).toEqual({ balance: 0 });
  expect((await read(pointsPath() + '/me/ledger', member).expect(200)).body)
    .toEqual({ balance: 0, items: [], hasNext: false });
  expect((await read(memberPath(brandId.toUpperCase(), memberNumber.toUpperCase()), admin).expect(200)).body)
    .toEqual({ memberNumber, displayName: '示範會員', balance: 0 });
  expectError(await read(memberPath(brandId, memberNumber.slice(0, 8)), admin).expect(404), 'NOT_FOUND');
  expectError(await read(memberPath(brandId, randomUUID()), admin).expect(404), 'NOT_FOUND');
  expect(await db.pointAccount.findUnique({ where: { brandId_memberId: pointAccount() } })).toBeNull();
});

test('會員只讀自己的點數，品牌管理員只讀授權品牌，拒絕的請求不占用識別碼', async () => {
  const key = operationKey();
  const member = await login('demo_member');
  const other = await registerMember();
  const adminA = await login('brand_admin_a');
  const adminB = await login('brand_admin_b');
  const admin = await login('group_admin');
  const { id: adminAId } = await db.account.findUniqueOrThrow({ where: { username: 'brand_admin_a' } });
  await db.brandAdminGrant.create({ data: { accountId: adminAId, brandId } });
  const absentBrand = randomUUID();
  const otherBrand = await createBrand();

  expectError(await read(pointsPath() + '/me/ledger').expect(401), 'UNAUTHENTICATED');
  expectError(await read(memberPath()).expect(401), 'UNAUTHENTICATED');
  expectError(await grant(undefined, key).expect(401), 'UNAUTHENTICATED');
  expectError(await read(memberPath(), member).expect(403), 'FORBIDDEN');
  expectError(await read(memberPath() + '/ledger', member).expect(403), 'FORBIDDEN');
  expectError(await grant(member, key).expect(403), 'FORBIDDEN');
  expectError(await read(pointsPath() + '/me/points', adminA).expect(403), 'FORBIDDEN');
  expectError(await read(pointsPath() + '/me/ledger', admin).expect(403), 'FORBIDDEN');
  for (const id of [otherBrand, absentBrand]) {
    expectError(await read(memberPath(id), adminA).expect(404), 'NOT_FOUND');
    expectError(await read(memberPath(id) + '/ledger', adminA).expect(404), 'NOT_FOUND');
    expectError(await grant(adminA, key, validGrant, memberPath(id)).expect(404), 'NOT_FOUND');
  }
  expectError(await grant(adminA, key, validGrant, memberPath(brandId, randomUUID())).expect(404), 'NOT_FOUND');
  expectError(await read(memberPath(), adminB).expect(404), 'NOT_FOUND');
  expectError(await read(pointsPath(absentBrand) + '/me/points', member).expect(404), 'NOT_FOUND');
  expect(await storedOperations()).toEqual([]);

  const created = await grant(adminA, key).expect(201);
  expect(created.body).toEqual({ operationId: expect.stringMatching(uuid), grantId: expect.stringMatching(uuid), balance: 17 });
  const ledger = (await read(memberPath() + '/ledger', adminA).expect(200)).body;
  expect(ledger).toEqual({
    balance: 17, hasNext: false, items: [{
      id: created.body.grantId, amount: 17, reason: validGrant.reason, source: 'GRANT',
      createdAt: expect.any(String), actorDisplayName: '品牌管理員 A',
    }],
  });
  expect(new Date(ledger.items[0].createdAt).toISOString()).toBe(ledger.items[0].createdAt);
  expect((await read(pointsPath() + '/me/ledger', member).expect(200)).body).toEqual(ledger);
  expect((await read(memberPath(), admin).expect(200)).body)
    .toEqual({ memberNumber, displayName: '示範會員', balance: 17 });
  expect((await read(pointsPath() + '/me/ledger', other.cookie).expect(200)).body)
    .toEqual({ balance: 0, items: [], hasNext: false });
  expect((await read(memberPath(brandId, other.memberNumber), adminA).expect(200)).body)
    .toEqual({ memberNumber: other.memberNumber, displayName: '點數測試會員', balance: 0 });
  expectError(await read(pointsPath() + '/members', adminA).expect(404), 'NOT_FOUND');
  await assertBalance(17, 1);

  const records = logs.mock.calls.map(([entry]) => JSON.parse(entry));
  expect(records).toContainEqual({
    traceId: created.headers['x-trace-id'], operation: 'grantPoints', status: 201, accountId: adminAId, brandId,
  });
  for (const sensitive of [memberNumber, key, validGrant.reason, adminA, passwords.brand_admin_a, 'demo_member']) {
    expect(JSON.stringify(records)).not.toContain(sensitive);
  }
});

test('同一 Key 正規化後回放原餘額與識別，跨內容衝突，仍查證當下授權及工作階段', async () => {
  const adminA = await login('brand_admin_a');
  const admin = await login('group_admin');
  const { id: adminAId } = await db.account.findUniqueOrThrow({ where: { username: 'brand_admin_a' } });
  const pair = { accountId: adminAId, brandId };
  await db.brandAdminGrant.create({ data: pair });
  const key = operationKey();
  const initial = await grant(adminA, key, { ...validGrant, reason: '　活動加點  ' }).expect(201);
  await grant(admin, key).expect(201);
  const replay = await grant(adminA, key.toUpperCase(), validGrant, memberPath(brandId.toUpperCase(), memberNumber.toUpperCase()))
    .expect(201);
  expect(replay.body).toEqual(initial.body);
  expect(replay.headers['x-trace-id']).not.toBe(initial.headers['x-trace-id']);
  for (const body of [{ ...validGrant, points: 18 }, { ...validGrant, reason: '其他原因' }]) {
    expectError(await grant(adminA, key, body).expect(409), 'IDEMPOTENCY_CONFLICT');
  }
  const otherBrand = await createBrand();
  expectError(await grant(admin, key, validGrant, memberPath(otherBrand)).expect(409), 'IDEMPOTENCY_CONFLICT');
  const other = await registerMember();
  expectError(await grant(admin, key, validGrant, memberPath(brandId, other.memberNumber)).expect(409), 'IDEMPOTENCY_CONFLICT');

  await db.brandAdminGrant.delete({ where: { accountId_brandId: pair } });
  expectError(await grant(adminA, key).expect(404), 'NOT_FOUND');
  await db.brandAdminGrant.create({ data: pair });
  await db.account.update({ where: { id: adminAId }, data: { role: 'MEMBER', memberNumber: randomUUID() } });
  try {
    expectError(await grant(adminA, key).expect(403), 'FORBIDDEN');
  } finally {
    await db.account.update({ where: { id: adminAId }, data: { role: 'BRAND_ADMIN', memberNumber: null } });
  }
  expect((await grant(adminA, key).expect(201)).body).toEqual(initial.body);
  await http.post('/api/auth/logout').set(headers).set('Cookie', adminA).send({}).expect(204);
  expectError(await grant(adminA, key).expect(401), 'UNAUTHENTICATED');
  expectError(await read(memberPath(), adminA).expect(401), 'UNAUTHENTICATED');
  now = new Date(now.getTime() + 1800000);
  expectError(await grant(admin, key).expect(401), 'UNAUTHENTICATED');
  expectError(await read(memberPath() + '/ledger', admin).expect(401), 'UNAUTHENTICATED');
  expect(await storedOperations()).toHaveLength(2);
  await assertBalance(34, 2);
});

test('點數請求的預期帳號須符合 Cookie 身分，拒絕後相同 Key 仍可使用', async () => {
  const admin = await login('group_admin');
  const adminA = await login('brand_admin_a');
  const { id: adminAId } = await db.account.findUniqueOrThrow({ where: { username: 'brand_admin_a' } });
  await db.brandAdminGrant.create({ data: { accountId: adminAId, brandId } });
  const key = operationKey();
  const actorHeader = 'X-Membership-Actor';
  const ledgerPath = memberPath() + '/ledger';

  await read(ledgerPath, adminA).set(actorHeader, 'brand_admin_a').expect(200);
  expectError(await read(ledgerPath).set(actorHeader, 'brand_admin_a').expect(401), 'UNAUTHENTICATED');
  expectError(await read(ledgerPath, admin).set(actorHeader, 'brand_admin_a').expect(403), 'FORBIDDEN');
  expectError(await grant(admin, key).set(actorHeader, 'brand_admin_a').expect(403), 'FORBIDDEN');
  expect(await storedOperations()).toEqual([]);
  await assertBalance(0, 0);

  const accepted = await grant(admin, key).set(actorHeader, 'group_admin').expect(201);
  expect((await grant(admin, key).set(actorHeader, 'group_admin').expect(201)).body).toEqual(accepted.body);
  expect((await grant(admin, key).expect(201)).body).toEqual(accepted.body);
  const matched = await read(ledgerPath, admin).set(actorHeader, 'group_admin').expect(200);
  expect((await read(ledgerPath, admin).expect(200)).body).toEqual(matched.body);
  expect(matched.body.balance).toBe(17);
  await assertBalance(17, 1);
});

test('登入標記在同一 Cookie 內固定，同帳號的新 Cookie 有獨立標記', async () => {
  const sessionHeader = 'x-membership-session';
  const credentials = { username: 'group_admin', password: passwords.group_admin };
  const signIn = (cookie) => http.post('/api/auth/login').set(headers).set('Cookie', cookie).send(credentials).expect(200);
  const first = await signIn('');
  const firstCookie = first.headers['set-cookie'][0].split(';', 1)[0];
  const second = await signIn(firstCookie);
  const secondCookie = second.headers['set-cookie'][0].split(';', 1)[0];
  const tags = [first.headers[sessionHeader], second.headers[sessionHeader]];
  const identity = { username: 'group_admin', displayName: '集團管理員', role: 'GROUP_ADMIN', memberNumber: null };

  expect(firstCookie).not.toBe(secondCookie);
  expect(tags[0]).not.toBe(tags[1]);
  for (const [index, cookie] of [firstCookie, secondCookie].entries()) {
    const token = cookie.slice(cookie.indexOf('=') + 1);
    expect(tags[index]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tags[index]).not.toBe(token);
    expect([first, second][index].body).toEqual(identity);
    const current = await read('/api/auth/me', cookie).expect(200).expect('Cache-Control', 'private, no-store');
    expect(current.body).toEqual(identity);
    expect(current.headers[sessionHeader]).toBe(tags[index]);
    expect(JSON.stringify(current.headers)).not.toContain(token);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(token);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(tags[index]);
  }
  for (const cookie of [undefined, 'membership_rewards_session=' + tags[0]]) {
    const anonymous = await read('/api/auth/me', cookie).expect(401);
    expectError(anonymous, 'UNAUTHENTICATED');
    expect(anonymous.headers[sessionHeader]).toBeUndefined();
  }
});

test('加點以原始 JSON 數字判斷正整數，接受等價指數與末尾零格式', async () => {
  const admin = await login('group_admin');
  const key = operationKey();
  const fractional = '{"points":2147483646.999999999999999999,"reason":"活動加點"}';
  expect(JSON.parse(fractional).points).toBe(maxPoints);
  expectError(await grant(admin, key, fractional).expect(400), 'INVALID_INPUT');
  expect(await storedOperations()).toEqual([]);
  await assertBalance(0, 0);

  const accepted = await grant(admin, key, '{"points":2.1474836470e9,"reason":"活動加點"}').expect(201);
  expect(accepted.body.balance).toBe(maxPoints);
  for (const points of ['2147483647.000', '214748364700e-2', '2147483647']) {
    const replay = await grant(admin, key, '{"points":' + points + ',"reason":"活動加點"}').expect(201);
    expect(replay.body).toEqual(accepted.body);
  }
  await assertBalance(maxPoints, 1);
});

test('加點驗證完整輸入、接受正整數上界，溢位保存原業務拒絕且不寫流水', async () => {
  const admin = await login('group_admin');
  const key = operationKey();
  expectError(await grant(admin, undefined).expect(400), 'INVALID_INPUT');
  expectError(await grant(admin, 'not-a-uuid').expect(400), 'INVALID_INPUT');
  expectError(await grant(admin, key + ', ' + randomUUID()).expect(400), 'INVALID_INPUT');
  expectError(await grant(admin, key, validGrant, memberPath('invalid-id')).expect(400), 'INVALID_INPUT');
  const malformedReason = JSON.stringify({ ...validGrant, reason: String.fromCharCode(0xd800) });
  expect(malformedReason).toContain('\\ud800');
  for (const invalid of [
    {}, { points: 1 }, { ...validGrant, actorId: randomUUID() }, [validGrant], 'null', '{"points":',
    ...[0, -1, 0.5, '1', maxPoints + 1].map((points) => ({ ...validGrant, points })),
    ...[true, '', '　', '內\n部', '內\u0085部', '𠮷'.repeat(201)].map((reason) => ({ ...validGrant, reason })),
    malformedReason, ' '.repeat(16385),
  ]) {
    expectError(await grant(admin, key, invalid).expect(400), 'INVALID_INPUT');
  }
  const wrongOrigin = await http.post(memberPath() + '/grants').set('Host', headers.Host)
    .set('Cookie', admin).set('Idempotency-Key', key).send(validGrant).expect(403);
  expectError(wrongOrigin, 'INVALID_ORIGIN');
  expect(await storedOperations()).toEqual([]);
  expect(await db.pointAccount.findUnique({ where: { brandId_memberId: pointAccount() } })).toBeNull();
  const reason = '𠮷'.repeat(200);
  const json = JSON.stringify({ points: maxPoints, reason: '　' + reason + ' ' });
  const atBodyLimit = json + ' '.repeat(16384 - Buffer.byteLength(json));
  const created = await grant(admin, key, atBodyLimit).expect(201);
  expect(created.body.balance).toBe(maxPoints);

  const overflowKey = operationKey();
  const first = await grant(admin, overflowKey).expect(409);
  const replay = await grant(admin, overflowKey).expect(409);
  expectError(first, 'BALANCE_LIMIT_EXCEEDED');
  expectError(replay, 'BALANCE_LIMIT_EXCEEDED');
  expect(first.body.message).toBe(replay.body.message);
  expect(first.body.traceId).not.toBe(replay.body.traceId);
  expectError(await grant(admin, overflowKey, { ...validGrant, points: 1 }).expect(409), 'IDEMPOTENCY_CONFLICT');
  expect(await storedOperations()).toEqual(expect.arrayContaining([
    expect.objectContaining({ key, status: 201, result: created.body }),
    expect.objectContaining({ key: overflowKey, status: 409, result: { code: first.body.code, message: first.body.message } }),
  ]));
  const ledger = (await read(memberPath() + '/ledger', admin).expect(200)).body;
  expect(ledger.items).toEqual([expect.objectContaining({ id: created.body.grantId, amount: maxPoints, reason })]);
  expectError(await http.patch(pointsPath() + '/grants/' + created.body.grantId).set(headers).set('Cookie', admin)
    .send({ reason: '改寫歷史' }).expect(404), 'NOT_FOUND');
  expectError(await http.delete(pointsPath() + '/grants/' + created.body.grantId).set(headers).set('Cookie', admin)
    .send({}).expect(404), 'NOT_FOUND');
  await assertBalance(maxPoints, 1);
});

async function waitForGrantOverlap(accountWaiters, operationWaiters) {
  const deadline = performance.now() + 5000;
  let waiters;
  do {
    [waiters] = await db.$queryRaw`
      SELECT
        COUNT(*) FILTER (
          WHERE query LIKE '%INSERT INTO "PointAccount"%' AND wait_event = 'advisory'
        )::int AS "accountWaiters",
        COUNT(*) FILTER (WHERE query LIKE '%INSERT INTO "IdempotentOperation"%')::int AS "operationWaiters"
      FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND datname = current_database()
    `;
    if (waiters.accountWaiters === accountWaiters && waiters.operationWaiters === operationWaiters) break;
    await delay(15);
  } while (performance.now() < deadline);
  return waiters;
}

test.each([
  { sameKey: false, accountWaiters: 2, operationWaiters: 0, expectedBalance: 34, expectedCount: 2 },
  { sameKey: true, accountWaiters: 1, operationWaiters: 1, expectedBalance: 17, expectedCount: 1 },
])('首次並行加點的帳戶與冪等結果符合鎖定順序（相同 Key：$sameKey）', async ({
  sameKey, accountWaiters, operationWaiters, expectedBalance, expectedCount,
}) => {
  const cookie = await login('group_admin');
  const token = cookie.slice(cookie.indexOf('=') + 1);
  const auth = app.get(AuthService);
  const key = operationKey();
  const otherKey = sameKey ? key : operationKey();
  await db.$executeRaw`
    CREATE FUNCTION points_test_hold_account_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(602, 3);
      RETURN NEW;
    END;
    $$
  `;
  try {
    await db.$executeRaw`
      CREATE TRIGGER points_test_hold_account_insert BEFORE INSERT ON "PointAccount"
      FOR EACH ROW EXECUTE FUNCTION points_test_hold_account_insert()
    `;

    const lockReady = Promise.withResolvers();
    const releaseLock = Promise.withResolvers();
    const fixtureLock = db.$transaction(async (tx) => {
      // 在首次帳戶 INSERT 擋住寫入，讓不同 Key 都抵達帳戶，相同 Key 等待冪等唯一鍵。
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(602, 3)`;
      lockReady.resolve();
      await releaseLock.promise;
    });
    await Promise.race([lockReady.promise, fixtureLock]);
    const attempts = Promise.allSettled([key, otherKey].map((operation) => grantPoints(
      db, (tx) => auth.me(token, tx, true), { brandId, memberNumber }, operation, validGrant,
    )));
    let overlap;
    try {
      overlap = await waitForGrantOverlap(accountWaiters, operationWaiters);
    } finally {
      releaseLock.resolve();
      await fixtureLock;
      await attempts;
    }
    expect(overlap).toEqual({ accountWaiters, operationWaiters });
    const results = await attempts;
    expect(results.map(({ status }) => status)).toEqual(['fulfilled', 'fulfilled']);
    const [first, second] = results.map(({ value }) => value);
    if (sameKey) {
      expect(first).toEqual(second);
    } else {
      expect(new Set([first.balance, second.balance])).toEqual(new Set([17, 34]));
      expect(first.grantId).not.toBe(second.grantId);
      expect(first.operationId).not.toBe(second.operationId);
    }
    expect((await grant(cookie, key).expect(201)).body).toEqual(first);
    expect((await grant(cookie, otherKey).expect(201)).body).toEqual(second);
    expect(await db.pointAccount.count({ where: pointAccount() })).toBe(1);
    expect(await storedOperations()).toHaveLength(expectedCount);
    await assertBalance(expectedBalance, expectedCount);
  } finally {
    await db.$executeRaw`DROP TRIGGER IF EXISTS points_test_hold_account_insert ON "PointAccount"`;
    await db.$executeRaw`DROP FUNCTION points_test_hold_account_insert()`;
  }
});

test('延後到提交時的真資料庫故障回滾帳戶、流水與冪等紀錄，原 Key 可安全重試', async () => {
  const admin = await login('group_admin');
  const key = operationKey();
  const body = { ...validGrant, reason: '提交故障測試' };
  await db.$executeRaw`
    CREATE FUNCTION points_test_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW."reason" = '提交故障測試' THEN
        RAISE EXCEPTION 'test-only deferred ledger failure';
      END IF;
      RETURN NEW;
    END;
    $$
  `;
  try {
    // 延後約束在提交時才觸發，此時帳戶、流水及操作結果都已執行寫入。
    await db.$executeRaw`
      CREATE CONSTRAINT TRIGGER points_test_fail_commit AFTER INSERT ON "PointLedger"
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION points_test_fail_commit()
    `;
    expectError(await grant(admin, key, body).expect(503), 'SERVICE_UNAVAILABLE');
    expect(await db.pointAccount.count({ where: pointAccount() })).toBe(0);
    expect(await storedOperations()).toEqual([]);
    expect((await read(memberPath() + '/ledger', admin).expect(200)).body)
      .toEqual({ balance: 0, items: [], hasNext: false });
  } finally {
    await db.$executeRaw`DROP TRIGGER IF EXISTS points_test_fail_commit ON "PointLedger"`;
    await db.$executeRaw`DROP FUNCTION points_test_fail_commit()`;
  }
  const retried = await grant(admin, key, body).expect(201);
  expect(retried.body.balance).toBe(17);
  expect((await grant(admin, key, body).expect(201)).body).toEqual(retried.body);
  expect(await storedOperations()).toHaveLength(1);
  await assertBalance(17, 1);
});

async function observe(condition) {
  const deadline = performance.now() + 4000;
  do {
    if (await condition()) return true;
    await delay(15);
  } while (performance.now() < deadline);
  return false;
}

test('客戶端斷線後加點仍提交，稽核包含原請求且每次只記一筆', async () => {
  const cookie = await login('group_admin');
  const { id: accountId } = await db.account.findUniqueOrThrow({ where: { username: 'group_admin' } });
  const initial = await grant(cookie, operationKey()).expect(201);
  const key = operationKey();
  const lockReady = Promise.withResolvers();
  const releaseLock = Promise.withResolvers();
  const fixtureLock = db.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "balance" FROM "PointAccount" WHERE "brandId" = ${brandId}::uuid AND "memberId" = ${memberId}::uuid FOR UPDATE
    `;
    lockReady.resolve();
    await releaseLock.promise;
  });
  await Promise.race([lockReady.promise, fixtureLock]);
  const server = app.getHttpServer();
  const connectionClosed = Promise.withResolvers();
  // 由伺服器端確認連線已關閉且尚未送完回應，才釋放寫入等待的帳戶鎖。
  const onRequest = (_request, response) => {
    response.once('close', () => connectionClosed.resolve({
      traceId: response.getHeader('X-Trace-Id'), finished: response.writableFinished,
    }));
  };
  server.prependOnceListener('request', onRequest);
  const body = JSON.stringify(validGrant);
  const client = sendHttp({
    hostname: '127.0.0.1', port: server.address().port, method: 'POST', path: memberPath() + '/grants',
    headers: {
      ...headers, Cookie: cookie, 'Idempotency-Key': key, 'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, (response) => response.resume());
  client.on('error', () => {});
  client.end(body);
  let interrupted;
  try {
    expect(await observe(async () => {
      const [row] = await db.$queryRaw`
        SELECT COUNT(*)::int AS count FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query LIKE '%SELECT "balance" FROM "PointAccount"%'
      `;
      return row.count === 1;
    })).toBe(true);
    client.destroy();
    interrupted = await Promise.race([connectionClosed.promise, delay(3000, null, { ref: false })]);
    expect(interrupted).toEqual({ traceId: expect.stringMatching(uuid), finished: false });
  } finally {
    client.destroy();
    server.removeListener('request', onRequest);
    releaseLock.resolve();
    await fixtureLock;
  }

  const audit = (traceId) => logs.mock.calls.map(([line]) => JSON.parse(line)).filter((entry) => entry.traceId === traceId);
  expect(await observe(() => audit(interrupted.traceId).length > 0)).toBe(true);
  expect(audit(interrupted.traceId)).toEqual([{
    traceId: interrupted.traceId, operation: 'grantPoints', status: 201, accountId, brandId,
  }]);
  const operation = await db.idempotentOperation.findUniqueOrThrow({ where: { actorId_key: { actorId: accountId, key } } });
  const replay = await grant(cookie, key).expect(201);
  expect(replay.body).toEqual(operation.result);
  expect(replay.body.balance).toBe(34);
  expect(audit(initial.headers['x-trace-id'])).toHaveLength(1);
  expect(audit(replay.headers['x-trace-id'])).toHaveLength(1);
  await assertBalance(34, 2);
});

test('讀完餘額後並行提交加點，同一流水回應維持舊快照，重新查詢取得新結果', async () => {
  const admin = await login('group_admin');
  const member = await login('demo_member');
  const ledgerPath = memberPath() + '/ledger';
  const token = admin.slice(admin.indexOf('=') + 1);
  const initial = await grant(admin, operationKey()).expect(201);
  const before = (await read(ledgerPath, admin).expect(200)).body;
  expect(before.balance).toBe(17);
  expect(before.items.map(({ id }) => id)).toEqual([initial.body.grantId]);

  const beforeLedgerRead = Promise.withResolvers();
  const resumeRead = Promise.withResolvers();
  const paused = db.$extends({ query: { pointLedger: {
    async findMany({ args, query }) {
      beforeLedgerRead.resolve(true);
      await resumeRead.promise;
      return query(args);
    },
  } } });
  const auth = app.get(AuthService);
  const inFlight = readPoints(paused, (tx) => auth.me(token, tx), { brandId, memberNumber }, () => ({ skip: 0, pageSize: 20 }));
  let added;
  try {
    // 舊查詢已讀取餘額並停在流水前，新加點從正常 HTTP 入口完成提交。
    expect(await Promise.race([beforeLedgerRead.promise, inFlight])).toBe(true);
    added = await grant(admin, operationKey()).expect(201);
  } finally {
    resumeRead.resolve();
    await inFlight;
  }
  expect(JSON.parse(JSON.stringify(await inFlight))).toEqual(before);
  const after = (await read(ledgerPath, admin).expect(200)).body;
  expect(after.balance).toBe(34);
  expect(new Set(after.items.map(({ id }) => id))).toEqual(new Set([added.body.grantId, initial.body.grantId]));
  expect((await read(pointsPath() + '/me/ledger', member).expect(200)).body).toEqual(after);
  await assertBalance(34, 2);
});

test('流水依時間及識別碼降冪分頁，各頁帶回同一品牌的已提交餘額', async () => {
  const member = await login('demo_member');
  const admin = await login('group_admin');
  const { id: actorId, displayName: actorDisplayName } = await db.account.findUniqueOrThrow({
    where: { username: 'group_admin' },
  });
  const fixtures = Array.from({ length: 101 }, () => ({
    ...pointAccount(), id: randomUUID(), amount: 1, source: 'GRANT', actorId,
    createdAt: new Date('2026-01-01T00:00:00Z'), reason: '分頁測試',
  })).sort((a, b) => b.id.localeCompare(a.id));
  const latest = fixtures.pop();
  latest.createdAt = new Date('2026-01-02T00:00:00Z');
  fixtures.unshift(latest);
  // 大量同時刻資料只作為排序 fixture，實際加點由其他公開操作測試驗證。
  await db.$transaction([
    db.pointAccount.create({ data: { ...pointAccount(), balance: fixtures.length } }),
    db.pointLedger.createMany({ data: fixtures }),
  ]);
  const items = fixtures.map(({ id, amount, reason, source, createdAt }) => ({
    id, amount, reason, source, createdAt: createdAt.toISOString(), actorDisplayName,
  }));
  const ledgerPath = pointsPath() + '/me/ledger';
  const memberLedgerPath = memberPath() + '/ledger';
  expect((await read(ledgerPath, member).expect(200)).body)
    .toEqual({ balance: 101, items: items.slice(0, 20), hasNext: true });
  expect((await read(ledgerPath + '?page=2', member).expect(200)).body)
    .toEqual({ balance: 101, items: items.slice(20, 40), hasNext: true });
  expect((await read(memberLedgerPath + '?pageSize=100', admin).expect(200)).body)
    .toEqual({ balance: 101, items: items.slice(0, 100), hasNext: true });
  expect((await read(memberLedgerPath + '?page=2&pageSize=100', admin).expect(200)).body)
    .toEqual({ balance: 101, items: items.slice(100), hasNext: false });
  expect((await read(ledgerPath + '?page=9007199254740991&pageSize=1', member).expect(200)).body)
    .toEqual({ balance: 101, items: [], hasNext: false });
  for (const query of ['?page=0', '?page=1&page=2', '?page=9007199254740991&pageSize=2', '?pageSize=101', '?pageSize=1.5']) {
    expectError(await read(ledgerPath + query, member).expect(400), 'INVALID_INPUT');
    expectError(await read(memberLedgerPath + query, admin).expect(400), 'INVALID_INPUT');
  }
  await assertBalance(101, 101);
});

test('示範種子保留單筆來源，重跑不覆寫既有加點、原結果或帳戶餘額', async () => {
  const admin = await login('group_admin');
  const member = await login('demo_member');
  const coffee = await db.brand.findUniqueOrThrow({ where: { seedKey: 'coffee' } });
  const dining = await db.brand.findUniqueOrThrow({ where: { seedKey: 'dining' } });
  const coffeeLedger = pointsPath(coffee.id) + '/me/ledger?pageSize=100';
  const diningPoints = pointsPath(dining.id) + '/me/points';
  const before = (await read(coffeeLedger, member).expect(200)).body;
  expect(before.items.filter(({ source }) => source === 'SEED')).toEqual([{
    id: expect.stringMatching(uuid), amount: 100, reason: '示範初始點數', source: 'SEED',
    createdAt: expect.any(String), actorDisplayName: '集團管理員',
  }]);
  expect(before.balance).toBe(before.items.reduce((sum, { amount }) => sum + amount, 0));
  const diningBefore = (await read(diningPoints, member).expect(200)).body;
  const key = operationKey();
  const existing = await grant(admin, key).expect(201);

  await Promise.all([runNode(process.execPath, ['dist/seed.js']), runNode(process.execPath, ['dist/seed.js'])]);

  expect((await read(coffeeLedger, member).expect(200)).body).toEqual(before);
  expect((await read(diningPoints, member).expect(200)).body).toEqual(diningBefore);
  expect((await grant(admin, key).expect(201)).body).toEqual(existing.body);
  await assertBalance(17, 1);
});
