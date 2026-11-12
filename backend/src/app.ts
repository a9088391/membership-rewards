import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  BadRequestException,
  Body,
  Catch,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  type ArgumentsHost,
  type DynamicModule,
  type ExceptionFilter,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter, type NestExpressApplication } from '@nestjs/platform-express';
import express, { type Request, type Response } from 'express';
import { ApiError, AuthService, invalidInput, readBody, sessionCookie, sessionCookieOptions } from './auth.js';
import { resourceIdPattern } from './brand-access.js';
import { createDatabase } from './database.js';
import { Prisma, PrismaClient, Role } from './generated/client.js';
import { createOffer, listOffers, stopOffer } from './offers.js';
import { grantPoints, readPoints } from './points.js';
import { exchangeOffer, readVouchers } from './vouchers.js';

const appClock = Symbol('appClock');

type AppOptions = {
  frontend?: (request: Request, response: Response) => Promise<unknown>;
  clock?: () => Date;
};

function readSession(request: Request) {
  const values = request.headers.cookie?.split(';')
    .map((field) => field.trim())
    .filter((field) => field.startsWith(sessionCookie + '='));
  return values?.length === 1 ? values[0].slice(sessionCookie.length + 1) : undefined;
}

function sessionTag(token: string) {
  // 讓前端識別工作階段更替，登入憑證仍只經 HttpOnly Cookie 傳送。
  return createHash('sha256').update('membership-rewards/session-tag/v1\0').update(token).digest('base64url');
}

@Controller('api/auth')
class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  register(@Body() body: unknown) {
    return this.auth.register(body);
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const result = await this.auth.login(body, readSession(request));
    response.locals.accountId = result.accountId;
    response.cookie(sessionCookie, result.token, { ...sessionCookieOptions, maxAge: result.maxAge });
    response.set('X-Membership-Session', sessionTag(result.token));
    return result.identity;
  }

  @Get('me')
  async me(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const token = readSession(request);
    const result = await this.auth.me(token);
    response.locals.accountId = result.accountId;
    if (token) response.set('X-Membership-Session', sessionTag(token));
    return result.identity;
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Body() body: unknown, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    response.locals.accountId = await this.auth.logout(body, readSession(request));
    response.clearCookie(sessionCookie, sessionCookieOptions);
  }
}

const brandFields = { id: true, name: true } as const;

function readBrandName(input: unknown) {
  const { name } = readBody(input, ['name']);
  if (typeof name !== 'string' || !name.isWellFormed()) throw invalidInput();
  const trimmed = name.trim();
  if (trimmed.length === 0 || [...trimmed].length > 80 || /\p{Cc}/u.test(trimmed)) throw invalidInput();
  return trimmed;
}

function positiveInteger(value: unknown, fallback: number) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw invalidInput();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw invalidInput();
  return parsed;
}

function readPage(pageInput: unknown, pageSizeInput: unknown) {
  const page = positiveInteger(pageInput, 1);
  const pageSize = positiveInteger(pageSizeInput, 20);
  const skip = (page - 1) * pageSize;
  if (pageSize > 100 || !Number.isSafeInteger(skip)) throw invalidInput();
  return { skip, pageSize };
}

@Controller('api/brands')
class BrandController {
  constructor(private readonly auth: AuthService, private readonly db: PrismaClient) {}

  private async requireGroupAdmin(request: Request, response: Response) {
    const { accountId, identity } = await this.auth.me(readSession(request));
    response.locals.accountId = accountId;
    if (identity.role !== Role.GROUP_ADMIN) throw new ApiError(403, 'FORBIDDEN', '沒有權限執行此操作。');
  }

  @Get()
  async list(
    @Query('page') pageInput: unknown,
    @Query('pageSize') pageSizeInput: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { accountId } = await this.auth.me(readSession(request));
    response.locals.accountId = accountId;
    const { skip, pageSize } = readPage(pageInput, pageSizeInput);
    const items = await this.db.brand.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip,
      take: pageSize + 1,
      select: brandFields,
    });
    return { items: items.slice(0, pageSize), hasNext: items.length > pageSize };
  }

  @Post()
  async create(@Body() body: unknown, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.requireGroupAdmin(request, response);
    const brand = await this.db.brand.create({
      data: { id: randomUUID(), name: readBrandName(body) },
      select: brandFields,
    });
    response.locals.brandId = brand.id;
    return brand;
  }

  @Patch(':brandId')
  async rename(
    @Param('brandId') id: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.requireGroupAdmin(request, response);
    if (!resourceIdPattern.test(id)) throw invalidInput();
    const name = readBrandName(body);
    try {
      const brand = await this.db.brand.update({ where: { id }, data: { name }, select: brandFields });
      response.locals.brandId = brand.id;
      return brand;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundException();
      }
      throw error;
    }
  }
}

