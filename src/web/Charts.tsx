import { memo, useEffect, useMemo, useRef } from 'react';
import * as echarts from 'echarts/core';
import { LineChart, ScatterChart as EScatterChart } from 'echarts/charts';
import { AriaComponent, GridComponent, LegendComponent, MarkLineComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';
import type { AssetRow, HistoryPoint, Thresholds } from '../shared/types';
import { historySeries, type HistoryView } from '../shared/history';
import { escapeHtml, money, percent } from './format';

echarts.use([LineChart, EScatterChart, AriaComponent, GridComponent, LegendComponent, MarkLineComponent, TooltipComponent, CanvasRenderer]);
const COLORS = { oi: '#0875e1', cap: '#16866b', fdv: '#8867be', warning: '#a47a21', danger: '#b94b2b', critical: '#c93646' };
const TEXT = '#777780';
const GRID = '#eeeef2';
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif';
const TOOLTIP = { backgroundColor: '#fff', borderColor: '#dedee5', borderWidth: 1, padding: [10, 13], textStyle: { color: '#303036', fontSize: 12 }, extraCssText: 'box-shadow:0 5px 22px #24242816;border-radius:8px;line-height:1.8' };
const chartPercent = (value: number | null) => value === null || !Number.isFinite(value) ? '—' : `${value.toLocaleString('en-US', { maximumSignificantDigits: 4 })}%`;

export function Chart({ option, label, onSelect, className = '' }: { option: EChartsOption; label: string; onSelect?: (id: string) => void; className?: string }) {
  const element = useRef<HTMLDivElement>(null);
  const instance = useRef<echarts.EChartsType | null>(null);
  const callback = useRef(onSelect); callback.current = onSelect;
  const latestOption = useRef(option); latestOption.current = option;
  useEffect(() => {
    if (!element.current) return;
    const resize = () => {
      if (!element.current || element.current.clientWidth === 0 || element.current.clientHeight === 0) return;
      if (instance.current) { instance.current.resize(); return; }
      const chart = echarts.init(element.current, undefined, { renderer: 'canvas' }); instance.current = chart;
      chart.on('click', (parameters: unknown) => {
        const data = (parameters as { data?: { assetId?: string } }).data;
        if (typeof data?.assetId === 'string') callback.current?.(data.assetId);
      });
      chart.setOption(latestOption.current, { notMerge: true, lazyUpdate: true });
    };
    const observer = new ResizeObserver(resize); observer.observe(element.current); resize();
    return () => { observer.disconnect(); instance.current?.dispose(); instance.current = null; };
  }, []);
  useEffect(() => { instance.current?.setOption(option, { notMerge: true, lazyUpdate: true }); }, [option]);
  return <div ref={element} className={`chart-canvas ${className}`} role="img" aria-label={label} />;
}

export const ScatterChart = memo(function ScatterChart({ assets, thresholds, selectedId, onSelect }: {
  assets: AssetRow[]; thresholds: Thresholds; selectedId: string | null; onSelect: (id: string) => void;
}) {
  const points = useMemo(() => assets.filter((row) => row.fdvUsd !== null && row.fdvUsd > 0 && row.oiUsd !== null && row.oiUsd > 0), [assets]);
  const option = useMemo<EChartsOption>(() => {
    const values = points.flatMap((row) => [row.fdvUsd!, row.oiUsd!]);
    const smallest = values.length ? Math.max(1, Math.min(...values)) : 1_000_000;
    const largest = values.length ? Math.max(...values) : 100_000_000;
    const min = 10 ** Math.floor(Math.log10(smallest));
    const max = 10 ** Math.ceil(Math.log10(largest * 1.05));
    return {
      animation: false, textStyle: { fontFamily: FONT }, aria: { enabled: true, label: { description: '每个点代表一个币种，横轴为 FDV，纵轴为合约 OI，采用对数刻度。图表信息同时列于行情表格。' } },
      grid: { left: 62, right: 24, top: 40, bottom: 50 },
      xAxis: { type: 'log', min, max, name: 'FDV · USD', nameLocation: 'middle', nameGap: 33, nameTextStyle: { color: TEXT, fontSize: 11 }, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { hideOverlap: true, color: TEXT, fontSize: 11, formatter: (value: number) => money(value).replace('$', '') }, splitLine: { lineStyle: { color: GRID } } },
      yAxis: { type: 'log', min, max, name: 'OI · USD', nameGap: 13, nameTextStyle: { color: TEXT, align: 'left', fontSize: 11 }, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { hideOverlap: true, color: TEXT, fontSize: 11, formatter: (value: number) => money(value).replace('$', '') }, splitLine: { lineStyle: { color: GRID } } },
      tooltip: { ...TOOLTIP, trigger: 'item', confine: true, formatter: (parameters: unknown) => {
        const data = (parameters as { data: { symbol?: string; value: number[]; ratio?: number } }).data;
        if (!data?.symbol) return '';
        return `<strong>${escapeHtml(data.symbol)}</strong><br/>OI ${money(data.value[1])}<br/>FDV ${money(data.value[0])}<br/>OI / FDV ${percent(data.ratio)}`;
      } },
      series: [
        ...(['warning', 'danger', 'critical'] as const).map((level) => ({ name: `${thresholds[level]}%`, type: 'line' as const,
          data: [[min, min * thresholds[level] / 100], [max, max * thresholds[level] / 100]], symbol: 'none', silent: true,
          lineStyle: { color: COLORS[level], width: 1, type: 'dashed' as const, opacity: 0.55 }, tooltip: { show: false }, z: 1,
        })),
        { name: '币种', type: 'scatter', symbolSize: (_: unknown, parameters: { data: unknown }) => (parameters.data as { assetId: string }).assetId === selectedId ? 12 : 7,
          data: points.map((row) => ({ value: [row.fdvUsd!, row.oiUsd!], assetId: row.id, symbol: row.symbol, ratio: row.oiToFdv,
            itemStyle: { color: !row.alertEligible ? '#b5bfcd' : row.oiToFdv! >= thresholds.critical ? COLORS.critical : row.oiToFdv! >= thresholds.danger ? COLORS.danger : row.oiToFdv! >= thresholds.warning ? COLORS.warning : COLORS.oi,
              opacity: row.id === selectedId ? 1 : 0.66, borderColor: row.id === selectedId ? '#34343c' : '#fff', borderWidth: row.id === selectedId ? 2 : 0.5 },
            label: { show: row.id === selectedId, formatter: row.symbol, position: 'top', color: '#34343c', fontSize: 12, fontWeight: 600 },
          })), emphasis: { scale: 1.6 }, z: 3,
        },
      ],
    };
  }, [points, selectedId, thresholds.warning, thresholds.danger, thresholds.critical]);
  if (points.length === 0) return <div className="chart-empty scatter-empty"><div className="empty-orbit"><span /><span /><span /></div><strong>等待可比较的数据</strong><p>同时取得 OI 与可靠 FDV 后显示散点。<br/>缺失数据的币种仍保留在行情列表。</p></div>;
  return <Chart option={option} label={`全市场 OI 与 FDV 散点图，${points.length} 个币种，点击可选中币种`} onSelect={onSelect} className="scatter-canvas" />;
});

export const HistoryCharts = memo(function HistoryCharts({ points, baseline, view, thresholds, hours, symbol, now }: { points: HistoryPoint[]; baseline: HistoryPoint | null; view: HistoryView; thresholds: Thresholds; hours: number; symbol: string; now: number }) {
  const prepared = useMemo(() => historySeries(points, baseline, view), [points, baseline, view]);
  const option = useMemo<EChartsOption>(() => {
    const series = [
      { name: '合约 OI', key: 'oiUsd' as const, color: COLORS.oi },
      { name: '流通市值', key: 'marketCapUsd' as const, color: COLORS.cap },
      { name: 'FDV', key: 'fdvUsd' as const, color: COLORS.fdv },
      { name: 'OI / FDV', key: 'oiToFdv' as const, color: COLORS.oi },
      { name: 'OI / 流通市值', key: 'oiToMarketCap' as const, color: COLORS.cap },
    ];
    const timeAxis = { type: 'time' as const, min: now - hours * 3_600_000, max: now, splitNumber: hours <= 1 ? 4 : 3, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { hideOverlap: true, color: TEXT, fontSize: 11 }, splitLine: { show: false } };
    const maximumRatio = points.reduce((maximum, point) => Math.max(maximum, point.oiToFdv ?? 0, point.oiToMarketCap ?? 0), 0);
    const visibleThresholds = [
      { value: thresholds.warning, color: COLORS.warning },
      { value: thresholds.critical, color: COLORS.critical },
    ].filter(threshold => threshold.value <= maximumRatio * 1.25);
    return {
      animation: false, textStyle: { fontFamily: FONT }, aria: { enabled: true, label: { description: `${symbol} 的 OI、流通市值和 FDV ${view === 'change' ? '相对共同起点涨跌幅' : '美元金额'}；下图为 OI 占比。缺失采样保留空缺，具体变化见下方数值。` } },
      grid: [{ left: 65, right: 22, top: 30, height: '44%' }, { left: 65, right: 22, top: '72%', bottom: 30 }],
      xAxis: [{ ...timeAxis, gridIndex: 0 }, { ...timeAxis, gridIndex: 1 }],
      yAxis: [
        { type: 'value', name: view === 'change' ? '相对起点 · %' : '金额 · USD', nameTextStyle: { color: TEXT, align: 'left', fontSize: 11 }, gridIndex: 0, scale: true, axisLabel: { hideOverlap: true, color: TEXT, fontSize: 11, formatter: (value: number) => view === 'change' ? chartPercent(value) : money(value).replace('$', '') }, splitNumber: 3, splitLine: { lineStyle: { color: GRID } } },
        { type: 'value', name: 'OI / 估值 · %', nameTextStyle: { color: TEXT, align: 'left', fontSize: 11 }, gridIndex: 1, min: 0, axisLabel: { hideOverlap: true, color: TEXT, fontSize: 11, formatter: (value: number) => chartPercent(value) }, splitNumber: 2, splitLine: { lineStyle: { color: GRID } } },
      ],
      tooltip: { ...TOOLTIP, trigger: 'axis', confine: true, axisPointer: { type: 'line', lineStyle: { color: '#9999a5', type: 'dashed' } },
        formatter: (parameters: unknown) => {
          const items = parameters as { seriesName: string; value: [number, number | null]; color: string }[];
          if (!items.length) return '';
          return `${escapeHtml(new Date(items[0].value[0]).toLocaleString('zh-CN', { hour12: false }))}<br/>` + items.map((item) => `<span style="color:${escapeHtml(item.color)}">●</span> ${escapeHtml(item.seriesName)}　${item.seriesName.includes('/') || view === 'change' ? chartPercent(item.value[1]) : money(item.value[1])}`).join('<br/>');
        },
      },
      series: series.map((s, index) => ({ name: s.name, type: 'line', xAxisIndex: index < 3 ? 0 : 1, yAxisIndex: index < 3 ? 0 : 1,
        data: prepared.map((point) => [point.timestamp, point[s.key]]), showSymbol: points.length < 10, symbolSize: 5, connectNulls: false, sampling: 'lttb',
        lineStyle: { color: s.color, width: index === 0 ? 2.5 : 1.7, type: index === 4 ? 'dashed' : 'solid' }, itemStyle: { color: s.color },
        ...(index === 3 ? { markLine: { symbol: 'none', silent: true, label: { position: 'insideEndTop', formatter: '{c}%', fontSize: 11 }, data: visibleThresholds.map(threshold => ({ yAxis: threshold.value, lineStyle: { color: threshold.color, width: 1, opacity: 0.65 }, label: { color: threshold.color } })) } } : {}),
      })),
    };
  }, [prepared, points, baseline, view, symbol, hours, now, thresholds.warning, thresholds.critical]);
  if (points.length === 0) return <div className="chart-empty history-empty"><strong>等待这个区间的真实历史</strong><p>曲线从实际采集时刻开始。<br/>未采集与中断时段保留空缺，不补造数据。</p></div>;
  return <Chart option={option} label={`${symbol} 合约 OI、流通市值、FDV ${view === 'change' ? '相对共同起点的涨跌幅' : '美元金额'}曲线和独立 OI 占比曲线；缺失数据不连线`} className="history-canvas" />;
});
