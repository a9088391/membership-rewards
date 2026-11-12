import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request as sendHttp } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { jest } from '@jest/globals';
import request from 'supertest';

const origin = process.env.APP_ORIGIN;
const target = URL.parse(process.env.DATABASE_URL ?? '');
if (process.env.MEMBERSHIP_TEST !== 'membership-rewards-test'
    || origin !== 'http://membership-rewards-test.localhost:18442'
    || target?.host !== 'db:5432' || target.pathname !== '/membership') {
  throw new Error('優惠券方案測試僅能在隔離的 membership-rewards-test Compose 專案執行');
}

const { createApp } = await import('../dist/app.js');
const { createDatabase } = await import('../dist/database.js');
const host = new URL(origin).host;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const validOffer = {
  name: ' 新品折扣 ',
  description: ' 第二件半價，限量比較 1 < 2 > 0，A<B。 ',
  points: 2147483647,
  startsAt: '2030-07-01T08:00:00.125+08:00',
  endsAt: '2030-06-30T20:00:00.678-04:00',
};
let app;
let db;
let http;
let logs;
let now;
let clock;
let passwords;
let brandId;
const fixtureBrands = [];
const fixtureAccounts = [];

beforeAll(async () => {
  logs = jest.spyOn(console, 'info').mockImplementation(() => {});
  db = createDatabase();
  passwords = JSON.parse(await readFile('/run/membership-app/demo-passwords.json', 'utf8'));
  app = await createApp({ clock: () => clock() });
  await app.listen(0, '127.0.0.1');
  http = request(app.getHttpServer());
});

beforeEach(async () => {
  now = new Date('2030-07-01T00:00:00.000Z');
  clock = () => now;
  logs.mockClear();
  await db.attemptWindow.deleteMany({ where: { kind: 'LOGIN_SOURCE', key: '127.0.0.1' } });
  brandId = await createBrand();
});

afterEach(async () => {
  const where = { brandId: { in: fixtureBrands } };
  // 只清除本次測試建立的資料。
  await db.$transaction([
    db.couponOffer.deleteMany({ where }),
    db.brandAdminGrant.deleteMany({ where }),
    db.brand.deleteMany({ where: { id: { in: fixtureBrands } } }),
    db.session.deleteMany({ where: { accountId: { in: fixtureAccounts } } }),
    db.account.deleteMany({ where: { id: { in: fixtureAccounts } } }),
  ]);
  fixtureBrands.length = fixtureAccounts.length = 0;
});

afterAll(async () => {
  await app?.close();
  await db?.$disconnect();
  logs?.mockRestore();
});

async function createBrand() {
  const id = randomUUID();
  await db.brand.create({ data: { id, name: '優惠券方案隔離測試' } });
  fixtureBrands.push(id);
  return id;
}

async function login(username, password = passwords[username]) {
  const response = await http.post('/api/auth/login').set({ Host: host, Origin: origin })
    .send({ username, password }).expect(200);
  return response.headers['set-cookie'][0].split(';', 1)[0];
}

const offersPath = (id = brandId) => '/api/brands/' + id + '/offers';
const stopPath = (id, brand = brandId) => offersPath(brand) + '/' + id + '/stop';
const read = (cookie, path = offersPath()) => http.get(path).set('Host', host).set('Cookie', cookie ?? '');
const post = (cookie, path = offersPath()) => http.post(path)
  .set({ Host: host, Origin: origin, Cookie: cookie ?? '' }).type('application/json');

function expectError(response, code) {
  expect(response.body).toEqual({ code, message: expect.any(String), traceId: expect.stringMatching(uuid) });
  expect(response.headers['x-trace-id']).toBe(response.body.traceId);
  expect(response.headers['cache-control']).toBe('private, no-store');
}

