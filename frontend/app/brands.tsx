import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { IdentityDto } from './identity';
import { BrandIcon, RefreshIcon } from './icons';
import { Offers } from './offers';
import { Points } from './points';
import { Redemptions } from './redemptions';
import { apiRequest, errorNotice, NoticeBox, type Notice } from './request';
import { Vouchers } from './vouchers';

type BrandDto = { id: string; name: string };
type BrandPageDto = { items: BrandDto[]; hasNext: boolean };
type PanelKind = 'points' | 'offers' | 'vouchers' | 'redemptions';

function isBrandDto(value: unknown): value is BrandDto {
  return !!value && typeof value === 'object'
    && 'id' in value && typeof value.id === 'string'
    && 'name' in value && typeof value.name === 'string';
}

function isBrandPageDto(value: unknown): value is BrandPageDto {
  return !!value && typeof value === 'object'
    && 'hasNext' in value && typeof value.hasNext === 'boolean'
    && 'items' in value && Array.isArray(value.items) && value.items.every(isBrandDto);
}

export function Brands({ identity, active, onAccessDenied, sessionInterrupted }: {
  identity: IdentityDto;
  active: boolean;
  onAccessDenied: () => void;
  sessionInterrupted: () => boolean;
}) {
  const [page, setPage] = useState(1);
  const [panel, setPanel] = useState<{ kind: PanelKind; brandId: string } | null>(null);
  const [retainedOfferBrands, setRetainedOfferBrands] = useState<BrandDto[]>([]);
  const [panelDenial, setPanelDenial] = useState<Notice | null>(null);
  const [list, setList] = useState<BrandPageDto | null>(null);
  const [activity, setActivity] = useState<'loading' | 'saving' | null>('loading');
  const [listFailure, setListFailure] = useState<{ page: number; notice: Notice } | null>(null);
  const [writeNotice, setWriteNotice] = useState<(Notice & { review?: 'required' | 'read' }) | null>(null);
  const [createName, setCreateName] = useState('');
  const [edit, setEdit] = useState<{ brand: BrandDto; name: string } | null>(null);
  const request = useRef<AbortController | null>(null);
  const title = useRef<HTMLHeadingElement>(null);

  const canWrite = identity.role === 'GROUP_ADMIN';
  const tabs: { kind: PanelKind; label: string; short: string }[] = [
    { kind: 'points', label: identity.role === 'MEMBER' ? '點數與流水' : '會員點數', short: '點數' },
    { kind: 'offers', label: '優惠券方案', short: '方案' },
    { kind: 'vouchers', label: identity.role === 'MEMBER' ? '我的持有券' : '持有券查核', short: '持有券' },
    { kind: 'redemptions', label: identity.role === 'MEMBER' ? '核銷請求' : '提出核銷', short: '核銷' },
  ];
  const selectedBrand = list?.items.find(({ id }) => id === panel?.brandId);
  const selectedOfferBrand = panel?.kind === 'offers' ? selectedBrand : undefined;
  const offerBrands = selectedOfferBrand
    ? [...retainedOfferBrands.filter(({ id }) => id !== selectedOfferBrand.id), selectedOfferBrand]
    : retainedOfferBrands;

  // 切換面板只保留仍在處理或待確認的寫入，各品牌沿用原元件。
  function retainOfferBrand(brand: BrandDto, retain: boolean) {
    setRetainedOfferBrands((previous) => retain ? [...previous, brand] : previous.filter(({ id }) => id !== brand.id));
  }

  const denyPanelAccess = useCallback((notice: Notice) => {
    setPanel(null);
    setPanelDenial(notice);
    onAccessDenied();
  }, [onAccessDenied]);
  const writeLocked = activity !== null || !!writeNotice?.review;

  const loadPage = useCallback(async (target: number, signal: AbortSignal) => {
    setListFailure(null);
    const result = await apiRequest(`brands?page=${target}`, signal);
    if (signal.aborted) return;
    if (result.status === 200 && isBrandPageDto(result.body)) {
      const brands = result.body;
      setPage(target);
      setList(brands);
      // 沿用 API 排序；換頁或原品牌消失時，以該頁第一個品牌開啟點數工作區。
      const firstBrand = brands.items[0];
      setPanel((previous) => previous && brands.items.some(({ id }) => id === previous.brandId)
        ? previous : firstBrand ? { kind: 'points', brandId: firstBrand.id } : null);
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
    if (active) void run('loading', (signal) => {
      if (target !== page) setPanel(null);
      return loadPage(target, signal);
    });
  }

  function togglePanel(kind: PanelKind, brandId: string) {
    if (!active || sessionInterrupted()) return;
    setPanelDenial(null);
    setPanel({ kind, brandId });
  }

  function save(event: FormEvent<HTMLFormElement>, current?: BrandDto) {
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

      if (result.status === (current ? 200 : 201) && isBrandDto(result.body)
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
    <section className="brands-shell" aria-labelledby="brands-title" hidden={!active}>
      <aside className="brand-rail">
        <h2 id="brands-title" ref={title} tabIndex={-1}>選擇品牌</h2>
        {activity && <p role="status">{activity === 'loading' ? '讀取品牌清單中…' : '儲存品牌中…'}</p>}
        {listFailure && <>
          <NoticeBox notice={listFailure.notice} />
          {!writeNotice?.review && <button type="button" onClick={() => browse(listFailure.page)}><RefreshIcon />重新讀取品牌清單</button>}
        </>}
        {list && <>
          {list.items.length === 0 && <p>此頁沒有品牌。</p>}
          {!!list.items.length && <div className="mobile-brand-select">
            <label htmlFor="selected-brand">品牌</label>
            <select id="selected-brand" value={selectedBrand?.id ?? ''} onChange={(event) => togglePanel(panel?.kind ?? 'points', event.target.value)}>
              {!selectedBrand && <option value="" disabled>請選擇品牌</option>}
              {list.items.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}（{brand.id}）</option>)}
            </select>
          </div>}
          <ul className="brand-options">
            {list.items.map((brand) => <li key={brand.id} className={selectedBrand?.id === brand.id ? 'selected' : undefined}>
              <BrandIcon name={brand.name} />
              <button type="button" aria-pressed={selectedBrand?.id === brand.id}
                aria-label={`選擇品牌：${brand.name}（品牌 ID ${brand.id}）`}
                onClick={() => togglePanel(panel?.kind ?? 'points', brand.id)}>{brand.name}</button>
              <details className="id-details"><summary>查看品牌 ID</summary><p className="brand-id">{brand.id}</p></details>
            </li>)}
          </ul>
          {(page > 1 || list.hasNext) && <nav className="brand-actions" aria-label="品牌清單分頁">
            <button type="button" disabled={page === 1} aria-disabled={activity !== null} onClick={() => browse(page - 1)}>上一頁</button>
            <p role="status">第 {page} 頁</p>
            <button type="button" disabled={!list.hasNext} aria-disabled={activity !== null} onClick={() => browse(page + 1)}>下一頁</button>
          </nav>}
        </>}
        {writeNotice && <NoticeBox notice={writeNotice} />}
        {writeNotice?.review && <div className="brand-actions">
          <button type="button" aria-disabled={activity !== null} onClick={() => browse(listFailure?.page ?? page)}><RefreshIcon />重新讀取品牌清單</button>
          {canWrite && writeNotice.review === 'read' && <button type="button" aria-disabled={activity !== null} onClick={() => {
            if (!active || request.current) return;
            title.current?.focus();
            setWriteNotice(null);
          }}>已檢查清單，允許新的操作</button>}
        </div>}
        {canWrite && <details className="brand-management">
          <summary>品牌管理</summary>
          <form className="brand-form" method="post" onSubmit={(event) => save(event)}>
            <label htmlFor="brand-name">新品牌名稱</label>
            <input id="brand-name" name="name" required value={createName} readOnly={writeLocked}
              onChange={(event) => setCreateName(event.target.value)} aria-describedby="brand-name-hint" />
            <p id="brand-name-hint" className="hint">去除首尾空白後須為 1 至 80 個字元。</p>
            <button type="submit" aria-disabled={writeLocked}>新增品牌</button>
          </form>
          {list?.items.map((brand) => <button key={brand.id} type="button" className="rename-brand"
            aria-label={`改名：${brand.name}（品牌 ID ${brand.id}）`} aria-disabled={writeLocked || !!edit} onClick={() => {
              if (!active || writeLocked || request.current || edit) return;
              setWriteNotice(null);
              setEdit({ brand, name: brand.name });
            }}>改名：{brand.name}<span className="brand-id">{brand.id}</span></button>)}
          {edit && <form className="brand-form" method="post" onSubmit={(event) => save(event, edit.brand)}>
            <label htmlFor="rename-brand-name">修改品牌名稱</label>
            <input id="rename-brand-name" name="name" autoFocus required value={edit.name} readOnly={writeLocked}
              onChange={(event) => setEdit({ ...edit, name: event.target.value })} aria-describedby="rename-brand-hint" />
            <p id="rename-brand-hint" className="hint">「{edit.brand.name}」改名後須為 1 至 80 個字元。
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
          </form>}
        </details>}
      </aside>
      <div className="brand-workspace">
        {selectedBrand && <>
          <div className="workspace-heading">
            <h2>{selectedBrand.name}</h2>
            <details className="id-details mobile-brand-id"><summary>品牌 ID</summary><p className="brand-id">{selectedBrand.id}</p></details>
            <p>{identity.role === 'MEMBER' ? '點數分品牌計算，僅限同品牌使用。' : '管理品牌內的點數、方案與核銷。'}</p>
          </div>
          <nav className="function-tabs" aria-label="品牌功能">
            {tabs.map((tab) => <button key={tab.kind} type="button" aria-current={panel?.kind === tab.kind ? 'page' : undefined}
              aria-controls={panel?.kind === tab.kind ? `brand-${tab.kind}` : undefined} onClick={() => togglePanel(tab.kind, selectedBrand.id)}>
              <span className="tab-full">{tab.label}</span><span className="tab-short">{tab.short}</span>
            </button>)}
          </nav>
        </>}

        {panelDenial && <NoticeBox notice={panelDenial} />}
        {selectedBrand && panel?.kind === 'points' && (
          <Points key={selectedBrand.id} brand={selectedBrand} active={active} isMember={identity.role === 'MEMBER'}
            actor={identity.username} sessionInterrupted={sessionInterrupted}
            onAccessDenied={denyPanelAccess} />
        )}
        {offerBrands.map((brand) => (
          <Offers key={brand.id} brand={brand} active={active && brand.id === selectedOfferBrand?.id}
            memberNumber={identity.memberNumber} actor={identity.username} sessionInterrupted={sessionInterrupted}
            onAccessDenied={onAccessDenied} retainBrand={retainOfferBrand} />
        ))}
        {active && selectedBrand && panel?.kind === 'vouchers' && (
          <Vouchers key={selectedBrand.id} brand={selectedBrand} isMember={identity.role === 'MEMBER'}
            actor={identity.username} sessionInterrupted={sessionInterrupted} onAccessDenied={denyPanelAccess} />
        )}
        {selectedBrand && panel?.kind === 'redemptions' && (
          <Redemptions key={selectedBrand.id} brand={selectedBrand} active={active} actor={identity.username}
            memberNumber={identity.memberNumber} sessionInterrupted={sessionInterrupted} onAccessDenied={onAccessDenied} />
        )}
      </div>
    </section>
  );
}
