import Decimal from 'decimal.js';
import type { AssetRow, HistoryPoint } from './types';

export type ChangeDirection = 'up' | 'down' | 'either';
export interface ChangeCondition { enabled: boolean; direction: ChangeDirection; threshold: number; }
export interface ChangeRule {
  windowMinutes: number;
  oiBasis: 'quantity' | 'usd';
  oi: ChangeCondition;
  fdv: ChangeCondition;
  combine: 'all' | 'any';
}
export interface ChangeResult {
  assetId: string; symbol: string;
  oiPct: number | null; fdvPct: number | null;
  oiMatched: boolean | null; fdvMatched: boolean | null;
  matched: boolean; evaluable: boolean;
  status: 'hit' | 'below' | 'unavailable'; reason: string;
  startAt: number | null; endAt: number;
  baseline: HistoryPoint | null; latest: HistoryPoint;
}

export const DEFAULT_CHANGE_RULE: ChangeRule = {
  windowMinutes: 5, oiBasis: 'quantity',
  oi: { enabled: true, direction: 'either', threshold: 5 },
  fdv: { enabled: true, direction: 'either', threshold: 3 }, combine: 'all',
};
export const BASELINE_TOLERANCE_MS = 45_000;
const MAX_SOURCE_AGE_MS = 90_000;
const MAX_SOURCE_SKEW_MS = 30_000;
const ExactDecimal = Decimal.clone({ precision: 80 });
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const finiteNonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export function isChangeRule(value: unknown): value is ChangeRule {
  const rule = record(value);
  const condition = (value: unknown): value is ChangeCondition => {
    const item = record(value);
    return item !== null && typeof item.enabled === 'boolean'
      && (item.direction === 'up' || item.direction === 'down' || item.direction === 'either')
      && finiteNonnegative(item.threshold) && item.threshold <= 1_000_000;
  };
  return rule !== null && typeof rule.windowMinutes === 'number' && Number.isInteger(rule.windowMinutes)
    && rule.windowMinutes >= 1 && rule.windowMinutes <= 10_080
    && (rule.oiBasis === 'quantity' || rule.oiBasis === 'usd')
    && (rule.combine === 'all' || rule.combine === 'any')
    && condition(rule.oi) && condition(rule.fdv) && (rule.oi.enabled || rule.fdv.enabled);
}

/** Select by observation/availability only, never by whether a metric will pass validation. */
export function selectChangeBaselines(points: readonly HistoryPoint[], at: number): HistoryPoint[] {
  if (!validTime(at)) return [];
  const selected = new Map<string, HistoryPoint>();
  for (const point of points) {
    if (!point.assetId || !validTime(point.timestamp) || !validTime(point.availableAt)
      || point.availableAt < point.timestamp || point.availableAt > at || point.timestamp > at
      || at - point.timestamp > BASELINE_TOLERANCE_MS) continue;
    const previous = selected.get(point.assetId);
    if (!previous || point.timestamp > previous.timestamp
      || (point.timestamp === previous.timestamp && point.availableAt < previous.availableAt!)) selected.set(point.assetId, point);
  }
  return [...selected.values()];
}

function observationIssue(point: HistoryPoint, cutoff: number): string | null {
  if (!validTime(point.timestamp) || !validTime(point.availableAt) || point.availableAt < point.timestamp)
    return '缺少真实观测时间或已知可用时间';
  if (point.timestamp > cutoff || point.availableAt > cutoff) return '观测在比较时点尚不可用';
  return null;
}

function sourceIssue(point: HistoryPoint, key: 'oiSourceTime' | 'priceSourceTime', cutoff: number): string | null {
  const sourceTime = point[key];
  if (!validTime(sourceTime)) return '缺少源时间';
  if (sourceTime > point.timestamp || sourceTime > point.availableAt! || sourceTime > cutoff) return '源时间在未来';
  if (point.availableAt! - sourceTime > MAX_SOURCE_AGE_MS || cutoff - sourceTime > MAX_SOURCE_AGE_MS)
    return '源数据超过 90 秒';
  return null;
}

interface MetricChange { pct: number | null; matched: boolean | null; issue: string | null; }
function compareMetric(current: number | null | undefined, initial: number | null | undefined,
  condition: ChangeCondition, issue: string | null): MetricChange {
  if (issue) return { pct: null, matched: null, issue };
  if (!finiteNonnegative(current) || !finiteNonnegative(initial))
    return { pct: null, matched: null, issue: '端点数值缺失或无效' };
  if (initial === 0) return { pct: null, matched: null, issue: '起点为零，无法计算涨跌幅' };
  const difference = new ExactDecimal(current).minus(initial).times(100);
  const pct = difference.div(initial).toNumber();
  if (!Number.isFinite(pct)) return { pct: null, matched: null, issue: '涨跌幅超出可表示范围' };
  const boundary = new ExactDecimal(initial).times(condition.threshold);
  // Compare the unrounded numerator against the exact decimal threshold, not the displayed percentage.
  const matched = condition.direction === 'up' ? difference.greaterThanOrEqualTo(boundary)
    : condition.direction === 'down' ? difference.lessThanOrEqualTo(boundary.negated())
      : difference.abs().greaterThanOrEqualTo(boundary);
  return { pct: Object.is(pct, -0) ? 0 : pct, matched: condition.enabled ? matched : null, issue: null };
}

