import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  Body,
  Catch,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Module,
  Post,
  Req,
  Res,
  type ArgumentsHost,
  type DynamicModule,
  type ExceptionFilter,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter, type NestExpressApplication } from '@nestjs/platform-express';
import express, { type Request, type Response } from 'express';
import { ApiError, AuthService, invalidInput, sessionCookie, sessionCookieOptions } from './auth.js';
import { createDatabase } from './database.js';

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
    return result.identity;
  }

  @Get('me')
  async me(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const result = await this.auth.me(readSession(request));
    response.locals.accountId = result.accountId;
    return result.identity;
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Body() body: unknown, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    response.locals.accountId = await this.auth.logout(body, readSession(request));
    response.clearCookie(sessionCookie, sessionCookieOptions);
  }
}

@Module({})
class AuthModule {
  static withService(auth: AuthService): DynamicModule {
    return {
      module: AuthModule,
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: auth }],
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

const parseJson = express.json({ limit: 16 * 1024, inflate: false });
const operations = new Map([
  ['POST /api/auth/register', 'register'],
  ['POST /api/auth/login', 'login'],
  ['GET /api/auth/me', 'me'],
  ['HEAD /api/auth/me', 'me'],
  ['POST /api/auth/logout', 'logout'],
]);

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
  const auth = new AuthService(createDatabase(), key, options.clock ?? (() => new Date()));
  const server = express();
  server.disable('x-powered-by');
  server.disable('etag');
  server.disable('trust proxy');
  server.enable('case sensitive routing');
  server.enable('strict routing');

  server.use(async (request, response, next) => {
    const api = request.path === '/api' || request.path.startsWith('/api/');
    const operation = operations.get(request.method + ' ' + request.path) ?? 'unknown';
    const traceId = randomUUID();
    response.locals.traceId = traceId;
    if (api) {
      response.set({ 'Cache-Control': 'private, no-store', 'X-Trace-Id': traceId });
      response.on('finish', () => console.info(JSON.stringify({
        traceId, operation, status: response.statusCode, accountId: response.locals.accountId,
      })));
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
      parseJson(request, response, (error) => {
        if (error) respondError(response, invalidInput());
        else next();
      });
    } catch (error) {
      respondError(response, error);
    }
  });

  try {
    const app = await NestFactory.create<NestExpressApplication>(AuthModule.withService(auth), new ExpressAdapter(server), {
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
