import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createCollector } from '../data/collector';
import { toHistoryPoint } from '../shared/history';
import { analyzeShortline } from '../shared/shortline';
import { COLLECTION_INTERVAL_MS } from '../shared/types';
import type { BackendStatus, CollectionProgress, HistoryPoint, Snapshot } from '../shared/types';
import { loadLatest, readHistory, readRecentSamples, saveSnapshot, type Settings } from './storage';

export async function backendGet<T>(base: string, path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(base + path, { cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(response.status === 503 ? '后台正在建立首轮快照，请稍候。' : `后台请求失败（${response.status}）`);
  return await response.json() as T;
}

export function useMonitor(settings: Settings, onSnapshot: (snapshot: Snapshot) => void) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [progress, setProgress] = useState<CollectionProgress | null>(null);
  const [collecting, setCollecting] = useState(false);
  const [nextRun, setNextRun] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [backend, setBackend] = useState<BackendStatus | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [recent, setRecent] = useState<Record<string, HistoryPoint[]>>({});
  const [clock, setClock] = useState(Date.now());
  const callback = useRef(onSnapshot); callback.current = onSnapshot;
  const refreshRef = useRef<() => void>(() => undefined);
  const refresh = useCallback(() => refreshRef.current(), []);
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 5_000); return () => clearInterval(timer); }, []);
  const shortline = useMemo(() => Object.fromEntries(Object.entries(recent)
    .map(([id, points]) => [id, analyzeShortline(points, id, clock)])), [recent, clock]);
  useEffect(() => {
    let stopped = false; let busy = false; let timer: ReturnType<typeof setTimeout> | undefined; let latest = 0;
    const controller = new AbortController();
    setSnapshot(null); setProgress(null); setError(null); setBackend(null); setStorageError(null); setRecent({});
    const remember = (points: HistoryPoint[]) => {
      if (stopped) return;
      const cutoff = Date.now() - 10 * 60_000;
      setRecent(previous => {
        const next: Record<string, HistoryPoint[]> = {};
        const grouped = new Map<string, Map<number, HistoryPoint>>();
        for (const point of [...Object.values(previous).flat(), ...points]) {
          if (point.timestamp < cutoff) continue;
          let samples = grouped.get(point.assetId);
          if (!samples) { samples = new Map(); grouped.set(point.assetId, samples); }
          samples.set(point.timestamp, point);
        }
        for (const [id, samples] of grouped) next[id] = [...samples.values()].sort((a, b) => a.timestamp - b.timestamp);
        return next;
      });
    };
    const collector = (settings.mode === 'direct' ? Promise.all([loadLatest(), readRecentSamples()]).then(([cached, points]) => {
      remember(points); return cached;
    }).catch(() => {
      if (!stopped) setStorageError('无法读取本机历史。浏览器存储可能被禁用。');
      return undefined;
    }) : Promise.resolve(undefined)).then((cached) => {
      if (!stopped && latest === 0 && cached) setSnapshot(cached);
      return createCollector({ mode: 'direct', concurrency: 12, initialSnapshot: cached });
    });
    const run = async () => {
      if (stopped || busy) return; busy = true;
      if (timer) clearTimeout(timer);
      const startedAt = Date.now(); setCollecting(true); setError(null);
      try {
        let current: Snapshot;
        if (settings.mode === 'server') {
          const [result, health] = await Promise.allSettled([
            backendGet<Snapshot>(settings.backendUrl, '/api/v1/snapshot', controller.signal),
            backendGet<BackendStatus>(settings.backendUrl, '/api/v1/health', controller.signal),
          ]);
          if (health.status === 'fulfilled' && !stopped) setBackend(health.value);
          if (result.status === 'rejected') throw result.reason;
          current = result.value;
          if (current.schemaVersion !== 1 || !Array.isArray(current.assets)) throw new Error('后台快照格式不兼容。');
        } else {
          const readyCollector = await collector;
          if (stopped) return;
          current = await readyCollector.collect({ signal: controller.signal, onProgress: (value) => { if (!stopped) setProgress(value); } });
        }
        if (stopped) return;
        if (current.asOf !== latest) {
          latest = current.asOf; setSnapshot(current); setClock(Date.now());
          remember(current.assets.map(asset => toHistoryPoint(asset, current)));
          callback.current(current);
          if (settings.mode === 'direct') {
            try { await saveSnapshot(current); if (!stopped) setStorageError(null); } catch { if (!stopped) setStorageError('本机历史保存失败，可能是存储空间不足。当前行情仍正常展示。'); }
          }
          if (!stopped) setHistoryVersion((v) => v + 1);
        }
      } catch (reason) {
        if (!stopped) setError(reason instanceof Error ? reason.message : '采集失败，将自动重试。');
      } finally {
        busy = false;
        if (!stopped) {
          setCollecting(false);
          const wait = settings.mode === 'server' ? 10_000 : Math.max(2_000, COLLECTION_INTERVAL_MS - (Date.now() - startedAt));
          setNextRun(Date.now() + wait); timer = setTimeout(() => void run(), wait);
        }
      }
    };
    refreshRef.current = () => { void run(); };
    void run();
    return () => { stopped = true; controller.abort(); if (timer) clearTimeout(timer); refreshRef.current = () => undefined; };
  }, [settings.mode, settings.backendUrl]);
  return { snapshot, progress, collecting, nextRun, error, storageError, backend, historyVersion, shortline, refresh };
}

export function useHistory(assetId: string | undefined, hours: number, settings: Settings, version: number) {
  const [points, setPoints] = useState<HistoryPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedKey = useRef('');
  useEffect(() => {
    if (!assetId) { setPoints([]); return; }
    let stopped = false; const controller = new AbortController(); setLoading(true); setError(null);
    const key = `${settings.mode}:${settings.backendUrl}:${assetId}:${hours}`;
    if (loadedKey.current !== key) { loadedKey.current = key; setPoints([]); }
    const request = settings.mode === 'server'
      ? backendGet<HistoryPoint[]>(settings.backendUrl, `/api/v1/history?assetId=${encodeURIComponent(assetId)}&hours=${Math.max(1, hours)}`, controller.signal)
      : readHistory(assetId, Math.max(1, hours));
    void request.then((data) => { if (!stopped) { if (!Array.isArray(data)) throw new Error('历史数据格式不兼容。'); setPoints(data); } })
      .catch((reason: unknown) => { if (!stopped) setError(reason instanceof Error ? reason.message : '历史读取失败'); })
      .finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; controller.abort(); };
  }, [assetId, hours, settings.mode, settings.backendUrl, version]);
  return { points, loading, error };
}