/** Compare two known endpoints. This does not certify a continuous path between them. */
export function analyzeChange(asset: AssetRow, latest: HistoryPoint, baseline: HistoryPoint | null,
  rule: ChangeRule, now: number): ChangeResult {
  const result: ChangeResult = { assetId: asset.id, symbol: asset.symbol, oiPct: null, fdvPct: null,
    oiMatched: null, fdvMatched: null, matched: false, evaluable: false, status: 'unavailable',
    reason: '', startAt: baseline?.timestamp ?? null, endAt: latest.timestamp, baseline, latest };
  const unavailable = (reason: string): ChangeResult => ({ ...result, reason: `${reason}；仅比较区间端点，不保证区间连续` });
  if (!isChangeRule(rule)) return unavailable('监控参数无效');
  if (!validTime(now)) return unavailable('当前时间无效');
  if (latest.assetId !== asset.id || (baseline !== null && baseline.assetId !== asset.id)) return unavailable('端点不属于同一标的');
  const latestIssue = observationIssue(latest, now);
  if (latestIssue) return unavailable(`最新端点${latestIssue}`);
  if (now - latest.timestamp > MAX_SOURCE_AGE_MS) return unavailable('最新观测超过 90 秒');
  if (!baseline) return unavailable('窗口起点附近尚无已知可用观测');
  const target = latest.timestamp - rule.windowMinutes * 60_000;
  const baselineIssue = observationIssue(baseline, target);
  if (baselineIssue) return unavailable(`起点${baselineIssue}`);
  if (target - baseline.timestamp > BASELINE_TOLERANCE_MS) return unavailable('窗口起点偏差超过 45 秒，不插值比较');

  let oiIssue: string | null = null;
  if (!latest.complete || !baseline.complete) oiIssue = '合约数据不完整';
  else if (!latest.contractSetKey?.trim() || !baseline.contractSetKey?.trim()
    || latest.contractSetKey !== baseline.contractSetKey) oiIssue = '端点合约组成或单位倍率不一致';
  else if (!finiteNonnegative(latest.sourceSkewMs) || latest.sourceSkewMs > MAX_SOURCE_SKEW_MS
    || !finiteNonnegative(baseline.sourceSkewMs) || baseline.sourceSkewMs > MAX_SOURCE_SKEW_MS) oiIssue = '源时间偏差未知或超过 30 秒';
  else {
    const oldOi = sourceIssue(baseline, 'oiSourceTime', baseline.availableAt!);
    const newOi = sourceIssue(latest, 'oiSourceTime', now);
    oiIssue = oldOi ? `起点${oldOi}` : newOi ? `最新${newOi}` : null;
    if (!oiIssue && rule.oiBasis === 'usd') {
      const oldPrice = sourceIssue(baseline, 'priceSourceTime', baseline.availableAt!);
      const newPrice = sourceIssue(latest, 'priceSourceTime', now);
      oiIssue = oldPrice ? `起点价格${oldPrice}` : newPrice ? `最新价格${newPrice}` : null;
    }
  }
  const oldFdvSource = sourceIssue(baseline, 'priceSourceTime', baseline.availableAt!);
  const newFdvSource = sourceIssue(latest, 'priceSourceTime', now);
  const fdvIssue = oldFdvSource ? `起点价格${oldFdvSource}` : newFdvSource ? `最新价格${newFdvSource}` : null;
  const oiKey = rule.oiBasis === 'quantity' ? 'oiQuantity' : 'oiUsd';
  const oi = compareMetric(latest[oiKey], baseline[oiKey], rule.oi, oiIssue);
  // fdvUsd is frozen only after source/supply validation. Never rebuild it from today's supply.
  const fdv = compareMetric(latest.fdvUsd, baseline.fdvUsd, rule.fdv, fdvIssue);
  const enabled = [rule.oi.enabled ? oi.matched : undefined, rule.fdv.enabled ? fdv.matched : undefined]
    .filter((value): value is boolean | null => value !== undefined);
  const outcome = rule.combine === 'all'
    ? enabled.includes(false) ? false : enabled.includes(null) ? null : true
    : enabled.includes(true) ? true : enabled.includes(null) ? null : false;
  const metricReason = (label: string, condition: ChangeCondition, value: MetricChange) =>
    `${label}：${value.issue ?? (condition.enabled ? value.matched ? '已命中' : '未达阈值' : '未启用')}`;
  return { ...result, oiPct: oi.pct, fdvPct: fdv.pct, oiMatched: oi.matched, fdvMatched: fdv.matched,
    matched: outcome === true, evaluable: outcome !== null, status: outcome === null ? 'unavailable' : outcome ? 'hit' : 'below',
    reason: `${metricReason('OI', rule.oi, oi)}；${metricReason('FDV', rule.fdv, fdv)}；仅比较区间端点，不保证区间连续` };
}
