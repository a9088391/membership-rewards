import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { promisify } from 'node:util';
import { jest } from '@jest/globals';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';

const target = URL.parse(process.env.DATABASE_URL ?? '');
if (process.env.MEMBERSHIP_TEST !== 'membership-rewards-test'
    || process.env.APP_ORIGIN !== 'http://membership-rewards-test.localhost:18442'
    || target?.host !== 'db:5432'
    || target?.pathname !== '/membership') {
  throw new Error('登入測試僅能在隔離的 membership-rewards-test Compose 專案執行');
}

const { createApp } = await import('../dist/app.js');
const { AuthService } = await import('../dist/auth.js');
const { createDatabase } = await import('../dist/database.js');
const origin = process.env.APP_ORIGIN;
const host = new URL(origin).host;
const username = () => randomUUID().replaceAll('-', '');
const password = '  測試會員密码🔐原樣保留  ';
const member = (overrides = {}) => ({
  username: username(),
  password,
  displayName: '  測試會員  ',
  ...overrides,
});
const headers = { Host: host, Origin: origin };
let app;
let http;
let db;
let logs;
let now;
const instant = Date.parse('2030-05-01T00:00:00.123Z');
const setTime = (offset = 0) => { now = new Date(instant + offset); };

async function startApp() {
  app = await createApp({ clock: () => now });
  await app.listen(0, '127.0.0.1');
  http = request(app.getHttpServer());
}

beforeAll(async () => {
  logs = jest.spyOn(console, 'info').mockImplementation(() => {});
  db = createDatabase();
  await startApp();
});

beforeEach(async () => {
  setTime();
  logs.mockClear();
  // 只清理隔離測試資料庫中本測試使用的 loopback 來源計數。
  await db.attemptWindow.deleteMany({
    where: { kind: { in: ['LOGIN_SOURCE', 'REGISTER_SOURCE'] }, key: '127.0.0.1' },
  });
});

afterAll(async () => {
  await app?.close();
  await db?.$disconnect();
  logs?.mockRestore();
});

const post = (operation, body) => http.post('/api/auth/' + operation).set(headers).send(body);
const get = (cookie) => http.get('/api/auth/me').set('Host', host).set('Cookie', cookie ?? '');
const session = (response) => response.headers['set-cookie'][0].split(';', 1)[0];
const token = (response) => session(response).slice('membership_rewards_session='.length);
const login = (input) => post('login', { username: input.username, password: input.password });
const runNode = promisify(execFile);
const wrongPassword = '測試錯誤密碼與帳號要同樣結果🔐';
const expectError = (response, code) => {
  expect(response.body).toEqual({
    code, message: expect.any(String), traceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    ...(response.status === 429 ? { retryAfterSeconds: expect.any(Number) } : {}),
  });
  expect(response.headers['x-trace-id']).toBe(response.body.traceId);
};

test('公開註冊只有會員角色，登入和查詢讀回相同身分', async () => {
  const input = member();
  const registered = await post('register', input).expect(201);
  expect(registered.body).toEqual({
    username: input.username,
    displayName: '測試會員',
    role: 'MEMBER',
    memberNumber: expect.stringMatching(/^[0-9a-f-]{36}$/),
  });
  expect(registered.headers['set-cookie']).toBeUndefined();
  await get().expect(401);
  const login = await post('login', { username: input.username, password }).expect(200);
  expect(login.body).toEqual(registered.body);
  expect(login.headers['cache-control']).toBe('private, no-store');
  const cookie = login.headers['set-cookie'][0];
  expect(/^membership_rewards_session=.*; Max-Age=1800; Path=\/; Expires=.*; HttpOnly; SameSite=Strict$/.test(cookie)).toBe(true);
  expect(/Domain=|Secure/.test(cookie)).toBe(false);
  const current = await get(session(login)).expect(200);
  expect(current.body).toEqual(login.body);
  expect(current.headers['cache-control']).toBe('private, no-store');
});

