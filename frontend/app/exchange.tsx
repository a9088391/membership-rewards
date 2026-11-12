import { useEffect, useRef, useState } from 'react';
import { apiRequest, errorNotice, isResourceId, type Notice } from './request';

type Intent = { key: string; offerId: string };
type Storage = { key: string; pending: Intent | null };
type Feedback = { notice: Notice; intentKey?: string; needsRetry?: boolean };

const storageUnavailable: Notice = {
  kind: 'alert', message: '無法存取瀏覽器的待確認紀錄，目前無法送出兌換。',
};
const pendingNotice: Notice = {
  kind: 'alert', message: '這次兌換結果尚未確認。請重試同一次兌換以確認結果。',
};

function readPending(key: string): Intent | null {
  const value = window.localStorage.getItem(key);
  if (value === null) return null;
  const pending = JSON.parse(value) as Partial<Intent> | null;
  if (!isResourceId(pending?.key) || !isResourceId(pending.offerId)) {
    throw new Error('無法讀取待確認兌換紀錄。');
  }
  return { key: pending.key, offerId: pending.offerId };
}

function isExchangeResult(value: unknown) {
  if (!value || typeof value !== 'object') return false;
  const { operationId, voucherId, balance } = value as Record<string, unknown>;
  return isResourceId(operationId) && isResourceId(voucherId)
    && typeof balance === 'number' && Number.isInteger(balance) && balance >= 0 && balance <= 2147483647;
}

export function useExchange({ actor, memberNumber, brandId, sessionInterrupted, onAccessDenied }: {
  actor: string;
  memberNumber: string | null;
  brandId: string;
  sessionInterrupted: () => boolean;
  onAccessDenied: () => void;
}) {
  const [storage, setStorage] = useState<Storage | null>();
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [sending, setSending] = useState(false);
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!memberNumber) return;
    const lifecycle = new AbortController();
    let key: string | undefined;

    function sync() {
      if (!key || lifecycle.signal.aborted || sessionInterrupted()) return;
      try {
        const pending = readPending(key);
        setStorage({ key, pending });
        setFeedback((previous) => previous?.intentKey === pending?.key ? previous : null);
      } catch {
        setStorage(null);
      }
    }

    async function prepareStorage() {
      try {
        if (!navigator.locks || !isResourceId(brandId) || !isResourceId(memberNumber)) throw new Error();
        // 綁定會員與品牌，同一會員重新登入可重試，且不保存帳號或工作階段資料。
        const scope = new TextEncoder().encode(JSON.stringify([actor, memberNumber, brandId]));
        const hash = await window.crypto.subtle.digest('SHA-256', scope);
        const digest = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
        key = `membership-rewards:pending-exchange:v1:${digest}`;
        sync();
      } catch {
        if (!lifecycle.signal.aborted) setStorage(null);
      }
    }

    function onStorage(event: StorageEvent) {
      if (event.key === key || event.key === null) sync();
    }

    window.addEventListener('storage', onStorage);
    void prepareStorage();
    return () => {
      lifecycle.abort();
      window.removeEventListener('storage', onStorage);
      request.current?.abort();
      request.current = null;
    };
  }, [actor, brandId, memberNumber, sessionInterrupted]);

  const pending = storage?.pending;

  async function send(offerId: string, retry?: Intent) {
    if (!memberNumber || !storage || !isResourceId(offerId) || request.current || sessionInterrupted()) return;
    const { key } = storage;
    const controller = new AbortController();
    const { signal } = controller;
    const isCurrent = () => !signal.aborted && !sessionInterrupted();
    request.current = controller;
    setSending(true);
    setFeedback(null);

    try {
      // 同步檢查另一分頁的保留紀錄，不能把剛點選的方案當成別筆操作的重試。
      const reservation = await navigator.locks.request(key, { signal }, () => {
        if (!isCurrent()) return null;
        const current = readPending(key);
        if (retry || current) {
          return { intent: current, send: !!retry && current?.key === retry.key && current.offerId === retry.offerId };
        }
        const intent = { key: window.crypto.randomUUID(), offerId };
        window.localStorage.setItem(key, JSON.stringify(intent));
        return { intent, send: true };
      }).catch(() => {
        if (isCurrent()) setFeedback({
          notice: { kind: 'alert', message: '無法保存待確認紀錄，這次請求尚未送出。' },
          intentKey: retry?.key, needsRetry: !!retry,
        });
        return null;
      });
      if (!reservation || !isCurrent()) return;
      const { intent } = reservation;
      setStorage({ key, pending: intent });
      if (!intent) {
        setFeedback({ notice: { kind: 'status', message: '待確認紀錄已由其他分頁處理。請查看持有券與點數流水。' } });
        return;
      }
      if (!reservation.send) return;

      const result = await apiRequest(`brands/${encodeURIComponent(brandId)}/offers/${encodeURIComponent(intent.offerId)}/exchanges`,
        signal, { method: 'POST', input: {}, expectedActor: actor, idempotencyKey: intent.key });
      if (!isCurrent()) return;

      const success = result.status === 201 && isExchangeResult(result.body);
      const failure = errorNotice(result, '暫時無法兌換。');
      const definitive = success || (result.status === 409 && (
        failure.code === 'OFFER_UNAVAILABLE' || failure.code === 'INSUFFICIENT_POINTS'
        || failure.code === 'IDEMPOTENCY_CONFLICT'
      ));
      if (!definitive) {
        // 目前權限不足或找不到資源時，伺服器尚未查閱原操作結果。
        setFeedback({
          notice: { ...failure, message: pendingNotice.message }, intentKey: intent.key, needsRetry: true,
        });
        if (result.status === 401 || result.status === 403) onAccessDenied();
        return;
      }

      let notice = success
        ? { kind: 'status' as const, message: '兌換已完成。請查看持有券與點數流水。' }
        : failure;
      let needsRetry = false;
      try {
        const remaining = await navigator.locks.request(key, { signal }, () => {
          if (!isCurrent()) return null;
          const current = readPending(key);
          if (current?.key !== intent.key || current.offerId !== intent.offerId) return current;
          window.localStorage.removeItem(key);
          return null;
        });
        if (isCurrent()) setStorage({ key, pending: remaining });
      } catch {
        notice = { ...notice, message: `${notice.message} 待確認紀錄暫時無法清除，可重試原操作。` };
        needsRetry = true;
      }
      if (isCurrent()) setFeedback({ notice, intentKey: intent.key, needsRetry });
    } finally {
      if (request.current === controller) {
        request.current = null;
        setSending(false);
      }
    }
  }

  // 另一分頁可能已成立新操作，原操作的成功訊息與追蹤識別只屬於原 Key。
  const notice = pending
    ? (feedback?.intentKey === pending.key ? feedback.notice : pendingNotice)
    : (feedback?.needsRetry ? null : feedback?.notice);

  return {
    sending,
    canExchange: !!storage && !pending && !sending,
    pending,
    notice: sending ? null : storage === null ? storageUnavailable : notice,
    send,
  };
}
