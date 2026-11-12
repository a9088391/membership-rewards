import { useCallback, useEffect, useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import { apiRequest, errorNotice, NoticeBox, type Notice } from './request';

const maxPoints = 2147483647;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const ledgerTime = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei', dateStyle: 'medium', timeStyle: 'medium', hourCycle: 'h23',
});

type Member = { memberNumber: string; displayName: string };
type LedgerEntry = {
  id: string;
  amount: number;
  reason: string;
  source: 'SEED' | 'GRANT';
  createdAt: string;
  actorDisplayName: string;
};
type Ledger = { balance: number; items: LedgerEntry[]; hasNext: boolean };
type Grant = { key: string; points: number; reason: string };
type GrantStorage = { key: string; pending: Grant | null };
type Draft = { search: string; memberNumber: string | null; points: string; reason: string };
const emptyDraft: Draft = { search: '', memberNumber: null, points: '', reason: '' };
const pendingNotice: Notice = {
  kind: 'alert', message: '這位會員有一筆結果待確認的加點。請重試同一次加點以確認結果。',
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function isBalance(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= maxPoints;
}

function isLedgerEntry(value: unknown): value is LedgerEntry {
  const entry = object(value);
  return !!entry && typeof entry.id === 'string' && isBalance(entry.amount) && entry.amount > 0
    && typeof entry.reason === 'string' && (entry.source === 'SEED' || entry.source === 'GRANT')
    && typeof entry.createdAt === 'string' && Number.isFinite(Date.parse(entry.createdAt))
    && typeof entry.actorDisplayName === 'string';
}

function isLedger(value: unknown): value is Ledger {
  const result = object(value);
  return !!result && isBalance(result.balance) && typeof result.hasNext === 'boolean'
    && Array.isArray(result.items) && result.items.every(isLedgerEntry);
}

function isGrantResult(value: unknown) {
  const result = object(value);
  return !!result && typeof result.operationId === 'string' && uuid.test(result.operationId)
    && typeof result.grantId === 'string' && uuid.test(result.grantId) && isBalance(result.balance);
}

function isReason(value: unknown): value is string {
  return typeof value === 'string' && value.isWellFormed() && value === value.trim()
    && value.length > 0 && [...value].length <= 200 && !/\p{Cc}/u.test(value);
}

function readPendingGrant(key: string): Grant | null {
  const stored = window.localStorage.getItem(key);
  if (stored === null) return null;

  const pending = object(JSON.parse(stored));
  if (!pending || typeof pending.key !== 'string' || !uuid.test(pending.key)
      || !isBalance(pending.points) || pending.points === 0 || !isReason(pending.reason)) {
    throw new Error('無法讀取待確認加點紀錄。');
  }
  return { key: pending.key, points: pending.points, reason: pending.reason };
}

async function readGrantStorage(actor: string, brandId: string, memberNumber: string): Promise<GrantStorage> {
  if (!window.navigator.locks) throw new Error('瀏覽器不支援同步待確認加點紀錄。');
  // 以已驗證帳號的雜湊區隔待確認紀錄，避免保存原始登入帳號。
  const hash = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(actor));
  const actorKey = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const key = `membership-rewards:pending-grant:v1:${actorKey}:${brandId}:${memberNumber}`;
  return { key, pending: readPendingGrant(key) };
}

type PointsProps = {
  brand: { id: string; name: string };
  isMember: boolean;
  actor: string;
  sessionInterrupted: () => boolean;
  onAccessDenied: (notice: Notice) => void;
};

export function Points({ active, ...props }: PointsProps & { active: boolean }) {
  // 同一工作階段重新確認時只保留草稿和查詢目標，重新取得授權資料後才顯示。
  const [draft, setDraft] = useState(emptyDraft);
  return active ? <ActivePoints {...props} draft={draft} setDraft={setDraft} /> : null;
}

