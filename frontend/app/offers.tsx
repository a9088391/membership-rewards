import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { RefreshIcon } from './icons';
import { useExchange } from './exchange';
import { apiRequest, errorNotice, isResourceId, NoticeBox, type Notice } from './request';

const statusLabels = {
  UPCOMING: '尚未開始',
  ACTIVE: '可兌換',
  EXPIRED: '已結束',
  STOPPED: '已停發',
} as const;

const taipeiTime = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hourCycle: 'h23',
});

type OfferDto = {
  id: string;
  name: string;
  description: string;
  points: number;
  startsAt: string;
  endsAt: string;
  stoppedAt: string | null;
  status: keyof typeof statusLabels;
};

type OfferPageDto = { items: OfferDto[]; hasNext: boolean };
const emptyDraft = { name: '', description: '', points: '', startsAt: '', endsAt: '' };
type Draft = typeof emptyDraft;
type StopTarget = Pick<OfferDto, 'id' | 'name'>;
type Review = { kind: 'create' } | { kind: 'stop'; offer: StopTarget };
type Feedback = { notice: Notice; review?: Review };
type ReadStart = { revision: number; page: number; error?: Notice };

function isTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isOfferDto(value: unknown): value is OfferDto {
  if (!value || typeof value !== 'object') return false;
  const { id, name, description, points, startsAt, endsAt, stoppedAt, status } = value as Partial<OfferDto>;
  return isResourceId(id) && typeof name === 'string' && typeof description === 'string'
    && typeof points === 'number' && Number.isInteger(points) && points > 0
    && isTime(startsAt) && isTime(endsAt) && (stoppedAt === null || isTime(stoppedAt))
    && typeof status === 'string' && Object.hasOwn(statusLabels, status);
}

function isOfferPageDto(value: unknown): value is OfferPageDto {
  return !!value && typeof value === 'object'
    && 'hasNext' in value && typeof value.hasNext === 'boolean'
    && 'items' in value && Array.isArray(value.items) && value.items.every(isOfferDto);
}

type Access = {
  actor: string;
  sessionInterrupted: () => boolean;
  onAccessDenied: () => void;
};

type Brand = { id: string; name: string };

