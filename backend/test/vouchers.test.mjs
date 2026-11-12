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
  throw new Error('持有券測試僅能在隔離的 membership-rewards-test Compose 專案執行');
}

const { createApp } = await import('../dist/app.js');
const { createDatabase } = await import('../dist/database.js');
const { AuthService } = await import('../dist/auth.js');
const { stopOffer } = await import('../dist/offers.js');
const { exchangeOffer, readVouchers } = await import('../dist/vouchers.js');
const headers = { Host: new URL(origin).host, Origin: origin };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const terms = {
  name: '新品折扣', description: '第二件半價', points: 80,
  startsAt: '2030-07-01T00:01:00.000Z', endsAt: '2030-07-01T00:02:00.000Z',
};
const fixtureBrands = [];
const fixtureKeys = [];
const fixtureMembers = [];
let app;
let db;
let http;
let logs;
let now;
let passwords;
let member;
let admin;
let memberNumber;
let memberId;
let brandId;

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
  now = new Date(terms.startsAt);
  logs.mockClear();
  await db.attemptWindow.deleteMany({ where: { kind: 'LOGIN_SOURCE', key: '127.0.0.1' } });
  brandId = await createBrand();
  admin = await login('group_admin');
  member = await login('demo_member');
});

afterEach(async () => {
  const where = { brandId: { in: fixtureBrands } };
  // 只清除本案例建立的方案、帳務、授權及操作紀錄。
  await db.$transaction([
    db.voucher.deleteMany({ where }),
    db.pointLedger.deleteMany({ where }),
    db.pointAccount.deleteMany({ where }),
    db.couponOffer.deleteMany({ where }),
    db.brandAdminGrant.deleteMany({ where }),
    db.idempotentOperation.deleteMany({ where: { key: { in: fixtureKeys } } }),
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

async function createBrand() {
  const id = randomUUID();
  await db.brand.create({ data: { id, name: '持有券隔離測試' } });
  fixtureBrands.push(id);
  return id;
}

async function login(username, password = passwords[username]) {
  const response = await post('/api/auth/login').send({ username, password }).expect(200);
  return response.headers['set-cookie'][0].split(';', 1)[0];
}

async function registerMember() {
  const username = randomUUID().replaceAll('-', '');
  const password = '兌換測試會員密碼僅供測試';
  await db.attemptWindow.deleteMany({ where: { kind: 'REGISTER_SOURCE', key: '127.0.0.1' } });
  const registered = await post('/api/auth/register').send({ username, password, displayName: '持有券測試會員' }).expect(201);
  const { id } = await db.account.findUniqueOrThrow({ where: { username }, select: { id: true } });
  fixtureMembers.push(id);
  return { id, number: registered.body.memberNumber, cookie: await login(username, password) };
}

function operationKey() {
  const key = randomUUID();
  fixtureKeys.push(key);
  return key;
}

const brandPath = (brand = brandId) => '/api/brands/' + brand;
const memberPath = (brand = brandId, number = memberNumber) => brandPath(brand) + '/members/' + number;
const exchangePath = (offerId, brand = brandId) => brandPath(brand) + '/offers/' + offerId + '/exchanges';
const ownVouchers = (brand = brandId) => '/api/me/vouchers?brandId=' + brand;
const memberVouchers = (brand = brandId, number = memberNumber) => memberPath(brand, number) + '/vouchers';
const read = (path, cookie = member) => http.get(path).set('Host', headers.Host).set('Cookie', cookie ?? '');
const post = (path, cookie) => http.post(path).set(headers).set('Cookie', cookie ?? '').type('application/json');
const exchange = (offerId, key = operationKey(), cookie = member, brand = brandId) =>
  post(exchangePath(offerId, brand), cookie).set('Idempotency-Key', key);

async function createOffer(brand = brandId, body = terms) {
  return (await post(brandPath(brand) + '/offers', admin).send(body).expect(201)).body.id;
}

async function grant(points, brand = brandId, number = memberNumber) {
  return (await post(memberPath(brand, number) + '/grants', admin).set('Idempotency-Key', operationKey())
    .send({ points, reason: '測試加點' }).expect(201)).body;
}

test('會員用同品牌點數兌換，從 HTTP 讀回扣點及持有券', async () => {
  const offerId = await createOffer();
  await grant(100);

  const purchased = await exchange(offerId).send({}).expect(201);
  expect(purchased.body).toEqual({
    operationId: expect.stringMatching(uuid), voucherId: expect.stringMatching(uuid), balance: 20,
  });
  expect(purchased.headers['cache-control']).toBe('private, no-store');
  expect((await read(brandPath() + '/me/points').expect(200)).body).toEqual({ balance: 20 });
  expect((await read(brandPath() + '/me/ledger').expect(200)).body).toEqual({
    balance: 20,
    hasNext: false,
    items: expect.arrayContaining([
      expect.objectContaining({ amount: -80, source: 'EXCHANGE', reason: null, actorDisplayName: '示範會員' }),
      expect.objectContaining({ amount: 100, source: 'GRANT', reason: '測試加點' }),
    ]),
  });
  expect((await read('/api/me/vouchers?brandId=' + brandId).expect(200)).body).toEqual({
    hasNext: false,
    items: [{
      ...terms, id: purchased.body.voucherId, brandId, offerId, code: expect.stringMatching(uuid),
      createdAt: terms.startsAt, status: 'UNUSED',
    }],
  });
});

function expectError(response, code) {
  expect(response.body).toEqual({ code, message: expect.any(String), traceId: expect.stringMatching(uuid) });
  expect(response.headers['x-trace-id']).toBe(response.body.traceId);
  expect(response.headers['cache-control']).toBe('private, no-store');
}

async function expectExchangeState(balance, debits, voucherIds) {
  const ledger = (await read(brandPath() + '/me/ledger').expect(200)).body;
  const vouchers = (await read(ownVouchers()).expect(200)).body.items;
  expect(ledger.balance).toBe(balance);
  expect(ledger.items.filter(({ source }) => source === 'EXCHANGE').map(({ amount }) => amount)).toEqual(debits);
  expect(ledger.items.reduce((sum, { amount }) => sum + amount, 0)).toBe(balance);
  expect(vouchers.map(({ id }) => id).sort()).toEqual([...voucherIds].sort());
  const stored = await db.voucher.findMany({ where: { brandId, memberId }, include: { ledger: true } });
  expect(stored.map(({ id }) => id).sort()).toEqual([...voucherIds].sort());
  expect(stored.map(({ ledger }) => ledger.id).sort())
    .toEqual(ledger.items.filter(({ source }) => source === 'EXCHANGE').map(({ id }) => id).sort());
  for (const voucher of stored) {
    expect(voucher.ledger).toMatchObject({ brandId, memberId, actorId: memberId, source: 'EXCHANGE' });
    expect(voucher.ledger.createdAt).toEqual(voucher.createdAt);
  }
}

const voucherDebitConstraint = 'Voucher_brandId_memberId_ledgerId_fkey';
const debitVoucherConstraint = 'PointLedger_brandId_memberId_exchangeId_fkey';

async function expectPairingCommitRejection(change, constraint) {
  let writeCompleted = false;
  const attempt = db.$transaction(async (tx) => {
    await change(tx);
    writeCompleted = true;
  });
  // 提交階段的外鍵錯誤由 PostgreSQL 轉接器回傳，語句階段已成功。
  await expect(attempt).rejects.toMatchObject({
    name: 'DriverAdapterError',
    cause: { originalCode: '23503', constraint: { index: constraint } },
  });
  expect(writeCompleted).toBe(true);
}

test.each(['GRANT', 'SEED'])('交易提交時拒絕讓持有券指向 %s 流水', async (source) => {
  const offerId = await createOffer();
  let ledgerId;
  if (source === 'GRANT') {
    ({ grantId: ledgerId } = await grant(100));
  } else {
    // 在本案例的品牌建立種子加點，避免改動升級驗證用的原有種子資料。
    const account = { brandId, memberId };
    ledgerId = randomUUID();
    await db.$transaction(async (tx) => {
      const { accountId: actorId } = await authenticate(admin)(tx);
      await tx.pointAccount.create({ data: { ...account, balance: 100 } });
      await tx.pointLedger.create({ data: {
        ...account, id: ledgerId, actorId, source, amount: 100, reason: '測試種子點數',
      } });
    });
  }

  const id = randomUUID();
  await expectPairingCommitRejection((tx) => tx.voucher.create({
    data: { id, code: randomUUID(), brandId, memberId, offerId, ledgerId, createdAt: now },
  }), voucherDebitConstraint);
  expect(await db.voucher.findUnique({ where: { id } })).toBeNull();
  await expectExchangeState(100, [], []);
});

test('交易提交時拒絕沒有持有券的兌換扣點，並回滾已寫入的餘額與流水', async () => {
  await grant(100);
  const account = { brandId, memberId };
  const id = randomUUID();
  await expectPairingCommitRejection(async (tx) => {
    await tx.pointAccount.update({ where: { brandId_memberId: account }, data: { balance: 20 } });
    await tx.pointLedger.create({ data: {
      ...account, id, actorId: memberId, amount: -80, source: 'EXCHANGE', reason: null,
    } });
  }, debitVoucherConstraint);
  expect(await db.pointLedger.findUnique({ where: { id } })).toBeNull();
  await expectExchangeState(100, [], []);
});

test('已提交的持有券與兌換流水不能被單獨刪除、改連結或改為加點', async () => {
  const offerId = await createOffer();
  const { grantId } = await grant(100);
  const { voucherId } = (await exchange(offerId).send({}).expect(201)).body;
  const { ledgerId } = await db.voucher.findUniqueOrThrow({ where: { id: voucherId } });
  const voucher = { id: voucherId };
  const debit = { id: ledgerId };

  await expectPairingCommitRejection((tx) => tx.voucher.delete({ where: voucher }), debitVoucherConstraint);
  await expectPairingCommitRejection((tx) => tx.pointLedger.delete({ where: debit }), voucherDebitConstraint);
  // 改連結會同時留下孤立的扣點並指向加點，任一配對約束都可拒絕提交。
  await expectPairingCommitRejection(
    (tx) => tx.voucher.update({ where: voucher, data: { ledgerId: grantId } }),
    expect.stringMatching(new RegExp(`^(?:${voucherDebitConstraint}|${debitVoucherConstraint})$`)),
  );
  await expectPairingCommitRejection((tx) => tx.pointLedger.update({
    where: debit, data: { source: 'GRANT', reason: '測試改為加點', amount: 80 },
  }), voucherDebitConstraint);

  expect((await db.voucher.findUniqueOrThrow({ where: voucher })).ledgerId).toBe(ledgerId);
  await expectExchangeState(20, [-80], [voucherId]);
});

test('同方案能重複獨立兌換，分頁穩定且會員與管理員只讀得授權範圍', async () => {
  const otherBrand = await createBrand();
  const another = await registerMember();
  const offerId = await createOffer();
  const otherOfferId = await createOffer(otherBrand);
  const { id: brandAdminId } = await db.account.findUniqueOrThrow({ where: { username: 'brand_admin_a' } });
  const assignment = { accountId: brandAdminId, brandId };
  await db.brandAdminGrant.create({ data: assignment });
  const brandAdmin = await login('brand_admin_a');

  await grant(200);
  await grant(100, otherBrand);
  await grant(80, brandId, another.number);
  const first = (await exchange(offerId).send({}).expect(201)).body;
  const second = (await exchange(offerId).send({}).expect(201)).body;
  const other = (await exchange(otherOfferId, operationKey(), member, otherBrand).send({}).expect(201)).body;
  const anotherVoucher = (await exchange(offerId, operationKey(), another.cookie).send({}).expect(201)).body;
  expect(first.balance).toBe(120);
  expect(second.balance).toBe(40);
  expect(other.balance).toBe(20);
  expect(anotherVoucher.balance).toBe(0);
  await expectExchangeState(40, [-80, -80], [first.voucherId, second.voucherId]);

  const scoped = (await read(ownVouchers()).expect(200)).body;
  expect(scoped.items.map(({ id }) => id)).toEqual([first.voucherId, second.voucherId].sort().reverse());
  expect((await read(ownVouchers() + '&pageSize=1').expect(200)).body)
    .toEqual({ items: [scoped.items[0]], hasNext: true });
  expect((await read(ownVouchers() + '&pageSize=1&page=2').expect(200)).body)
    .toEqual({ items: [scoped.items[1]], hasNext: false });
  const own = (await read('/api/me/vouchers').expect(200)).body;
  expect(new Set(own.items.map(({ id }) => id))).toEqual(new Set([first.voucherId, second.voucherId, other.voucherId]));
  expect(new Set(own.items.map(({ code }) => code)).size).toBe(3);
  expect((await read('/api/me/vouchers', another.cookie).expect(200)).body.items.map(({ id }) => id))
    .toEqual([anotherVoucher.voucherId]);
  expect((await read(memberVouchers(brandId.toUpperCase(), memberNumber.toUpperCase()), brandAdmin).expect(200)).body)
    .toEqual(scoped);
  expect((await read(memberVouchers(otherBrand), admin).expect(200)).body.items.map(({ id }) => id))
    .toEqual([other.voucherId]);

  expectError(await read(memberVouchers(brandId, memberNumber.slice(0, 8)), brandAdmin).expect(404), 'NOT_FOUND');
  expectError(await read(memberVouchers(brandId, randomUUID()), brandAdmin).expect(404), 'NOT_FOUND');
  expectError(await read(memberVouchers(otherBrand), brandAdmin).expect(404), 'NOT_FOUND');
  expectError(await read(memberVouchers(), another.cookie).expect(403), 'FORBIDDEN');
  expectError(await read('/api/me/vouchers', admin).expect(403), 'FORBIDDEN');
  expectError(await read('/api/me/vouchers', '').expect(401), 'UNAUTHENTICATED');
  expectError(await read('/api/me/vouchers').set('X-Membership-Actor', 'group_admin').expect(403), 'FORBIDDEN');
  expectError(await read(ownVouchers() + '&brandId=' + otherBrand).expect(400), 'INVALID_INPUT');
  expectError(await read(ownVouchers() + '&pageSize=101').expect(400), 'INVALID_INPUT');

  await db.brandAdminGrant.delete({ where: { accountId_brandId: assignment } });
  expectError(await read(memberVouchers(), brandAdmin).expect(404), 'NOT_FOUND');
});

test('兌換拒絕非法 JSON、Key、身分、品牌或方案；格式錯誤及不可見資源不占用 Key', async () => {
  const offerId = await createOffer();
  const wrongBrand = await createBrand();
  const key = operationKey();
  const route = exchangePath(offerId);
  await grant(100);

  expectError(await post(route, member).send({}).expect(400), 'INVALID_INPUT');
  for (const invalidKey of ['invalid-key', key + ', ' + key]) {
    expectError(await exchange(offerId, invalidKey).send({}).expect(400), 'INVALID_INPUT');
  }
  expectError(await exchange(offerId, key).set('Content-Length', '0').expect(400), 'INVALID_INPUT');
  for (const body of ['[]', '{', '{ "memberId": "spoofed" }', '{ "points": 1 }', '{ "brandId": "spoofed" }',
    '{' + ' '.repeat(16 * 1024) + '}']) {
    expectError(await exchange(offerId, key).send(body).expect(400), 'INVALID_INPUT');
  }
  expectError(await exchange(offerId, key).type('text/plain').send('{}').expect(400), 'INVALID_INPUT');
  expectError(await exchange(offerId, key).unset('Origin').send({}).expect(403), 'INVALID_ORIGIN');
  expectError(await exchange(offerId, key, '').send({}).expect(401), 'UNAUTHENTICATED');
  expectError(await exchange(offerId, key, admin).send({}).expect(403), 'FORBIDDEN');
  expectError(await exchange(offerId, key).set('X-Membership-Actor', 'group_admin').send({}).expect(403), 'FORBIDDEN');
  expectError(await exchange(offerId, key, member, 'invalid-brand').send({}).expect(400), 'INVALID_INPUT');
  expectError(await exchange(offerId, key, member, randomUUID()).send({}).expect(404), 'NOT_FOUND');
  expectError(await exchange(offerId, key, member, wrongBrand).send({}).expect(404), 'NOT_FOUND');
  expectError(await exchange(randomUUID(), key).send({}).expect(404), 'NOT_FOUND');
  expectError(await exchange('invalid-offer', key).send({}).expect(404), 'NOT_FOUND');
  expect(await db.idempotentOperation.count({ where: { key } })).toBe(0);
  await expectExchangeState(100, [], []);

  const purchased = await exchange(offerId.toUpperCase(), key.toUpperCase(), member, brandId.toUpperCase()).send({}).expect(201);
  expect((await exchange(offerId, key).send({}).expect(201)).body).toEqual(purchased.body);
  expectError(await exchange(offerId, key).send({ memberId }).expect(400), 'INVALID_INPUT');
  expectError(await exchange(offerId, key, member, wrongBrand).send({}).expect(404), 'NOT_FOUND');
  expectError(await exchange(await createOffer(), key).send({}).expect(409), 'IDEMPOTENCY_CONFLICT');
  expectError(await exchange(await createOffer(wrongBrand), key, member, wrongBrand).send({}).expect(409), 'IDEMPOTENCY_CONFLICT');
  await expectExchangeState(20, [-80], [purchased.body.voucherId]);
});

test('同一操作者的 Key 跨端點唯一，權限變更及登出後無法回放', async () => {
  const actor = await registerMember();
  const offerId = await createOffer();
  await grant(100, brandId, actor.number);
  const key = operationKey();
  const purchased = (await exchange(offerId, key, actor.cookie).send({}).expect(201)).body;
  await db.account.update({ where: { id: actor.id }, data: { role: 'GROUP_ADMIN', memberNumber: null } });
  expectError(await exchange(offerId, key, actor.cookie).send({}).expect(403), 'FORBIDDEN');
  expectError(await post(memberPath() + '/grants', actor.cookie).set('Idempotency-Key', key)
    .send({ points: 80, reason: '跨端點的相同識別碼' }).expect(409), 'IDEMPOTENCY_CONFLICT');
  await db.account.update({ where: { id: actor.id }, data: { role: 'MEMBER', memberNumber: actor.number } });
  expect((await exchange(offerId, key, actor.cookie).send({}).expect(201)).body).toEqual(purchased);
  await post('/api/auth/logout', actor.cookie).send({}).expect(204);
  expectError(await exchange(offerId, key, actor.cookie).send({}).expect(401), 'UNAUTHENTICATED');
  expectError(await read(ownVouchers(), actor.cookie).expect(401), 'UNAUTHENTICATED');
  expect((await read(memberVouchers(brandId, actor.number), admin).expect(200)).body.items.map(({ id }) => id))
    .toEqual([purchased.voucherId]);
  await expectExchangeState(0, [], []);
});

test('餘額不足保存原拒絕，不建立帳戶或扣點；補點後須用新 Key', async () => {
  const offerId = await createOffer();
  const otherBrand = await createBrand();
  await grant(100, otherBrand);
  const key = operationKey();
  const declined = await exchange(offerId, key).send({}).expect(409);
  expectError(declined, 'INSUFFICIENT_POINTS');
  expect(await db.pointAccount.findUnique({ where: { brandId_memberId: { brandId, memberId } } })).toBeNull();
  await expectExchangeState(0, [], []);

  await grant(100);
  const replay = await exchange(offerId, key).send({}).expect(409);
  expectError(replay, 'INSUFFICIENT_POINTS');
  expect(replay.body.message).toBe(declined.body.message);
  expect(replay.body.traceId).not.toBe(declined.body.traceId);
  await expectExchangeState(100, [], []);
  const purchased = (await exchange(offerId).send({}).expect(201)).body;
  await expectExchangeState(20, [-80], [purchased.voucherId]);
  expect((await read(brandPath(otherBrand) + '/me/points').expect(200)).body).toEqual({ balance: 100 });
});

test('起始時刻允許、截止起拒絕，既有券即時到期且不退點，回放保留原結果', async () => {
  // 時鐘保持在工作階段簽發後，以晚一毫秒的方案起始時刻驗證前後邊界。
  const startsAt = new Date(Date.parse(terms.startsAt) + 1).toISOString();
  const offerId = await createOffer(brandId, { ...terms, startsAt });
  await grant(200);
  const earlyKey = operationKey();
  await expect(runExchange(offerId, earlyKey)).rejects.toMatchObject({ status: 409, code: 'OFFER_UNAVAILABLE' });
  await expectExchangeState(200, [], []);

  now = new Date(startsAt);
  expectError(await exchange(offerId, earlyKey).send({}).expect(409), 'OFFER_UNAVAILABLE');
  const key = operationKey();
  const first = await runExchange(offerId, key);
  expect(first.balance).toBe(120);
  now = new Date(Date.parse(terms.endsAt) - 1);
  const second = await runExchange(offerId);
  expect(second.balance).toBe(40);
  expect((await read(ownVouchers()).expect(200)).body.items.map(({ status }) => status)).toEqual(['UNUSED', 'UNUSED']);

  now = new Date(terms.endsAt);
  const expiredKey = operationKey();
  await expect(runExchange(offerId, expiredKey)).rejects.toMatchObject({ status: 409, code: 'OFFER_UNAVAILABLE' });
  expectError(await exchange(offerId, expiredKey).send({}).expect(409), 'OFFER_UNAVAILABLE');
  expect((await read(ownVouchers()).expect(200)).body.items.map(({ status }) => status)).toEqual(['EXPIRED', 'EXPIRED']);
  expect((await read(memberVouchers(), admin).expect(200)).body.items.map(({ status }) => status)).toEqual(['EXPIRED', 'EXPIRED']);
  expect((await exchange(offerId, key).send({}).expect(201)).body).toEqual(first);
  await expectExchangeState(40, [-80, -80], [first.voucherId, second.voucherId]);
});

async function holdLock(lock) {
  const ready = Promise.withResolvers();
  const release = Promise.withResolvers();
  const transaction = db.$transaction(async (tx) => {
    await lock(tx);
    ready.resolve();
    await release.promise;
  });
  await Promise.race([ready.promise, transaction]);
  return async () => {
    release.resolve();
    await transaction;
  };
}

const holdOffer = (id) => holdLock((tx) => tx.$queryRaw`
  SELECT "id" FROM "CouponOffer" WHERE "id" = ${id}::uuid FOR UPDATE
`);
const holdAccount = () => holdLock((tx) => tx.$queryRaw`
  SELECT "balance" FROM "PointAccount"
  WHERE "brandId" = ${brandId}::uuid AND "memberId" = ${memberId}::uuid FOR UPDATE
`);

async function waiters(pattern, count) {
  const deadline = performance.now() + 4000;
  do {
    const [row] = await db.$queryRaw`
      SELECT COUNT(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE ${pattern}
    `;
    if (row.count === count) return true;
    await delay(15);
  } while (performance.now() < deadline);
  return false;
}

const offerLock = '%FROM "CouponOffer"%FOR UPDATE%';
const accountLock = '%FROM "PointAccount"%FOR UPDATE%';
const keyLock = '%INSERT INTO "IdempotentOperation"%';

function authenticate(cookie, lock = false) {
  const auth = app.get(AuthService);
  const token = cookie.slice(cookie.indexOf('=') + 1);
  return (tx) => auth.me(token, tx, lock);
}

function runExchange(offerId, key = operationKey()) {
  return exchangeOffer(db, authenticate(member, true), { brandId, offerId }, key, {}, () => now);
}

test.each([1, 2, 3])('不同 Key 並行兌換各 80 點，餘額 100 只允許一筆成功（第 %i 輪）', async () => {
  const offerId = await createOffer();
  await grant(100);
  const release = await holdAccount();
  const keys = [operationKey(), operationKey()];
  const requests = Promise.allSettled(keys.map((key) => runExchange(offerId, key)));
  try {
    // 第一個兌換已持有方案鎖而等帳戶，第二個等待同方案，兩個操作確實同時執行。
    expect(await waiters(accountLock, 1)).toBe(true);
    expect(await waiters(offerLock, 1)).toBe(true);
  } finally {
    await release();
    await requests;
  }
  const results = await requests;
  expect(results.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
  const success = results.find(({ status }) => status === 'fulfilled').value;
  expect(success).toMatchObject({ balance: 20 });
  for (const [index, result] of results.entries()) {
    const replay = exchange(offerId, keys[index]).send({});
    if (result.status === 'fulfilled') {
      expect((await replay.expect(201)).body).toEqual(success);
    } else {
      expect(result.reason).toMatchObject({ status: 409, code: 'INSUFFICIENT_POINTS' });
      expectError(await replay.expect(409), 'INSUFFICIENT_POINTS');
    }
  }
  await expectExchangeState(20, [-80], [success.voucherId]);
});

test.each([false, true])('HTTP 並行兌換（相同 Key：%s）只產生一筆扣點及持有券', async (sameKey) => {
  const offerId = await createOffer();
  await grant(100);
  const release = await holdOffer(offerId);
  const key = operationKey();
  const requests = Promise.allSettled([
    exchange(offerId, key).send({}),
    exchange(offerId, sameKey ? key : operationKey()).send({}),
  ]);
  try {
    expect(await waiters(offerLock, sameKey ? 1 : 2)).toBe(true);
    if (sameKey) expect(await waiters(keyLock, 1)).toBe(true);
  } finally {
    await release();
    await requests;
  }
  const results = await requests;
  expect(results.map(({ status }) => status)).toEqual(['fulfilled', 'fulfilled']);
  const responses = results.map(({ value }) => value).sort((left, right) => left.status - right.status);
  const [first, second] = responses;
  expect(responses.map(({ status }) => status)).toEqual(sameKey ? [201, 201] : [201, 409]);
  if (sameKey) expect(second.body).toEqual(first.body);
  else expectError(second, 'INSUFFICIENT_POINTS');
  expect(first.body.balance).toBe(20);
  await expectExchangeState(20, [-80], [first.body.voucherId]);
});

test.each(['offer', 'account'])('等待 %s 鎖跨過截止，取得鎖後拒絕且沒有業務異動', async (resource) => {
  const offerId = await createOffer();
  await grant(100);
  const release = await (resource === 'offer' ? holdOffer(offerId) : holdAccount());
  const key = operationKey();
  const result = Promise.allSettled([runExchange(offerId, key)]);
  try {
    expect(await waiters(resource === 'offer' ? offerLock : accountLock, 1)).toBe(true);
    now = new Date(terms.endsAt);
  } finally {
    await release();
    await result;
  }
  expect(await result).toEqual([{
    status: 'rejected', reason: expect.objectContaining({ status: 409, code: 'OFFER_UNAVAILABLE' }),
  }]);
  expectError(await exchange(offerId, key).send({}).expect(409), 'OFFER_UNAVAILABLE');
  await expectExchangeState(100, [], []);
});

test.each([true, false])('停發與兌換競爭遵守方案鎖順序（停發在先：%s）', async (stopFirst) => {
  const offerId = await createOffer();
  await grant(200);
  const release = await (stopFirst ? holdOffer(offerId) : holdAccount());
  const stop = () => stopOffer(db, authenticate(admin, true), brandId, offerId, {}, () => now);
  const purchase = () => runExchange(offerId);
  const first = Promise.allSettled([stopFirst ? stop() : purchase()]);
  let second;
  try {
    // 停發先進入方案鎖等待佇列，或兌換先持有方案鎖並等待帳戶，再送出第二筆。
    expect(await waiters(stopFirst ? offerLock : accountLock, 1)).toBe(true);
    second = Promise.allSettled([stopFirst ? purchase() : stop()]);
    expect(await waiters(offerLock, stopFirst ? 2 : 1)).toBe(true);
  } finally {
    await release();
    await first;
    await second;
  }
  const [firstOutcome, secondOutcome] = [...await first, ...await second];
  const stopped = stopFirst ? firstOutcome : secondOutcome;
  const purchased = stopFirst ? secondOutcome : firstOutcome;
  if (stopped.status === 'rejected') throw stopped.reason;
  const stoppedView = { ...terms, id: offerId, status: 'STOPPED', stoppedAt: terms.startsAt };
  expect(stopped.value).toEqual({
    ...stoppedView, startsAt: new Date(terms.startsAt), endsAt: new Date(terms.endsAt), stoppedAt: now,
  });
  expect((await read(brandPath() + '/offers', admin).expect(200)).body).toEqual({
    items: [stoppedView], hasNext: false,
  });
  expectError(await exchange(offerId).send({}).expect(409), 'OFFER_UNAVAILABLE');
  if (stopFirst) {
    expect(purchased).toMatchObject({ status: 'rejected', reason: { status: 409, code: 'OFFER_UNAVAILABLE' } });
    await expectExchangeState(200, [], []);
  } else {
    if (purchased.status === 'rejected') throw purchased.reason;
    expect(purchased.value.balance).toBe(120);
    await expectExchangeState(120, [-80], [purchased.value.voucherId]);
    expect((await read(ownVouchers()).expect(200)).body.items).toEqual([{
      ...terms, id: purchased.value.voucherId, brandId, offerId, code: expect.stringMatching(uuid),
      createdAt: terms.startsAt, status: 'UNUSED',
    }]);
  }
});

test('提交時故障回滾扣點、流水、持有券與操作結果，移除故障後原 Key 可重試', async () => {
  const offerId = await createOffer();
  await grant(100);
  const key = operationKey();
  await db.$executeRaw`
    CREATE FUNCTION vouchers_test_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'test-only deferred voucher failure';
    END;
    $$
  `;
  try {
    // 延後約束在提交時觸發，四項寫入都已在該交易內執行。
    await db.$executeRaw`
      CREATE CONSTRAINT TRIGGER vouchers_test_fail_commit AFTER INSERT ON "Voucher"
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION vouchers_test_fail_commit()
    `;
    await expect(runExchange(offerId, key)).rejects.toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
    expect(await db.idempotentOperation.findUnique({ where: { actorId_key: { actorId: memberId, key } } })).toBeNull();
    await expectExchangeState(100, [], []);

    expectError(await exchange(offerId, key).send({}).expect(503), 'SERVICE_UNAVAILABLE');
    expect(await db.idempotentOperation.findUnique({ where: { actorId_key: { actorId: memberId, key } } })).toBeNull();
    await expectExchangeState(100, [], []);
  } finally {
    await db.$executeRaw`DROP TRIGGER IF EXISTS vouchers_test_fail_commit ON "Voucher"`;
    await db.$executeRaw`DROP FUNCTION vouchers_test_fail_commit()`;
  }
  const retried = (await exchange(offerId, key).send({}).expect(201)).body;
  expect((await exchange(offerId, key).send({}).expect(201)).body).toEqual(retried);
  await expectExchangeState(20, [-80], [retried.voucherId]);
});

test('已提交但回應在送出前中斷，原 Key 回放同一券且稽核不含券碼或登入憑證', async () => {
  const offerId = await createOffer();
  await grant(100);
  const key = operationKey();
  const server = app.getHttpServer();
  const closedBeforeSend = Promise.withResolvers();
  const loseResponse = (_request, response) => {
    // 等正常 HTTP 路徑取得已提交結果並嘗試送出 201，再關閉連線。
    response.end = function () {
      closedBeforeSend.resolve({
        status: this.statusCode, traceId: this.getHeader('X-Trace-Id'), headersSent: this.headersSent,
      });
      return this.destroy();
    };
  };
  server.prependOnceListener('request', loseResponse);
  try {
    await expect(exchange(offerId, key).send({})).rejects.toMatchObject({ code: 'ECONNRESET' });
  } finally {
    server.removeListener('request', loseResponse);
  }
  const interrupted = await Promise.race([closedBeforeSend.promise, delay(1000, null, { ref: false })]);
  expect(interrupted).toEqual({ status: 201, traceId: expect.stringMatching(uuid), headersSent: false });

  const vouchers = (await read(ownVouchers()).expect(200)).body.items;
  expect(vouchers).toHaveLength(1);
  const replay = (await exchange(offerId, key).send({}).expect(201)).body;
  expect(replay).toEqual({ operationId: expect.stringMatching(uuid), voucherId: vouchers[0].id, balance: 20 });
  expect(logs.mock.calls.map(([line]) => JSON.parse(line)).filter(({ traceId }) => traceId === interrupted.traceId)).toEqual([{
    traceId: interrupted.traceId, operation: 'exchangeOffer', status: 201, accountId: memberId, brandId, offerId,
  }]);
  await expectExchangeState(20, [-80], [replay.voucherId]);
});

test('持有券查詢與精確會員查核共用一致快照，並行提交後新查詢才看到新券', async () => {
  const offerId = await createOffer();
  await grant(200);
  const first = (await exchange(offerId).send({}).expect(201)).body;
  const before = (await read(memberVouchers(), admin).expect(200)).body;
  expect(before.items.map(({ id }) => id)).toEqual([first.voucherId]);

  const reachedList = Promise.withResolvers();
  const resumeRead = Promise.withResolvers();
  const paused = db.$extends({ query: { voucher: {
    async findMany({ args, query }) {
      reachedList.resolve(true);
      await resumeRead.promise;
      return query(args);
    },
  } } });
  const result = readVouchers(paused, authenticate(admin), { brandId, memberNumber }, () => ({ skip: 0, pageSize: 20 }), () => now);
  let second;
  try {
    // 讀取已完成授權與會員查核，在取券前暫停；另一連線用正常 HTTP 完成兌換。
    expect(await Promise.race([reachedList.promise, result])).toBe(true);
    second = (await exchange(offerId).send({}).expect(201)).body;
  } finally {
    resumeRead.resolve();
    await result;
  }
  expect(JSON.parse(JSON.stringify(await result))).toEqual(before);
  const after = (await read(memberVouchers(), admin).expect(200)).body;
  expect((await read(ownVouchers()).expect(200)).body).toEqual(after);
  await expectExchangeState(40, [-80, -80], [first.voucherId, second.voucherId]);
});