test.each([
  ['偽造角色', { role: 'GROUP_ADMIN' }],
  ['指定會員編號', { memberNumber: randomUUID() }],
  ['未知欄位', { other: true }],
  ['帳號型別', { username: 123 }],
  ['帳號太短', { username: 'ab' }],
  ['帳號太長', { username: 'a'.repeat(33) }],
  ['帳號含大寫', { username: 'Member' }],
  ['帳號前後空白', { username: ' member ' }],
  ['帳號含換行', { username: 'member\n' }],
  ['密碼型別', { password: ['wrong'] }],
  ['密碼太短', { password: '🔐'.repeat(11) }],
  ['密碼太長', { password: '🔐'.repeat(129) }],
  ['密碼含無效 Unicode', { password: '\ud800' + password }],
  ['名稱型別', { displayName: 1 }],
  ['名稱去空白後為空', { displayName: '　 ' }],
  ['名稱太長', { displayName: '測'.repeat(41) }],
  ['名稱含控制字元', { displayName: '測試\u0000會員' }],
  ['缺少必要欄位', { displayName: undefined }],
])('註冊拒絕%s', async (_description, overrides) => {
  const input = member(overrides);
  const invalid = await post('register', input).expect(400);
  expectError(invalid, 'INVALID_INPUT');
  if (typeof input.username === 'string') {
    expect(await db.account.count({ where: { username: input.username } })).toBe(0);
  }
});

test('接受 Unicode 長度上下界與 16 KiB JSON，拒絕超過一位元組', async () => {
  const input = member({ username: 'm_' + username().slice(0, 30), password: '🔐'.repeat(128), displayName: '𠮷'.repeat(40) });
  const json = JSON.stringify(input);
  const padded = json.padEnd(json.length + 16 * 1024 - Buffer.byteLength(json), ' ');
  expect(Buffer.byteLength(padded)).toBe(16384);
  await post('register', padded + ' ').type('application/json').expect(400);
  await post('register', padded).type('application/json').expect(201);
  await login(input).expect(200);
  const lower = member({ password: '🔐'.repeat(12), displayName: '𠮷' });
  await post('register', lower).expect(201);
  await login(lower).expect(200);
});

test('並行註冊保留唯一帳號，會員編號各自唯一', async () => {
  const input = member();
  const responses = await Promise.all([post('register', input), post('register', input)]);
  expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
  const duplicate = responses.find(({ status }) => status === 409);
  expectError(duplicate, 'USERNAME_TAKEN');
  const registered = responses.find(({ status }) => status === 201);
  const another = await post('register', member()).expect(201);
  expect(another.body.memberNumber).not.toBe(registered.body.memberNumber);
  await post('register', member({ username: 'group_admin' })).expect(409);
  await login(input).expect(200);
});

test('來源、Host 與轉送標頭先驗證，未通過的請求不占有效註冊配額', async () => {
  for (const input of [
    { Host: host },
    { Host: host, Origin: origin + '/' },
    { Host: 'localhost:18442', Origin: origin },
    { ...headers, Forwarded: 'for=127.0.0.1' },
    { ...headers, 'X-Forwarded-For': '127.0.0.1' },
    { ...headers, 'X-Forwarded-Host': host },
    { ...headers, 'X-Real-IP': '127.0.0.1' },
  ]) {
    await http.post('/api/auth/register').set(input).send(member()).expect(403);
  }
  await http.get('/api/auth/me').set({ Host: host, 'X-Forwarded-Proto': 'https' }).expect(403);
  await http.get('/api/unknown').set('Host', host).expect(404);

  for (let index = 0; index < 5; index++) {
    await post('register', member()).expect(201);
  }
  const limited = await post('register', member()).expect(429);
  expectError(limited, 'RATE_LIMITED');
});

test.each([['register', 5, '600'], ['login', 30, '60']])('%s 先計入來源限流，再檢查 Content-Type', async (operation, limit, wait) => {
  const send = (headers) => http.post('/api/auth/' + operation).set(headers).type('text/plain').send('text');
  await send({ Host: host }).expect(403);
  await send({ Host: 'localhost:18442', Origin: origin }).expect(403);
  await send({ ...headers, 'X-Forwarded-For': '127.0.0.1' }).expect(403);
  for (let index = 0; index < limit; index++) {
    expectError(await send(headers).expect(400), 'INVALID_INPUT');
  }
  await send({ Host: host }).expect(403);
  const limited = await send(headers).expect(429).expect('Retry-After', wait);
  expectError(limited, 'RATE_LIMITED');
  expect(limited.body.retryAfterSeconds).toBe(Number(wait));
  setTime(Number(wait) * 1000);
  await send(headers).expect(400);
});

