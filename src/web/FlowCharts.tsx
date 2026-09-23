import { memo, useEffect, useMemo, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, CandlestickChart, LineChart, ScatterChart } from 'echarts/charts';
import { AriaComponent, DataZoomComponent, GridComponent, MarkLineComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';
import type { FlowCandle, FlowEvent, FlowHistory } from '../shared/flowTypes';
import { escapeHtml } from './format';

echarts.use([BarChart, CandlestickChart, LineChart, ScatterChart, AriaComponent, DataZoomComponent, GridComponent, MarkLineComponent, TooltipComponent, CanvasRenderer]);

const MINUTE = 60_000;
const COLOR = { buy: '#16866b', sell: '#c93646', blue: '#0875e1', cvd: '#8764b7', text: '#68717d', grid: '#eef0f4' };
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif';
const numeric = (value: number | null | undefined, compact = false) => value == null || !Number.isFinite(value) ? '—'
  : value.toLocaleString('en-US', compact ? { notation: 'compact', maximumFractionDigits: 2 } : { maximumSignificantDigits: 8 });

export interface FlowChartBar { timestamp: number; candle: FlowCandle | null; delta: number | null; cvd: number | null; oi: number | null; }

export function visibleFlowTrades(history: FlowHistory, from: number, to: number, observedUntil: number): FlowEvent[] {
  return history.events.filter(event => event.rawTrade && event.marketKey === history.market?.key && (event.kind === 'large_buy' || event.kind === 'large_sell')
    && event.timestamp >= from && event.timestamp <= Math.min(to, observedUntil) && event.detectedAt <= observedUntil && event.rawTrade.receivedAt <= observedUntil);
}

/** Display aggregation only. Missing candles are never invented or used in event rules. */
export function prepareFlowChart(history: FlowHistory, interval: 1 | 5, from: number, to: number, observedUntil: number): FlowChartBar[] {
  const step = interval * MINUTE;
  const candles = new Map<number, FlowCandle>();
  for (const candle of history.candles) {
    if (candle.marketKey !== history.market?.key || candle.openTime < from || candle.openTime > to || candle.openTime > observedUntil
      || candle.sourceTime > observedUntil || candle.receivedAt > observedUntil) continue;
    if (![candle.open, candle.high, candle.low, candle.close, candle.quoteVolume, candle.takerBuyQuote].every(Number.isFinite)) continue;
    const previous = candles.get(candle.openTime);
    if (!previous || (!previous.closed && candle.closed) || previous.closed === candle.closed && candle.receivedAt >= previous.receivedAt) candles.set(candle.openTime, candle);
  }
  const quantities = new Map<number, { timestamp: number; quantity: number }>();
  for (const point of history.oi) {
    if (point.marketKey !== history.market?.key || point.timestamp < from || point.timestamp > to || point.timestamp > observedUntil || point.receivedAt > observedUntil || !Number.isFinite(point.quantity)) continue;
    const bucket = Math.floor(point.timestamp / step) * step;
    const previous = quantities.get(bucket);
    if (!previous || point.timestamp > previous.timestamp) quantities.set(bucket, point);
  }
  const result: FlowChartBar[] = [];
  let cumulative = 0;
  for (let timestamp = Math.floor(from / step) * step; timestamp <= to; timestamp += step) {
    const parts: FlowCandle[] = [];
    for (let index = 0; index < interval; index++) {
      const part = candles.get(timestamp + index * MINUTE);
      if (part) parts.push(part);
    }
    const contiguous = parts.every((part, index) => part.openTime === timestamp + index * MINUTE);
    const ended = timestamp + step - 1 <= Math.min(observedUntil, to);
    let candle: FlowCandle | null = null;
    if (parts.length && contiguous && (!ended || parts.length === interval)) {
      const first = parts[0]; const last = parts.at(-1)!;
      candle = { ...first, closeTime: last.closeTime, high: Math.max(...parts.map(part => part.high)), low: Math.min(...parts.map(part => part.low)), close: last.close,
        volume: parts.reduce((sum, part) => sum + part.volume, 0), quoteVolume: parts.reduce((sum, part) => sum + part.quoteVolume, 0),
        takerBuyQuote: parts.reduce((sum, part) => sum + part.takerBuyQuote, 0), trades: parts.reduce((sum, part) => sum + part.trades, 0),
        closed: parts.length === interval && parts.every(part => part.closed), sourceTime: last.sourceTime, receivedAt: Math.max(...parts.map(part => part.receivedAt)) };
    }
    const delta = candle ? 2 * candle.takerBuyQuote - candle.quoteVolume : null;
    if (delta === null) cumulative = 0; else cumulative += delta;
    result.push({ timestamp, candle, delta, cvd: delta === null ? null : cumulative, oi: quantities.get(timestamp)?.quantity ?? null });
  }
  return result;
}

export interface FlowChartsProps {
  history: FlowHistory; interval: 1 | 5; from: number; to: number; observedUntil: number;
  selectedEventId: string | null; eventTime: number | null; onSelectEvent: (event: FlowEvent) => void;
}

export const FlowCharts = memo(function FlowCharts({ history, interval, from, to, observedUntil, selectedEventId, eventTime, onSelectEvent }: FlowChartsProps) {
  const element = useRef<HTMLDivElement>(null);
  const instance = useRef<echarts.EChartsType | null>(null);
  const callback = useRef(onSelectEvent); callback.current = onSelectEvent;
  const events = useRef(history.events); events.current = history.events;
  const bars = useMemo(() => prepareFlowChart(history, interval, from, to, observedUntil), [history, interval, from, to, observedUntil]);
  const quote = history.market?.quoteAsset ?? '报价币';
  const option = useMemo<EChartsOption>(() => {
    const times = bars.map(bar => bar.timestamp);
    const indexByTime = new Map(times.map((timestamp, index) => [timestamp, index]));
    const bubbles = visibleFlowTrades(history, from, to, observedUntil);
    const maxSize = bubbles.reduce((maximum, event) => Math.max(maximum, Number(event.rawTrade!.quoteQuantity)), 0);
    const bubbleSeries = (side: 'buy' | 'sell') => ({
      name: side === 'buy' ? '大额主动买' : '大额主动卖', type: 'scatter' as const, xAxisIndex: 0, yAxisIndex: 0, symbol: side === 'buy' ? 'circle' : 'diamond', z: 6,
      data: bubbles.filter(event => event.rawTrade?.side === side).flatMap(event => {
        const x = indexByTime.get(Math.floor(event.timestamp / (interval * MINUTE)) * interval * MINUTE);
        const price = Number(event.rawTrade!.price), amount = Number(event.rawTrade!.quoteQuantity);
        return x === undefined || !Number.isFinite(price) || !Number.isFinite(amount) ? [] : [{ value: [x, price, amount], eventId: event.id,
          symbolSize: Math.min(31, 8 + Math.sqrt(amount / Math.max(1, maxSize)) * 23), itemStyle: { color: side === 'buy' ? COLOR.buy : COLOR.sell, opacity: event.id === selectedEventId ? .95 : .5, borderColor: event.id === selectedEventId ? '#24292f' : '#fff', borderWidth: event.id === selectedEventId ? 2 : 1 } }];
      }),
      tooltip: { trigger: 'item' as const, formatter: (input: unknown) => {
        const data = (input as { data?: { eventId?: string } }).data;
        const event = history.events.find(candidate => candidate.id === data?.eventId);
        if (!event?.rawTrade) return '';
        return `<strong>${escapeHtml(event.title)}</strong><br/>${escapeHtml(new Date(event.timestamp).toLocaleString('zh-CN', { hour12: false }))}<br/>价格 ${numeric(Number(event.rawTrade.price))} ${escapeHtml(quote)}<br/>金额 ${numeric(Number(event.rawTrade.quoteQuantity))} ${escapeHtml(quote)}<br/>点击查看原始证据`;
      } },
    });
    const axes = [0, 1, 2, 3].map(index => ({ type: 'category' as const, gridIndex: index, data: times, boundaryGap: true,
      axisLine: { show: index === 3, lineStyle: { color: '#d9dde5' } }, axisTick: { show: false },
      axisPointer: { label: { formatter: (input: { value: string | number }) => new Date(Number(input.value)).toLocaleString('zh-CN', { hour12: false }) } },
      axisLabel: { show: index === 3, color: COLOR.text, fontSize: 11, showMinLabel: true, showMaxLabel: true, hideOverlap: true,
        formatter: (value: string) => new Date(Number(value)).toLocaleString('zh-CN', to - from > 86_400_000 ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false } : { hour: '2-digit', minute: '2-digit', hour12: false }) }, splitLine: { show: false } }));
    const eventIndex = eventTime === null ? undefined : indexByTime.get(Math.floor(eventTime / (interval * MINUTE)) * interval * MINUTE);
    return {
      animation: false, textStyle: { fontFamily: FONT }, aria: { enabled: true, label: { description: `${history.market?.symbol ?? ''} ${interval}分钟K线、大额成交事件、主动成交差Delta、区间CVD和原始OI数量；空缺不连接，CVD在缺口后重新起算。` } },
      grid: [{ left: 66, right: 20, top: 28, height: '37%' }, { left: 66, right: 20, top: '45%', height: '13%' }, { left: 66, right: 20, top: '65%', height: '11%' }, { left: 66, right: 20, top: '82%', bottom: 53 }],
      xAxis: axes,
      yAxis: [
        { type: 'value', gridIndex: 0, scale: true, name: `价格 · ${quote}`, nameGap: 12 },
        { type: 'value', gridIndex: 1, name: `Delta · ${quote}`, nameGap: 10 },
        { type: 'value', gridIndex: 2, name: `CVD · ${quote}`, nameGap: 10 },
        { type: 'value', gridIndex: 3, name: '原始 OI 数量', nameGap: 10, scale: true },
      ].map(axis => ({ ...axis, nameTextStyle: { color: COLOR.text, fontSize: 11, align: 'left' }, axisLabel: { color: COLOR.text, fontSize: 11, hideOverlap: true, formatter: (value: number) => numeric(value, true) }, axisLine: { show: false }, axisTick: { show: false }, splitNumber: 2, splitLine: { lineStyle: { color: COLOR.grid } } })),
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      dataZoom: [{ type: 'inside', xAxisIndex: [0, 1, 2, 3], filterMode: 'none', start: 0, end: 100 }, { type: 'slider', xAxisIndex: [0, 1, 2, 3], filterMode: 'none', bottom: 3, height: 17, left: 66, right: 20, showDetail: false, borderColor: '#e5e8ed', fillerColor: '#0875e117', dataBackground: { lineStyle: { color: '#bbc7d6' }, areaStyle: { color: '#eef2f8' } }, handleStyle: { color: '#fff', borderColor: '#bdc9d9' } }],
      tooltip: { trigger: 'axis', confine: true, backgroundColor: '#fff', borderColor: '#dfe3ea', textStyle: { color: '#24292f', fontSize: 12 }, padding: [10, 13], extraCssText: 'border-radius:8px;box-shadow:0 5px 22px #24242816;line-height:1.8',
        formatter: (input: unknown) => {
          const items = input as { dataIndex: number }[];
          const bar = bars[items[0]?.dataIndex]; if (!bar) return '';
          const candle = bar.candle;
          return `<strong>${escapeHtml(new Date(bar.timestamp).toLocaleString('zh-CN', { hour12: false }))}</strong><br/>` + (candle
            ? `开 ${numeric(candle.open)}　高 ${numeric(candle.high)}<br/>低 ${numeric(candle.low)}　收 ${numeric(candle.close)} ${escapeHtml(quote)}<br/>成交额 ${numeric(candle.quoteVolume, true)} ${escapeHtml(quote)}${candle.closed ? '' : '<br/>本根未收盘'}<br/>`
            : '该区间 K 线缺失<br/>') + `Delta ${numeric(bar.delta, true)} ${escapeHtml(quote)}<br/>CVD ${numeric(bar.cvd, true)} ${escapeHtml(quote)}<br/>OI ${numeric(bar.oi)}`;
        },
      },
      series: [
        { name: 'K线', type: 'candlestick', xAxisIndex: 0, yAxisIndex: 0,
          data: bars.map(bar => ({ value: bar.candle ? [bar.candle.open, bar.candle.close, bar.candle.low, bar.candle.high] : [NaN, NaN, NaN, NaN], itemStyle: { opacity: bar.candle?.closed ? 1 : .5 } })),
          itemStyle: { color: COLOR.buy, color0: COLOR.sell, borderColor: COLOR.buy, borderColor0: COLOR.sell }, barMaxWidth: 12,
          ...(eventIndex === undefined ? {} : { markLine: { silent: true, symbol: 'none', lineStyle: { color: COLOR.blue, width: 1, type: 'dashed' }, label: { formatter: '事件', position: 'insideEndTop', color: COLOR.blue, fontSize: 11 }, data: [{ xAxis: eventIndex }] } }),
        }, bubbleSeries('buy'), bubbleSeries('sell'),
        { name: 'Delta', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: bars.map(bar => ({ value: bar.delta, itemStyle: { color: (bar.delta ?? 0) >= 0 ? COLOR.buy : COLOR.sell } })), barMaxWidth: 12 },
        { name: 'CVD', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: bars.map(bar => bar.cvd), showSymbol: false, connectNulls: false, lineStyle: { color: COLOR.cvd, width: 1.6 }, itemStyle: { color: COLOR.cvd } },
        { name: 'OI 数量', type: 'line', xAxisIndex: 3, yAxisIndex: 3, data: bars.map(bar => bar.oi), showSymbol: false, connectNulls: false, lineStyle: { color: COLOR.blue, width: 1.8 }, itemStyle: { color: COLOR.blue } },
      ],
    } as EChartsOption;
  }, [bars, history.events, history.market?.symbol, interval, from, to, observedUntil, selectedEventId, eventTime, quote]);
  const latest = useRef(option); latest.current = option;
  const viewKey = `${history.market?.key}:${interval}:${eventTime ?? 'live'}:${to - from}`;
  const previousKey = useRef(viewKey);
  useEffect(() => {
    if (!element.current) return;
    const resize = () => {
      if (!element.current?.clientWidth || !element.current.clientHeight) return;
      if (instance.current) { instance.current.resize(); return; }
      const chart = echarts.init(element.current, undefined, { renderer: 'canvas' }); instance.current = chart;
      chart.on('click', (input: unknown) => {
        const id = (input as { data?: { eventId?: string } }).data?.eventId;
        const event = events.current.find(candidate => candidate.id === id);
        if (event) callback.current(event);
      });
      chart.setOption(latest.current);
    };
    const observer = new ResizeObserver(resize); observer.observe(element.current); resize();
    return () => { observer.disconnect(); instance.current?.dispose(); instance.current = null; };
  }, []);
  useEffect(() => {
    const chart = instance.current; if (!chart) return;
    const old = chart.getOption() as { dataZoom?: { start?: number; end?: number }[] };
    const zoom = old.dataZoom?.[0];
    const preserve = previousKey.current === viewKey && zoom?.start != null && zoom.end != null;
    chart.setOption({ ...option, dataZoom: (option.dataZoom as object[]).map(item => preserve ? { ...item, start: zoom.start, end: zoom.end } : item) }, { notMerge: true, lazyUpdate: true });
    previousKey.current = viewKey;
  }, [option, viewKey]);

  const hasData = bars.some(bar => bar.candle || bar.oi !== null);
  return <div className="flow-chart-stage"><div ref={element} className="flow-chart-canvas" role="img" aria-hidden={!hasData} aria-label={`${history.market?.symbol ?? ''} ${interval}分钟K线、成交事件、Delta、CVD、OI联动图，可拖动底部时间范围`} />{!hasData ? <div className="flow-chart-empty"><strong>这个区间还没有可用行情</strong><p>等待官方 K 线预热或选择其他市场；历史缺口不会自动补成曲线。</p></div> : null}</div>;
});
