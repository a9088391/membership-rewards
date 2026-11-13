import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { apiRequest, errorNotice, isResourceId, NoticeBox, type Notice } from './request';

const statuses = {
  PENDING: '待確認', COMPLETED: '已完成', CANCELLED: '已取消', REJECTED: '已拒絕', EXPIRED: '已到期',
} as const;
const actions = {
  create: { label: '提出核銷', status: 'PENDING' },
  confirm: { label: '確認核銷', status: 'COMPLETED' },
  cancel: { label: '取消核銷請求', status: 'CANCELLED' },
  reject: { label: '拒絕核銷', status: 'REJECTED' },
} as const;
const taipeiTime = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hourCycle: 'h23',
});
const conflicts = new Set(['VOUCHER_UNAVAILABLE', 'REDEMPTION_PENDING', 'REDEMPTION_NOT_PENDING', 'IDEMPOTENCY_CONFLICT']);
const preKeyErrors: Record<number, string> = {
  400: 'INVALID_INPUT', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 429: 'RATE_LIMITED',
};

type RequestRow = {
  requestId: string;
  brandId: string;
  brandName: string;
  voucherId: string;
  offerId: string;
  offerName: string;
  status: keyof typeof statuses;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  initiatorDisplayName?: string;
};
type RequestPage = { items: RequestRow[]; hasNext: boolean };
type Resolution = 'confirm' | 'cancel' | 'reject';
type Operation = { action: 'create'; codeDigest: string } | { action: Resolution; requestId: string };
type Intent = Operation & { key: string };
type Pending = { scope: string; intents: Intent[] };
type Submission = { action: 'create'; retryKeys?: readonly string[] }
  | { action: Resolution; requestId: string; retryKey?: string };
type ReadQuery = { target: string | number };
type ReadResult = { query: ReadQuery } & (
  { notice: Notice } | { data: RequestPage; serverTime?: number; receivedAt: number }
);

function isTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isRequestRow(value: unknown, brandId: string, isMember: boolean): value is RequestRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<RequestRow>;
  return isResourceId(row.requestId) && row.brandId === brandId && typeof row.brandName === 'string'
    && isResourceId(row.voucherId) && isResourceId(row.offerId) && typeof row.offerName === 'string'
    && typeof row.status === 'string' && Object.hasOwn(statuses, row.status)
    && isTime(row.createdAt) && isTime(row.expiresAt) && (row.resolvedAt === null || isTime(row.resolvedAt))
    && (isMember ? typeof row.initiatorDisplayName === 'string' : row.initiatorDisplayName === undefined);
}

function isRequestPage(value: unknown, brandId: string): value is RequestPage {
  return !!value && typeof value === 'object' && 'hasNext' in value && typeof value.hasNext === 'boolean'
    && 'items' in value && Array.isArray(value.items) && value.items.every((row) => isRequestRow(row, brandId, true));
}

async function digest(value: string) {
  const hash = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function intentTarget(intent: Operation) {
  return intent.action === 'create' ? intent.codeDigest : intent.requestId;
}

function readIntents(scope: string, isMember: boolean): Intent[] {
  const raw = window.localStorage.getItem(scope);
  if (raw === null) return [];
  const stored: unknown = JSON.parse(raw);
  // 舊版本只保存單筆；第一次更新時保留原 Key 並改存清單。
  const keys = new Set<string>();
  const targets = new Set<string>();
  return (Array.isArray(stored) ? stored : [stored]).map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('無法讀取待確認核銷紀錄。');
    const intent = item as Partial<Intent>;
    if (!isResourceId(intent.key)) throw new Error('無法讀取待確認核銷紀錄。');
    let parsed: Intent;
    if (!isMember && intent.action === 'create' && typeof intent.codeDigest === 'string'
      && /^[a-f0-9]{64}$/.test(intent.codeDigest)) {
      parsed = { key: intent.key, action: 'create', codeDigest: intent.codeDigest };
    } else if (intent.action === 'confirm' || intent.action === 'reject' || intent.action === 'cancel') {
      if (isMember === (intent.action === 'cancel') || !isResourceId(intent.requestId)) {
        throw new Error('無法讀取待確認核銷紀錄。');
      }
      parsed = { key: intent.key, action: intent.action, requestId: intent.requestId };
    } else {
      throw new Error('無法讀取待確認核銷紀錄。');
    }
    const target = intentTarget(parsed);
    if (keys.has(parsed.key) || targets.has(target)) throw new Error('無法讀取待確認核銷紀錄。');
    keys.add(parsed.key);
    targets.add(target);
    return parsed;
  });
}

