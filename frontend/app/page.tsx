'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

const roles = {
  MEMBER: '會員',
  GROUP_ADMIN: '集團管理員',
  BRAND_ADMIN: '品牌管理員',
} as const;

type Identity = {
  username: string;
  displayName: string;
  role: keyof typeof roles;
  memberNumber: string | null;
};

type Session =
  | { status: 'checking' | 'unavailable' | 'anonymous' }
  | { status: 'authenticated'; identity: Identity };

type Notice = {
  kind: 'status' | 'alert';
  message: string;
  traceId?: string;
  retryAfterSeconds?: number;
};

type AuthResult = { status: number; body: unknown };

function isIdentity(body: unknown): body is Identity {
  if (!body || typeof body !== 'object') return false;
  const { username, displayName, role, memberNumber } = body as Partial<Identity>;
  return typeof username === 'string' && typeof displayName === 'string'
    && typeof role === 'string' && Object.hasOwn(roles, role)
    && (role === 'MEMBER' ? typeof memberNumber === 'string' : memberNumber === null);
}

function errorNotice({ body }: AuthResult, fallback: string): Notice {
  if (body && typeof body === 'object') {
    const { code, message, traceId, retryAfterSeconds } = body as Record<string, unknown>;
    if (typeof code === 'string' && typeof message === 'string' && typeof traceId === 'string') {
      return {
        kind: 'alert',
        message,
        traceId,
        retryAfterSeconds: typeof retryAfterSeconds === 'number' && Number.isSafeInteger(retryAfterSeconds)
          && retryAfterSeconds > 0 ? retryAfterSeconds : undefined,
      };
    }
  }
  return { kind: 'alert', message: fallback };
}