test('註冊限流計入無效 JSON、超限內容與欄位錯誤，時間窗截止可再次送出', async () => {
  await post('register', '{"username":').type('application/json').expect(400);
  await post('register', ' '.repeat(16385)).type('application/json').expect(400);
  await post('register', []).expect(400);
  await post('register', member({ role: 'MEMBER' })).expect(400);
  await post('register', member({ displayName: '' })).expect(400);
  const input = member();
  const limited = await post('register', input).expect(429).expect('Retry-After', '600');
  expect(limited.body.retryAfterSeconds).toBe(600);
  setTime(599999);
  await post('register', input).expect(429).expect('Retry-After', '1');
  expect(await db.account.count({ where: { username: input.username } })).toBe(0);
  setTime(600000);
  await post('register', input).expect(201);
});

test('認證日誌以追蹤識別關聯結果與已確認帳號，排除憑證及原始請求', async () => {
  const first = member();
  const second = member();
  await post('register', first).expect(201);
  await post('register', second).expect(201);
  const wrong = await login({ ...first, password: wrongPassword }).expect(401);
  const missing = await login({ username: username(), password: wrongPassword }).expect(401);
  expectError(wrong, 'INVALID_CREDENTIALS');
  expectError(missing, 'INVALID_CREDENTIALS');
  expect(missing.body.message).toBe(wrong.body.message);
  expect(wrong.headers['set-cookie']).toBeUndefined();
  const auth = await login(first).expect(200);
  const current = await get(session(auth)).expect(200);
  const ended = await post('logout', {}).set('Cookie', session(auth)).expect(204);
  const revoked = await get(session(auth)).expect(401);
  const logoutFailed = await post('logout', {}).set('Cookie', session(auth)).expect(401);
  const saved = await db.account.findMany({
    where: { username: { in: [first.username, second.username] } },
    select: { id: true, username: true, passwordHash: true },
  });
  const [one, two] = saved.map(({ passwordHash }) => passwordHash);
  expect(/^scrypt:[a-f0-9]{32}:[a-f0-9]{64}$/.test(one)).toBe(true);
  expect(one === two).toBe(false);
  const records = logs.mock.calls.map(([entry]) => JSON.parse(entry));
  const accountId = saved.find((account) => account.username === first.username).id;
  expect(records).toContainEqual({ traceId: wrong.body.traceId, operation: 'login', status: 401 });
  expect(records).toContainEqual({ traceId: revoked.body.traceId, operation: 'me', status: 401 });
  expect(records).toContainEqual({ traceId: logoutFailed.body.traceId, operation: 'logout', status: 401 });
  for (const [response, operation, status] of [[auth, 'login', 200], [current, 'me', 200], [ended, 'logout', 204]]) {
    expect(records).toContainEqual({ traceId: response.headers['x-trace-id'], operation, status, accountId });
  }
  const recorded = JSON.stringify(records);
  for (const sensitive of [one, two, password, wrongPassword, token(auth), first.username, second.username]) {
    expect(recorded.includes(sensitive)).toBe(false);
  }
  const bodies = JSON.stringify([wrong.body, missing.body, auth.body, current.body, revoked.body, logoutFailed.body]);
  for (const sensitive of [accountId, one, two, password, wrongPassword, token(auth)]) {
    expect(bodies.includes(sensitive)).toBe(false);
  }
});

