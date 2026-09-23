import { COLLECTION_INTERVAL_MS, SHORTLINE_WINDOW_MS, type HistoryPoint } from './types';
import { relativeChange } from './history';

export type ShortlineStatus = 'ready' | 'warming' | 'stale' | 'gap' | 'composition' | 'unavailable';
export interface ShortlineAnalysis {
  status: ShortlineStatus;
  oiQuantityChange: number | null;
  priceChange: number | null;
  oiUsdChange: number | null;
  startAt: number | null;
  endAt: number | null;
  observations: number;
  reason: string;
}

/** Filled from real quantity samples only. This is descriptive, never a trade recommendation. */
export function analyzeShortline(input: HistoryPoint[], assetId: string, now = Date.now()): ShortlineAnalysis {
  const empty: ShortlineAnalysis = { status: 'warming', oiQuantityChange: null, priceChange: null, oiUsdChange: null,
    startAt: null, endAt: null, observations: 0, reason: '正在积累连续 5 分钟的原始数量样本' };
  const byTime = new Map<number, HistoryPoint>();
  for (const point of input) {
    if (point.assetId !== assetId || !Number.isFinite(point.timestamp) || point.timestamp > now
      || point.timestamp < now - 2 * SHORTLINE_WINDOW_MS || point.availableAt === undefined || point.availableAt > now) continue;
    byTime.set(point.timestamp, point);
  }
  const points = [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp);
  const latest = points.at(-1);
  if (!latest) return empty;
  const result = { ...empty, endAt: latest.timestamp, observations: points.length };
  if (now - latest.timestamp > 60_000 || latest.oiSourceTime == null || now - latest.oiSourceTime > 60_000)
    return { ...result, status: 'stale', reason: '最新 OI 超过 60 秒，暂停短线比较' };
  const valid = (point: HistoryPoint) => point.complete && point.oiQuantity != null && Number.isFinite(point.oiQuantity)
    && point.oiQuantity >= 0 && point.priceUsd != null && Number.isFinite(point.priceUsd) && point.priceUsd > 0
    && point.oiSourceTime != null && point.priceSourceTime != null && point.oiSourceTime <= point.availableAt!
    && point.priceSourceTime <= point.availableAt! && point.availableAt! - point.oiSourceTime <= 45_000
    && point.availableAt! - point.priceSourceTime <= 45_000 && point.sourceSkewMs != null && point.sourceSkewMs <= 30_000
    && point.sourceSkewMs >= 0 && Boolean(point.contractSetKey) && point.samplingIntervalMs === COLLECTION_INTERVAL_MS;
  if (!valid(latest)) return { ...result, status: 'unavailable', reason: '原始数量、源时间或同窗价格尚不满足短线比较条件' };
  // Baseline must already have existed at the target source time; never use a later point or interpolate.
  const target = latest.oiSourceTime! - SHORTLINE_WINDOW_MS;
  const baselineIndex = points.findLastIndex(point => point.oiSourceTime != null && point.oiSourceTime <= target);
  if (baselineIndex < 0) return result;
  const baseline = points[baselineIndex];
  const window = points.slice(baselineIndex);
  if (target - baseline.oiSourceTime! > 45_000)
    return { ...result, status: 'gap', reason: '5 分钟起点附近缺少有效观测，不插值计算' };
  const compared = { ...result, startAt: baseline.timestamp, observations: window.length };
  if (window.some(point => point.contractSetKey !== latest.contractSetKey))
    return { ...compared, status: 'composition', reason: '合约组成发生变化，等待同一组成的连续样本' };
  if (window.some(point => !valid(point))) return { ...compared, status: 'gap', reason: '窗口内有缺失或时间不一致的样本，暂停比较' };
  for (let index = 1; index < window.length; index++) {
    const prior = window[index - 1]; const next = window[index];
    const sourceDelta = next.oiSourceTime! - prior.oiSourceTime!;
    if (sourceDelta <= 0 || sourceDelta > 45_000 || next.timestamp - prior.timestamp > 45_000)
      return { ...compared, status: 'gap', reason: 'OI 源时间未前进或采样中断，等待连续窗口' };
  }
  if (window.length < 10 || baseline.oiQuantity! <= 0)
    return { ...compared, reason: '有效数量样本不足，不能以美元 OI 代替' };
  return { ...compared, status: 'ready', oiQuantityChange: relativeChange(latest.oiQuantity!, baseline.oiQuantity!),
    priceChange: relativeChange(latest.priceUsd!, baseline.priceUsd!), oiUsdChange: relativeChange(latest.oiUsd, baseline.oiUsd),
    reason: '同一合约组成、原始数量与指数价的约 5 分钟变化；不是买卖指令' };
}