function authenticateRequest(auth: AuthService, request: Request, response: Response, brandId?: unknown, lock = false) {
  return async (tx: Prisma.TransactionClient) => {
    const actor = await auth.me(readSession(request), tx, lock);
    response.locals.accountId = actor.accountId;
    if (typeof brandId === 'string' && resourceIdPattern.test(brandId)) response.locals.brandId = brandId.toLowerCase();
    // 以 Cookie 查得的身分為準，防止其他分頁已切換帳號時讀寫舊畫面的資料。
    const expectedActor = request.header('X-Membership-Actor');
    if (expectedActor !== undefined && expectedActor !== actor.identity.username) {
      throw new ApiError(403, 'FORBIDDEN', '登入身分已變更，請重新確認後再試。');
    }
    return actor;
  };
}

@Controller('api/brands/:brandId')
class PointsController {
  constructor(private readonly auth: AuthService, private readonly db: PrismaClient) {}

  @Get('me/points')
  myPoints(
    @Param('brandId') brandId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return readPoints(this.db, authenticateRequest(this.auth, request, response, brandId), { brandId });
  }

  @Get('me/ledger')
  myLedger(
    @Param('brandId') brandId: string,
    @Query('page') page: unknown,
    @Query('pageSize') pageSize: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return readPoints(this.db, authenticateRequest(this.auth, request, response, brandId), { brandId }, () => readPage(page, pageSize));
  }

  @Get('members/:memberNumber')
  memberPoints(
    @Param('brandId') brandId: string,
    @Param('memberNumber') memberNumber: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return readPoints(this.db, authenticateRequest(this.auth, request, response, brandId), { brandId, memberNumber });
  }

  @Get('members/:memberNumber/ledger')
  memberLedger(
    @Param('brandId') brandId: string,
    @Param('memberNumber') memberNumber: string,
    @Query('page') page: unknown,
    @Query('pageSize') pageSize: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return readPoints(
      this.db, authenticateRequest(this.auth, request, response, brandId), { brandId, memberNumber }, () => readPage(page, pageSize),
    );
  }

  @Post('members/:memberNumber/grants')
  async grant(
    @Param('brandId') brandId: string,
    @Param('memberNumber') memberNumber: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const authenticate = authenticateRequest(this.auth, request, response, brandId, true);
    return auditWrite(response, 'grantPoints', 201, () => grantPoints(
      this.db, authenticate, { brandId, memberNumber }, request.header('Idempotency-Key'), body,
    ));
  }
}

@Controller('api/brands/:brandId/offers')
class OffersController {
  constructor(
    private readonly auth: AuthService,
    private readonly db: PrismaClient,
    @Inject(appClock) private readonly clock: () => Date,
  ) {}

  @Get()
  list(
    @Param('brandId') brandId: string,
    @Query('page') page: unknown,
    @Query('pageSize') pageSize: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const authenticate = authenticateRequest(this.auth, request, response, brandId);
    return listOffers(this.db, authenticate, brandId, () => readPage(page, pageSize), this.clock);
  }

  @Post()
  create(
    @Param('brandId') brandId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const authenticate = authenticateRequest(this.auth, request, response, brandId, true);
    return auditWrite(response, 'createOffer', 201, async () => {
      const offer = await createOffer(this.db, authenticate, brandId, body, this.clock);
      response.locals.offerId = offer.id;
      return offer;
    });
  }

  @Post(':offerId/exchanges')
  exchange(
    @Param('brandId') brandId: string,
    @Param('offerId') offerId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const authenticate = authenticateRequest(this.auth, request, response, brandId, true);
    return auditWrite(response, 'exchangeOffer', 201, async () => {
      const result = await exchangeOffer(
        this.db, authenticate, { brandId, offerId }, request.header('Idempotency-Key'), body, this.clock,
      );
      response.locals.offerId = offerId.toLowerCase();
      return result;
    });
  }

  @Post(':offerId/stop')
  @HttpCode(200)
  stop(
    @Param('brandId') brandId: string,
    @Param('offerId') offerId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const authenticate = authenticateRequest(this.auth, request, response, brandId, true);
    return auditWrite(response, 'stopOffer', 200, async () => {
      const offer = await stopOffer(this.db, authenticate, brandId, offerId, body, this.clock);
      response.locals.offerId = offer.id;
      return offer;
    });
  }
}

@Controller('api')
class VouchersController {
  constructor(
    private readonly auth: AuthService,
    private readonly db: PrismaClient,
    @Inject(appClock) private readonly clock: () => Date,
  ) {}

