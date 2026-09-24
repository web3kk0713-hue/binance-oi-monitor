import { useMemo, useState } from 'react';
import Decimal from 'decimal.js';
import type { EChartsOption } from 'echarts';
import { BASELINE_TOLERANCE_MS, compareMetric, latestEndpointIssue, oiChangeIssue, priceChangeIssue,
  type ChangeResult, type ChangeRule } from '../shared/changeMonitor';
import type { HistoryPoint } from '../shared/types';
import { relativeChange } from '../shared/history';
import { Chart } from './Charts';
import { dateTime, escapeHtml, signed } from './format';

export function prepareChangeChart(points: HistoryPoint[], result: ChangeResult, rule: ChangeRule) {
  const baseline = result.baseline;
  if (!baseline || result.startAt === null) return [];
  const target = result.endAt - rule.windowMinutes * 60_000;
  if (!Number.isSafeInteger(baseline.timestamp) || baseline.timestamp <= 0 || baseline.timestamp > target
    || target - baseline.timestamp > BASELINE_TOLERANCE_MS || baseline.availableAt === undefined
    || baseline.availableAt < baseline.timestamp || baseline.availableAt > target) return [];
  const unique = new Map<number, HistoryPoint>();
  for (const point of [...points, baseline, result.latest]) {
    if (point.assetId !== result.assetId || point.availableAt === undefined || point.availableAt < point.timestamp
      || point.availableAt > result.endAt || point.timestamp < baseline.timestamp || point.timestamp > result.endAt) continue;
    unique.set(point.timestamp, point);
  }
  const output: { at: number; oi: number | null; fdv: number | null }[] = [];
  const valid = (point: HistoryPoint, source: number | null | undefined) => source != null && Number.isSafeInteger(source)
    && source > 0 && source <= point.timestamp && source <= point.availableAt! && point.availableAt! - source <= 90_000;
  const baseOi = rule.oiBasis === 'quantity' ? baseline.oiQuantity ?? null : baseline.oiUsd;
  for (const point of [...unique.values()].sort((a, b) => a.timestamp - b.timestamp)) {
    const prior = output.at(-1);
    if (prior && point.timestamp - prior.at > Math.max(30_000, point.samplingIntervalMs ?? 30_000) * 1.5) output.push({ at: prior.at + 30_000, oi: null, fdv: null });
    const oiValid = point.complete && baseline.complete && valid(point, point.oiSourceTime) && valid(baseline, baseline.oiSourceTime)
      && Boolean(point.contractSetKey) && point.contractSetKey === baseline.contractSetKey
      && point.sourceSkewMs != null && point.sourceSkewMs >= 0 && point.sourceSkewMs <= 30_000
      && baseline.sourceSkewMs != null && baseline.sourceSkewMs >= 0 && baseline.sourceSkewMs <= 30_000
      && (rule.oiBasis === 'quantity' || valid(point, point.priceSourceTime) && valid(baseline, baseline.priceSourceTime));
    const oiValue = rule.oiBasis === 'quantity' ? point.oiQuantity ?? null : point.oiUsd;
    const safeChange = (value: number | null, base: number | null) => {
      const change = value !== null && base !== null && Number.isFinite(value) && Number.isFinite(base) && value >= 0 && base > 0 ? relativeChange(value, base) : null;
      return change !== null && Number.isFinite(change) ? change : null;
    };
    output.push({ at: point.timestamp, oi: oiValid ? safeChange(oiValue, baseOi) : null,
      fdv: valid(point, point.priceSourceTime) && valid(baseline, baseline.priceSourceTime) ? safeChange(point.fdvUsd, baseline.fdvUsd) : null });
  }
  return output;
}

export interface PositionChartPoint { at: number; oi: number | null; fdv: number | null; price: number | null; ratio: number | null; }
const ExactDecimal = Decimal.clone({ precision: 80 });
const DISPLAY_ONLY = { enabled: false, direction: 'either', threshold: 0 } as const;
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const validTime = (value: unknown): value is number => positive(value) && Number.isSafeInteger(value);