export function Offers({ brand, active, memberNumber, actor, sessionInterrupted, onAccessDenied, retainBrand }: Access & {
  brand: Brand;
  active: boolean;
  memberNumber: string | null;
  retainBrand: (brand: Brand, retain: boolean) => void;
}) {
  const [draft, setDraft] = useState(emptyDraft);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [saving, setSaving] = useState(false);
  const [readStart, setReadStart] = useState<ReadStart>({ revision: 0, page: 1 });
  const writeRequest = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const path = `brands/${encodeURIComponent(brand.id)}/offers`;

  // 切換面板或身分重驗只卸載清單，待確認的寫入仍由原品牌元件處理。
  useEffect(() => () => writeRequest.current?.abort(), []);

  const resetRead = useCallback((page: number, error?: Notice) => {
    setReadStart((previous) => ({ revision: previous.revision + 1, page, error }));
  }, []);

  const denyRead = useCallback((page: number, error: Notice) => {
    resetRead(page, error);
    onAccessDenied();
  }, [onAccessDenied, resetRead]);

  const clearReadError = useCallback(() => {
    setReadStart((previous) => previous.error ? { ...previous, error: undefined } : previous);
  }, []);

  async function save(page: number, offer?: StopTarget) {
    if (!active || memberNumber || feedback?.review || writeRequest.current || sessionInterrupted()) return;
    const targetPage = offer ? page : 1;
    let input: Record<string, string | number> = {};
    if (!offer) {
      const points = Number(draft.points);
      // 在 JSON 數字轉換前檢查原文，避免小數因浮點精度被當成整數。
      if (!/^[0-9]+$/.test(draft.points) || !Number.isInteger(points) || points < 1 || points > 2147483647) {
        setFeedback({ notice: { kind: 'alert', message: '兌換點數須為 1 至 2,147,483,647 的整數。' } });
        return;
      }
      // 選取值一律視為台北時刻，明確附加時區，避免依裝置時區轉換。
      input = { ...draft, points, startsAt: `${draft.startsAt}+08:00`, endsAt: `${draft.endsAt}+08:00` };
    }

    const controller = new AbortController();
    writeRequest.current = controller;
    retainBrand(brand, true);
    setSaving(true);
    setFeedback(null);
    const result = await apiRequest(offer ? `${path}/${encodeURIComponent(offer.id)}/stop` : path, controller.signal, {
      method: 'POST', input, expectedActor: actor,
    });
    if (controller.signal.aborted) return;
    writeRequest.current = null;
    setSaving(false);

    if (result.status === (offer ? 200 : 201) && isOfferDto(result.body)
      && (!offer || (result.body.id === offer.id && result.body.status === 'STOPPED'))) {
      if (!offer) setDraft(emptyDraft);
      setFeedback({ notice: {
        kind: 'status', message: offer ? `已停發「${result.body.name}」。` : `已上架「${result.body.name}」。`,
      } });
      resetRead(targetPage);
      retainBrand(brand, false);
      return;
    }

    const failure = errorNotice(result, '暫時無法處理優惠券方案。');
    if (result.status === 401 || result.status === 403) {
      resetRead(targetPage, failure);
      if (!sessionInterrupted()) onAccessDenied();
    } else if (result.status === 404) {
      resetRead(targetPage, {
        ...failure, message: '找不到可存取的優惠券方案或品牌。請重讀清單，或回品牌清單選擇其他品牌。',
      });
    } else if (result.status === 400) {
      setFeedback({ notice: {
        ...failure,
        message: offer ? '無法停發方案。請重新讀取方案清單後再試。'
          : '無法上架方案。請確認名稱、純文字優惠內容、整數點數及台北起訖時間。開始須早於截止，截止須在未來。',
      } });
    } else {
      setFeedback({
        notice: {
          ...failure,
          message: offer
            ? `無法確認「${offer.name}」是否已停發。請重讀清單並確認原方案的狀態。`
            : '無法確認方案是否已上架。草稿已保留。請從清單第一頁核對新上架的方案；若找到這次建立的方案，請避免重複上架。',
        },
        review: offer ? { kind: 'stop', offer } : { kind: 'create' },
      });
      resetRead(targetPage);
      return;
    }
    retainBrand(brand, false);
  }

  return active ? (
    <section className="offers" id="brand-offers" aria-labelledby="offers-title">
      <h3 id="offers-title" ref={heading} tabIndex={-1}>{brand.name}的優惠券方案</h3>
      <OfferList key={readStart.revision} readStart={readStart} path={path} actor={actor}
        brandId={brand.id} memberNumber={memberNumber} onAccessDenied={onAccessDenied}
        saving={saving} draft={draft} setDraft={setDraft} feedback={feedback}
        heading={heading} save={save} sessionInterrupted={sessionInterrupted}
        denyRead={denyRead} clearReadError={clearReadError}
        acknowledge={() => {
          setFeedback(null);
          retainBrand(brand, false);
        }} />
    </section>
  ) : null;
}

