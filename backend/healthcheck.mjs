import { get } from 'node:http';
import { createDatabase } from './dist/database.js';

function listenerReady() {
  const port = Number(process.env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  return new Promise((resolve) => {
    const request = get({
      hostname: '127.0.0.1',
      port,
      path: '/api/auth/me',
      headers: { Host: new URL(process.env.APP_ORIGIN).host },
      signal: AbortSignal.timeout(2000),
    }, (response) => {
      response.resume();
      resolve(response.statusCode === 401);
    });
    request.once('error', () => resolve(false));
  });
}

try {
  if (!await listenerReady()) {
    process.exitCode = 1;
  } else {
    // 未登入的 HTTP 回應未存取資料庫，因此另驗證登入所需的資料表。
    const db = createDatabase();
    try {
      if (!await db.account.findFirst({ select: { id: true } })) process.exitCode = 1;
    } finally {
      await db.$disconnect();
    }
  }
} catch {
  process.exitCode = 1;
}
