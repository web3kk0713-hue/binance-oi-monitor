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
const COLORS = { oi: '#356ee6', cap: '#099a95', fdv: '#9161cb', warning: '#c69015', danger: '#e05a42', critical: '#c92f43' };
const TEXT = '#738295';
const GRID = '#edf1f5';
const chartPercent = (value: number | null) => value === null || !Number.isFinite(value) ? '—' : `${value.toLocaleString('en-US', { maximumSignificantDigits: 4 })}%`;

function Chart({ option, label, onSelect, className = '' }: { option: EChartsOption; label: string; onSelect?: (id: string) => void; className?: string }) {
  const element = useRef<HTMLDivElement>(null);
  const instance = useRef<echarts.EChartsType | null>(null);
  const callback = useRef(onSelect); callback.current = onSelect;
  useEffect(() => {
    if (!element.current) return;
    const chart = echarts.init(element.current, undefined, { renderer: 'canvas' }); instance.current = chart;
    chart.on('click', (parameters: unknown) => {
      const data = (parameters as { data?: { assetId?: string } }).data;
      if (typeof data?.assetId === 'string') callback.current?.(data.assetId);
    });
    const observer = new ResizeObserver(() => chart.resize()); observer.observe(element.current);
    return () => { observer.disconnect(); chart.dispose(); instance.current = null; };
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
      animation: false, textStyle: { fontFamily: 'inherit' }, aria: { enabled: true, label: { description: '每个点代表一个币种，横轴为 FDV，纵轴为合约 OI，采用对数刻度。图表信息同时列于下方表格。' } },
      grid: { left: 62, right: 24, top: 25, bottom: 50 },
      xAxis: { type: 'log', min, max, name: 'FDV · USD', nameLocation: 'middle', nameGap: 33, nameTextStyle: { color: TEXT }, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { hideOverlap: true, color: TEXT, fontSize: 10, formatter: (value: number) => money(value).replace('$', '') }, splitLine: { lineStyle: { color: GRID } } },
      yAxis: { type: 'log', min, max, name: 'OI · USD', nameGap: 13, nameTextStyle: { color: TEXT, align: 'left' }, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { hideOverlap: true, color: TEXT, fontSize: 10, formatter: (value: number) => money(value).replace('$', '') }, splitLine: { lineStyle: { color: GRID } } },
      tooltip: { trigger: 'item', confine: true, backgroundColor: '#142c44', borderWidth: 0, textStyle: { color: '#fff', fontSize: 12 }, formatter: (parameters: unknown) => {
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
              opacity: row.id === selectedId ? 1 : 0.66, borderColor: row.id === selectedId ? '#142c44' : '#fff', borderWidth: row.id === selectedId ? 2 : 0.5 },
            label: { show: row.id === selectedId, formatter: row.symbol, position: 'top', color: '#142c44', fontSize: 11, fontWeight: 600 },
          })), emphasis: { scale: 1.6 }, z: 3,
        },
      ],
    };
  }, [points, selectedId, thresholds.warning, thresholds.danger, thresholds.critical]);
  if (points.length === 0) return <div className="chart-empty scatter-empty"><div className="empty-orbit"><span /><span /><span /></div><strong>等待可比较的数据</strong><p>同时取得 OI 与可靠 FDV 后显示散点。<br/>缺失数据的币种仍保留在下方表格。</p></div>;
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
    const firstTimestamp = view === 'change' && baseline ? baseline.timestamp : points[0]?.timestamp ?? now;
    const timeAxis = { type: 'time' as const, min: Math.max(now - hours * 3_600_000, Math.min(firstTimestamp, now - 60_000)), max: now, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { hideOverlap: true, color: TEXT, fontSize: 10 }, splitLine: { show: false } };
    return {
      animation: false, textStyle: { fontFamily: 'inherit' }, aria: { enabled: true, label: { description: `${symbol} 的 OI、流通市值和 FDV ${view === 'change' ? '相对共同起点涨跌幅' : '美元金额'}；下图为 OI 占比。缺失分钟保留空缺，具体变化见上方数值。` } },
      grid: [{ left: 65, right: 22, top: 25, height: '46%' }, { left: 65, right: 22, top: '70%', bottom: 30 }],
      xAxis: [{ ...timeAxis, gridIndex: 0 }, { ...timeAxis, gridIndex: 1 }],
      yAxis: [
        { type: 'value', name: view === 'change' ? '相对起点变化 · %' : '金额 · USD', nameTextStyle: { color: TEXT, align: 'left', fontSize: 10 }, gridIndex: 0, scale: true, axisLabel: { hideOverlap: true, color: TEXT, fontSize: 10, formatter: (value: number) => view === 'change' ? chartPercent(value) : money(value).replace('$', '') }, splitNumber: 3, splitLine: { lineStyle: { color: GRID } } },
        { type: 'value', name: 'OI / 估值 · %', nameTextStyle: { color: TEXT, align: 'left', fontSize: 10 }, gridIndex: 1, min: 0, axisLabel: { hideOverlap: true, color: TEXT, fontSize: 10, formatter: '{value}%' }, splitNumber: 2, splitLine: { lineStyle: { color: GRID } } },
      ],
      tooltip: { trigger: 'axis', confine: true, backgroundColor: '#142c44', borderWidth: 0, textStyle: { color: '#fff', fontSize: 12 }, axisPointer: { type: 'line', lineStyle: { color: '#8398b1', type: 'dashed' } },
        formatter: (parameters: unknown) => {
          const items = parameters as { seriesName: string; value: [number, number | null]; color: string }[];
          if (!items.length) return '';
          return `${escapeHtml(new Date(items[0].value[0]).toLocaleString('zh-CN', { hour12: false }))}<br/>` + items.map((item) => `<span style="color:${escapeHtml(item.color)}">●</span> ${escapeHtml(item.seriesName)}　${item.seriesName.includes('/') || view === 'change' ? chartPercent(item.value[1]) : money(item.value[1])}`).join('<br/>');
        },
      },
      series: series.map((s, index) => ({ name: s.name, type: 'line', xAxisIndex: index < 3 ? 0 : 1, yAxisIndex: index < 3 ? 0 : 1,
        data: prepared.map((point) => [point.timestamp, point[s.key]]), showSymbol: points.length < 10, symbolSize: 5, connectNulls: false, sampling: 'lttb',
        lineStyle: { color: s.color, width: index === 0 ? 2.5 : 1.7, type: index === 4 ? 'dashed' : 'solid' }, itemStyle: { color: s.color },
        ...(index === 3 ? { markLine: { symbol: 'none', silent: true, label: { position: 'insideEndTop', formatter: '{c}%', fontSize: 9 }, data: [
          { yAxis: thresholds.warning, lineStyle: { color: COLORS.warning, width: 1, opacity: 0.65 }, label: { color: COLORS.warning } },
          { yAxis: thresholds.critical, lineStyle: { color: COLORS.critical, width: 1, opacity: 0.65 }, label: { color: COLORS.critical } },
        ] } } : {}),
      })),
    };
  }, [prepared, points, baseline, view, symbol, hours, now, thresholds.warning, thresholds.critical]);
  if (points.length === 0) return <div className="chart-empty history-empty"><strong>这个时间区间还没有历史</strong><p>真实分钟数据会随着采集积累。<br/>页面关闭或采集失败的时间段保留为空缺。</p></div>;
  return <Chart option={option} label={`${symbol} 合约 OI、流通市值、FDV ${view === 'change' ? '相对共同起点的涨跌幅' : '美元金额'}曲线和独立 OI 占比曲线；缺失数据不连线`} className="history-canvas" />;
});