function requestPath(id: string) {
  return `redemption-requests/${encodeURIComponent(id)}`;
}

function RequestDetails({ row }: { row: RequestRow }) {
  return (
    <>
      <h4>{row.offerName}</h4>
      <dl>
        <div><dt>狀態</dt><dd>{statuses[row.status]}</dd></div>
        <div><dt>品牌</dt><dd>{row.brandName}</dd></div>
        <div><dt>持有券 ID</dt><dd>{row.voucherId}</dd></div>
        <div><dt>核銷請求 ID</dt><dd>{row.requestId}</dd></div>
        {row.initiatorDisplayName !== undefined && <div><dt>發起管理員</dt><dd>{row.initiatorDisplayName}</dd></div>}
        <div><dt>提出時間</dt><dd><time dateTime={row.createdAt}>{taipeiTime.format(new Date(row.createdAt))}</time></dd></div>
        <div><dt>截止時間</dt><dd><time dateTime={row.expiresAt}>{taipeiTime.format(new Date(row.expiresAt))}</time></dd></div>
        {row.resolvedAt && <div><dt>結束時間</dt><dd><time dateTime={row.resolvedAt}>{taipeiTime.format(new Date(row.resolvedAt))}</time></dd></div>}
      </dl>
    </>
  );
}

export function Redemptions({ brand, active, actor, memberNumber, sessionInterrupted, onAccessDenied }: {
  brand: { id: string; name: string };
  active: boolean;
  actor: string;
  memberNumber: string | null;
  sessionInterrupted: () => boolean;
  onAccessDenied: () => void;
}) {
  const isMember = memberNumber !== null;
  const [code, setCode] = useState('');
  const [lookupId, setLookupId] = useState('');
  const [query, setQuery] = useState<ReadQuery | null>(() => isMember ? { target: 1 } : null);
  const [readResult, setReadResult] = useState<ReadResult | null>(null);
  const [storage, setStorage] = useState<Pending | null>();
  const [sending, setSending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [feedback, setFeedback] = useState<Notice | null>(null);
  const [lookupNotice, setLookupNotice] = useState<Notice | null>(null);
  const write = useRef<AbortController | null>(null);
  const read = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  // 身分重新驗證後，需重新讀取才能顯示請求和動作。
  if (!active && readResult) setReadResult(null);
  const scopeBrand = encodeURIComponent(brand.id);
  const intents = storage?.intents ?? [];
  const pendingCreates = intents.filter(({ action }) => action === 'create');
  const pendingResolutions = intents.filter((intent) => intent.action !== 'create');
  const retryChoices = pendingResolutions.length + Number(pendingCreates.length > 0);
  const currentRead = active && readResult?.query === query ? readResult : null;
  const page = currentRead && 'data' in currentRead ? currentRead.data : null;
  const target = query?.target;
  const readBusy = query !== null && currentRead === null;
  const canWrite = !!storage && !sending;

  useEffect(() => {
    heading.current?.focus();
    return () => write.current?.abort();
  }, []);

  useEffect(() => {
    let disposed = false;
    let scope: string | undefined;
    function sync() {
      if (disposed || !scope) return;
      try {
        setStorage({ scope, intents: readIntents(scope, isMember) });
      } catch {
        setStorage(null);
      }
    }
    function onStorage(event: StorageEvent) {
      if (event.key === scope || event.key === null) sync();
    }
    async function prepare() {
      try {
        if (!navigator.locks || !isResourceId(brand.id)) throw new Error();
        // 同一帳號重新登入可讀回操作；不保存帳號、券碼或登入憑證。
        scope = `membership-rewards:pending-redemption:v1:${await digest(JSON.stringify([actor, memberNumber, brand.id]))}`;
        sync();
      } catch {
        if (!disposed) setStorage(null);
      }
    }
    window.addEventListener('storage', onStorage);
    void prepare();
    return () => {
      disposed = true;
      window.removeEventListener('storage', onStorage);
    };
  }, [actor, brand.id, isMember, memberNumber]);

  const select = useCallback((target: string | number | null) => {
    read.current?.abort();
    setQuery(target === null ? null : { target });
  }, []);

  useEffect(() => {
    if (!active || !query) return;
    const controller = new AbortController();
    read.current = controller;
    async function load(currentQuery: ReadQuery) {
      const { target } = currentQuery;
      const result = await apiRequest(typeof target === 'number'
        ? `me/redemption-requests?brandId=${scopeBrand}&page=${target}` : requestPath(target),
      controller.signal, { expectedActor: actor });
      if (controller.signal.aborted) return;
      if (sessionInterrupted()) {
        // 短暫的驗證可能未更新畫面；保留查詢目標供使用者重新讀取。
        setReadResult({ query: currentQuery, notice: { kind: 'status', message: '請在確認登入後重新讀取核銷請求。' } });
        return;
      }
      let data: RequestPage | undefined;
      if (result.status === 200) {
        if (typeof target === 'number' && isRequestPage(result.body, brand.id)) data = result.body;
        if (typeof target === 'string' && isRequestRow(result.body, brand.id, isMember) && result.body.requestId === target) {
          data = { items: [result.body], hasNext: false };
        }
      }
      if (data) {
        setReadResult({ query: currentQuery, data, receivedAt: performance.now(), serverTime: result.serverTime });
      } else {
        const notice = result.status === 200 && typeof target === 'string'
          ? { kind: 'alert' as const, message: '無法讀取此品牌的核銷請求。' }
          : errorNotice(result, '暫時無法讀取核銷請求。');
        setReadResult({ query: currentQuery, notice });
        if (result.status === 401 || result.status === 403) onAccessDenied();
      }
    }
    void load(query);
    return () => {
      controller.abort();
      if (read.current === controller) read.current = null;
    };
  }, [active, actor, brand.id, isMember, onAccessDenied, query, refresh, scopeBrand, sessionInterrupted]);

  useEffect(() => {
    if (!currentRead || !('data' in currentRead)) return;
    const pendingRows = currentRead.data.items.filter(({ status }) => status === 'PENDING');
    if (!pendingRows.length) return;
    // HTTP Date 只用來安排重讀；保留目前查詢畫面，等伺服器判定請求狀態。
    const expiresAt = Math.min(...pendingRows.map((row) => Date.parse(row.expiresAt)));
    const delay = currentRead.serverTime === undefined ? 5000
      : Math.max(1000, currentRead.receivedAt + expiresAt - currentRead.serverTime - performance.now());
    const controller = read.current;
    const timer = window.setTimeout(() => {
      if (controller && !controller.signal.aborted && read.current === controller) setRefresh((value) => value + 1);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [currentRead]);

  async function send(submission: Submission) {
    if (!active || !storage || write.current || sessionInterrupted()) return;
    const { action } = submission;
    const retryKeys = action === 'create' ? submission.retryKeys
      : submission.retryKey === undefined ? undefined : [submission.retryKey];
    const controller = new AbortController();
    const { signal } = controller;
    const isCurrent = () => !signal.aborted && !sessionInterrupted();
    write.current = controller;
    setSending(true);
    setFeedback(null);
    const { scope } = storage;
    let dispatched = false;
    try {
      if (action === 'create' && !isResourceId(code)) {
        codeInput.current?.focus();
        setFeedback({ kind: 'alert', message: '請輸入完整券碼。' });
        return;
      }
      // 同一分頁鎖保護整份紀錄；鎖忙碌時不排隊，避免稍後以舊畫面建立操作。
      await navigator.locks.request(scope, { ifAvailable: true }, async (lock) => {
        if (!isCurrent()) return;
        if (!lock) {
          setFeedback({ kind: 'status', message: '其他分頁正在處理核銷。請稍後重新讀取，再確認待處理的操作。' });
          return;
        }
        const normalizedCode = code.toLowerCase();
        const operation: Operation = action === 'create' ? { action, codeDigest: await digest(normalizedCode) }
          : { action, requestId: submission.requestId };
        if (!isCurrent()) return;
        const current = readIntents(scope, isMember);
        setStorage({ scope, intents: current });
        const existing = current.find((intent) => intentTarget(intent) === intentTarget(operation));
        if (retryKeys && (existing?.action !== action || !retryKeys.includes(existing.key))) {
          if (action === 'create') codeInput.current?.focus();
          setFeedback({ kind: 'alert', message: action === 'create'
            ? '這個券碼沒有待確認操作。請輸入原操作的完整券碼。'
            : '待確認紀錄已變更。請重新讀取核銷請求。' });
          return;
        }
        if (!retryKeys && existing) {
          setFeedback({ kind: 'alert', message: '此目標已有待確認操作，請重試同一次操作。' });
          return;
        }
        const intent = existing ?? { ...operation, key: window.crypto.randomUUID() };
        if (!existing) {
          const intents = [...current, intent];
          window.localStorage.setItem(scope, JSON.stringify(intents));
          setStorage({ scope, intents });
        }
        const path = intent.action === 'create' ? `brands/${scopeBrand}/redemption-requests`
          : `${requestPath(intent.requestId)}/${intent.action}`;
        dispatched = true;
        const result = await apiRequest(path, signal, {
          method: 'POST', input: intent.action === 'create' ? { code: normalizedCode } : {},
          expectedActor: actor, idempotencyKey: intent.key,
        });
        if (!isCurrent()) return;
        const receipt = result.status === 201 && isRequestRow(result.body, brand.id, isMember)
          && 'operationId' in result.body && isResourceId(result.body.operationId)
          && result.body.status === actions[intent.action].status
          && (intent.action === 'create' || result.body.requestId === intent.requestId) ? result.body : null;
        const failure = errorNotice(result, '暫時無法處理核銷。');
        const knownConflict = result.status === 409 && failure.code !== undefined && conflicts.has(failure.code);
        const knownPreKey = !retryKeys && failure.code !== undefined && preKeyErrors[result.status] === failure.code;

        if (receipt || knownConflict || knownPreKey) {
          // 目前的查詢或權限錯誤不能證明舊寫入未提交；只在取得確定結果時清除。
          const remaining = readIntents(scope, isMember).filter((item) => item.key !== intent.key);
          if (remaining.length) window.localStorage.setItem(scope, JSON.stringify(remaining));
          else window.localStorage.removeItem(scope);
          setStorage({ scope, intents: remaining });
        }
        if (receipt) {
          setFeedback({ kind: 'status',
            message: `本次操作結果：${statuses[receipt.status]}。核銷請求 ID ${receipt.requestId}。` });
          if (intent.action === 'create') setCode('');
          setLookupNotice(null);
          heading.current?.focus();
          if (!isMember) {
            setLookupId(receipt.requestId);
            select(receipt.requestId);
          } else {
            select(target ?? 1);
          }
        } else {
          setFeedback(knownConflict || knownPreKey ? failure : {
            ...failure, message: `${failure.message} 本次操作結果尚未確認；可先重新讀取，再重試同一次操作。`,
          });
          if (knownConflict && intent.action !== 'create') {
            if (isMember) select(target ?? 1);
            else {
              setLookupId(intent.requestId);
              select(intent.requestId);
            }
          }
          if (result.status === 401 || result.status === 403) onAccessDenied();
        }
      });
    } catch {
      if (isCurrent()) {
        setFeedback({ kind: 'alert', message: dispatched
          ? '暫時無法更新待確認紀錄，請重新讀取並重試同一次操作。'
          : '無法保存待確認紀錄，這次操作尚未送出。' });
      }
    } finally {
      if (write.current === controller) {
        write.current = null;
        if (!signal.aborted) setSending(false);
      }
    }
  }

  function lookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (write.current || sessionInterrupted()) return;
    if (!isResourceId(lookupId)) {
      select(null);
      setLookupNotice({ kind: 'alert', message: '請輸入完整核銷請求 ID。' });
      return;
    }
    setLookupNotice(null);
    select(lookupId.toLowerCase());
  }

  return (
    <section className="redemptions" id="brand-redemptions" aria-labelledby="redemptions-title">
      <h3 id="redemptions-title" ref={heading} tabIndex={-1}>「{brand.name}」核銷請求</h3>
      <p className="hint">核銷請求時間以 Asia/Taipei 顯示。</p>
      {storage === null && <NoticeBox notice={{ kind: 'alert', message: '無法存取待確認紀錄，目前無法送出核銷操作。' }} />}
      {feedback && <NoticeBox notice={feedback} />}
      {!isMember && (
        <form className="brand-form" method="post" onSubmit={(event) => {
          event.preventDefault();
          if (canWrite) void send({ action: 'create' });
        }}>
          <label htmlFor="redemption-code">完整券碼</label>
          <input id="redemption-code" name="code" ref={codeInput} required autoComplete="off" autoCapitalize="none"
            spellCheck={false} value={code} readOnly={sending}
            aria-describedby={pendingCreates.length ? 'redemption-create-recovery' : undefined}
            onChange={(event) => setCode(event.currentTarget.value)} />
          <div className="brand-actions">
            <button type="submit" disabled={!canWrite}>提出核銷</button>
          </div>
        </form>
      )}
      {!!pendingCreates.length && <div>
        <p id="redemption-create-recovery">有 {pendingCreates.length} 筆提出核銷的結果尚未確認。請輸入原操作的完整券碼，再重試。</p>
        <div className="brand-actions">
          <button type="button" disabled={!canWrite}
            aria-label={retryChoices > 1 ? '重試同一次操作：提出核銷' : undefined}
            onClick={() => void send({ action: 'create', retryKeys: pendingCreates.map(({ key }) => key) })}>重試同一次操作</button>
        </div>
      </div>}
      {pendingResolutions.map(({ key, action, requestId }) => (
        <div key={key}>
          <p>待確認操作：{actions[action].label}。核銷請求 ID {requestId}。</p>
          <div className="brand-actions">
            <button type="button" disabled={!canWrite}
              aria-label={retryChoices > 1 ? `重試同一次操作：${actions[action].label}（核銷請求 ID ${requestId}）` : undefined}
              onClick={() => void send({ action, requestId, retryKey: key })}>重試同一次操作</button>
            {requestId !== target && <button type="button" disabled={sending}
              aria-label={pendingResolutions.length > 1 ? `查看待確認操作的請求（核銷請求 ID ${requestId}）` : undefined}
              onClick={() => {
                if (!isMember) setLookupId(requestId);
                setLookupNotice(null);
                select(requestId);
              }}>查看待確認操作的請求</button>}
          </div>
        </div>
      ))}
      {sending && <p role="status">送出核銷操作中…</p>}
      {!isMember && (
        <form className="brand-form" method="post" onSubmit={lookup}>
          <label htmlFor="redemption-id">核銷請求 ID</label>
          <input id="redemption-id" name="requestId" required autoComplete="off" autoCapitalize="none"
            spellCheck={false} value={lookupId} readOnly={sending} onChange={(event) => {
              if (write.current) return;
              setLookupId(event.currentTarget.value);
              setLookupNotice(null);
              select(null);
            }} />
          <div className="brand-actions">
            <button type="submit" disabled={sending}>查詢核銷請求</button>
          </div>
        </form>
      )}
      {lookupNotice && <NoticeBox notice={lookupNotice} />}
      {readBusy && <p role="status">讀取核銷請求中…</p>}
      {currentRead && 'notice' in currentRead && <NoticeBox notice={currentRead.notice} />}
      {page && (page.items.length ? (
        <ul className="brand-list offers-list">
          {page.items.map((row) => {
            const blocked = !canWrite || pendingResolutions.some(({ requestId }) => requestId === row.requestId);
            const resolve = (action: Resolution) => {
              if (!blocked) void send({ action, requestId: row.requestId });
            };
            return (
              <li key={row.requestId}>
                <RequestDetails row={row} />
                {row.status === 'PENDING' && (
                  <div className="brand-actions">
                    {isMember ? <>
                      <button type="button" disabled={blocked} onClick={() => resolve('confirm')}>確認核銷</button>
                      <button type="button" disabled={blocked} onClick={() => resolve('reject')}>拒絕核銷</button>
                    </> : <button type="button" disabled={blocked} onClick={() => resolve('cancel')}>取消核銷請求</button>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : <p>此頁沒有核銷請求。</p>)}
      {typeof target === 'number' && (target > 1 || page?.hasNext) && (
        <nav className="brand-actions" aria-label="核銷請求分頁">
          <button type="button" disabled={target === 1 || sending || readBusy} onClick={() => select(target - 1)}>上一頁</button>
          <p role="status">第 {target} 頁</p>
          <button type="button" disabled={!page?.hasNext || sending} onClick={() => select(target + 1)}>下一頁</button>
        </nav>
      )}
      {isMember && typeof target === 'string' && <div className="brand-actions">
        <button type="button" disabled={sending} onClick={() => select(1)}>返回核銷請求清單</button>
      </div>}
      {target !== undefined && <div className="brand-actions">
        <button type="button" disabled={sending} onClick={() => select(target)}>重新讀取核銷請求</button>
      </div>}
    </section>
  );
}
