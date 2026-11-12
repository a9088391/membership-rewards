import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { AttemptKind, Prisma, Role, type PrismaClient } from './generated/client.js';
import { hashPassword, matchesPassword } from './password.js';

const sessionSeconds = 30 * 60;
const jwtIdentity = { issuer: 'membership-rewards', audience: 'membership-rewards-web' };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const identityFields = { username: true, displayName: true, role: true, memberNumber: true } as const;

export const sessionCookie = 'membership_rewards_session';
export const sessionCookieOptions = { httpOnly: true, sameSite: 'strict', path: '/' } as const;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export const invalidInput = () => new ApiError(400, 'INVALID_INPUT', '輸入格式錯誤。');
const invalidLogin = () => new ApiError(401, 'INVALID_CREDENTIALS', '帳號或密碼錯誤。');
const unauthenticated = () => new ApiError(401, 'UNAUTHENTICATED', '請先登入。');

export function readBody(body: unknown, keys: string[]): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== keys.length || keys.some((key) => !Object.hasOwn(body, key))) {
    throw invalidInput();
  }
  return body as Record<string, unknown>;
}

function credentials(body: Record<string, unknown>) {
  const { username, password } = body;
  if (typeof username !== 'string' || !/^[a-z0-9_]{3,32}$/.test(username)
      || typeof password !== 'string' || !password.isWellFormed()) {
    throw invalidInput();
  }
  const length = [...password].length;
  if (length < 12 || length > 128) throw invalidInput();
  return { username, password };
}

type Transaction = Prisma.TransactionClient;

const limits = {
  [AttemptKind.LOGIN_SOURCE]: { limit: 30, windowMs: 60000 },
  [AttemptKind.LOGIN_ACCOUNT]: { limit: 5, windowMs: 600000 },
  [AttemptKind.REGISTER_SOURCE]: { limit: 5, windowMs: 600000 },
};

export class AuthService {
  private readonly jwt: JwtService;

  constructor(
    private readonly db: PrismaClient,
    key: Buffer,
    private readonly clock: () => Date,
  ) {
    this.jwt = new JwtService({ secret: key });
  }

  async onApplicationShutdown() {
    await this.db.$disconnect();
  }

  private async lockWindow(tx: Transaction, kind: AttemptKind, key: string) {
    // 每個時間窗只鎖一列，取鎖後才取時間並裁掉過期嘗試。
    await tx.$executeRaw`
      INSERT INTO "AttemptWindow" ("kind", "key", "attempted")
      VALUES (${kind}::"AttemptKind", ${key}, ARRAY[]::timestamptz[])
      ON CONFLICT ("kind", "key") DO NOTHING
    `;
    const [bucket] = await tx.$queryRaw<{ attempted: Date[] }[]>`
      SELECT "attempted" FROM "AttemptWindow"
      WHERE "kind" = ${kind}::"AttemptKind" AND "key" = ${key} FOR UPDATE
    `;
    const now = this.clock();
    const { limit, windowMs } = limits[kind];
    const recent = bucket.attempted.filter((at) => at.getTime() > now.getTime() - windowMs);
    if (recent.length >= limit) {
      const earliest = Math.min(...recent.map((at) => at.getTime()));
      const retryAfter = Math.ceil((earliest + windowMs - now.getTime()) / 1000);
      throw new ApiError(429, 'RATE_LIMITED', '嘗試次數過多，請稍後再試。', retryAfter);
    }
    return { now, recent };
  }

  async consumeSource(kind: 'LOGIN_SOURCE' | 'REGISTER_SOURCE', source: string) {
    await this.db.$transaction(async (tx) => {
      const { now, recent } = await this.lockWindow(tx, kind, source);
      await tx.attemptWindow.update({
        where: { kind_key: { kind, key: source } },
        data: { attempted: [...recent, now] },
      });
    });
  }