function ActivePoints({ brand, isMember, actor, sessionInterrupted, onAccessDenied, draft, setDraft }: PointsProps & {
  draft: Draft;
  setDraft: Dispatch<SetStateAction<Draft>>;
}) {
  const { search, points, reason } = draft;
  const [restoreMemberNumber] = useState(draft.memberNumber);
  const [member, setMember] = useState<Member | null>(null);
  const [ledger, setLedger] = useState<{ page: number; data: Ledger } | null>(null);
  const [activity, setActivity] = useState<'loading' | 'granting' | null>(null);
  const [readNotice, setReadNotice] = useState<Notice | null>(null);
  const [grantNotice, setGrantNotice] = useState<Notice | null>(null);
  const [storage, setStorage] = useState<GrantStorage | null>(null);
  const request = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const brandPath = `brands/${encodeURIComponent(brand.id)}`;
  const subjectPath = isMember ? `${brandPath}/me`
    : member ? `${brandPath}/members/${encodeURIComponent(member.memberNumber)}` : null;
  const pending = storage?.pending;
  const busy = activity !== null;

  const isCurrent = useCallback((signal: AbortSignal) =>
    !signal.aborted && !sessionInterrupted(), [sessionInterrupted]);

  const run = useCallback(async (
    next: 'loading' | 'granting',
    work: (signal: AbortSignal) => Promise<void>,
  ) => {
    if (request.current || sessionInterrupted()) return;
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
  }, [sessionInterrupted]);

  const clearMember = useCallback(() => {
    setMember(null);
    setLedger(null);
    setStorage(null);
    setDraft((previous) => ({ ...emptyDraft, search: previous.search }));
    setReadNotice(null);
    setGrantNotice(null);
  }, [setDraft]);

  const loadLedger = useCallback(async (path: string, page: number, signal: AbortSignal) => {
    setReadNotice(null);
    const result = await apiRequest(`${path}/ledger?page=${page}`, signal, { expectedActor: actor });
    if (!isCurrent(signal)) return;
    if (result.status === 200 && isLedger(result.body)) {
      setLedger({ page, data: result.body });
      return;
    }

    const notice = errorNotice(result, '暫時無法讀取點數流水。');
    if (result.status === 401 || result.status === 403) {
      onAccessDenied(notice);
      return;
    }
    if (result.status === 404) clearMember();
    setReadNotice(notice);
  }, [actor, clearMember, isCurrent, onAccessDenied]);

  const loadMember = useCallback(async (memberNumber: string, signal: AbortSignal) => {
    const path = `${brandPath}/members/${encodeURIComponent(memberNumber)}`;
    const result = await apiRequest(path, signal, { expectedActor: actor });
    if (!isCurrent(signal)) return;
    const target = object(result.body);
    if (result.status !== 200 || !target || typeof target.memberNumber !== 'string'
        || target.memberNumber !== memberNumber.toLowerCase() || !uuid.test(target.memberNumber)
        || typeof target.displayName !== 'string' || !isBalance(target.balance)) {
      const notice = errorNotice(result, '暫時無法查詢會員。');
      if (result.status === 401 || result.status === 403) {
        onAccessDenied(notice);
      } else {
        if (result.status === 404) clearMember();
        setReadNotice(notice);
      }
      return;
    }

    const match = { memberNumber: target.memberNumber, displayName: target.displayName };
    const grantStorage = await readGrantStorage(actor, brand.id, match.memberNumber).catch(() => null);
    if (!isCurrent(signal)) return;
    setMember(match);
    setStorage(grantStorage);
    setDraft((previous) => ({ ...previous, memberNumber: match.memberNumber }));
    if (!grantStorage) {
      setGrantNotice({ kind: 'alert', message: '無法存取瀏覽器的待確認紀錄，目前無法送出加點。' });
    } else if (grantStorage.pending) {
      setGrantNotice(pendingNotice);
    }
    await loadLedger(path, 1, signal);
  }, [actor, brand.id, brandPath, clearMember, isCurrent, loadLedger, onAccessDenied, setDraft]);

  useEffect(() => {
    heading.current?.focus();
    if (isMember) void run('loading', (signal) => loadLedger(`${brandPath}/me`, 1, signal));
    else if (restoreMemberNumber) void run('loading', (signal) => loadMember(restoreMemberNumber, signal));
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [brandPath, isMember, loadLedger, loadMember, restoreMemberNumber, run]);

  function lookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.current || sessionInterrupted()) return;
    if (!uuid.test(search)) {
      clearMember();
      setReadNotice({ kind: 'alert', message: '找不到此資源。請輸入完整會員編號。' });
      return;
    }

    void run('loading', (signal) => {
      clearMember();
      return loadMember(search, signal);
    });
  }

  function browse(page: number) {
    if (subjectPath) void run('loading', (signal) => loadLedger(subjectPath, page, signal));
  }

  function submitGrant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!member || !subjectPath || !storage || request.current || sessionInterrupted()) return;

    const amount = pending?.points ?? Number(points);
    const justification = pending?.reason ?? reason.trim();
    if (!pending && (!/^[0-9]+$/.test(points) || !isBalance(amount) || amount === 0)) {
      setGrantNotice({ kind: 'alert', message: '請輸入 1 至 2,147,483,647 的整數點數。' });
      return;
    }
    if (!isReason(justification)) {
      setGrantNotice({ kind: 'alert', message: '原因去除首尾空白後須為 1 至 200 個字元，且不得含控制字元。' });
      return;
    }

    void run('granting', async (signal) => {
      let reservation: { intent: Grant | null; send: boolean } | null;
      try {
        // 分頁共用一筆待確認操作。鎖只涵蓋比對和保存，網路請求可在鎖外重試。
        reservation = await navigator.locks.request(storage.key, { signal }, () => {
          if (!isCurrent(signal)) return null;
          const current = readPendingGrant(storage.key);
          if (pending || current) {
            const send = !!pending && current?.key === pending.key
              && current.points === pending.points && current.reason === pending.reason;
            return { intent: current, send };
          }
          const intent = { key: window.crypto.randomUUID(), points: amount, reason: justification };
          window.localStorage.setItem(storage.key, JSON.stringify(intent));
          return { intent, send: true };
        });
      } catch {
        if (isCurrent(signal)) {
          setGrantNotice({ kind: 'alert', message: '無法保存待確認紀錄，這次請求尚未送出。' });
        }
        return;
      }
      if (!reservation || !isCurrent(signal)) return;
      const { intent, send } = reservation;
      setStorage({ ...storage, pending: intent });
      if (!intent) {
        setDraft((previous) => ({ ...previous, points: '', reason: '' }));
        setGrantNotice({ kind: 'status', message: '待確認紀錄已清除。請查看重新讀取的流水確認結果。' });
        setLedger(null);
        setActivity('loading');
        await loadLedger(subjectPath, 1, signal);
        return;
      }
      if (!send) {
        setGrantNotice(pendingNotice);
        return;
      }

      setDraft((previous) => ({ ...previous, points: '', reason: '' }));
      setGrantNotice(null);
      const result = await apiRequest(`${subjectPath}/grants`, signal, {
        method: 'POST', expectedActor: actor, idempotencyKey: intent.key,
        input: { points: intent.points, reason: intent.reason },
      });
      if (!isCurrent(signal)) return;

      const success = result.status === 201 && isGrantResult(result.body);
      const failure = errorNotice(result, '暫時無法加點。');
      const denied = result.status === 401 || result.status === 403;
      const missing = result.status === 404;
      // 授權或資源拒絕只描述這次請求，其他分頁可能已重試並提交原操作。
      const definitive = success || (result.status === 409 && failure.code === 'BALANCE_LIMIT_EXCEEDED')
        || (!pending && (
          (result.status === 400 && failure.code === 'INVALID_INPUT')
          || (result.status === 409 && failure.code === 'IDEMPOTENCY_CONFLICT')
        ));
      let cleanupFailed = false;
      if (definitive) {
        try {
          const remaining = await navigator.locks.request(storage.key, { signal }, () => {
            const current = readPendingGrant(storage.key);
            if (current?.key !== intent.key) return current;
            window.localStorage.removeItem(storage.key);
            return null;
          });
          if (!isCurrent(signal)) return;
          setStorage({ ...storage, pending: remaining });
        } catch {
          if (!isCurrent(signal)) return;
          cleanupFailed = true;
        }
      }

      if (denied) {
        onAccessDenied(failure);
      } else if (missing) {
        clearMember();
        setReadNotice(failure);
      } else if (success) {
        setGrantNotice({
          kind: 'status', message: cleanupFailed
            ? '加點已完成。待確認紀錄暫時無法清除，可重試原操作。' : '加點已完成。',
        });
        // 201 可能是舊操作的回放；目前餘額與流水須重新從同一份讀取結果取得。
        setLedger(null);
        setActivity('loading');
        await loadLedger(subjectPath, 1, signal);
      } else if (definitive) {
        setDraft((previous) => ({ ...previous, points: String(intent.points), reason: intent.reason }));
        setGrantNotice(cleanupFailed ? {
          ...failure, message: `${failure.message} 待確認紀錄暫時無法清除。`,
        } : failure);
      } else {
        const conflict = result.status === 409 && failure.code === 'IDEMPOTENCY_CONFLICT';
        setGrantNotice({
          ...failure,
          message: conflict
            ? '操作識別碼與原結果衝突，這次加點結果仍無法確認。'
            : '這次加點結果尚未確認。請重試同一次加點以確認結果。',
        });
      }
    });
  }

  return (
    <section className="points" id="brand-points" aria-labelledby="points-title">
      <h3 id="points-title" ref={heading} tabIndex={-1}>「{brand.name}」點數</h3>
      <p className="brand-id">品牌 ID {brand.id}</p>
      {!isMember && (
        <form method="post" onSubmit={lookup}>
          <label htmlFor="points-member-number">完整會員編號</label>
          <input id="points-member-number" name="memberNumber" required autoComplete="off"
            autoCapitalize="none" spellCheck={false} value={search} readOnly={busy}
            onChange={(event) => {
              if (request.current) return;
              const { value } = event.currentTarget;
              clearMember();
              setDraft((previous) => ({ ...previous, search: value }));
            }} />
          <button type="submit" disabled={busy}>查詢會員</button>
        </form>
      )}
      {member && (
        <dl className="identity">
          <div><dt>會員顯示名稱</dt><dd>{member.displayName}</dd></div>
          <div><dt>會員編號</dt><dd>{member.memberNumber}</dd></div>
        </dl>
      )}
      {activity && <p role="status">{activity === 'loading' ? '讀取點數資料中…' : '加點送出中…'}</p>}
      {readNotice && <NoticeBox notice={readNotice} />}
      {subjectPath && (
        <section aria-labelledby="ledger-title">
          <h4 id="ledger-title">點數流水</h4>
          {ledger && (
            <>
              <p><strong>目前餘額 {ledger.data.balance.toLocaleString('zh-TW')} 點</strong></p>
              {ledger.data.items.length === 0 ? <p>目前沒有點數流水。</p> : (
                <ol className="brand-list">
                  {ledger.data.items.map((entry) => (
                    <li key={entry.id}>
                      <p><strong>+{entry.amount.toLocaleString('zh-TW')} 點</strong> {entry.source === 'SEED' ? '種子點數' : '加點'}</p>
                      <p>原因 {entry.reason}</p>
                      <p>操作者 {entry.actorDisplayName}</p>
                      <time dateTime={entry.createdAt}>{ledgerTime.format(new Date(entry.createdAt))}（Asia/Taipei）</time>
                    </li>
                  ))}
                </ol>
              )}
              {(ledger.page > 1 || ledger.data.hasNext) && (
                <nav className="brand-actions" aria-label="點數流水分頁">
                  <button type="button" disabled={busy || ledger.page === 1}
                    onClick={() => browse(ledger.page - 1)}>上一頁</button>
                  <p role="status">第 {ledger.page} 頁</p>
                  <button type="button" disabled={busy || !ledger.data.hasNext}
                    onClick={() => browse(ledger.page + 1)}>下一頁</button>
                </nav>
              )}
            </>
          )}
          <button type="button" disabled={busy} onClick={() => browse(1)}>重新讀取流水</button>
        </section>
      )}
      {member && (
        <form method="post" noValidate autoComplete="off" onSubmit={submitGrant}>
          <h4>為會員加點</h4>
          {grantNotice && <NoticeBox notice={grantNotice} />}
          <label htmlFor="grant-points">加點點數</label>
          <input id="grant-points" name="points" inputMode="numeric" required readOnly={busy || !!pending}
            aria-describedby="grant-points-hint" value={pending?.points ?? points}
            onChange={(event) => {
              const { value } = event.currentTarget;
              setDraft((previous) => ({ ...previous, points: value }));
            }} />
          <p className="hint" id="grant-points-hint">請輸入 1 至 2,147,483,647 的整數。</p>
          <label htmlFor="grant-reason">加點原因</label>
          <textarea id="grant-reason" name="reason" rows={3} required readOnly={busy || !!pending}
            aria-describedby="grant-reason-hint" value={pending?.reason ?? reason}
            onChange={(event) => {
              const { value } = event.currentTarget;
              setDraft((previous) => ({ ...previous, reason: value }));
            }} />
          <p className="hint" id="grant-reason-hint">去除首尾空白後須為 1 至 200 個字元。</p>
          <button type="submit" disabled={busy || !storage}>{pending ? '重試同一次加點' : '加點'}</button>
        </form>
      )}
    </section>
  );
}
