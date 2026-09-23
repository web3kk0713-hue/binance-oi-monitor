import { useMemo } from 'react';
import type { EChartsOption } from 'echarts';
import { BASELINE_TOLERANCE_MS, type ChangeResult, type ChangeRule } from '../shared/changeMonitor';
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

export default function ChangeChart({ points, result, rule, loading }: { points: HistoryPoint[]; result: ChangeResult; rule: ChangeRule; loading: boolean }) {
  const prepared = useMemo(() => prepareChangeChart(points, result, rule), [points, result, rule]);
  const option = useMemo<EChartsOption>(() => {
    const line = (key: 'oi' | 'fdv', name: string, color: string) => ({ name, type: 'line' as const, showSymbol: prepared.length < 3,
      connectNulls: false, data: prepared.map(point => [point.at, point[key]]), lineStyle: { color, width: 2 }, itemStyle: { color },
      markLine: { silent: true, symbol: 'none' as const, data: [{ yAxis: 0 }], label: { show: false }, lineStyle: { color: '#adb6c2', width: 1, type: 'dashed' as const } } });
    return { animation: false, grid: { left: 64, right: 22, top: 44, bottom: 34 },
      legend: { top: 6, left: 16, textStyle: { color: '#68717d', fontSize: 12 } },
      xAxis: { type: 'time', min: result.startAt ?? result.endAt - rule.windowMinutes * 60_000, max: result.endAt, splitNumber: 4, axisLabel: { hideOverlap: true }, splitLine: { show: false } },
      yAxis: { type: 'value', scale: true, splitLine: { lineStyle: { color: '#edf0f4' } }, axisLabel: { formatter: (value: number) => `${value.toLocaleString('en-US', { maximumSignificantDigits: 4 })}%` } },
      tooltip: { trigger: 'axis', confine: true, formatter: (items: unknown) => {
        const values = items as { value: [number, number | null]; seriesName: string }[];
        return values.length ? `${escapeHtml(dateTime(values[0].value[0]))}<br/>` + values.map(item => `${escapeHtml(item.seriesName)} ${escapeHtml(signed(item.value[1], '%', 4))}`).join('<br/>') : '';
      } },
      series: [line('oi', rule.oiBasis === 'quantity' ? 'OI 数量涨跌幅' : 'OI 金额涨跌幅', '#0875e1'), line('fdv', 'FDV 涨跌幅', '#8867be')] };
  }, [prepared, result.startAt, result.endAt, rule.windowMinutes, rule.oiBasis]);
  if (!prepared.some(point => point.oi !== null || point.fdv !== null)) return <div className="change-empty"><strong>{loading ? '读取曲线…' : '缺少有效比较起点'}</strong><span>保留空值，不从最新值倒推历史。</span></div>;
  return <><Chart option={option} label={`${result.symbol} ${rule.oiBasis === 'quantity' ? 'OI数量' : 'OI美元金额'}与FDV相对同一观测起点涨跌幅，缺口断线`} className="change-chart"/>{loading ? <p className="change-chart-note">正在读取中间观测；仅绘制已取得点。</p> : null}</>;
}