test('建立即上架，保留 UTC 毫秒與起訖邊界，會員可讀回公開條件', async () => {
  const admin = await login('group_admin');
  const member = await login('demo_member');
  const created = await post(admin).send(validOffer).expect(201);
  expect(created.headers['cache-control']).toBe('private, no-store');
  const { id: accountId } = await db.account.findUniqueOrThrow({ where: { username: 'group_admin' } });
  expect(logs.mock.calls.map(([line]) => JSON.parse(line)).filter(({ traceId }) => traceId === created.headers['x-trace-id']))
    .toEqual([{ traceId: created.headers['x-trace-id'], operation: 'createOffer', status: 201, accountId, brandId,
      offerId: created.body.id }]);
  expect(created.body).toEqual({
    id: expect.stringMatching(uuid), name: '新品折扣', description: '第二件半價，限量比較 1 < 2 > 0，A<B。',
    points: 2147483647, startsAt: '2030-07-01T00:00:00.125Z', endsAt: '2030-07-01T00:00:00.678Z',
    stoppedAt: null, status: 'UPCOMING',
  });

  for (const [instant, status] of [
    ['2030-07-01T00:00:00.124Z', 'UPCOMING'],
    ['2030-07-01T00:00:00.125Z', 'ACTIVE'],
    ['2030-07-01T00:00:00.677Z', 'ACTIVE'],
    ['2030-07-01T00:00:00.678Z', 'EXPIRED'],
  ]) {
    now = new Date(instant);
    const page = await read(member).expect(200);
    expect(page.headers['cache-control']).toBe('private, no-store');
    expect(page.body).toEqual({ items: [{ ...created.body, status }], hasNext: false });
  }
  const active = await post(admin).send({ ...validOffer, endsAt: '2030-07-01T00:00:00.679Z' }).expect(201);
  expect(active.body.status).toBe('ACTIVE');
  expectError(await post(admin).send(validOffer).expect(400), 'INVALID_INPUT');
});

test.each([
  ['20300701T000000.125Z', '20300630T200000.678-0400', '2030-07-01T00:00:00.678Z'],
  ['20300701T080000,1250+0800', '20300701T0001Z', '2030-07-01T00:01:00.000Z'],
])('基本格式時刻 %s 以 UTC 毫秒保存，會員可讀回', async (startsAt, endsAt, expectedEnd) => {
  const admin = await login('group_admin');
  const member = await login('demo_member');
  const created = await post(admin).send({ ...validOffer, startsAt, endsAt }).expect(201);
  expect(created.body).toMatchObject({
    startsAt: '2030-07-01T00:00:00.125Z', endsAt: expectedEnd, status: 'UPCOMING',
  });
  expect((await read(member).expect(200)).body).toEqual({ items: [created.body], hasNext: false });
});

