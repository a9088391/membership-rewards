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
  | { status: 'checking' | 'unavailable'; identity?: Identity }
  | { status: 'anonymous'; identity?: never }
  | { status: 'authenticated'; identity: Identity };

type Notice = {
  kind: 'status' | 'alert';
  message: string;
  traceId?: string;
  retryAfterSeconds?: number;
};

type ApiResult = { status: number; body: unknown };
const sessionChangeKey = 'membership-rewards:session-change';

function readSessionChange() {
  try {
    return window.localStorage.getItem(sessionChangeKey);
  } catch {
    return null;
  }
}

function isIdentity(body: unknown): body is Identity {
  if (!body || typeof body !== 'object') return false;
  const { username, displayName, role, memberNumber } = body as Partial<Identity>;
  return typeof username === 'string' && typeof displayName === 'string'
    && typeof role === 'string' && Object.hasOwn(roles, role)
    && (role === 'MEMBER' ? typeof memberNumber === 'string' : memberNumber === null);
}

function errorNotice({ body }: ApiResult, fallback: string): Notice {
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

async function apiRequest(
  path: string,
  signal: AbortSignal,
  write?: { method: 'POST' | 'PATCH'; input: Record<string, string> },
): Promise<ApiResult> {
  try {
    const response = await fetch(`/api/${path}`, {
      signal,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(write && {
        method: write.method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(write.input),
      }),
    });
    const body: unknown = response.status === 204 ? null : await response.json().catch(() => null);
    return { status: response.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

function NoticeBox({ notice }: { notice: Notice }) {
  return (
    <div className={`notice ${notice.kind}`} role={notice.kind}>
      <p>{notice.message}</p>
      {notice.retryAfterSeconds && <p>請等候 {notice.retryAfterSeconds} 秒後再試。</p>}
      {notice.traceId && <p className="trace">追蹤識別 {notice.traceId}</p>}
    </div>
  );
}

type Brand = { id: string; name: string };
type BrandPage = { items: Brand[]; hasNext: boolean };

function isBrand(value: unknown): value is Brand {
  return !!value && typeof value === 'object'
    && 'id' in value && typeof value.id === 'string'
    && 'name' in value && typeof value.name === 'string';
}

function isBrandPage(value: unknown): value is BrandPage {
  return !!value && typeof value === 'object'
    && 'hasNext' in value && typeof value.hasNext === 'boolean'
    && 'items' in value && Array.isArray(value.items) && value.items.every(isBrand);
}

function Brands({ isGroupAdmin, active, onAccessDenied }: {
  isGroupAdmin: boolean;
  active: boolean;
  onAccessDenied: () => void;
}) {
  const [page, setPage] = useState(1);
  const [list, setList] = useState<BrandPage | null>(null);
  const [activity, setActivity] = useState<'loading' | 'saving' | null>('loading');
  const [listFailure, setListFailure] = useState<{ page: number; notice: Notice } | null>(null);
  const [writeNotice, setWriteNotice] = useState<(Notice & { review?: 'required' | 'read' }) | null>(null);
  const [createName, setCreateName] = useState('');
  const [edit, setEdit] = useState<{ brand: Brand; name: string } | null>(null);
  const request = useRef<AbortController | null>(null);
  const title = useRef<HTMLHeadingElement>(null);

  const canWrite = isGroupAdmin;
  const writeLocked = activity !== null || !!writeNotice?.review;

  const loadPage = useCallback(async (target: number, signal: AbortSignal) => {
    setListFailure(null);
    const result = await apiRequest(`brands?page=${target}`, signal);
    if (signal.aborted) return;
    if (result.status === 200 && isBrandPage(result.body)) {
      setPage(target);
      setList(result.body);
      setWriteNotice((previous) => previous?.review ? { ...previous, review: 'read' } : previous);
    } else {
      setListFailure({ page: target, notice: errorNotice(result, '暫時無法讀取品牌清單。') });
      setWriteNotice((previous) => previous?.review === 'read' ? { ...previous, review: 'required' } : previous);
      if (result.status === 401 || result.status === 403) {
        setList(null);
        onAccessDenied();
      }
    }
  }, [onAccessDenied]);

  const run = useCallback(async (
    next: 'loading' | 'saving',
    work: (signal: AbortSignal) => Promise<void>,
  ) => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setActivity(next);
    try {
      await work(controller.signal);
    } finally {
      if (request.current === controller) {
        request.current = null;
        setActivity(null);
      }
    }
  }, []);

  useEffect(() => {
    void run('loading', (signal) => loadPage(1, signal));
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [loadPage, run]);

  function browse(target: number) {
    if (active) void run('loading', (signal) => loadPage(target, signal));
  }

  function save(event: FormEvent<HTMLFormElement>, current?: Brand) {
    event.preventDefault();
    if (!active || !canWrite || writeLocked || request.current) return;

    const name = current ? edit?.name : createName;
    if (name === undefined) return;

    void run('saving', async (signal) => {
      setWriteNotice(null);
      const result = await apiRequest(current ? `brands/${encodeURIComponent(current.id)}` : 'brands', signal, {
        method: current ? 'PATCH' : 'POST',
        input: { name },
      });
      if (signal.aborted) return;

      if (result.status === (current ? 200 : 201) && isBrand(result.body)
        && (!current || result.body.id === current.id)) {
        setWriteNotice({ kind: 'status', message: current ? `已改名為「${result.body.name}」。` : `已新增「${result.body.name}」。` });
        if (current) {
          title.current?.focus();
          setEdit(null);
        } else {
          setCreateName('');
        }
        setActivity('loading');
        await loadPage(page, signal);
      } else if (result.status === 401 || result.status === 403) {
        setWriteNotice(errorNotice(result, '目前無法管理品牌。'));
        onAccessDenied();
      } else if (result.status === 400) {
        setWriteNotice(errorNotice(result, '無法儲存品牌名稱。'));
      } else if (current && result.status === 404) {
        setWriteNotice(errorNotice(result, '找不到要改名的品牌。'));
        title.current?.focus();
        setEdit(null);
        setActivity('loading');
        await loadPage(page, signal);
      } else {
        const failure = errorNotice(result, '');
        setWriteNotice({
          kind: 'alert',
          message: '無法確認這次寫入的結果。請重新讀取品牌清單並查看相關頁面，再決定是否發起新的操作。',
          traceId: failure.traceId,
          review: 'required',
        });
      }
    });
  }

  return (
    <section className="auth-card brands-card" aria-labelledby="brands-title" hidden={!active}>
      <h2 id="brands-title" ref={title} tabIndex={-1}>品牌清單</h2>
      {writeNotice && <NoticeBox notice={writeNotice} />}
      {writeNotice?.review && (
        <div className="brand-actions">
          <button type="button" aria-disabled={activity !== null}
            onClick={() => browse(listFailure?.page ?? page)}>重新讀取品牌清單</button>
          {canWrite && writeNotice.review === 'read' && (
            <button type="button" aria-disabled={activity !== null} onClick={() => {
              if (!active || request.current) return;
              title.current?.focus();
              setWriteNotice(null);
            }}>已檢查清單，允許新的操作</button>
          )}
        </div>
      )}
      {canWrite && (
        <form className="brand-form" method="post" onSubmit={(event) => save(event)}>
          <label htmlFor="brand-name">新品牌名稱</label>
          <input id="brand-name" name="name" required value={createName} readOnly={writeLocked}
            onChange={(event) => setCreateName(event.target.value)} aria-describedby="brand-name-hint" />
          <p id="brand-name-hint" className="hint">去除首尾空白後須為 1 至 80 個字元。</p>
          <button type="submit" aria-disabled={writeLocked}>新增品牌</button>
        </form>
      )}
      {activity && <p role="status">{activity === 'loading' ? '讀取品牌清單中…' : '儲存品牌中…'}</p>}
      {listFailure && (
        <>
          <NoticeBox notice={listFailure.notice} />
          {!writeNotice?.review && (
            <button type="button" onClick={() => browse(listFailure.page)}>重新讀取品牌清單</button>
          )}
        </>
      )}
      {list && (
        <>
          {list.items.length === 0 && <p>此頁沒有品牌。</p>}
          <ul className="brand-list">
            {list.items.map((brand) => (
              <li key={brand.id}>
                <span>{brand.name}</span>
                {canWrite && (
                  <>
                    <span className="brand-id">品牌 ID {brand.id}</span>
                    <button type="button" aria-label={`改名：${brand.name}（品牌 ID ${brand.id}）`}
                      aria-disabled={writeLocked || !!edit} onClick={() => {
                        if (!active || writeLocked || request.current || edit) return;
                        setWriteNotice(null);
                        setEdit({ brand, name: brand.name });
                      }}>改名</button>
                  </>
                )}
              </li>
            ))}
          </ul>
          {(page > 1 || list.hasNext) && (
            <nav className="brand-actions" aria-label="品牌清單分頁">
              <button type="button" disabled={page === 1} aria-disabled={activity !== null}
                onClick={() => browse(page - 1)}>上一頁</button>
              <p role="status">第 {page} 頁</p>
              <button type="button" disabled={!list.hasNext} aria-disabled={activity !== null}
                onClick={() => browse(page + 1)}>下一頁</button>
            </nav>
          )}
        </>
      )}
      {canWrite && edit && (
        <form className="brand-form" method="post" onSubmit={(event) => save(event, edit.brand)}>
          <label htmlFor="rename-brand-name">修改品牌名稱</label>
          <input id="rename-brand-name" name="name" autoFocus required value={edit.name} readOnly={writeLocked}
            onChange={(event) => setEdit({ ...edit, name: event.target.value })} aria-describedby="rename-brand-hint" />
          <p id="rename-brand-hint" className="hint">
            「{edit.brand.name}」改名後須為 1 至 80 個字元。
            <span className="brand-id">品牌 ID {edit.brand.id}</span>
          </p>
          <div className="brand-actions">
            <button type="submit" aria-disabled={writeLocked}>儲存名稱</button>
            <button type="button" aria-disabled={writeLocked} onClick={() => {
              if (!active || writeLocked || request.current) return;
              title.current?.focus();
              setEdit(null);
              setWriteNotice(null);
            }}>取消改名</button>
          </div>
        </form>
      )}
    </section>
  );
}

export default function Home() {
  const [session, setSession] = useState<Session>({ status: 'checking' });
  const [sessionGeneration, setSessionGeneration] = useState(0);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState(false);
  const [prefilledUsername, setPrefilledUsername] = useState('');
  const activeRequest = useRef<{ controller: AbortController; checkingSession: boolean } | null>(null);
  const observedSessionChange = useRef<string | null>(null);
  const checkAfterAuth = useRef(false);
  const brandDenialRevision = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusHeading = useRef(false);

  function publishSessionChange() {
    // 只通知其他分頁重新驗證；此標記與帳號、Cookie 或伺服器工作階段識別無關。
    try {
      const marker = window.crypto.randomUUID();
      window.localStorage.setItem(sessionChangeKey, marker);
      observedSessionChange.current = marker;
    } catch {
      // 儲存空間不可用時仍可向伺服器確認目前身分。
    }
  }

  const readSession = useCallback(async (
    signal: AbortSignal,
    recovery?: { anonymous: Notice; authenticated: Notice | null },
  ) => {
    // 重新確認期間隱藏品牌區塊；同一工作階段的草稿可在驗證後繼續編輯。
    setSession((previous) => ({ status: 'checking', identity: previous.identity }));
    setNotice(null);
    let revision: number;
    let result: ApiResult;
    // 品牌拒絕若晚於身分讀取，就在恢復畫面前重新取得當前權限。
    do {
      revision = brandDenialRevision.current;
      result = await apiRequest('auth/me', signal);
      if (signal.aborted) return;
    } while (revision !== brandDenialRevision.current);

    if (result.status === 401) {
      setSession({ status: 'anonymous' });
      setNotice(recovery?.anonymous ?? null);
      return 'anonymous';
    } else if (result.status === 200 && isIdentity(result.body)) {
      setPrefilledUsername('');
      setMode('login');
      setSession({ status: 'authenticated', identity: result.body });
      setNotice(recovery?.authenticated ?? null);
      return 'authenticated';
    } else {
      setSession((previous) => ({ status: 'unavailable', identity: previous.identity }));
      setNotice({ kind: 'alert', message: '暫時無法確認登入狀態。請重新確認後再繼續。' });
    }
  }, []);

  const run = useCallback(async (
    work: (signal: AbortSignal) => Promise<unknown>,
    checkingSession = false,
  ) => {
    if (activeRequest.current) return;
    const controller = new AbortController();
    const request = { controller, checkingSession };
    activeRequest.current = request;
    try {
      await work(controller.signal);
      if (checkAfterAuth.current && !controller.signal.aborted) {
        checkAfterAuth.current = false;
        request.checkingSession = true;
        await readSession(controller.signal);
      }
    } finally {
      if (activeRequest.current === request) activeRequest.current = null;
    }
  }, [readSession]);

  const refreshSession = useCallback(() => {
    // 較新的驗證需求可取代已送出的身分讀取；登入與登出仍由原請求完成。
    if (activeRequest.current?.checkingSession) {
      activeRequest.current.controller.abort();
      activeRequest.current = null;
    }
    void run(readSession, true);
  }, [readSession, run]);

  const confirmAfterBrandDenial = useCallback(() => {
    brandDenialRevision.current += 1;
    refreshSession();
  }, [refreshSession]);

  const observeSessionChange = useCallback(() => {
    const marker = readSessionChange();
    if (!marker || marker === observedSessionChange.current) return false;
    observedSessionChange.current = marker;
    // 即使新工作階段屬於同一帳號，也須卸載舊品牌表單及其待處理請求。
    setSessionGeneration((previous) => previous + 1);
    setSession({ status: 'checking' });
    if (activeRequest.current && !activeRequest.current.checkingSession) {
      checkAfterAuth.current = true;
    } else {
      refreshSession();
    }
    return true;
  }, [refreshSession]);

  useEffect(() => {
    observedSessionChange.current = readSessionChange();
    function onStorage(event: StorageEvent) {
      if (event.key === sessionChangeKey) observeSessionChange();
    }
    window.addEventListener('storage', onStorage);
    void run(readSession, true);
    return () => {
      window.removeEventListener('storage', onStorage);
      activeRequest.current?.controller.abort();
      activeRequest.current = null;
      checkAfterAuth.current = false;
    };
  }, [observeSessionChange, readSession, run]);

  const hasIdentity = !!session.identity;
  useEffect(() => {
    if (!hasIdentity) return;

    function revalidate() {
      if (!observeSessionChange()) void run(readSession, true);
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
  }, [observeSessionChange, readSession, run, hasIdentity]);

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
      const result = await apiRequest(`auth/${mode}`, signal, { method: 'POST', input });
      if (signal.aborted) return;
      setPending(false);
      observeSessionChange();

      if (mode === 'register' && result.status === 201) {
        focusHeading.current = true;
        setPrefilledUsername(username);
        setMode('login');
        setNotice({ kind: 'status', message: '會員註冊成功。請使用此帳號登入。' });
      } else if (mode === 'login' && result.status === 200 && isIdentity(result.body)) {
        publishSessionChange();
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
          const verified = await readSession(signal, {
            anonymous: accountSwitchBlocked ? { kind: 'status', message: '登入狀態已變更，請重新登入。' } : failure,
            authenticated: accountSwitchBlocked ? failure : null,
          });
          observeSessionChange();
          if (uncertain && verified === 'authenticated' && !checkAfterAuth.current) publishSessionChange();
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
      setSession({ status: 'checking', identity: session.identity });
      setNotice(null);
      const result = await apiRequest('auth/logout', signal, { method: 'POST', input: {} });
      if (signal.aborted) return;
      observeSessionChange();

      if (result.status === 204 || result.status === 401) {
        publishSessionChange();
        setSession({ status: 'anonymous' });
        setNotice({ kind: 'status', message: result.status === 204 ? '已登出。' : '登入已失效，請重新登入。' });
      } else {
        // 回應遺失時登出可能已提交，以伺服器目前身分決定能否切換帳號。
        const verified = await readSession(signal, {
          anonymous: { kind: 'status', message: '目前已登出。' },
          authenticated: errorNotice(result, '仍為登入狀態。請再試一次登出。'),
        });
        observeSessionChange();
        if (verified === 'anonymous' && !checkAfterAuth.current) publishSessionChange();
      }
    });
  }

  const isRegister = mode === 'register';
  const title = session.status === 'anonymous' ? (isRegister ? '註冊會員' : '登入') : '目前身分';

  return (
    <main>
      <section className="auth-card" aria-labelledby="auth-title">
        <h1 id="auth-title" ref={heading} tabIndex={-1}>{title}</h1>
        {notice && <NoticeBox notice={notice} />}
        {session.status === 'checking' && <p role="status">確認登入狀態中…</p>}
        {session.status === 'unavailable' && (
          <button type="button" onClick={() => {
            focusHeading.current = true;
            if (!observeSessionChange()) void run(readSession, true);
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
      {session.identity && (
        <Brands key={`${sessionGeneration}:${session.identity.username}:${session.identity.role}`}
          isGroupAdmin={session.identity.role === 'GROUP_ADMIN'} active={session.status === 'authenticated'}
          onAccessDenied={confirmAfterBrandDenial} />
      )}
    </main>
  );
}
