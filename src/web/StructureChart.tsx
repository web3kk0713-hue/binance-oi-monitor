import { useMemo } from 'react';
import * as echarts from 'echarts/core';
import { CandlestickChart } from 'echarts/charts';
import { DataZoomComponent } from 'echarts/components';
import type { EChartsOption } from 'echarts';
import type { StructureAdvice, StructureHistory } from '../shared/structureTypes';
import { Chart } from './Charts';
import { dateTime, escapeHtml } from './format';

echarts.use([CandlestickChart, DataZoomComponent]);
export function structureChartRows(history: StructureHistory, advice: StructureAdvice, horizonMs: number) {
  if (history.marketKey !== advice.position.marketKey) return [];
  const from = advice.asOf - 12 * 3_600_000;
  const to = advice.mode === 'replay' ? advice.asOf + horizonMs : advice.asOf;
  return history.candles.filter(c => c.openTime >= from && c.closeTime < to);
}
export default function StructureChart({ history, advice, horizonMs }: { history: StructureHistory; advice: StructureAdvice; horizonMs: number }) {
  const rows = useMemo(() => structureChartRows(history, advice, horizonMs), [history, advice, horizonMs]);
  const option = useMemo<EChartsOption>(() => {
    const levels = [{ name: '止损', value: advice.stop.price, color: '#c93646' },
      { name: '目标一', value: advice.target1.price, color: '#0875e1' },
      ...(advice.target2 ? [{ name: '目标二', value: advice.target2.price, color: '#16866b' }] : [])];
    const low = Math.min(...rows.map(r => Number(r.low)), ...levels.map(l => Number(l.value)));
    const high = Math.max(...rows.map(r => Number(r.high)), ...levels.map(l => Number(l.value)));
    const padding = (high - low) * .1 || high * .001;
    const cut = rows.findIndex(r => r.openTime >= advice.asOf);
    return { animation: false, aria: { enabled: true, label: { description: '5 分钟标记价 K 线及冻结候选价位；横线只是方案参照，不表示过去已经可知。' } },
      grid: { left: 70, right: 18, top: 22, bottom: 62 },
      xAxis: { type: 'category', data: rows.map(r => r.openTime), boundaryGap: true, axisTick: { show: false },
        axisLine: { lineStyle: { color: '#dddde4' } }, axisLabel: { hideOverlap: true, color: '#6e6e73', fontSize: 10,
          formatter: (value: string) => new Date(Number(value)).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) } },
      yAxis: { type: 'value', scale: true, min: Math.max(0, low - padding), max: high + padding, splitNumber: 4,
        axisLabel: { color: '#6e6e73', fontSize: 10, formatter: (value: number) => value.toLocaleString('en-US', { maximumSignificantDigits: 6 }) },
        splitLine: { lineStyle: { color: '#eeeef2' } } },
      dataZoom: [{ type: 'inside', filterMode: 'none' }, { type: 'slider', filterMode: 'none', bottom: 4, height: 18, showDetail: false }],
      tooltip: { trigger: 'axis', confine: true, formatter: (input: unknown) => {
        const index = (input as { dataIndex: number }[])[0]?.dataIndex, row = rows[index];
        return row ? `${escapeHtml(dateTime(row.openTime))}<br/>标记价 · USDT<br/>开 ${escapeHtml(row.open)}<br/>高 ${escapeHtml(row.high)}<br/>低 ${escapeHtml(row.low)}<br/>收 ${escapeHtml(row.close)}` : '';
      } },
      series: [{ name: '标记价 5m', type: 'candlestick', data: rows.map(r => [Number(r.open), Number(r.close), Number(r.low), Number(r.high)]),
        itemStyle: { color: '#16866b', color0: '#c93646', borderColor: '#16866b', borderColor0: '#c93646' }, barMaxWidth: 10,
        markLine: { symbol: 'none', silent: true, label: { position: 'insideEndTop', fontSize: 10 },
          data: [...levels.map(level => ({ name: level.name, yAxis: Number(level.value), lineStyle: { color: level.color, type: 'dashed' as const },
            label: { formatter: `${level.name} ${level.value}`, color: level.color } })),
          ...(cut >= 0 ? [{ xAxis: cut, name: '生成时点', lineStyle: { color: '#6e6e73' }, label: { formatter: '生成时点' } }] : [])] } }],
    };
  }, [rows, advice]);
  return <><div className="structure-chart"><Chart option={option} label={`${advice.position.symbol} 5分钟标记价与候选止损目标`}/></div>
    <p className="structure-chart-note">5m 标记价 K 线 · USDT · 横线为 {dateTime(advice.asOf)} 生成的候选参照，不代表此前已知；不是成交价。</p>
    <details className="private-method"><summary>查看图中原始价格</summary><div className="structure-data-scroll"><table><thead><tr><th>开盘时间</th><th>开</th><th>高</th><th>低</th><th>收</th></tr></thead><tbody>{rows.map(row => <tr key={row.openTime}><td>{dateTime(row.openTime)}</td><td>{row.open}</td><td>{row.high}</td><td>{row.low}</td><td>{row.close}</td></tr>)}</tbody></table></div></details></>;
}
