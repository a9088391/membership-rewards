import { useCallback, useEffect, useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import { apiRequest, errorNotice, isResourceId, NoticeBox, type Notice } from './request';

const maxPoints = 2147483647;
const ledgerTime = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei', dateStyle: 'medium', timeStyle: 'medium', hourCycle: 'h23',
});

type Member = { memberNumber: string; displayName: string };
type LedgerEntry = {
  id: string;
  amount: number;
  createdAt: string;
  actorDisplayName: string;
} & ({ source: 'SEED' | 'GRANT'; reason: string } | { source: 'EXCHANGE'; reason: null }
  | { source: 'REVERSAL'; reason: string; reversalOfId: string });
type Ledger = { balance: number; items: LedgerEntry[]; hasNext: boolean };
type Grant = { key: string; points: number; reason: string; grantId?: never };
type ReversalDraft = { grantId: string; points: number; reason: string };
type Reversal = ReversalDraft & { key: string };
type Operation = 'grant' | 'reversal';
type PointStorageKeys = Record<Operation, string>;
type PointStorage = {
  keys: PointStorageKeys;
  grant?: Grant | null;
  reversal?: Reversal | null;
};
type Feedback = { notice: Notice; intentKey?: string; needsRetry?: boolean };
type Draft = { search: string; memberNumber: string | null; points: string; reason: string };
const emptyDraft: Draft = { search: '', memberNumber: null, points: '', reason: '' };
const operationName = { grant: '加點', reversal: '撤回' };

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function isBalance(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= maxPoints;
}

function isLedgerEntry(value: unknown): value is LedgerEntry {
  const entry = object(value);
  return !!entry && typeof entry.id === 'string' && typeof entry.amount === 'number'
    && (entry.source === 'EXCHANGE' || entry.source === 'REVERSAL'
      ? entry.amount < 0 && isBalance(-entry.amount) && (entry.source === 'EXCHANGE'
        ? entry.reason === null : typeof entry.reason === 'string' && isResourceId(entry.reversalOfId))
      : (entry.source === 'SEED' || entry.source === 'GRANT')
        && entry.amount > 0 && isBalance(entry.amount) && typeof entry.reason === 'string')
    && typeof entry.createdAt === 'string' && Number.isFinite(Date.parse(entry.createdAt))
    && typeof entry.actorDisplayName === 'string';
}

function isLedger(value: unknown): value is Ledger {
  const result = object(value);
  return !!result && isBalance(result.balance) && typeof result.hasNext === 'boolean'
    && Array.isArray(result.items) && result.items.every(isLedgerEntry);
}

function isPointResult(value: unknown, operation: Operation) {
  const result = object(value);
  return !!result && isResourceId(result.operationId) && isBalance(result.balance)
    && isResourceId(operation === 'grant' ? result.grantId : result.reversalId);
}

function isReason(value: unknown): value is string {
  return typeof value === 'string' && value.isWellFormed() && value === value.trim()
    && value.length > 0 && [...value].length <= 200 && !/\p{Cc}/u.test(value);
}

function readPendingGrant(key: string): Grant | null {
  const stored = window.localStorage.getItem(key);
  if (stored === null) return null;

  const pending = object(JSON.parse(stored));
  if (!pending || !isResourceId(pending.key)
      || !isBalance(pending.points) || pending.points === 0 || !isReason(pending.reason)) {
    throw new Error('無法讀取待確認加點紀錄。');
  }
  return { key: pending.key, points: pending.points, reason: pending.reason };
}

function readPendingReversal(key: string): Reversal | null {
  const raw = window.localStorage.getItem(key);
  if (raw === null) return null;

  const pending = object(JSON.parse(raw));
  if (!pending || !isResourceId(pending.key) || !isResourceId(pending.grantId)
      || !isBalance(pending.points) || pending.points === 0 || !isReason(pending.reason)) {
    throw new Error('無法讀取待確認撤回紀錄。');
  }
  return { key: pending.key, grantId: pending.grantId, points: pending.points, reason: pending.reason };
}

function readPointStorage(keys: PointStorageKeys): PointStorage {
  const storage: PointStorage = { keys };
  try {
    storage.grant = readPendingGrant(keys.grant);
  } catch { /* 只停用無法讀取的操作。 */ }
  try {
    storage.reversal = readPendingReversal(keys.reversal);
  } catch { /* 只停用無法讀取的操作。 */ }
  return storage;
}