function OfferList({
  readStart, path, actor, brandId, memberNumber, saving, draft, setDraft, feedback, heading, save,
  sessionInterrupted, onAccessDenied, denyRead, clearReadError, acknowledge,
}: Access & {
  readStart: ReadStart;
  path: string;
  brandId: string;
  memberNumber: string | null;
  saving: boolean;
  draft: Draft;
  setDraft: (value: Draft) => void;
  feedback: Feedback | null;
  heading: { current: HTMLHeadingElement | null };
  save: (page: number, offer?: StopTarget) => Promise<void>;
  denyRead: (page: number, notice: Notice) => void;
  clearReadError: () => void;
  acknowledge: () => void;
}) {
  const [initialPage] = useState(readStart.page);
  const [autoRead] = useState(!readStart.error && !feedback?.review);
  const [page, setPage] = useState(initialPage);
  const [list, setList] = useState<OfferPageDto | null>(null);
  const [readError, setReadError] = useState<Notice | undefined>(readStart.error);
  const [checkedFirstPage, setCheckedFirstPage] = useState(false);
  const [loading, setLoading] = useState(autoRead);
  const request = useRef<AbortController | null>(null);
  const exchange = useExchange({ actor, memberNumber, brandId, sessionInterrupted, onAccessDenied });
  const busy = loading || saving;
  const canManage = !memberNumber && !!list;
  const review = feedback?.review;
  const reviewedStop = review?.kind === 'stop' && list?.items.find(({ id }) => id === review.offer.id);
  const reviewed = review?.kind === 'create' ? checkedFirstPage : !!reviewedStop;
  const locked = busy || !!review;

  const loadPage = useCallback(async (target: number) => {
    if (request.current || sessionInterrupted()) {
      if (!request.current) setLoading(false);
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setReadError(undefined);
    const result = await apiRequest(`${path}?page=${target}`, controller.signal, { expectedActor: actor });
    if (controller.signal.aborted) return;
    request.current = null;
    setLoading(false);
    if (sessionInterrupted()) return;
    setPage(target);

    if (result.status === 200 && isOfferPageDto(result.body)) {
      setList(result.body);
      if (target === 1) setCheckedFirstPage(true);
      clearReadError();
      return;
    }

    setList(null);
    setCheckedFirstPage(false);
    const failure = errorNotice(result, '暫時無法讀取優惠券方案。');
    if (result.status === 401 || result.status === 403) {
      denyRead(target, failure);
    } else {
      setReadError(result.status === 404 ? {
        ...failure, message: '找不到可存取的品牌方案。請重讀清單，或回品牌清單選擇其他品牌。',
      } : failure);
    }
  }, [actor, clearReadError, denyRead, path, sessionInterrupted]);

  useEffect(() => {
    heading.current?.focus();
    if (autoRead) void loadPage(initialPage);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [autoRead, heading, initialPage, loadPage]);

  function browse(target: number) {
    if (!busy) void loadPage(target);
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canManage && !locked && !request.current) void save(page);
  }

  return (
    <>
      <p className="hint">方案及持有券共用有效期間，到期不退點。時間以 Asia/Taipei 顯示。</p>
      {feedback && !saving && <NoticeBox notice={feedback.notice} />}
      {exchange.notice && <NoticeBox notice={exchange.notice} />}
      {exchange.sending && <p role="status">送出兌換中…</p>}
      {exchange.pending && (
        <button type="button" aria-disabled={exchange.sending} onClick={() => {
          if (exchange.pending) void exchange.send(exchange.pending.offerId, exchange.pending);
        }}>重試同一次兌換</button>
      )}
      {readError && <NoticeBox notice={readError} />}
      <div className="brand-actions">
        <button type="button" aria-disabled={busy}
          onClick={() => browse(review?.kind === 'create' ? 1 : page)}><RefreshIcon />重新讀取方案清單</button>
        {canManage && review && reviewed && (
          <button type="button" aria-disabled={busy} onClick={() => {
            if (busy || request.current || sessionInterrupted()) return;
            heading.current?.focus();
            acknowledge();
          }}>已檢查清單，允許新的操作</button>
        )}
      </div>
      {reviewedStop && (
        <p role="status">已讀回原方案，狀態為「{statusLabels[reviewedStop.status]}」。</p>
      )}
      {saving && <p role="status">儲存優惠券方案中…</p>}
      {loading && <p role="status">讀取優惠券方案中…</p>}
      {canManage && list.items.some(({ status }) => status !== 'STOPPED') && (
        <p className="hint" id="offer-stop-hint">停發後無法恢復發券。已發出的持有券仍依原條件使用。</p>
      )}
      {list && (
        <>
          {list.items.length ? (
            <ul className="brand-list offers-list">
              {list.items.map((offer) => (
                <li className="ticket" key={offer.id}>
                  <div className="ticket-main">
                    <div className="ticket-heading"><h4>{offer.name}</h4><span className={`status-badge status-${offer.status.toLowerCase()}`}>{statusLabels[offer.status]}</span></div>
                    <p>{offer.description}</p>
                    <dl>
                      <div><dt>開始時間</dt><dd><time dateTime={offer.startsAt}>{taipeiTime.format(new Date(offer.startsAt))}</time></dd></div>
                      <div><dt>截止時間</dt><dd><time dateTime={offer.endsAt}>{taipeiTime.format(new Date(offer.endsAt))}</time></dd></div>
                    </dl>
                    <details className="id-details"><summary>方案識別資訊</summary><p className="brand-id">方案 ID {offer.id}</p></details>
                  </div>
                  <div className="ticket-action">
                    <p className="ticket-points"><strong>{offer.points.toLocaleString('zh-TW')}</strong> 點</p>
                    {memberNumber && offer.status === 'ACTIVE' && (
                      <button type="button" aria-disabled={busy || !exchange.canExchange}
                        aria-label={`兌換：${offer.name}（${offer.points.toLocaleString('zh-TW')} 點，方案 ID ${offer.id}）`}
                        onClick={() => {
                          if (!busy && exchange.canExchange) void exchange.send(offer.id);
                        }}>兌換</button>
                    )}
                    {canManage && (
                      <>
                        {offer.status !== 'STOPPED' && (
                          <button type="button" aria-disabled={locked} aria-describedby="offer-stop-hint"
                            aria-label={`停發：${offer.name}（方案 ID ${offer.id}）`}
                            onClick={() => {
                              if (!locked && !request.current) void save(page, offer);
                            }}>停發</button>
                        )}
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : <p>此頁沒有優惠券方案。</p>}
          <p className="page-count">本頁 {list.items.length} 筆</p>
          {(page > 1 || list.hasNext) && (
            <nav className="brand-actions" aria-label="優惠券方案分頁">
              <button type="button" disabled={page === 1} aria-disabled={busy} onClick={() => browse(page - 1)}>上一頁</button>
              <p role="status">第 {page} 頁</p>
              <button type="button" disabled={!list.hasNext} aria-disabled={busy} onClick={() => browse(page + 1)}>下一頁</button>
            </nav>
          )}
        </>
      )}
      {canManage && (
        <details className="create-offer">
          <summary>建立優惠券方案</summary>
          <form className="brand-form" aria-labelledby="offer-create-title" method="post" onSubmit={create}>
            <h4 id="offer-create-title">建立優惠券方案</h4>
            <label htmlFor="offer-name">方案名稱</label>
            <input id="offer-name" name="name" value={draft.name} readOnly={locked} required
              onChange={(event) => setDraft({ ...draft, name: event.target.value })} aria-describedby="offer-name-hint" />
            <p className="hint" id="offer-name-hint">去除首尾空白後 1 至 80 個字元。</p>
            <label htmlFor="offer-description">優惠內容</label>
            <textarea id="offer-description" name="description" value={draft.description} readOnly={locked} required rows={3}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })} aria-describedby="offer-description-hint" />
            <p className="hint" id="offer-description-hint">純文字，去除首尾空白後 1 至 500 個字元。</p>
            <label htmlFor="offer-points">兌換點數</label>
            <input id="offer-points" name="points" inputMode="numeric" value={draft.points} readOnly={locked} required
              onChange={(event) => setDraft({ ...draft, points: event.target.value })} aria-describedby="offer-points-hint" />
            <p className="hint" id="offer-points-hint">1 至 2,147,483,647 的整數。</p>
            <label htmlFor="offer-starts-at">開始時間</label>
            <input id="offer-starts-at" name="startsAt" type="datetime-local" value={draft.startsAt} disabled={locked} required
              onChange={(event) => setDraft({ ...draft, startsAt: event.target.value })} aria-describedby="offer-time-hint" />
            <label htmlFor="offer-ends-at">截止時間</label>
            <input id="offer-ends-at" name="endsAt" type="datetime-local" value={draft.endsAt} disabled={locked} required
              onChange={(event) => setDraft({ ...draft, endsAt: event.target.value })} aria-describedby="offer-time-hint" />
            <p className="hint" id="offer-time-hint">
              以台北時間（Asia/Taipei，UTC+08:00）選擇日期與時間。開始須早於截止，截止須在未來。
            </p>
            <p className="hint">建立即上架。上架後方案條件固定。</p>
            <button type="submit" aria-disabled={locked}>上架方案</button>
          </form>
        </details>
      )}
    </>
  );
}