test('JWT 只從指定 Cookie 讀取並逐次驗證工作階段、簽章、欄位與資料庫角色', async () => {
  const input = member();
  await post('register', input).expect(201);
  const auth = await login(input).expect(200);
  const cookie = session(auth);
  await http.get('/api/auth/me').set({ Host: host, Authorization: 'Bearer ' + token(auth) }).expect(401);
  await get(cookie + '; ' + cookie).expect(401);
  await get(cookie + 'x').expect(401);
  await get('another_project_session=' + token(auth)).expect(401);
  const signer = new JwtService({ secret: Buffer.from(await readFile('/run/membership-app/jwt-key', 'utf8'), 'hex') });
  const signed = signer.decode(token(auth));
  const base = { ...signed, role: 'GROUP_ADMIN' };
  for (const [overrides, algorithm] of [
    [{ iss: 'other-project' }, 'HS256'],
    [{ aud: 'other-app' }, 'HS256'],
    [{ exp: undefined }, 'HS256'],
    [{ iat: undefined }, 'HS256'],
    [{ jti: undefined }, 'HS256'],
    [{ jti: randomUUID() }, 'HS256'],
    [{ sub: randomUUID() }, 'HS256'],
    [{}, 'HS384'],
  ]) {
    const claims = { ...base, ...overrides };
    for (const field of Object.keys(claims)) {
      if (claims[field] === undefined) delete claims[field];
    }
    const altered = signer.sign(claims, { algorithm, ...(overrides.iat === undefined && 'iat' in overrides ? { noTimestamp: true } : {}) });
    await get('membership_rewards_session=' + altered).expect(401);
  }
  const forgedRole = 'membership_rewards_session=' + signer.sign(base, { algorithm: 'HS256' });
  const sameMember = await get(forgedRole).expect(200);
  expect(sameMember.body.role).toBe('MEMBER');

  await db.account.update({ where: { username: input.username }, data: { role: 'BRAND_ADMIN', memberNumber: null } });
  const updated = await get(cookie).expect(200);
  expect(updated.body).toEqual({ username: input.username, displayName: '測試會員', role: 'BRAND_ADMIN', memberNumber: null });
});

test('工作階段到期前一毫秒仍可讀取，等於及超過期限立即拒絕且不續期', async () => {
  const input = member();
  await post('register', input).expect(201);
  const auth = await login(input).expect(200);
  const cookie = session(auth);
  setTime(1799999);
  const active = await get(cookie).expect(200);
  expect(active.headers['set-cookie']).toBeUndefined();
  setTime(1800000);
  expectError(await get(cookie).expect(401), 'UNAUTHENTICATED');
  setTime(1800001);
  await get(cookie).expect(401);
  await post('logout', {}).set('Cookie', cookie).expect(401);
});

test('登出持久撤銷單一工作階段，重新建立服務後仍拒絕舊 Cookie', async () => {
  const input = member();
  const other = member();
  await post('register', input).expect(201);
  await post('register', other).expect(201);
  const first = session(await login(input).expect(200));
  const second = session(await login(other).expect(200));
  await post('logout', {}).expect(401);
  await post('logout', { username: other.username }).set('Cookie', first).expect(400);
  const revoked = await post('logout', {}).set('Cookie', first).expect(204);
  expect(revoked.text).toBe('');
  expect(/^membership_rewards_session=; Path=\/; Expires=.*; HttpOnly; SameSite=Strict$/.test(revoked.headers['set-cookie'][0])).toBe(true);
  await get(first).expect(401);
  await app.close();
  await startApp();
  await get(first).expect(401);
  const otherSession = await get(second).expect(200);
  expect(otherSession.body.username).toBe(other.username);
  expect(otherSession.headers['cache-control']).toBe('private, no-store');
});

test('仍有效的 Cookie 拒絕切換帳號，登出後可登入不同帳號', async () => {
  const first = member();
  const second = member();
  await post('register', first).expect(201);
  await post('register', second).expect(201);
  const cookie = session(await login(first).expect(200));
  const originalSession = await login(first).set('Cookie', cookie).expect(200);
  const currentCookie = session(originalSession);
  for (const input of [second, { ...second, password: wrongPassword }, { ...second, username: username() }]) {
    const rejected = await login(input).set('Cookie', currentCookie).expect(409);
    expectError(rejected, 'ACCOUNT_SWITCH_REQUIRES_LOGOUT');
    expect(rejected.headers['set-cookie']).toBeUndefined();
  }
  const other = await db.account.findUniqueOrThrow({ where: { username: second.username }, select: { id: true } });
  expect(await db.session.count({ where: { accountId: other.id } })).toBe(0);
  expect(await db.attemptWindow.count({ where: { kind: 'LOGIN_ACCOUNT', key: second.username } })).toBe(0);
  expect((await get(currentCookie).expect(200)).body).toEqual(originalSession.body);
  await post('logout', {}).set('Cookie', currentCookie).expect(204);
  await get(currentCookie).expect(401);
  const switched = await login(second).set('Cookie', currentCookie).expect(200);
  expect((await get(session(switched)).expect(200)).body.username).toBe(second.username);

  const invalid = 'membership_rewards_session=invalid';
  await login(second).set('Cookie', invalid).expect(200);
  setTime(1800000);
  await login(second).set('Cookie', cookie).expect(200);
});

