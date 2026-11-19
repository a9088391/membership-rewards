'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Brands } from './brands';
import { BrandIcon } from './icons';
import { isIdentityDto, roleLabels, type IdentityDto } from './identity';
import { apiRequest, errorNotice, NoticeBox, type ApiResult, type Notice } from './request';

type ConfirmedSession = { identity: IdentityDto; sessionTag: string };
type Session =
  | { status: 'checking' | 'unavailable'; confirmed?: ConfirmedSession }
  | { status: 'anonymous'; confirmed?: never }
  | { status: 'authenticated'; confirmed: ConfirmedSession };

const sessionChangeKey = 'membership-rewards:session-change';

function readSessionChange() {
  try {
    return window.localStorage.getItem(sessionChangeKey);
  } catch {
    return null;
  }
}

function confirmedSession({ status, body, sessionTag }: ApiResult): ConfirmedSession | null {
  return status === 200 && sessionTag && isIdentityDto(body) ? { identity: body, sessionTag } : null;
}

export default function Home() {
  const [session, setSession] = useState<Session>({ status: 'checking' });
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
    setSession((previous) => ({ status: 'checking', confirmed: previous.confirmed }));
    setNotice(null);
    let revision: number;
    let result: ApiResult;
    // 品牌拒絕若晚於身分讀取，就在恢復畫面前重新取得當前權限。
    do {
      revision = brandDenialRevision.current;
      result = await apiRequest('auth/me', signal);
      if (signal.aborted) return;
    } while (revision !== brandDenialRevision.current);

    const confirmed = confirmedSession(result);
    if (result.status === 401) {
      setSession({ status: 'anonymous' });
      setNotice(recovery?.anonymous ?? null);
      return 'anonymous';
    } else if (confirmed) {
      setPrefilledUsername('');
      setMode('login');
      setSession({ status: 'authenticated', confirmed });
      setNotice(recovery?.authenticated ?? null);
      return 'authenticated';
    } else {
      setSession((previous) => ({ status: 'unavailable', confirmed: previous.confirmed }));
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
    // 跨分頁通知可能晚於身分驗證；先隱藏畫面，由伺服器確認是否需要重置草稿。
    setSession((previous) => ({ status: 'checking', confirmed: previous.confirmed }));
    if (activeRequest.current && !activeRequest.current.checkingSession) {
      checkAfterAuth.current = true;
    } else {
      refreshSession();
    }
    return true;
  }, [refreshSession]);

  const pointsSessionInterrupted = useCallback(() =>
    observeSessionChange() || activeRequest.current !== null, [observeSessionChange]);

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

  const hasIdentity = !!session.confirmed;
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

      const confirmed = mode === 'login' ? confirmedSession(result) : null;
      if (mode === 'register' && result.status === 201) {
        focusHeading.current = true;
        setPrefilledUsername(username);
        setMode('login');
        setNotice({ kind: 'status', message: '會員註冊成功。請使用此帳號登入。' });
      } else if (confirmed) {
        publishSessionChange();
        focusHeading.current = true;
        setPrefilledUsername('');
        setSession({ status: 'authenticated', confirmed });
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
      setSession({ status: 'checking', confirmed: session.confirmed });
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
  const title = session.status === 'anonymous' ? (isRegister ? '註冊會員' : '登入會員平台') : '目前身分';
  const identity = session.confirmed?.identity;

  return (
    <>
      <header className="site-header">
        <div className="wordmark"><span>MEMBER <i>/</i> REWARDS</span><strong>會員平台</strong></div>
        {session.status === 'authenticated' && identity && <div className="account-area">
          <span className="account-name">{identity.displayName}</span><span className="role-badge">{roleLabels[identity.role]}</span>
          <details className="account-details">
            <summary>帳號資訊</summary>
            <dl className="identity">
              <div><dt>顯示名稱</dt><dd>{identity.displayName}</dd></div>
              <div><dt>登入帳號</dt><dd>{identity.username}</dd></div>
              <div><dt>角色</dt><dd>{roleLabels[identity.role]}</dd></div>
              {identity.role === 'MEMBER' && <div><dt>會員編號</dt><dd>{identity.memberNumber}</dd></div>}
            </dl>
          </details>
          <button type="button" className="logout" onClick={logout}>登出</button>
        </div>}
      </header>
      <main className={session.status === 'authenticated' ? 'signed-in' : 'signed-out'}>
        <div className={session.status === 'anonymous' ? 'login-layout' : undefined}>
          {session.status === 'anonymous' && <aside className="login-intro">
            <h2>一個帳號，<br />累積每個品牌的日常。</h2>
            <div className="intro-rule" />
            <div className="intro-brands">
              <p><BrandIcon name="咖啡" />咖啡</p>
              <p><BrandIcon name="餐飲" />餐飲</p>
            </div>
            <p>各品牌點數分開累積，優惠券由原會員確認使用。</p>
          </aside>}
          <section className={session.status === 'authenticated' ? 'session-summary' : 'auth-card'} aria-labelledby="auth-title">
            <h1 id="auth-title" className={session.status === 'authenticated' ? 'sr-only' : undefined} ref={heading} tabIndex={-1}>{title}</h1>
            {session.status === 'anonymous' && <p className="auth-subtitle">會員與管理員使用同一入口。</p>}
            {notice && <NoticeBox notice={notice} />}
            {session.status === 'checking' && <p role="status">確認登入狀態中…</p>}
            {session.status === 'unavailable' && (
              <button type="button" onClick={() => {
                focusHeading.current = true;
                if (!observeSessionChange()) void run(readSession, true);
              }}>重新確認</button>
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
            {session.status === 'anonymous' && <p className="register-note">註冊僅建立會員帳號</p>}
          </section>
        </div>
        {/* 工作階段與帳號共同決定工作區生命週期；同帳號重驗保留，換身分則重新建立。 */}
        {session.confirmed && (
          <Brands key={`${session.confirmed.sessionTag}:${session.confirmed.identity.username}:${session.confirmed.identity.role}`}
            identity={session.confirmed.identity} active={session.status === 'authenticated'}
            onAccessDenied={confirmAfterBrandDenial} sessionInterrupted={pointsSessionInterrupted} />
        )}
      </main>
    </>
  );
}