function sameIntent(current: Grant | Reversal | null, intent: Grant | Reversal) {
  return current?.key === intent.key && current.points === intent.points && current.reason === intent.reason
    && current.grantId === intent.grantId;
}

async function pointStorageKeys(actor: string, brandId: string, memberNumber: string): Promise<PointStorageKeys> {
  if (!window.navigator.locks) throw new Error('瀏覽器不支援同步待確認點數操作。');
  // 以已驗證帳號的雜湊區隔待確認紀錄，避免保存原始登入帳號。
  const hash = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(actor));
  const actorKey = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const scope = `${actorKey}:${brandId}:${memberNumber}`;
  return { grant: `membership-rewards:pending-grant:v1:${scope}`, reversal: `membership-rewards:pending-reversal:v1:${scope}` };
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
  const [activity, setActivity] = useState<'loading' | Operation | null>(null);
  const [readNotice, setReadNotice] = useState<Notice | null>(null);
  const [feedback, setFeedback] = useState<Partial<Record<Operation, Feedback>>>({});
  const [storageKeys, setStorageKeys] = useState<PointStorageKeys | null>(null);
  const [storageSnapshot, setStorage] = useState<PointStorage | null>(null);
  const [reversalDraft, setReversalDraft] = useState<ReversalDraft | null>(null);
  const request = useRef<AbortController | null>(null);
  const ledgerRead = useRef<{ scope: PointStorageKeys | null; version: number }>({ scope: null, version: 0 });
  const heading = useRef<HTMLHeadingElement>(null);
  const reversalReason = useRef<HTMLTextAreaElement>(null);
  const reversalTrigger = useRef<HTMLButtonElement>(null);
  const brandPath = `brands/${encodeURIComponent(brand.id)}`;
  const subjectPath = isMember ? `${brandPath}/me`
    : member ? `${brandPath}/members/${encodeURIComponent(member.memberNumber)}` : null;
  // 舊會員的分頁事件可能晚到；只顯示或送出目前查詢範圍的待確認操作。
  const storage = storageSnapshot?.keys === storageKeys ? storageSnapshot : null;
  const pending = storage?.grant;
  const pendingReversal = storage?.reversal;
  const displayedReversal = pendingReversal ?? reversalDraft;
  const busy = activity !== null;

  const isCurrent = useCallback((signal: AbortSignal) =>
    !signal.aborted && !sessionInterrupted(), [sessionInterrupted]);

  const run = useCallback(async (
    next: 'loading' | Operation,
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
    ledgerRead.current.scope = null;
    ledgerRead.current.version += 1;
    setMember(null);
    setLedger(null);
    setStorageKeys(null);
    setStorage(null);
    setReversalDraft(null);
    setDraft((previous) => ({ ...emptyDraft, search: previous.search }));
    setReadNotice(null);
    setFeedback({});
  }, [setDraft]);

  const loadLedger = useCallback(async (path: string, page: number, signal: AbortSignal) => {
    const version = ledgerRead.current.version;
    setReadNotice(null);
    const result = await apiRequest(`${path}/ledger?page=${page}`, signal, { expectedActor: actor });
    if (!isCurrent(signal) || version !== ledgerRead.current.version) return;
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
    if (result.status !== 200 || !target || !isResourceId(target.memberNumber)
        || target.memberNumber !== memberNumber.toLowerCase()
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
    const keys = await pointStorageKeys(actor, brand.id, match.memberNumber).catch(() => null);
    if (!isCurrent(signal)) return;
    ledgerRead.current.scope = keys;
    setMember(match);
    setStorageKeys(keys);
    setDraft((previous) => ({ ...previous, memberNumber: match.memberNumber }));
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

  useEffect(() => {
    if (!storageKeys) return;
    function sync(event?: StorageEvent) {
      if (!storageKeys || storageKeys !== ledgerRead.current.scope || sessionInterrupted()) return;
      if (event && event.key !== null && event.key !== storageKeys.grant && event.key !== storageKeys.reversal) return;
      const current = readPointStorage(storageKeys);
      setStorage(current);
      if (event) {
        if (event.key !== null && event.oldValue !== null && event.newValue === null) {
          // 另一分頁移除紀錄未證明成功，先讓舊流水與尚未回來的查詢失效。
          ledgerRead.current.version += 1;
          setLedger(null);
          setReadNotice({
            kind: 'status', message: '待確認紀錄已在其他分頁移除。請重新讀取流水確認目前餘額與異動。',
          });
        }
        setFeedback((previous) => {
          const next = { ...previous };
          if (event.key !== storageKeys.reversal && previous.grant?.intentKey !== current.grant?.key) delete next.grant;
          if (event.key !== storageKeys.grant && previous.reversal?.intentKey !== current.reversal?.key) delete next.reversal;
          return next;
        });
      }
    }
    window.addEventListener('storage', sync);
    sync();
    return () => window.removeEventListener('storage', sync);
  }, [sessionInterrupted, storageKeys]);

  const selectedGrantId = reversalDraft?.grantId;
  useEffect(() => {
    if (selectedGrantId) reversalReason.current?.focus();
  }, [selectedGrantId]);

  function lookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.current || sessionInterrupted()) return;
    if (!isResourceId(search)) {
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

  function showFeedback(operation: Operation, value?: Feedback) {
    setFeedback((previous) => ({ ...previous, [operation]: value }));
  }

  function submitPointAction(event: FormEvent<HTMLFormElement>, operation: Operation) {
    event.preventDefault();
    if (!member || !subjectPath || !storage || request.current || sessionInterrupted()) return;

    const retry = storage[operation];
    if (retry === undefined) return;
    const name = operationName[operation];
    const selection = operation === 'reversal' ? displayedReversal : null;
    if (operation === 'reversal' && !selection) return;
    const amount = retry?.points ?? selection?.points ?? Number(points);
    const justification = retry?.reason ?? (selection?.reason ?? reason).trim();
    if (!retry && operation === 'grant' && (!/^[0-9]+$/.test(points) || !isBalance(amount) || amount === 0)) {
      showFeedback(operation, { notice: { kind: 'alert', message: '請輸入 1 至 2,147,483,647 的整數點數。' } });
      return;
    }
    if (!isReason(justification)) {
      showFeedback(operation, { notice: {
        kind: 'alert', message: '原因去除首尾空白後須為 1 至 200 個字元，且不得含控制字元。',
      } });
      return;
    }

    void run(operation, async (signal) => {
      const { keys } = storage;
      let intent: Grant | Reversal | null | undefined;
      try {
        // 兩種操作共用既有加點鎖；比對與保留在鎖內，網路請求可在鎖外重試。
        intent = await navigator.locks.request<Grant | Reversal | null | undefined>(keys.grant, { signal }, () => {
          if (!isCurrent(signal)) return undefined;
          const current = readPointStorage(keys);
          const saved = current[operation];
          if (saved === undefined) throw new Error('無法讀取待確認紀錄。');
          if (retry || saved) {
            setStorage(current);
            return retry && sameIntent(saved, retry) ? retry : null;
          }
          const input = { key: window.crypto.randomUUID(), points: amount, reason: justification };
          const next = selection ? { ...input, grantId: selection.grantId } : input;
          window.localStorage.setItem(keys[operation], JSON.stringify(next));
          setStorage({ ...current, [operation]: next });
          return next;
        });
      } catch {
        if (isCurrent(signal)) {
          showFeedback(operation, { intentKey: retry?.key, needsRetry: !!retry, notice: {
            kind: 'alert', message: '無法保存待確認紀錄，這次請求尚未送出。',
          } });
        }
        return;
      }
      if (intent === undefined || !isCurrent(signal)) return;
      if (!intent) {
        if (retry) {
          showFeedback(operation, { notice: {
            kind: 'status', message: '待確認紀錄已由其他分頁處理。請查看重新讀取的流水確認結果。',
          } });
          setLedger(null);
          setActivity('loading');
          await loadLedger(subjectPath, 1, signal);
        }
        return;
      }

      const reversal = intent.grantId ? intent : null;
      if (operation === 'grant') setDraft((previous) => ({ ...previous, points: '', reason: '' }));
      else setReversalDraft(null);
      showFeedback(operation);
      const result = await apiRequest(
        reversal ? `${brandPath}/grants/${encodeURIComponent(reversal.grantId)}/reversal` : `${subjectPath}/grants`,
        signal, {
          method: 'POST', expectedActor: actor, idempotencyKey: intent.key,
          input: reversal ? { reason: reversal.reason } : { points: intent.points, reason: intent.reason },
        },
      );
      if (!isCurrent(signal)) return;

      const success = result.status === 201 && isPointResult(result.body, operation);
      const failure = errorNotice(result, `暫時無法${name}。`);
      const conflict = result.status === 409 && failure.code === 'IDEMPOTENCY_CONFLICT';
      const alreadyReversed = operation === 'reversal' && result.status === 409 && failure.code === 'ALREADY_REVERSED';
      const insufficient = operation === 'reversal' && result.status === 409 && failure.code === 'INSUFFICIENT_POINTS';
      // 目前授權或資源拒絕只描述這次請求，不能用來推斷原操作是否提交。
      if (result.status === 401 || result.status === 403) {
        onAccessDenied(failure);
        return;
      }
      if (result.status === 404) {
        clearMember();
        setReadNotice(failure);
        return;
      }
      const definitive = success || alreadyReversed || insufficient
        || (operation === 'grant' && result.status === 409 && failure.code === 'BALANCE_LIMIT_EXCEEDED')
        || (!retry && ((result.status === 400 && failure.code === 'INVALID_INPUT') || conflict));
      const settledIntent = intent;
      let cleanupFailed = false;
      let ownsFeedback = true;
      try {
        await navigator.locks.request(keys.grant, { signal }, () => {
          if (!isCurrent(signal)) return;
          const current = readPointStorage(keys);
          const saved = current[operation];
          if (saved === undefined) throw new Error('無法讀取待確認紀錄。');
          const matches = sameIntent(saved, settledIntent);
          if (definitive && matches) {
            window.localStorage.removeItem(keys[operation]);
            current[operation] = null;
          }
          ownsFeedback = !saved || matches;
          setStorage(current);
        });
      } catch {
        cleanupFailed = definitive;
      }
      if (!isCurrent(signal)) return;

      if (ownsFeedback) {
        let notice: Notice;
        if (success) {
          notice = { kind: 'status', message: `${name}已完成。` };
        } else if (definitive) {
          notice = insufficient ? { ...failure, message: `${failure.message} 補足點數後可重新送出撤回。` } : failure;
          if (!cleanupFailed) {
            if (reversal && !alreadyReversed) {
              setReversalDraft({ grantId: reversal.grantId, points: reversal.points, reason: reversal.reason });
            }
            else if (!reversal) {
              setDraft((previous) => ({ ...previous, points: String(settledIntent.points), reason: settledIntent.reason }));
            }
          }
        } else {
          notice = { ...failure, message: conflict
            ? `操作識別碼與原結果衝突，這次${name}結果仍無法確認。`
            : `這次${name}結果尚未確認。請重試同一次${name}以確認結果。` };
        }
        if (cleanupFailed) notice = { ...notice, message: `${notice.message} 待確認紀錄暫時無法清除，可重試原操作。` };
        showFeedback(operation, { notice, intentKey: settledIntent.key, needsRetry: cleanupFailed || !definitive });
      }

      if (success || alreadyReversed || insufficient) {
        // 操作結果可能是回放，畫面餘額與流水一律取自新的授權讀取。
        setLedger(null);
        setActivity('loading');
        await loadLedger(subjectPath, 1, signal);
      }
    });
  }

  function operationNotice(operation: Operation): Notice | null {
    if (activity === operation) return null;
    const current = storage?.[operation];
    const ownFeedback = feedback[operation];
    // 其他分頁可能已開始新操作；舊操作的回應和追蹤識別只屬於原 Key。
    if (current) {
      if (current.key === ownFeedback?.intentKey) return ownFeedback.notice;
      const name = operationName[operation];
      return { kind: 'alert', message: `這位會員有一筆結果待確認的${name}。請重試同一次${name}以確認結果。` };
    }
    if (ownFeedback?.needsRetry) return null;
    return ownFeedback?.notice ?? null;
  }

  const grantNotice = operationNotice('grant');
  const reversalNotice = operationNotice('reversal');
  const canGrant = storage?.grant !== undefined;
  const canReverse = storage?.reversal !== undefined;
  const pageEntries = ledger?.data.items ?? [];
  const originalIds = new Set(pageEntries.filter((entry) => entry.source === 'GRANT').map((entry) => entry.id));
  const reversedIds = new Set(pageEntries.flatMap((entry) => entry.source === 'REVERSAL' ? [entry.reversalOfId] : []));

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
      {activity && <p role="status">{activity === 'loading' ? '讀取點數資料中…' : `${operationName[activity]}送出中…`}</p>}
      {readNotice && <NoticeBox notice={readNotice} />}
      {subjectPath && (
        <section aria-labelledby="ledger-title">
          <h4 id="ledger-title">點數流水</h4>
          {ledger && (
            <>
              <p><strong>目前餘額 {ledger.data.balance.toLocaleString('zh-TW')} 點</strong></p>
              {pageEntries.length === 0 ? <p>目前沒有點數流水。</p> : (
                <ol className="brand-list">
                  {pageEntries.map((entry) => (
                    <li key={entry.id} id={`point-entry-${entry.id}`}>
                      <p>
                        <strong>{entry.amount.toLocaleString('zh-TW', { signDisplay: 'always' })} 點</strong>{' '}
                        {{ SEED: '種子點數', GRANT: '加點', EXCHANGE: '兌換', REVERSAL: '撤回加點' }[entry.source]}
                      </p>
                      {entry.source === 'GRANT' && <p className="brand-id">加點紀錄 ID {entry.id}</p>}
                      {entry.source === 'REVERSAL' && <p className="brand-id">
                        原加點紀錄 ID {originalIds.has(entry.reversalOfId)
                          ? <a href={`#point-entry-${entry.reversalOfId}`}>{entry.reversalOfId}</a> : entry.reversalOfId}
                      </p>}
                      {entry.reason !== null && <p>原因 {entry.reason}</p>}
                      <p>操作者 {entry.actorDisplayName}</p>
                      <time dateTime={entry.createdAt}>{ledgerTime.format(new Date(entry.createdAt))}（Asia/Taipei）</time>
                      {member && entry.source === 'GRANT' && !reversedIds.has(entry.id) && (
                        <button type="button" disabled={busy || !canReverse || !!pendingReversal}
                          onClick={(event) => {
                            reversalTrigger.current = event.currentTarget;
                            showFeedback('reversal');
                            setReversalDraft({ grantId: entry.id, points: entry.amount, reason: '' });
                            reversalReason.current?.focus();
                          }}>選擇撤回</button>
                      )}
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
      {member && reversalNotice && <NoticeBox notice={reversalNotice} />}
      {member && !canReverse && !busy && <NoticeBox notice={{
        kind: 'alert', message: '無法存取瀏覽器的待確認撤回紀錄，目前無法送出撤回。',
      }} />}
      {member && displayedReversal && (
        <form method="post" noValidate autoComplete="off" aria-labelledby="reversal-title"
          onSubmit={(event) => submitPointAction(event, 'reversal')}>
          <h4 id="reversal-title">整筆撤回加點</h4>
          <p>原加點 {displayedReversal.points.toLocaleString('zh-TW', { signDisplay: 'always' })} 點，將等額撤回。</p>
          <p className="brand-id">原加點紀錄 ID {displayedReversal.grantId}</p>
          <label htmlFor="reversal-reason">撤回原因</label>
          <textarea id="reversal-reason" name="reason" rows={3} required ref={reversalReason}
            readOnly={busy || !!pendingReversal} aria-describedby="reversal-reason-hint" value={displayedReversal.reason}
            onChange={(event) => {
              const { value } = event.currentTarget;
              setReversalDraft((previous) => previous && { ...previous, reason: value });
            }} />
          <p className="hint" id="reversal-reason-hint">去除首尾空白後須為 1 至 200 個字元。</p>
          <div className="brand-actions">
            <button type="submit" disabled={busy || !canReverse}>
              {pendingReversal ? '重試同一次撤回' : '確認整筆撤回'}
            </button>
            {!pendingReversal && <button type="button" disabled={busy} onClick={() => {
              setReversalDraft(null);
              showFeedback('reversal');
              const trigger = reversalTrigger.current;
              if (trigger?.isConnected) trigger.focus();
              else heading.current?.focus();
            }}>取消撤回</button>}
          </div>
        </form>
      )}
      {member && (
        <form method="post" noValidate autoComplete="off" onSubmit={(event) => submitPointAction(event, 'grant')}>
          <h4>為會員加點</h4>
          {grantNotice && <NoticeBox notice={grantNotice} />}
          {!canGrant && !busy && <NoticeBox notice={{
            kind: 'alert', message: '無法存取瀏覽器的待確認紀錄，目前無法送出加點。',
          }} />}
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
          <button type="submit" disabled={busy || !canGrant}>
            {pending ? '重試同一次加點' : '加點'}
          </button>
        </form>
      )}
    </section>
  );
}