test('授權依目前角色及品牌，拒絕跨品牌、偽造及不受信任的請求', async () => {
  const { id: accountId } = await db.account.findUniqueOrThrow({ where: { username: 'brand_admin_a' } });
  const grant = { accountId, brandId };
  await db.brandAdminGrant.create({ data: grant });
  const member = await login('demo_member');
  const group = await login('group_admin');
  const admin = await login('brand_admin_a');
  const otherAdmin = await login('brand_admin_b');
  const otherBrand = await createBrand();
  const offer = (await post(admin, offersPath(brandId.toUpperCase())).send(validOffer).expect(201)).body;
  const stop = stopPath(offer.id);
  const missingBrand = randomUUID();
  const initial = { items: [offer], hasNext: false };
  expect((await read(member).expect(200)).body).toEqual(initial);
  expect((await read(admin).expect(200)).body).toEqual(initial);

  expectError(await read().expect(401), 'UNAUTHENTICATED');
  expectError(await post().send(validOffer).expect(401), 'UNAUTHENTICATED');
  expectError(await post(undefined, stop).send({}).expect(401), 'UNAUTHENTICATED');
  expectError(await post(member).send(validOffer).expect(403), 'FORBIDDEN');
  expectError(await post(member, stop).send({}).expect(403), 'FORBIDDEN');
  expectError(await post(member).set('X-Membership-Actor', 'group_admin').send(validOffer).expect(403), 'FORBIDDEN');
  expectError(await read(group).set('X-Membership-Actor', 'demo_member').expect(403), 'FORBIDDEN');
  expectError(await post(group, stop).set('X-Membership-Actor', 'demo_member').send({}).expect(403), 'FORBIDDEN');

  for (const inaccessible of [brandId, missingBrand, 'invalid-id']) {
    expectError(await read(otherAdmin, offersPath(inaccessible)).expect(404), 'NOT_FOUND');
    expectError(await post(otherAdmin, offersPath(inaccessible)).send(validOffer).expect(404), 'NOT_FOUND');
    expectError(await post(otherAdmin, stopPath(offer.id, inaccessible)).send({}).expect(404), 'NOT_FOUND');
  }
  for (const cookie of [group, member]) {
    expectError(await read(cookie, offersPath(missingBrand)).expect(404), 'NOT_FOUND');
  }
  expectError(await post(group, stopPath(offer.id, otherBrand)).send({}).expect(404), 'NOT_FOUND');
  expectError(await post(group, stopPath(randomUUID(), otherBrand)).send({}).expect(404), 'NOT_FOUND');
  expectError(await post(group, stopPath('invalid-id')).send({}).expect(404), 'NOT_FOUND');
  expectError(await post(group).unset('Origin').send(validOffer).expect(403), 'INVALID_ORIGIN');
  expectError(await post(group, stop).set('Origin', 'http://wrong.localhost').send({}).expect(403), 'INVALID_ORIGIN');
  expectError(await post(group).set('Host', 'wrong.localhost').send(validOffer).expect(403), 'UNTRUSTED_HOST');
  expectError(await post(group, stop).set('X-Forwarded-Host', host).send({}).expect(403), 'UNTRUSTED_HOST');
  expectError(await post(group).type('text/plain').send(JSON.stringify(validOffer)).expect(400), 'INVALID_INPUT');

  await db.brandAdminGrant.delete({ where: { accountId_brandId: grant } });
  expectError(await read(admin).expect(404), 'NOT_FOUND');
  expectError(await post(admin).send(validOffer).expect(404), 'NOT_FOUND');
  expectError(await post(admin, stop).send({}).expect(404), 'NOT_FOUND');
  expect((await read(group).expect(200)).body).toEqual(initial);
  expect(await db.couponOffer.count({ where: { brandId: { in: fixtureBrands } } })).toBe(1);
});

test('登入後角色變更立即生效，過期工作階段無法讀寫方案', async () => {
  const { passwordHash } = await db.account.findUniqueOrThrow({ where: { username: 'group_admin' } });
  const id = randomUUID();
  const username = id.replaceAll('-', '');
  await db.account.create({ data: { id, username, displayName: '測試管理員', passwordHash, role: 'GROUP_ADMIN' } });
  fixtureAccounts.push(id);
  const cookie = await login(username, passwords.group_admin);
  const offer = (await post(cookie).send(validOffer).expect(201)).body;
  await db.account.update({ where: { id }, data: { role: 'MEMBER', memberNumber: randomUUID() } });
  expectError(await post(cookie).send(validOffer).expect(403), 'FORBIDDEN');
  expectError(await post(cookie, stopPath(offer.id)).send({}).expect(403), 'FORBIDDEN');
  expect((await read(cookie).expect(200)).body.items).toEqual([offer]);

  now = new Date('2030-07-01T00:30:00.000Z');
  expectError(await read(cookie).expect(401), 'UNAUTHENTICATED');
  expectError(await post(cookie).send(validOffer).expect(401), 'UNAUTHENTICATED');
  expectError(await post(cookie, stopPath(offer.id)).send({}).expect(401), 'UNAUTHENTICATED');
  expect(await db.couponOffer.findMany({ where: { brandId }, select: { id: true, stoppedAt: true } }))
    .toEqual([{ id: offer.id, stoppedAt: null }]);
});

