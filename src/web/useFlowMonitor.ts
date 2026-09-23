import { useCallback, useEffect, useRef, useState } from 'react';
import { createFlowFeed } from '../data/flowFeed';
import type { FlowHistory, FlowSnapshot } from '../shared/flowTypes';
import type { Snapshot } from '../shared/types';
import type { Settings } from './storage';
import { backendGet } from './useMonitor';
import { loadFlowEvents, loadFlowHistory, mergeFlowHistory, saveFlowUpdate } from './flowStorage';

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
          try { await saveFlowUpdate(update, stream.snapshot().rows.map(r => r.market)); }
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
  const history = useCallback(async (key: string, hours: number, to = Date.now()): Promise<FlowHistory> => {
    const boundedHours = Math.max(1 / 60, Math.min(168, hours)), from = to - boundedHours * 3_600_000;
    if (settings.mode === 'server') return backendGet<FlowHistory>(settings.backendUrl, `/api/v1/flow/history?marketKey=${encodeURIComponent(key)}&hours=${boundedHours}&to=${Math.floor(to)}`);
    const live = feed.current?.history(key, from, to) ?? { market: null, from, to, candles: [], events: [], depth: [], oi: [] };
    try { return mergeFlowHistory(await loadFlowHistory(key, from, to), live); }
    catch { setError('浏览器历史读取失败，仅显示当前进程缓存'); return live; }
  }, [settings.mode, settings.backendUrl]);
  return { data, error, selectMarket, history, refresh: useCallback(() => refreshAction.current(), []) };
}