async function authRequest(
  action: 'me' | 'login' | 'register' | 'logout',
  signal: AbortSignal,
  input?: Record<string, string>,
): Promise<AuthResult> {
  try {
    const response = await fetch(`/api/auth/${action}`, {
      signal,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(input && {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    });
    const body: unknown = response.status === 204 ? null : await response.json().catch(() => null);
    return { status: response.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

export default function Home() {
  const [session, setSession] = useState<Session>({ status: 'checking' });
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState(false);
  const [prefilledUsername, setPrefilledUsername] = useState('');
  const activeRequest = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusHeading = useRef(false);

  // 共用請求鎖讓身分讀回、登入及登出依序完成，卸載時取消還在等待的回應。
  const run = useCallback(async (work: (signal: AbortSignal) => Promise<void>) => {
    if (activeRequest.current) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    try {
      await work(controller.signal);
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
    }
  }, []);

  const readSession = useCallback(async (
    signal: AbortSignal,
    recovery?: { anonymous: Notice; authenticated: Notice | null },
  ) => {
    setSession({ status: 'checking' });
    setNotice(null);
    const result = await authRequest('me', signal);
    if (signal.aborted) return;

    if (result.status === 401) {
      setSession({ status: 'anonymous' });
      setNotice(recovery?.anonymous ?? null);
    } else if (result.status === 200 && isIdentity(result.body)) {
      setPrefilledUsername('');
      setMode('login');
      setSession({ status: 'authenticated', identity: result.body });
      setNotice(recovery?.authenticated ?? null);
    } else {
      setSession({ status: 'unavailable' });
      setNotice({ kind: 'alert', message: '暫時無法確認登入狀態。請重新確認後再繼續。' });
    }
  }, []);

  useEffect(() => {
    void run(readSession);
    return () => {
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, [readSession, run]);

  useEffect(() => {
    if (session.status !== 'authenticated') return;

    function revalidate() {
      void run(readSession);
    }

    function restore(event: PageTransitionEvent) {
      if (event.persisted) revalidate();
    }

    window.addEventListener('focus', revalidate);
    window.addEventListener('pageshow', restore);
    return () => {
      window.removeEventListener('focus', revalidate);
      window.removeEventListener('pageshow', restore);
    };
  }, [readSession, run, session.status]);

  useEffect(() => {
    if (session.status === 'checking' || !focusHeading.current) return;
    focusHeading.current = false;
    heading.current?.focus();
  }, [mode, session.status]);

  function switchMode() {
    if (activeRequest.current) return;
    focusHeading.current = true;
    setNotice(null);
    setMode(mode === 'login' ? 'register' : 'login');
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (activeRequest.current || session.status !== 'anonymous') return;

    const form = event.currentTarget;
    const fields = new FormData(form);
    const username = String(fields.get('username'));
    const passwordInput = form.elements.namedItem('password') as HTMLInputElement;
    const credentials = { username, password: passwordInput.value };
    const input = mode === 'register'
      ? { ...credentials, displayName: String(fields.get('displayName')) }
      : credentials;
    passwordInput.value = '';

    setPending(true);
    setNotice(null);
    void run(async (signal) => {
      const result = await authRequest(mode, signal, input);
      if (signal.aborted) return;
      setPending(false);

      if (mode === 'register' && result.status === 201) {
        focusHeading.current = true;
        setPrefilledUsername(username);
        setMode('login');
        setNotice({ kind: 'status', message: '會員註冊成功。請使用此帳號登入。' });
      } else if (mode === 'login' && result.status === 200 && isIdentity(result.body)) {
        focusHeading.current = true;
        setPrefilledUsername('');
        setSession({ status: 'authenticated', identity: result.body });
      } else {
        const accountSwitchBlocked = result.status === 409 && result.body !== null && typeof result.body === 'object'
          && 'code' in result.body && result.body.code === 'ACCOUNT_SWITCH_REQUIRES_LOGOUT';
        const failure = errorNotice(result, accountSwitchBlocked ? '切換帳號前請先登出。' : '暫時無法完成請求，請稍後再試。');
        const uncertain = result.status === 0 || result.status >= 500 || result.status === 200;
        if (mode === 'login' && (uncertain || accountSwitchBlocked)) {
          // 其他分頁可能已更新登入 Cookie，由伺服器讀回決定應顯示登入或登出。
          focusHeading.current = true;
          setPrefilledUsername(username);
          await readSession(signal, {
            anonymous: accountSwitchBlocked ? { kind: 'status', message: '登入狀態已變更，請重新登入。' } : failure,
            authenticated: accountSwitchBlocked ? failure : null,
          });
        } else {
          setNotice(failure);
        }
      }
    });
  }

  function logout() {
    if (session.status !== 'authenticated') return;

    void run(async (signal) => {
      focusHeading.current = true;
      setSession({ status: 'checking' });
      setNotice(null);
      const result = await authRequest('logout', signal, {});
      if (signal.aborted) return;

      if (result.status === 204 || result.status === 401) {
        setSession({ status: 'anonymous' });
        setNotice({ kind: 'status', message: result.status === 204 ? '已登出。' : '登入已失效，請重新登入。' });
      } else {
        // 回應遺失時登出可能已提交，以伺服器目前身分決定能否切換帳號。
        await readSession(signal, {
          anonymous: { kind: 'status', message: '目前已登出。' },
          authenticated: errorNotice(result, '仍為登入狀態。請再試一次登出。'),
        });
      }
    });
  }

  const isRegister = mode === 'register';
  const title = session.status === 'anonymous' ? (isRegister ? '註冊會員' : '登入') : '目前身分';

  return (
    <main>
      <section className="auth-card" aria-labelledby="auth-title">
        <h1 id="auth-title" ref={heading} tabIndex={-1}>{title}</h1>
        {notice && (
          <div className={`notice ${notice.kind}`} role={notice.kind}>
            <p>{notice.message}</p>
            {notice.retryAfterSeconds && <p>請等候 {notice.retryAfterSeconds} 秒後再試。</p>}
            {notice.traceId && <p className="trace">追蹤識別 {notice.traceId}</p>}
          </div>
        )}
        {session.status === 'checking' && <p role="status">確認登入狀態中…</p>}
        {session.status === 'unavailable' && (
          <button type="button" onClick={() => {
            focusHeading.current = true;
            void run(readSession);
          }}>重新確認</button>
        )}
        {session.status === 'authenticated' && (
          <>
            <dl className="identity">
              <div><dt>顯示名稱</dt><dd>{session.identity.displayName}</dd></div>
              <div><dt>登入帳號</dt><dd>{session.identity.username}</dd></div>
              <div><dt>角色</dt><dd>{roles[session.identity.role]}</dd></div>
              {session.identity.role === 'MEMBER' && (
                <div><dt>會員編號</dt><dd>{session.identity.memberNumber}</dd></div>
              )}
            </dl>
            <button type="button" onClick={logout}>登出</button>
          </>
        )}
        {session.status === 'anonymous' && (
          <>
            <form key={mode} method="post" onSubmit={submit}>
              <label htmlFor="username">登入帳號</label>
              <input id="username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false}
                defaultValue={prefilledUsername} readOnly={pending} required aria-describedby="username-hint" />
              <p className="hint" id="username-hint">3 至 32 個字元，可用小寫英文字母、數字及底線。</p>
              {isRegister && (
                <>
                  <label htmlFor="display-name">顯示名稱</label>
                  <input id="display-name" name="displayName" autoComplete="nickname" readOnly={pending} required
                    aria-describedby="display-name-hint" />
                  <p className="hint" id="display-name-hint">1 至 40 個字元。</p>
                </>
              )}
              <label htmlFor="password">密碼</label>
              <input id="password" name="password" type="password" autoComplete={isRegister ? 'new-password' : 'current-password'}
                readOnly={pending} required aria-describedby="password-hint" />
              <p className="hint" id="password-hint">12 至 128 個字元，保留輸入的空白。</p>
              <button type="submit" aria-disabled={pending}>{isRegister ? '註冊' : '登入'}</button>
            </form>
            {pending && <p role="status">{isRegister ? '註冊中…' : '登入中…'}</p>}
            <button className="switch-mode" type="button" aria-disabled={pending} onClick={switchMode}>
              {isRegister ? '已有帳號，前往登入' : '註冊會員'}
            </button>
          </>
        )}
      </section>
    </main>
  );
}
