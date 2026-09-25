import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createFlowFeed } from '../data/flowFeed';
import type { FlowHistory, FlowSnapshot } from '../shared/flowTypes';
import type { Snapshot } from '../shared/types';
import type { Settings } from './storage';
import { backendGet } from './useMonitor';
import { loadFlowEvents, loadFlowHistory, mergeFlowHistory, saveFlowUpdate } from './flowStorage';

export type FlowMonitor = ReturnType<typeof useFlowMonitor>;

/** Exact-window in-flight sharing, with independent cancellation for each consumer.
 * Completed responses are not cached: late received evidence must retain its real
 * observable time and replay requests must not inherit a newer live window.
 */
export function createFlowHistoryRequests(load: (key: string, hours: number, to: number, signal: AbortSignal) => Promise<FlowHistory>) {
  type Entry = { controller: AbortController; promise: Promise<FlowHistory>; users: number };
  const pending = new Map<string, Entry>();
  const abortReason = (signal: AbortSignal) => signal.reason ?? new DOMException('History request aborted', 'AbortError');
  return {
    read(key: string, hours: number, to: number, signal?: AbortSignal): Promise<FlowHistory> {
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      const requestKey = JSON.stringify([key, hours, to]);
      let entry = pending.get(requestKey);
      if (!entry || entry.controller.signal.aborted) {
        const controller = new AbortController();
        const created: Entry = { controller, users: 0, promise: Promise.resolve().then(async () => {
          controller.signal.throwIfAborted();
          const result = await load(key, hours, to, controller.signal);
          controller.signal.throwIfAborted();
          return result;
        }) };
        entry = created; pending.set(requestKey, created);
        const settled = () => { if (pending.get(requestKey) === created) pending.delete(requestKey); };
        void created.promise.then(settled, settled);
      }
      const shared = entry;
      shared.users++;
      return new Promise<FlowHistory>((resolve, reject) => {
        let settled = false;
        const complete = (success: boolean, value: unknown) => {
          if (settled) return; settled = true;
          signal?.removeEventListener('abort', abort);
          shared.controller.signal.removeEventListener('abort', sharedAbort);
          shared.users--;
          if (success) resolve(value as FlowHistory); else reject(value);
        };
        const abort = () => {
          complete(false, abortReason(signal!));
          if (shared.users === 0) {
            if (pending.get(requestKey) === shared) pending.delete(requestKey);
            shared.controller.abort();
          }
        };
        const sharedAbort = () => complete(false, abortReason(shared.controller.signal));
        signal?.addEventListener('abort', abort, { once: true });
        shared.controller.signal.addEventListener('abort', sharedAbort, { once: true });
        void shared.promise.then(result => complete(true, result), error => complete(false, error));
      });
    },
    cancelAll() { for (const entry of pending.values()) entry.controller.abort(); pending.clear(); },
  };
}

export function useFlowMonitor(settings: Settings, snapshot: Snapshot | null) {
  const [data, setData] = useState<FlowSnapshot | null>(null), [error, setError] = useState<string | null>(null);
  const feed = useRef<ReturnType<typeof createFlowFeed> | null>(null), source = useRef(snapshot);
  const selected = useRef<string | null>(null), refreshAction = useRef<() => void>(() => {});
  source.current = snapshot;
  useEffect(() => {
    let disposed = false; const controller = new AbortController(); setData(null); setError(null);
    let cleanup = () => {}; let busy = false;
    if (settings.mode === 'server') {
      const poll = async () => {
        if (busy || disposed) return; busy = true;
        try {
          const result = await backendGet<FlowSnapshot>(settings.backendUrl, '/api/v1/flow/snapshot', controller.signal);
          if (result.schemaVersion !== 1 || !Array.isArray(result.rows) || !result.status) throw new Error('订单流后台版本不兼容');
          if (!disposed) { setData(result); setError(null); }
        } catch (e) { if (!disposed) setError(e instanceof Error ? e.message : '后台订单流不可用'); }
        finally { busy = false; }
      };
      refreshAction.current = () => void poll(); void poll(); const timer = setInterval(() => void poll(), 5000);
      cleanup = () => clearInterval(timer);
    } else {
      const stream = createFlowFeed({ mode: 'direct',
        onChange: () => { if (!disposed) { const next = stream.snapshot(); setData(next); if (next.status.connectedStreams > 0 && !next.status.errors.some(e => e.includes('历史写入'))) setError(null); } },
        onUpdate: async update => {
          try { await saveFlowUpdate(update, stream.markets()); }
          catch (e) { if (!disposed) setError('浏览器历史保存失败（可能空间不足）；实时数据仍可用，历史可能有缺口'); throw e; }
        },
      });
      feed.current = stream;
      refreshAction.current = () => { if (!disposed) setData(stream.snapshot()); };
      if (source.current) stream.updateSnapshot(source.current);
      if (selected.current) stream.selectMarket(selected.current);
      void loadFlowEvents().then(events => { if (!disposed) stream.hydrateEvents(events); })
        .catch(() => { if (!disposed) setError('浏览器历史读取失败；本次只显示新采集数据'); });
      void stream.start().catch(e => { if (!disposed) setError(e instanceof Error ? e.message : '无法连接官方行情'); });
      cleanup = () => { void stream.stop(); if (feed.current === stream) feed.current = null; };
    }
    return () => { disposed = true; controller.abort(); cleanup(); refreshAction.current = () => {}; };
  }, [settings.mode, settings.backendUrl]);
  useEffect(() => { if (snapshot) feed.current?.updateSnapshot(snapshot); }, [snapshot]);
  const selectMarket = useCallback((key: string | null) => { selected.current = key; feed.current?.selectMarket(key); }, []);
  const historyRequests = useMemo(() => createFlowHistoryRequests(async (key, boundedHours, to, signal) => {
    signal.throwIfAborted();
    const from = to - boundedHours * 3_600_000;
    if (settings.mode === 'server') return backendGet<FlowHistory>(settings.backendUrl, `/api/v1/flow/history?marketKey=${encodeURIComponent(key)}&hours=${boundedHours}&to=${to}`, signal);
    const live = feed.current?.history(key, from, to) ?? { market: null, from, to, candles: [], events: [], depth: [], oi: [] };
    try {
      const stored = await loadFlowHistory(key, from, to); signal.throwIfAborted();
      return mergeFlowHistory(stored, live);
    } catch (error) {
      if (signal.aborted) throw error;
      setError('浏览器历史读取失败，仅显示当前进程缓存'); return live;
    }
  }), [settings.mode, settings.backendUrl]);
  useEffect(() => () => historyRequests.cancelAll(), [historyRequests]);
  const history = useCallback((key: string, hours: number, to = Date.now(), signal?: AbortSignal): Promise<FlowHistory> => {
    if (!Number.isFinite(hours) || !Number.isFinite(to) || to <= 0) return Promise.reject(new Error('历史请求时间范围无效'));
    return historyRequests.read(key, Math.max(1 / 60, Math.min(168, hours)), Math.floor(to), signal);
  }, [historyRequests]);
  return { data, error, selectMarket, history, refresh: useCallback(() => refreshAction.current(), []) };
}