  @Get('me/vouchers')
  myVouchers(
    @Query('brandId') brandId: unknown,
    @Query('page') page: unknown,
    @Query('pageSize') pageSize: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const authenticate = authenticateRequest(this.auth, request, response, brandId);
    return readVouchers(this.db, authenticate, { brandId }, () => readPage(page, pageSize), this.clock);
  }

  @Get('brands/:brandId/members/:memberNumber/vouchers')
  memberVouchers(
    @Param('brandId') brandId: string,
    @Param('memberNumber') memberNumber: string,
    @Query('page') page: unknown,
    @Query('pageSize') pageSize: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const authenticate = authenticateRequest(this.auth, request, response, brandId);
    return readVouchers(this.db, authenticate, { brandId, memberNumber }, () => readPage(page, pageSize), this.clock);
  }
}

@Module({})
class ApiModule {
  static withServices(auth: AuthService, db: PrismaClient, clock: () => Date): DynamicModule {
    return {
      module: ApiModule,
      controllers: [AuthController, BrandController, PointsController, OffersController, VouchersController],
      providers: [
        { provide: AuthService, useValue: auth }, { provide: PrismaClient, useValue: db }, { provide: appClock, useValue: clock },
      ],
    };
  }
}

function respondError(response: Response, error: unknown) {
  if (response.destroyed) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }

  const failure = error instanceof ApiError
    ? error
    : error instanceof BadRequestException
      ? invalidInput()
      : error instanceof HttpException && error.getStatus() === 404
        ? new ApiError(404, 'NOT_FOUND', '找不到此資源。')
        : new ApiError(503, 'SERVICE_UNAVAILABLE', '服務暫時無法使用，請稍後再試。');
  const { status, code, message, retryAfterSeconds } = failure;
  if (retryAfterSeconds !== undefined) response.setHeader('Retry-After', retryAfterSeconds);
  response.status(status).json({ code, message, traceId: response.locals.traceId, retryAfterSeconds });
}

@Catch()
class ErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    respondError(host.switchToHttp().getResponse<Response>(), error);
  }
}

const jsonOptions = { limit: 16 * 1024, inflate: false };
const parseJson = express.json(jsonOptions);
const parseExchangeJson = express.json({
  ...jsonOptions,
  verify(_request, _response, body) {
    // Express 會把零位元組的 JSON 解析成 {}，兌換仍要求明確送出空物件。
    if (body.length === 0) throw invalidInput();
  },
});
const parsePointsJson = express.json({
  ...jsonOptions,
  reviver(key: string, value: unknown, context?: { source: string }) {
    if (key !== 'points' || typeof value !== 'number' || value <= 0 || !Number.isInteger(value)) return value;
    // 十進位數即使被 Number 捨入成整數，原始有效數字也必須能消去全部小數位。
    if (!context) return NaN;
    const [significand, exponent = '0'] = context.source.split(/[eE]/);
    const decimal = significand.indexOf('.');
    const fractionalDigits = decimal < 0 ? 0 : significand.length - decimal - 1;
    const digits = significand.replace('.', '');
    const places = fractionalDigits - Number(exponent);
    for (let offset = 1; offset <= places; offset += 1) {
      if (digits.at(-offset) !== '0') return NaN;
    }
    return value;
  },
});
const operations = new Map([
  ['POST /api/auth/register', 'register'],
  ['POST /api/auth/login', 'login'],
  ['GET /api/auth/me', 'me'],
  ['HEAD /api/auth/me', 'me'],
  ['POST /api/auth/logout', 'logout'],
  ['GET /api/brands', 'listBrands'],
  ['HEAD /api/brands', 'listBrands'],
  ['POST /api/brands', 'createBrand'],
  ['GET /api/me/vouchers', 'myVouchers'],
  ['HEAD /api/me/vouchers', 'myVouchers'],
]);

const brandOperations: [string[], RegExp, string][] = [
  [['PATCH'], /^\/api\/brands\/[^/]+$/, 'renameBrand'],
  [['GET', 'HEAD'], /^\/api\/brands\/[^/]+\/me\/points$/, 'myPoints'],
  [['GET', 'HEAD'], /^\/api\/brands\/[^/]+\/me\/ledger$/, 'myLedger'],
  [['GET', 'HEAD'], /^\/api\/brands\/[^/]+\/members\/[^/]+$/, 'memberPoints'],
  [['GET', 'HEAD'], /^\/api\/brands\/[^/]+\/members\/[^/]+\/ledger$/, 'memberLedger'],
  [['GET', 'HEAD'], /^\/api\/brands\/[^/]+\/members\/[^/]+\/vouchers$/, 'memberVouchers'],
  [['POST'], /^\/api\/brands\/[^/]+\/members\/[^/]+\/grants$/, 'grantPoints'],
  [['GET', 'HEAD'], /^\/api\/brands\/[^/]+\/offers$/, 'listOffers'],
  [['POST'], /^\/api\/brands\/[^/]+\/offers$/, 'createOffer'],
  [['POST'], /^\/api\/brands\/[^/]+\/offers\/[^/]+\/stop$/, 'stopOffer'],
  [['POST'], /^\/api\/brands\/[^/]+\/offers\/[^/]+\/exchanges$/, 'exchangeOffer'],
];