test('拒絕不精確點數、不合法時刻及非純文字內容，非法輸入不寫入方案', async () => {
  const admin = await login('group_admin');
  for (const [field, inputs] of Object.entries({
    name: ['', ' ', 1, '🙂'.repeat(81), '\t名稱', '名稱\u0085', '\uD800'],
    description: [
      '', ' ', false, '🙂'.repeat(501), '\n優惠', '優惠\r', '測\u0000試', '\uDFFF',
      '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<SVG/onload=alert(1)>', '<!-- 註解 -->',
      '<x.y onclick=alert(1)>優惠</x.y>',
    ],
    points: [0, -1, 0.5, '1', true, 2147483648],
    startsAt: [
      123, '2030-07-01', '2030-07-01T00:00:00', '2030-02-29T00:00:00Z', '2030-04-31T00:00:00Z',
      '2030-00-01T00:00:00Z', '2030-07-00T00:00:00Z', '2030-07-01T24:01:00Z', '2030-07-01T00:60:00Z',
      '2030-07-01T00:00:60Z', '2030-07-01T00:00:00+24:00', '2030-07-01T00:00:00-03:60',
      '2030-07-01T00:00:00.1251Z', '2030-07-01T00:00:00Z\n',
      '20300229T000000Z', '20300701T006000Z', '20300701T000000', '20300701T000000.1251Z',
      '20300701T000000+2460', '2030-07-01T000000Z', '20300701T00:00:00Z', '20300701T0000:00Z',
      '20300701T000000+08:00', '20300701T000000Z\n',
    ],
    endsAt: [
      '2030-07-01T00:00:01', '2030-07-01T00:00:00.125Z', '2030-07-01T00:00:00.124Z',
      '2030-07-01T00:00:00.6789Z', '2031-02-29T00:00:00Z',
      '20300701T000000.125Z', '20300701T000000.124Z', '20300701T000000.6789Z', '20310229T000000Z',
    ],
  })) {
    for (const value of inputs) {
      expectError(await post(admin).send({ ...validOffer, [field]: value }).expect(400), 'INVALID_INPUT');
    }
  }
  const { name, ...missingField } = validOffer;
  const priorEnd = { ...validOffer, startsAt: '2030-06-30T23:59:59Z', endsAt: '2030-07-01T00:00:00Z' };
  for (const input of [missingField, priorEnd, [], 'null', '{', { ...validOffer, brandId }, { ...validOffer, stoppedAt: null },
    { ...validOffer, description: 'x'.repeat(16 * 1024) }]) {
    expectError(await post(admin).send(input).expect(400), 'INVALID_INPUT');
  }
  const raw = JSON.stringify(validOffer);
  for (const value of ['1.00000000000000001', '2147483647.000000001', '100000000000000001e-17']) {
    expect(Number.isInteger(Number(value))).toBe(true);
    const body = raw.replace('2147483647', value);
    expect(body).toContain('"points":' + value);
    expectError(await post(admin).send(body).expect(400), 'INVALID_INPUT');
  }
  expect(await db.couponOffer.count({ where: { brandId } })).toBe(0);

  const exact = {
    ...validOffer, name: '🙂'.repeat(80), description: '語'.repeat(499) + '🙂',
    startsAt: '2028-02-29T02:03:04.1250+05:45', endsAt: '2030-07-01T00:01Z',
  };
  const accepted = await post(admin).send(JSON.stringify(exact).replace('2147483647', '214748364700e-2')).expect(201);
  expect(accepted.body).toMatchObject({
    name: exact.name, description: exact.description, points: 2147483647,
    startsAt: '2028-02-28T20:18:04.125Z', endsAt: '2030-07-01T00:01:00.000Z', status: 'ACTIVE',
  });
});

