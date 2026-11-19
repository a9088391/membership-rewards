import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { RefreshIcon } from './icons';
import { apiRequest, errorNotice, isResourceId, NoticeBox, type Notice } from './request';

const voucherTime = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hourCycle: 'h23',
});
const maxTimeout = 2_147_483_647;
const minRefreshDelay = 1000;
const missingDateRefreshDelay = 5000;

type VoucherDto = {
  id: string;
  code: string;
  brandId: string;
  offerId: string;
  name: string;
  description: string;
  points: number;
  startsAt: string;
  endsAt: string;
  createdAt: string;
  status: 'UNUSED' | 'USED' | 'EXPIRED';
};
type VoucherPageDto = { items: VoucherDto[]; hasNext: boolean };
const voucherStatus = { UNUSED: '未使用', USED: '已核銷', EXPIRED: '已到期' } as const;

function isTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isVoucherDto(value: unknown, brandId: string): value is VoucherDto {
  if (!value || typeof value !== 'object') return false;
  const { id, code, brandId: ownerBrand, offerId, name, description, points, startsAt, endsAt, createdAt, status }
    = value as Partial<VoucherDto>;
  return ownerBrand === brandId && isResourceId(id) && isResourceId(code) && isResourceId(offerId)
    && typeof name === 'string' && typeof description === 'string'
    && typeof points === 'number' && Number.isInteger(points) && points > 0 && points <= 2147483647
    && isTime(startsAt) && isTime(endsAt) && isTime(createdAt)
    && typeof status === 'string' && Object.hasOwn(voucherStatus, status);
}

function isVoucherPageDto(value: unknown, brandId: string): value is VoucherPageDto {
  return !!value && typeof value === 'object'
    && 'hasNext' in value && typeof value.hasNext === 'boolean'
    && 'items' in value && Array.isArray(value.items) && value.items.every((item) => isVoucherDto(item, brandId));
}