/** Historical observations are validated at their actual availability, not at today's clock.
 * Every series shares the monitor's exact baseline; an interior point is not another fixed window.
 */
export function preparePositionChart(points: HistoryPoint[], result: ChangeResult, rule: ChangeRule): PositionChartPoint[] {
  const baseline = result.baseline;
  if (!Number.isInteger(rule.windowMinutes) || rule.windowMinutes < 1 || rule.windowMinutes > 10_080
    || !baseline || result.startAt === null || !validTime(result.endAt) || !validTime(baseline.availableAt)
    || latestEndpointIssue(result.assetId, baseline, baseline.availableAt)) return [];
  const target = result.endAt - rule.windowMinutes * 60_000;
  if (baseline.timestamp > target || target - baseline.timestamp > BASELINE_TOLERANCE_MS || baseline.availableAt > target) return [];
  const unique = new Map<number, HistoryPoint>();
  for (const point of [...points, baseline, result.latest]) {
    if (point.assetId !== result.assetId || !validTime(point.timestamp) || !validTime(point.availableAt)
      || point.availableAt < point.timestamp || point.availableAt > result.endAt
      || point.timestamp < baseline.timestamp || point.timestamp > result.endAt) continue;
    unique.set(point.timestamp, point);
  }
  const asFinite = (value: Decimal) => Number.isFinite(value.toNumber()) ? value.isZero() ? 0 : value.toNumber() : null;
  const ratio = (point: HistoryPoint): Decimal | null => {
    if (point.oiUsd === null || !Number.isFinite(point.oiUsd) || point.oiUsd < 0 || !positive(point.fdvUsd)
      || !positive(point.priceUsd) || Math.abs(point.oiSourceTime! - point.priceSourceTime!) > 30_000) return null;
    const value = new ExactDecimal(point.oiUsd).div(point.fdvUsd).times(100);
    return asFinite(value) === null ? null : value;
  };
  const baseRatio = oiChangeIssue(baseline, baseline, baseline.availableAt, 'usd') ? null : ratio(baseline);
  const output: PositionChartPoint[] = [];
  for (const point of [...unique.values()].sort((a, b) => a.timestamp - b.timestamp)) {
    const prior = output.at(-1);
    const interval = Number.isFinite(point.samplingIntervalMs) && point.samplingIntervalMs! > 0 ? point.samplingIntervalMs! : 30_000;
    if (prior && point.timestamp - prior.at > Math.max(30_000, interval) * 1.5)
      output.push({ at: prior.at + 30_000, oi: null, fdv: null, price: null, ratio: null });
    const observationIssue = latestEndpointIssue(result.assetId, point, point.availableAt!);
    const oiIssue = observationIssue ?? oiChangeIssue(point, baseline, point.availableAt!, rule.oiBasis);
    const priceIssue = observationIssue ?? priceChangeIssue(point, baseline, point.availableAt!);
    const ratioIssue = observationIssue ?? oiChangeIssue(point, baseline, point.availableAt!, 'usd');
    const currentRatio = ratioIssue ? null : ratio(point);
    const ratioChange = baseRatio?.greaterThan(0) && currentRatio !== null
      ? asFinite(currentRatio.div(baseRatio).minus(1).times(100)) : null;
    const oiKey = rule.oiBasis === 'quantity' ? 'oiQuantity' : 'oiUsd';
    output.push({ at: point.timestamp,
      oi: compareMetric(point[oiKey], baseline[oiKey], DISPLAY_ONLY, oiIssue).pct,
      fdv: compareMetric(point.fdvUsd, baseline.fdvUsd, DISPLAY_ONLY, priceIssue).pct,
      price: compareMetric(point.priceUsd, baseline.priceUsd, DISPLAY_ONLY, priceIssue).pct,
      ratio: ratioChange,
    });
  }
  return output;
}