test('列表以建立時間及識別碼穩定分頁，僅回傳所屬品牌', async () => {
  const admin = await login('group_admin');
  const otherBrand = await createBrand();
  await post(admin, offersPath(otherBrand)).send(validOffer).expect(201);
  const created = [];
  for (let number = 1; number <= 21; number += 1) {
    created.push((await post(admin).send({ ...validOffer, name: '方案 ' + number }).expect(201)).body);
  }

  // 安排兩筆同毫秒建立，確認排序仍以唯一識別碼決定。
  const tiedIds = created.slice(0, 2).map(({ id }) => id);
  const rows = await db.couponOffer.findMany({ where: { brandId }, select: { id: true, createdAt: true } });
  const tiedTime = new Date(Math.max(...rows.map(({ createdAt }) => createdAt.getTime())) + 1);
  await db.couponOffer.updateMany({ where: { id: { in: tiedIds } }, data: { createdAt: tiedTime } });
  for (const row of rows) {
    if (tiedIds.includes(row.id)) row.createdAt = tiedTime;
  }
  const expectedOrder = rows.sort((left, right) =>
    right.createdAt - left.createdAt || (right.id > left.id ? 1 : -1)).map(({ id }) => id);
  const first = (await read(admin).expect(200)).body;
  const second = (await read(admin, offersPath() + '?page=2').expect(200)).body;
  expect(first.items).toHaveLength(20);
  expect(first.hasNext).toBe(true);
  expect(second.hasNext).toBe(false);
  expect([...first.items, ...second.items].map(({ id }) => id)).toEqual(expectedOrder);
  expect(expectedOrder.slice(0, 2)).toEqual(tiedIds.sort().reverse());
  expect((await read(admin, offersPath() + '?pageSize=100').expect(200)).body)
    .toEqual({ items: [...first.items, ...second.items], hasNext: false });
  expect((await read(admin, offersPath() + '?page=3').expect(200)).body).toEqual({ items: [], hasNext: false });
  for (const query of ['page=0', 'page=-1', 'page=1.5', 'page=1&page=2', 'pageSize=0', 'pageSize=101', 'page=9007199254740991']) {
    expectError(await read(admin, offersPath() + '?' + query).expect(400), 'INVALID_INPUT');
  }
});

async function holdLock(lock) {
  const ready = Promise.withResolvers();
  const release = Promise.withResolvers();
  const transaction = db.$transaction(async (tx) => {
    await lock(tx);
    ready.resolve();
    await release.promise;
  }, { timeout: 10000 });
  await Promise.race([ready.promise, transaction]);
  return async () => {
    release.resolve();
    await transaction;
  };
}

async function observe(condition) {
  const deadline = performance.now() + 4000;
  do {
    if (await condition()) return true;
    await delay(15);
  } while (performance.now() < deadline);
  return false;
}

async function waiters(pattern, count) {
  return observe(async () => {
    const [row] = await db.$queryRaw`
      SELECT COUNT(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE ${pattern}
    `;
    return row.count === count;
  });
}

const offerLockPattern = '%FROM "CouponOffer"%FOR UPDATE%';

function holdOffer(id) {
  return holdLock((tx) => tx.$queryRaw`
    SELECT "id" FROM "CouponOffer" WHERE "id" = ${id}::uuid FOR UPDATE
  `);
}

test('建立等待品牌授權鎖跨過截止，取得鎖後拒絕建立', async () => {
  const { id: accountId } = await db.account.findUniqueOrThrow({ where: { username: 'brand_admin_a' } });
  await db.brandAdminGrant.create({ data: { accountId, brandId } });
  const admin = await login('brand_admin_a');
  const release = await holdLock((tx) => tx.$queryRaw`
    SELECT "brandId" FROM "BrandAdminGrant"
    WHERE "accountId" = ${accountId}::uuid AND "brandId" = ${brandId}::uuid FOR UPDATE
  `);
  const pending = post(admin).send(validOffer).then((response) => response);
  try {
    expect(await waiters('%FROM "BrandAdminGrant"%FOR SHARE%', 1)).toBe(true);
    now = new Date('2030-07-01T00:00:00.678Z');
  } finally {
    await release();
    await pending;
  }
  const response = await pending;
  expect(response.status).toBe(400);
  expectError(response, 'INVALID_INPUT');
  expect(await db.couponOffer.count({ where: { brandId } })).toBe(0);
});