function logApiOutcome(response: Response, operation: string, status: number) {
  const { traceId, accountId, brandId, offerId } = response.locals;
  console.info(JSON.stringify({ traceId, operation, status, accountId, brandId, offerId }));
}

async function auditWrite<T>(response: Response, operation: string, status: number, write: () => Promise<T>) {
  try {
    return await write();
  } catch (error) {
    status = error instanceof ApiError ? error.status : 503;
    throw error;
  } finally {
    // 即使客戶端在提交前斷線，仍記錄交易結果且每次請求只記一筆。
    response.locals.writeAudited = true;
    logApiOutcome(response, operation, status);
  }
}

async function readConfig() {
  const origin = process.env.APP_ORIGIN;
  if (!origin) throw new Error('缺少 APP_ORIGIN');
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== 'http:' || !url.hostname.endsWith('.localhost')) {
    throw new Error('APP_ORIGIN 必須是專屬 .localhost HTTP 來源');
  }

  try {
    const key = await readFile('/run/membership-app/jwt-key', 'utf8');
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error();
    return { origin, host: url.host, key: Buffer.from(key, 'hex') };
  } catch {
    throw new Error('JWT 密鑰檔無法讀取或格式錯誤');
  }
}

export async function createApp(options: AppOptions = {}) {
  const { origin, host, key } = await readConfig();
  const db = createDatabase();
  const clock = options.clock ?? (() => new Date());
  const auth = new AuthService(db, key, clock);
  const server = express();
  server.disable('x-powered-by');
  server.disable('etag');
  server.disable('trust proxy');
  server.enable('case sensitive routing');
  server.enable('strict routing');

  server.use(async (request, response, next) => {
    const api = request.path === '/api' || request.path.startsWith('/api/');
    const operation = operations.get(request.method + ' ' + request.path)
      ?? brandOperations.find(([methods, path]) => methods.includes(request.method) && path.test(request.path))?.[2]
      ?? 'unknown';
    const traceId = randomUUID();
    response.locals.traceId = traceId;
    if (api) {
      response.set({ 'Cache-Control': 'private, no-store', 'X-Trace-Id': traceId });
      response.on('finish', () => {
        if (!response.locals.writeAudited) logApiOutcome(response, operation, response.statusCode);
      });
    }

    try {
      const rawNames = request.rawHeaders.filter((_, index) => index % 2 === 0).map((name) => name.toLowerCase());
      if (request.headers.host !== host || rawNames.filter((name) => name === 'host').length !== 1
          || rawNames.some((name) => name === 'forwarded' || name === 'x-real-ip' || name.startsWith('x-forwarded-'))) {
        throw new ApiError(403, 'UNTRUSTED_HOST', '請求來源不受信任。');
      }

      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        if (!api && options.frontend) await options.frontend(request, response);
        else next();
        return;
      }

      if (request.headers.origin !== origin) {
        throw new ApiError(403, 'INVALID_ORIGIN', '請求來源不受信任。');
      }
      if (operation === 'login' || operation === 'register') {
        const source = request.socket.remoteAddress;
        if (!source) throw new ApiError(403, 'UNTRUSTED_HOST', '請求來源不受信任。');
        // 先提交來源計數，後續格式錯誤、帳號限流或登入失敗仍算一次。
        await auth.consumeSource(operation === 'login' ? 'LOGIN_SOURCE' : 'REGISTER_SOURCE', source);
      }
      if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        throw invalidInput();
      }
      if (!api && options.frontend) {
        await options.frontend(request, response);
        return;
      }
      const parseBody = operation === 'grantPoints' || operation === 'createOffer' ? parsePointsJson
        : operation === 'exchangeOffer' ? parseExchangeJson : parseJson;
      parseBody(request, response, (error) => {
        if (error) respondError(response, invalidInput());
        else next();
      });
    } catch (error) {
      respondError(response, error);
    }
  });

  try {
    const app = await NestFactory.create<NestExpressApplication>(ApiModule.withServices(auth, db, clock), new ExpressAdapter(server), {
      bodyParser: false,
      logger: false,
      abortOnError: false,
    });
    app.useGlobalFilters(new ErrorFilter());
    await app.init();
    app.enableShutdownHooks(['SIGINT', 'SIGTERM']);
    return app;
  } catch (error) {
    await auth.onApplicationShutdown();
    throw error;
  }
}
