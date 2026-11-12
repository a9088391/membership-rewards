export type Notice = {
  kind: 'status' | 'alert';
  message: string;
  code?: string;
  traceId?: string;
  retryAfterSeconds?: number;
};

export type ApiResult = { status: number; body: unknown; sessionTag?: string; serverTime?: number };

export function isResourceId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
}

export function errorNotice({ body }: ApiResult, fallback: string): Notice {
  if (body && typeof body === 'object') {
    const { code, message, traceId, retryAfterSeconds } = body as Record<string, unknown>;
    if (typeof code === 'string' && typeof message === 'string' && typeof traceId === 'string') {
      return {
        kind: 'alert',
        code,
        message,
        traceId,
        retryAfterSeconds: typeof retryAfterSeconds === 'number' && Number.isSafeInteger(retryAfterSeconds)
          && retryAfterSeconds > 0 ? retryAfterSeconds : undefined,
      };
    }
  }
  return { kind: 'alert', message: fallback };
}

export async function apiRequest(
  path: string,
  signal: AbortSignal,
  options?: { expectedActor?: string } & (
    | { method?: never }
    | { method: 'POST' | 'PATCH'; input: Record<string, string | number>; idempotencyKey?: string }
  ),
): Promise<ApiResult> {
  try {
    const response = await fetch(`/api/${path}`, {
      signal,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        ...(options?.expectedActor && { 'X-Membership-Actor': options.expectedActor }),
        ...(options?.method && {
          'Content-Type': 'application/json',
          ...(options.idempotencyKey && { 'Idempotency-Key': options.idempotencyKey }),
        }),
      },
      ...(options?.method && {
        method: options.method,
        body: JSON.stringify(options.input),
      }),
    });
    const body: unknown = response.status === 204 ? null : await response.json().catch(() => null);
    const sessionTag = response.status === 200 && (path === 'auth/login' || path === 'auth/me')
      ? response.headers.get('X-Membership-Session') : null;
    const responseDate = response.headers.get('Date');
    const serverTime = responseDate ? Date.parse(responseDate) : NaN;
    return {
      status: response.status, body,
      ...(sessionTag && /^[A-Za-z0-9_-]{43}$/.test(sessionTag) && { sessionTag }),
      ...(Number.isFinite(serverTime) && new Date(serverTime).toUTCString() === responseDate && { serverTime }),
    };
  } catch {
    return { status: 0, body: null };
  }
}

export function NoticeBox({ notice }: { notice: Notice }) {
  return (
    <div className={`notice ${notice.kind}`} role={notice.kind}>
      <p>{notice.message}</p>
      {notice.retryAfterSeconds && <p>請等候 {notice.retryAfterSeconds} 秒後再試。</p>}
      {notice.traceId && <p className="trace">追蹤識別 {notice.traceId}</p>}
    </div>
  );
}