test('並行停發只保存一次停發時刻，重試與會員讀回保持原條件', async () => {
  const admin = await login('group_admin');
  const member = await login('demo_member');
  const created = await post(admin).send(validOffer).expect(201);
  const { id } = created.body;
  const stop = stopPath(id);
  expectError(await post(admin, stop).send({ name: '變更' }).expect(400), 'INVALID_INPUT');
  expectError(await post(admin, stop).send([]).expect(400), 'INVALID_INPUT');
  expect((await read(member).expect(200)).body.items).toEqual([created.body]);

  const release = await holdOffer(id);
  const attempts = Promise.allSettled([
    post(admin, stop).send({}),
    post(admin, stopPath(id.toUpperCase())).send({}),
  ]);
  try {
    // 兩個 HTTP 請求都抵達同一方案鎖後才釋放，確認不是依序發送。
    expect(await waiters(offerLockPattern, 2)).toBe(true);
    let milliseconds = Date.parse('2030-07-01T00:00:00.375Z');
    clock = () => new Date(milliseconds++);
  } finally {
    await release();
    await attempts;
  }
  const stopped = { ...created.body, stoppedAt: '2030-07-01T00:00:00.375Z', status: 'STOPPED' };
  for (const result of await attempts) {
    expect(result.status).toBe('fulfilled');
    expect(result.value.status).toBe(200);
    expect(result.value.body).toEqual(stopped);
  }
  now = new Date('2030-07-01T00:00:01Z');
  clock = () => now;
  expect((await post(admin, stop).send({}).expect(200)).body).toEqual(stopped);
  expectError(await http.patch(offersPath() + '/' + id).set({ Host: host, Origin: origin, Cookie: admin })
    .send({ name: '變更' }).expect(404), 'NOT_FOUND');
  expectError(await post(admin, offersPath() + '/' + id + '/reactivate').send({}).expect(404), 'NOT_FOUND');
  expect((await read(member).expect(200)).body).toEqual({ items: [stopped], hasNext: false });
  const persisted = await db.couponOffer.findUniqueOrThrow({ where: { id } });
  expect(persisted.stoppedAt.toISOString()).toBe(stopped.stoppedAt);
  expect(persisted.name).toBe(stopped.name);
});

test('停發回應中斷後仍提交，原請求只留一筆稽核結果', async () => {
  const admin = await login('group_admin');
  const { id: accountId } = await db.account.findUniqueOrThrow({ where: { username: 'group_admin' } });
  const created = (await post(admin).send(validOffer).expect(201)).body;
  const release = await holdOffer(created.id);
  const server = app.getHttpServer();
  const closed = Promise.withResolvers();
  const onRequest = (_request, response) => {
    response.once('close', () => closed.resolve({
      traceId: response.getHeader('X-Trace-Id'), finished: response.writableFinished,
    }));
  };
  server.prependOnceListener('request', onRequest);
  const client = sendHttp({
    hostname: '127.0.0.1', port: server.address().port, method: 'POST', path: stopPath(created.id),
    headers: { Host: host, Origin: origin, Cookie: admin, 'Content-Type': 'application/json', 'Content-Length': 2 },
  }, (response) => response.resume());
  client.on('error', () => {});
  client.end('{}');
  let interrupted;
  try {
    expect(await waiters(offerLockPattern, 1)).toBe(true);
    client.destroy();
    interrupted = await Promise.race([closed.promise, delay(3000, null, { ref: false })]);
    expect(interrupted).toEqual({ traceId: expect.stringMatching(uuid), finished: false });
  } finally {
    client.destroy();
    server.removeListener('request', onRequest);
    await release();
  }

  const audit = () => logs.mock.calls.map(([line]) => JSON.parse(line))
    .filter(({ traceId }) => traceId === interrupted.traceId);
  expect(await observe(() => audit().length > 0)).toBe(true);
  expect(audit()).toEqual([{
    traceId: interrupted.traceId, operation: 'stopOffer', status: 200, accountId, brandId, offerId: created.id,
  }]);
  const stopped = { ...created, status: 'STOPPED', stoppedAt: now.toISOString() };
  expect((await read(admin).expect(200)).body).toEqual({ items: [stopped], hasNext: false });
  expect((await post(admin, stopPath(created.id)).send({}).expect(200)).body).toEqual(stopped);
});
