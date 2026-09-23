import { useEffect, useMemo, useState } from 'react';
import { analyzeChange, type ChangeRule } from '../shared/changeMonitor';
import { toHistoryPoint } from '../shared/history';
import type { HistoryPoint, Snapshot } from '../shared/types';
import { readChangeBaselines, type Settings } from './storage';
import { backendGet } from './useMonitor';

const EMPTY: HistoryPoint[] = [];
export function useChangeMonitor(snapshot: Snapshot | null, settings: Settings, rule: ChangeRule, version: number) {
  const [now, setNow] = useState(Date.now());
  const [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; points: HistoryPoint[]; error: string | null }>({ key: '', points: EMPTY, error: null });
  const at = snapshot ? snapshot.asOf - rule.windowMinutes * 60_000 : null;
  const key = `${settings.mode}:${settings.backendUrl}:${at}:${version}:${retry}`;
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 5_000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (at === null) return;
    let stopped = false; const controller = new AbortController();
    const request = settings.mode === 'server'
      ? backendGet<HistoryPoint[]>(settings.backendUrl, `/api/v1/change-baselines?at=${at}`, controller.signal)
      : readChangeBaselines(at);
    void request.then(points => {
      if (!Array.isArray(points)) throw new Error('比较起点格式不兼容');
      if (!stopped) setLoaded({ key, points, error: null });
    }).catch((error: unknown) => {
      if (!stopped) setLoaded({ key, points: EMPTY, error: error instanceof Error ? error.message : '比较起点读取失败' });
    });
    return () => { stopped = true; controller.abort(); };
  }, [at, settings.mode, settings.backendUrl, key]);
  const points = loaded.key === key ? loaded.points : EMPTY;
  const rows = useMemo(() => {
    const baselines = new Map(points.map(point => [point.assetId, point]));
    const evaluatedAt = Date.now();
    return snapshot?.assets.map(asset => analyzeChange(asset, toHistoryPoint(asset, snapshot), baselines.get(asset.id) ?? null, rule, evaluatedAt)) ?? [];
  }, [snapshot, points, rule, now]);
  return { rows, now, loading: at !== null && loaded.key !== key, error: loaded.key === key ? loaded.error : null, refresh: () => setRetry(value => value + 1) };
}