export function Vouchers({ brand, actor, isMember, sessionInterrupted, onAccessDenied }: {
  brand: { id: string; name: string };
  actor: string;
  isMember: boolean;
  sessionInterrupted: () => boolean;
  onAccessDenied: (notice: Notice) => void;
}) {
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState<string | null>(null);
  const [list, setList] = useState<{ page: number; data: VoucherPageDto; readAt: number; serverTime?: number } | null>(null);
  const [loading, setLoading] = useState(isMember);
  const [notice, setNotice] = useState<Notice | null>(null);
  const request = useRef<AbortController | null>(null);
  const expiryTimer = useRef<number | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);

  const clear = useCallback(() => {
    window.clearTimeout(expiryTimer.current);
    request.current?.abort();
    request.current = null;
    setTarget(null);
    setList(null);
    setLoading(false);
    setNotice(null);
  }, []);

  const load = useCallback(async (page: number, memberNumber: string | null) => {
    if (request.current || sessionInterrupted()) {
      if (!request.current) setLoading(false);
      return;
    }
    window.clearTimeout(expiryTimer.current);
    const controller = new AbortController();
    request.current = controller;
    setTarget(memberNumber);
    setLoading(true);
    setList(null);
    setNotice(null);
    const brandId = encodeURIComponent(brand.id);
    const path = memberNumber
      ? `brands/${brandId}/members/${encodeURIComponent(memberNumber)}/vouchers?page=${page}`
      : `me/vouchers?brandId=${brandId}&page=${page}`;
    const result = await apiRequest(path, controller.signal, { expectedActor: actor });
    if (controller.signal.aborted) return;
    request.current = null;
    setLoading(false);
    if (sessionInterrupted()) return;
    if (result.status === 200 && isVoucherPageDto(result.body, brand.id)) {
      setList({ page, data: result.body, readAt: performance.now(), serverTime: result.serverTime });
    } else {
      const failure = errorNotice(result, '暫時無法讀取持有券。');
      if (result.status === 401 || result.status === 403) onAccessDenied(failure);
      else setNotice(failure);
    }
  }, [actor, brand.id, onAccessDenied, sessionInterrupted]);

  useEffect(() => {
    heading.current?.focus();
    if (isMember) void load(1, null);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [isMember, load]);

  useEffect(() => {
    if (!list) return;
    const { page, data, readAt, serverTime } = list;
    let deadline = Infinity;
    for (const voucher of data.items) {
      if (voucher.status === 'UNUSED') deadline = Math.min(deadline, Date.parse(voucher.endsAt));
    }
    if (!Number.isFinite(deadline)) return;

    // 以伺服器時間推算剩餘時間，再用單調時鐘等待，避免瀏覽器時鐘偏差。
    const readyAt = readAt + (serverTime === undefined
      ? missingDateRefreshDelay : Math.max(minRefreshDelay, deadline - serverTime));
    function schedule() {
      const delay = Math.min(maxTimeout, Math.max(0, readyAt - performance.now()));
      expiryTimer.current = window.setTimeout(() => {
        if (performance.now() < readyAt) schedule();
        else void load(page, target);
      }, delay);
    }
    schedule();
    return () => window.clearTimeout(expiryTimer.current);
  }, [list, load, target]);

  function lookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sessionInterrupted()) return;
    clear();
    if (isResourceId(search)) void load(1, search);
    else setNotice({ kind: 'alert', message: '請輸入完整會員編號。' });
  }

  return (
    <section className="vouchers" id="brand-vouchers" aria-labelledby="vouchers-title">
      <h3 id="vouchers-title" ref={heading} tabIndex={-1}>「{brand.name}」持有券</h3>
      <p className="hint">持有券時間以 Asia/Taipei 顯示。</p>
      {!isMember && (
        <form className="brand-form" method="post" onSubmit={lookup}>
          <label htmlFor="voucher-member-number">完整會員編號</label>
          <input id="voucher-member-number" name="memberNumber" required autoComplete="off"
            autoCapitalize="none" spellCheck={false} value={search} onChange={(event) => {
              clear();
              setSearch(event.currentTarget.value);
            }} />
          <button type="submit">查詢持有券</button>
        </form>
      )}
      {loading && <p role="status">讀取持有券中…</p>}
      {notice && <NoticeBox notice={notice} />}
      {list && (
        <>
          {target && <p>會員編號 {target}</p>}
          {list.data.items.length ? (
            <ul className="brand-list offers-list">
              {list.data.items.map((voucher) => (
                <li className="voucher-card" key={voucher.id}>
                  <div className="ticket-heading"><h4>{voucher.name}</h4><span className="status-badge">{voucherStatus[voucher.status]}</span></div>
                  <p>{voucher.description}</p>
                  <dl>
                    <div><dt>兌換點數</dt><dd>{voucher.points.toLocaleString('zh-TW')}</dd></div>
                    <div><dt>開始時間</dt><dd><time dateTime={voucher.startsAt}>{voucherTime.format(new Date(voucher.startsAt))}</time></dd></div>
                    <div><dt>截止時間</dt><dd><time dateTime={voucher.endsAt}>{voucherTime.format(new Date(voucher.endsAt))}</time></dd></div>
                    <div><dt>取得時間</dt><dd><time dateTime={voucher.createdAt}>{voucherTime.format(new Date(voucher.createdAt))}</time></dd></div>
                  </dl>
                  <p className="code-label">完整券碼</p><code className="voucher-code">{voucher.code}</code>
                  <p className="hint">提供券碼給管理員後，請到核銷請求確認使用。</p>
                  <details className="id-details"><summary>識別資訊</summary>
                    <p className="brand-id">持有券 ID {voucher.id}</p><p className="brand-id">方案 ID {voucher.offerId}</p>
                  </details>
                </li>
              ))}
            </ul>
          ) : <p>此頁沒有持有券。</p>}
          <p className="page-count">本頁 {list.data.items.length} 筆</p>
          {(list.page > 1 || list.data.hasNext) && (
            <nav className="brand-actions" aria-label="持有券分頁">
              <button type="button" disabled={list.page === 1} onClick={() => void load(list.page - 1, target)}>上一頁</button>
              <p role="status">第 {list.page} 頁</p>
              <button type="button" disabled={!list.data.hasNext} onClick={() => void load(list.page + 1, target)}>下一頁</button>
            </nav>
          )}
        </>
      )}
      {(isMember || target) && (
        <div className="brand-actions">
          <button type="button" aria-disabled={loading} onClick={() => void load(1, target)}><RefreshIcon />重新讀取持有券</button>
        </div>
      )}
    </section>
  );
}