export default function ChangeChart({ points, result, rule, loading, now = Date.now() }: {
  points: HistoryPoint[]; result: ChangeResult; rule: ChangeRule; loading: boolean; now?: number;
}) {
  const prepared = useMemo(() => preparePositionChart(points, result, rule), [points, result, rule]);
  const [showRatio, setShowRatio] = useState(false);
  const historicalOnly = Boolean(latestEndpointIssue(result.assetId, result.latest, now)
    || oiChangeIssue(result.latest, result.latest, now, rule.oiBasis) || priceChangeIssue(result.latest, result.latest, now));
  const ratioName = 'OI/FDV 占比相对变化';
  const option = useMemo<EChartsOption>(() => {
    const line = (key: 'oi' | 'fdv' | 'price' | 'ratio', name: string, color: string, dashed = false) => ({ name, type: 'line' as const, showSymbol: prepared.filter(point => point[key] !== null).length < 20,
      connectNulls: false, data: prepared.map(point => [point.at, point[key]]), lineStyle: { color, width: 2, type: dashed ? 'dashed' as const : 'solid' as const }, itemStyle: { color },
      markLine: { silent: true, symbol: 'none' as const, data: [{ yAxis: 0 }], label: { show: false }, lineStyle: { color: '#adb6c2', width: 1, type: 'dashed' as const } } });
    return { animation: false, grid: { left: 64, right: 22, top: 44, bottom: 34 },
      legend: { type: 'scroll', top: 6, left: 16, right: 16, selectedMode: false, selected: { [ratioName]: showRatio }, textStyle: { color: '#68717d', fontSize: 12 } },
      xAxis: { type: 'time', min: result.startAt ?? result.endAt - rule.windowMinutes * 60_000, max: result.endAt, splitNumber: 4, axisLabel: { hideOverlap: true }, splitLine: { show: false } },
      yAxis: { type: 'value', scale: true, splitLine: { lineStyle: { color: '#edf0f4' } }, axisLabel: { formatter: (value: number) => `${value.toLocaleString('en-US', { maximumSignificantDigits: 4 })}%` } },
      tooltip: { trigger: 'axis', confine: true, formatter: (items: unknown) => {
        const values = items as { value: [number, number | null]; seriesName: string }[];
        return values.length ? `${escapeHtml(dateTime(values[0].value[0]))}<br/>` + values.map(item => `${escapeHtml(item.seriesName)} ${escapeHtml(signed(item.value[1], '%', 4))}`).join('<br/>') : '';
      } },
      series: [line('oi', rule.oiBasis === 'quantity' ? 'OI 数量涨跌幅' : 'OI 金额涨跌幅', '#0875e1'),
        line('fdv', 'FDV 涨跌幅', '#8867be'), line('price', '价格涨跌幅', '#16866b', true), line('ratio', ratioName, '#a47a21', true)] };
  }, [prepared, result.startAt, result.endAt, rule.windowMinutes, rule.oiBasis, showRatio]);
  if (!prepared.some(point => point.oi !== null || point.fdv !== null || point.price !== null || point.ratio !== null)) return <div className="change-empty"><strong>{loading ? '读取曲线…' : '缺少有效比较起点'}</strong><span>保留空值，不从最新值倒推历史。</span></div>;
  return <><div className="change-chart-note"><label><input type="checkbox" checked={showRatio} onChange={event => setShowRatio(event.target.checked)}/> 显示 OI/FDV 占比相对变化</label></div>
    <Chart option={option} label={`${result.symbol} ${rule.oiBasis === 'quantity' ? 'OI数量' : 'OI美元金额'}、FDV、价格和可选OI/FDV占比相对同一观测起点的变化，单位%，缺口断线`} className="change-chart"/>
    <p className="change-chart-note">历史观测截至 {dateTime(result.endAt)}{historicalOnly ? '（端点已过期或不可用，不代表当前值）' : ''} · 共同起点 = 0%</p>
    {loading ? <p className="change-chart-note">正在读取中间观测；仅绘制已取得点。</p> : null}</>;
}