test('健康檢查必須同時通過 HTTP listener 及應用程式的資料庫驗證', async () => {
  const port = String(app.getHttpServer().address().port);
  const health = (env) => runNode(process.execPath, ['healthcheck.mjs'], {
    env: { ...process.env, PORT: port, ...env },
  });
  await expect(health({})).resolves.toEqual({ stdout: '', stderr: '' });
  const rejected = new URL(target);
  rejected.username = 'membership_test_unknown_role';
  await expect(health({ DATABASE_URL: rejected.href })).rejects.toMatchObject({ code: 1, stdout: '', stderr: '' });
  await expect(health({ PORT: '0' })).rejects.toMatchObject({ code: 1, stdout: '', stderr: '' });
});

test('每帳號只記錄失敗，滾動窗分別到期且成功登入不清空失敗計數', async () => {
  const input = member();
  const bad = { ...input, password: wrongPassword };
  await post('register', input).expect(201);
  for (let index = 0; index < 3; index++) await login(bad).expect(401);
  setTime(30000);
  await login(input).expect(200);
  await login(bad).expect(401);
  await login(bad).expect(401);

  setTime(599999);
  const limited = await login(input).expect(429).expect('Retry-After', '1');
  expectError(limited, 'RATE_LIMITED');
  expect(limited.body.retryAfterSeconds).toBe(1);

  setTime(600000);
  await login(input).expect(200);
  for (let index = 0; index < 3; index++) await login(bad).expect(401);
  await login(input).expect(429).expect('Retry-After', '30');
});