  async register(input: unknown) {
    const body = readBody(input, ['username', 'password', 'displayName']);
    const { username, password } = credentials(body);
    if (typeof body.displayName !== 'string' || !body.displayName.isWellFormed()) {
      throw invalidInput();
    }
    const displayName = body.displayName.trim();
    if (displayName.length === 0 || [...displayName].length > 40 || /\p{Cc}/u.test(displayName)) throw invalidInput();

    try {
      return await this.db.account.create({
        data: {
          id: randomUUID(),
          username,
          passwordHash: await hashPassword(password),
          displayName,
          role: Role.MEMBER,
          memberNumber: randomUUID(),
        },
        select: identityFields,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
          && await this.db.account.findUnique({ where: { username }, select: { id: true } })) {
        throw new ApiError(409, 'USERNAME_TAKEN', '此帳號已使用。');
      }
      throw error;
    }
  }

  async login(input: unknown, token?: string) {
    const { username, password } = credentials(readBody(input, ['username', 'password']));
    const active = await this.findActiveSession(token);
    if (active && active.account.username !== username) {
      throw new ApiError(409, 'ACCOUNT_SWITCH_REQUIRES_LOGOUT', '切換帳號前請先登出。');
    }
    const result = await this.db.$transaction(async (tx) => {
      const kind = AttemptKind.LOGIN_ACCOUNT;
      const { recent } = await this.lockWindow(tx, kind, username);
      const account = await tx.account.findUnique({
        where: { username },
        select: { ...identityFields, id: true, passwordHash: true },
      });
      const matches = await matchesPassword(password, account?.passwordHash);
      const now = this.clock();
      if (!matches || !account) {
        await tx.attemptWindow.update({
          where: { kind_key: { kind, key: username } },
          data: { attempted: [...recent, now] },
        });
        return null;
      }

      const sessionId = randomUUID();
      const expiresAt = new Date(now.getTime() + sessionSeconds * 1000);
      const token = this.jwt.sign({
        sub: account.id,
        jti: sessionId,
        iat: now.getTime() / 1000,
        exp: expiresAt.getTime() / 1000,
      }, { algorithm: 'HS256', ...jwtIdentity });
      await tx.session.create({ data: { id: sessionId, accountId: account.id, expiresAt } });
      const { displayName, role, memberNumber } = account;
      return { accountId: account.id, identity: { username, displayName, role, memberNumber }, token, maxAge: sessionSeconds * 1000 };
    });
    // 401 在交易提交後才回傳，讓失敗計數保留。
    if (result === null) throw invalidLogin();
    return result;
  }

  private async findActiveSession(token: string | undefined, tx?: Transaction, lock = false) {
    if (!token) return null;
    const now = this.clock().getTime() / 1000;
    let claims: { sub: string; jti: string; iat: number; exp: number };
    try {
      claims = this.jwt.verify(token, { algorithms: ['HS256'], ...jwtIdentity, clockTimestamp: now });
    } catch {
      return null;
    }
    if (typeof claims?.sub !== 'string' || !uuid.test(claims.sub)
        || typeof claims.jti !== 'string' || !uuid.test(claims.jti)
        || !Number.isFinite(claims.iat) || claims.iat > now
        || !Number.isFinite(claims.exp) || Math.round((claims.exp - claims.iat) * 1000) !== sessionSeconds * 1000) {
      return null;
    }

    if (tx && lock) {
      // 保留本次業務寫入採用的工作階段及角色，讓並行撤銷或變更角色與寫入有明確順序。
      await tx.$queryRaw`
        SELECT s."id" FROM "Session" s JOIN "Account" a ON a."id" = s."accountId"
        WHERE s."id" = ${claims.jti}::uuid AND a."id" = ${claims.sub}::uuid FOR SHARE OF s, a
      `;
    }
    const session = await (tx ?? this.db).session.findUnique({
      where: { id: claims.jti },
      include: { account: { select: identityFields } },
    });
    if (!session || session.accountId !== claims.sub || session.revokedAt
        || session.expiresAt.getTime() !== Math.round(claims.exp * 1000)
        || session.expiresAt <= this.clock()) {
      return null;
    }
    return session;
  }

  private async requireActiveSession(token: string | undefined, tx?: Transaction, lock = false) {
    const session = await this.findActiveSession(token, tx, lock);
    if (!session) throw unauthenticated();
    return session;
  }

  async me(token: string | undefined, tx?: Transaction, lock = false) {
    const session = await this.requireActiveSession(token, tx, lock);
    return { accountId: session.accountId, identity: session.account };
  }

  async logout(input: unknown, token: string | undefined) {
    readBody(input, []);
    const session = await this.requireActiveSession(token);
    const now = this.clock();
    const { count } = await this.db.session.updateMany({
      where: { id: session.id, revokedAt: null, expiresAt: { gt: now } },
      data: { revokedAt: now },
    });
    if (count === 0) throw unauthenticated();
    return session.accountId;
  }
}