test('並行登入在真實資料庫鎖競爭中最多登記五次帳號失敗', async () => {
  const account = username();
  await db.attemptWindow.create({ data: { kind: 'LOGIN_ACCOUNT', key: account, attempted: [] } });
  const service = app.get(AuthService);
  const lockReady = Promise.withResolvers();
  const releaseLock = Promise.withResolvers();
  const fixtureLock = db.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "key" FROM "AttemptWindow" WHERE "kind" = 'LOGIN_ACCOUNT' AND "key" = ${account} FOR UPDATE
    `;
    lockReady.resolve();
    await releaseLock.promise;
  });
  await Promise.race([lockReady.promise, fixtureLock]);
  const requests = Promise.allSettled(Array.from({ length: 8 }, () => service.login({ username: account, password })));
  let waiting = 0;
  try {
    const deadline = performance.now() + 4000;
    while (waiting < 2 && performance.now() < deadline) {
      const [result] = await db.$queryRaw`
        SELECT COUNT(*)::int AS count FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query LIKE '%"AttemptWindow"%'
      `;
      waiting = result.count;
      await setImmediate();
    }
    setTime(200);
  } finally {
    releaseLock.resolve();
    await fixtureLock;
    await requests;
  }
  expect(waiting).toBeGreaterThanOrEqual(2);
  const outcomes = (await requests).map((result) => result.reason?.code);
  expect(outcomes.filter((code) => code === 'INVALID_CREDENTIALS')).toHaveLength(5);
  expect(outcomes.filter((code) => code === 'RATE_LIMITED')).toHaveLength(3);
  setTime(600199);
  await login({ username: account, password }).expect(429).expect('Retry-After', '1');
  setTime(600200);
  await login({ username: account, password }).expect(401);
});

test('來源登入窗含帳號限流與無效 JSON，並行最多受理三十次且重新啟動保留配額', async () => {
  const input = { username: username(), password: wrongPassword };
  for (let index = 0; index < 5; index++) await login(input).expect(401);
  await login(input).expect(429).expect('Retry-After', '600');
  await post('login', ' '.repeat(16385)).type('application/json').expect(400);
  const results = await Promise.all(Array.from({ length: 25 }, () =>
    post('login', '{"username":').type('application/json'),
  ));
  expect(results.filter(({ status }) => status === 400)).toHaveLength(23);
  const refused = results.filter(({ status }) => status === 429);
  expect(refused).toHaveLength(2);
  for (const result of refused) {
    expectError(result, 'RATE_LIMITED');
    expect(result.headers['retry-after']).toBe('60');
    expect(result.body.retryAfterSeconds).toBe(60);
  }

  await app.close();
  await startApp();
  setTime(59999);
  await login({ username: username(), password }).expect(429).expect('Retry-After', '1');
  setTime(60000);
  await login({ username: username(), password }).expect(401);
  await login(input).expect(429).expect('Retry-After', '540');
});

test('資料庫寫入中途故障不發 Cookie 或留下工作階段，解除故障可重試', async () => {
  const input = member();
  await post('register', input).expect(201);
  const account = await db.account.findUniqueOrThrow({ where: { username: input.username } });
  const diagnostic = 'isolated-session-fixture-sql-detail';
  await db.$executeRaw`
    CREATE OR REPLACE FUNCTION membership_test_reject_session() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'isolated-session-fixture-sql-detail';
      END; $$
  `;
  try {
    await db.$executeRaw`
      CREATE TRIGGER membership_test_reject_session BEFORE INSERT ON "Session"
      FOR EACH ROW EXECUTE FUNCTION membership_test_reject_session()
    `;
    const failed = await login(input).expect(503);
    expectError(failed, 'SERVICE_UNAVAILABLE');
    expect(failed.headers['set-cookie']).toBeUndefined();
    expect(await db.session.count({ where: { accountId: account.id } })).toBe(0);
    const records = logs.mock.calls.map(([entry]) => JSON.parse(entry));
    expect(records).toContainEqual({ traceId: failed.body.traceId, operation: 'login', status: 503 });
    expect(JSON.stringify({ records, response: failed.body }).includes(diagnostic)).toBe(false);
  } finally {
    await db.$executeRaw`DROP TRIGGER IF EXISTS membership_test_reject_session ON "Session"`;
    await db.$executeRaw`DROP FUNCTION membership_test_reject_session()`;
  }

  const recovered = await login(input).expect(200);
  const identity = await get(session(recovered)).expect(200);
  expect(identity.body.username).toBe(input.username);
  expect(await db.session.count({ where: { accountId: account.id } })).toBe(1);
});

test('示範帳號全部能登入，seed 重跑保留現有帳號、密碼、角色與撤銷狀態', async () => {
  const passwords = JSON.parse(await readFile('/run/membership-app/demo-passwords.json', 'utf8'));
  for (const [username, role] of [
    ['demo_member', 'MEMBER'],
    ['group_admin', 'GROUP_ADMIN'],
    ['brand_admin_a', 'BRAND_ADMIN'],
    ['brand_admin_b', 'BRAND_ADMIN'],
  ]) {
    const auth = await login({ username, password: passwords[username] }).expect(200);
    const current = await get(session(auth)).expect(200);
    expect(current.body).toEqual(auth.body);
    expect(auth.body).toEqual({ username, role, displayName: expect.any(String),
      memberNumber: role === 'MEMBER' ? expect.any(String) : null });
  }

  const input = member();
  await post('register', input).expect(201);
  const auth = await login(input).expect(200);
  const revoked = session(auth);
  await post('logout', {}).set('Cookie', revoked).expect(204);
  const original = await db.account.findUniqueOrThrow({ where: { username: 'brand_admin_b' } });
  const { passwordHash } = await db.account.findUniqueOrThrow({ where: { username: input.username } });
  await db.account.update({
    where: { id: original.id },
    data: { passwordHash, role: 'GROUP_ADMIN', displayName: '已變更的示範帳號' },
  });
  try {
    await runNode(process.execPath, ['dist/seed.js']);
    const retained = await login({ username: original.username, password: input.password }).expect(200);
    expect(retained.body).toEqual({
      username: original.username, displayName: '已變更的示範帳號', role: 'GROUP_ADMIN', memberNumber: null,
    });
    await login({ username: original.username, password: passwords[original.username] }).expect(401);
    await login(input).expect(200);
    await get(revoked).expect(401);
  } finally {
    await db.account.update({
      where: { id: original.id },
      data: { passwordHash: original.passwordHash, role: original.role, displayName: original.displayName },
    });
  }
});
