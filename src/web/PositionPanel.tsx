import { useMemo } from 'react';
import { POSITION_THRESHOLDS, type PositionContext } from '../shared/positionContext';
import { selectFlowContext, type FlowContextRow } from '../shared/flowContext';
import type { FlowSnapshot } from '../shared/flowTypes';
import { clockTime, dateTime, percent, signed } from './format';
import './position.css';

const valueClass = (value: number | null) => value === null || value === 0 ? '' : value > 0 ? 'change-up' : 'change-down';
const observed = (item: PositionContext) => item.pattern !== 'quiet' && item.pattern !== 'unavailable';
const quoteNumber = (value: number | null) => value === null ? '—' : `${value > 0 ? '+' : ''}${value.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 2 })}`;

export function PositionBadge({ value }: { value: PositionContext }) {
  return <span className={`position-badge ${value.pattern}`} title={value.reason}>{value.label}</span>;
}

export function PositionHighlights({ rows, windowMinutes, loading, onSelect }: { rows: PositionContext[]; windowMinutes: number; loading: boolean; onSelect: (assetId: string) => void }) {
  const candidates = useMemo(() => rows.filter(observed).sort((a, b) => Number(b.pattern === 'build_flat') - Number(a.pattern === 'build_flat')
    || Math.abs(b.oiQuantityPct ?? 0) - Math.abs(a.oiQuantityPct ?? 0)), [rows]);
  const comparable = rows.filter(row => row.pattern !== 'unavailable').length;
  return <section className={`position-watch ${candidates.length ? 'has-observations' : ''}`} aria-label="持仓联动重点观察">
    <div className="position-watch-title"><strong>持仓联动观察 <span>{loading ? '…' : candidates.length}</span></strong><small>过去 {windowMinutes}m · {loading ? '读取比较起点' : `${comparable} / ${rows.length} 可比较`}</small></div>
    <div className="position-watch-items">{!loading && candidates.slice(0, 5).map(row => <button key={row.assetId} onClick={() => onSelect(row.assetId)}><strong>{row.symbol}</strong><span>{row.label}</span><b className={valueClass(row.oiQuantityPct)}>OI {signed(row.oiQuantityPct)}</b></button>)}
      {!candidates.length || loading ? <span className="position-watch-empty">{loading ? '校验真实历史，暂不显示旧结果' : !comparable ? '历史不足或源数据无效，暂不能判断联动' : '当前没有达到联动观察门槛的标的'}</span> : null}</div>
    <p>数量 OI |变化| ≥ {POSITION_THRESHOLDS.oiPct}%；“价格近乎不变”指 |变化| ≤ {POSITION_THRESHOLDS.flatPricePct}%。观察标签，不是买卖指令。</p>
  </section>;
}

function TradeContext({ row, venue }: { row: FlowContextRow | null; venue: string }) {
  return <div className="position-flow-cell"><span>{venue}主动买入 · 完整 5m</span><strong>{percent(row?.buyShare5m)}</strong>
    <small>{row ? `${row.symbol} · 净主动成交 ${quoteNumber(row.delta5m)} ${row.quoteAsset}` : '尚无已核实市场数据'}</small>
    <small>{row?.buyShare5m != null ? `价格 ${signed(row.priceChange5m)} · ${clockTime(row.asOf)}` : row?.reason ?? '选择标的后采集，缺失不补零'}</small></div>;
}

export function PositionPanel({ value, flow, now, preferredMarketKey, replay = false, loading = false }: {
  value: PositionContext | undefined; flow: FlowSnapshot | null; now: number; preferredMarketKey?: string | null; replay?: boolean; loading?: boolean;
}) {
  const context = useMemo(() => selectFlowContext(flow, value?.assetId, now, preferredMarketKey), [flow, value?.assetId, now, preferredMarketKey]);
  const funding = context.futures;
  return <section className="position-panel" aria-label="当前标的持仓与价格联动">
    <div className="position-heading"><div><span>当前观察 · 币种合约聚合</span><h2>{value?.symbol ?? '等待标的'}<small>持仓 × 价格</small></h2></div>
      <div className="position-heading-state">{value && !loading ? <PositionBadge value={value}/> : <span className="position-badge unavailable">{loading ? '读取起点' : '等待数据'}</span>}<small>{value ? `${value.windowMinutes}m · ${clockTime(value.endAt)}` : '尚无观测'}</small></div></div>
    {replay ? <p className="position-visible-warning">以下是当前快照，不是所选历史事件的触发证据。</p> : null}
    <div className="position-primary">
      <div><span>OI 数量变化</span><strong className={valueClass(value?.oiQuantityPct ?? null)}>{signed(value?.oiQuantityPct ?? null, '%', 3)}</strong><small>归一化币数量，不含价格涨跌</small></div>
      <div><span>价格变化</span><strong className={valueClass(value?.pricePct ?? null)}>{signed(value?.pricePct ?? null, '%', 3)}</strong><small>同一对快照端点 · 指数价格</small></div>
      <div className="position-ratio"><span>OI / FDV 占比</span><strong>{percent(value?.oiToFdvPct)}</strong><small>相对变化 <b className={valueClass(value?.oiToFdvChangePct ?? null)}>{signed(value?.oiToFdvChangePct ?? null, '%', 3)}</b></small><small>占比差 {signed(value?.oiToFdvDeltaPp ?? null, ' 个百分点', 3)}</small></div>
      <div><span>FDV 变化</span><strong className={valueClass(value?.fdvPct ?? null)}>{signed(value?.fdvPct ?? null, '%', 3)}</strong><small>美元 OI 变化 {signed(value?.oiUsdPct ?? null, '%', 3)}</small></div>
    </div>
    {value?.pattern === 'unavailable' || value?.issues.length || value?.supplyChanged ? <p className="position-visible-warning">{value.supplyChanged ? '供给口径有变化：FDV 变化不能全部解释为价格。 ' : ''}{value.pattern === 'unavailable' ? value.reason : value.issues.join('；')}</p> : null}
    <div className="position-confirmation"><TradeContext venue="合约" row={context.futures}/><TradeContext venue="现货" row={context.spot}/>
      <div className="position-flow-cell"><span>当前资金费率</span><strong>{signed(funding?.fundingRate == null ? null : funding.fundingRate * 100, '%', 5)}</strong>
        <small>{funding?.fundingRate != null ? `${funding.symbol} · ${funding.fundingIntervalHours ? `每 ${funding.fundingIntervalHours} 小时` : '周期待核实'}` : funding?.reason ?? '尚无有效资金费率'}</small>
        <small>{funding?.nextFundingTime ? `下次结算 ${dateTime(funding.nextFundingTime)}` : '结算时间未核实'}</small></div>
    </div>
    <p className="position-context-note">成交为单交易对最近完整 5m，非上方快照的精确同步窗口；未覆盖或过期显示 —。</p>
    <details className="position-method"><summary>口径与边界：不是资金流入或多空指令</summary><p>数量 OI 上升说明未平仓合约数量增加，每笔合约同时存在多空双方。OI / FDV 是名义额占比，不是账户实际杠杆。占比相对变化 =（末占比 ÷ 初占比 − 1）× 100%，不是两个涨跌幅相除。</p>
      <p>供给固定时，FDV 涨跌幅接近价格涨跌幅；占比变化通常接近数量 OI 变化。这些不是相互独立的确认信号。联动标签仅描述端点，不证明中间连续走势；尚未回测盈利能力。</p>
      <p>合约与现货成交使用各自最近 5 根完整 1m K 线，可能与上方快照窗口不同。净主动成交 = 主动买额 − 主动卖额，不是资金净流入；各交易对按原报价币展示。当前观察标的现货按需采集，未覆盖、预热或过期显示 —。</p>
      <p>{value?.startAt ? `快照比较：${dateTime(value.startAt)} → ${dateTime(value.endAt)}。` : '缺少有效历史起点时，只显示可验证的当前占比。'}资金费率为当前观测值，不保证下一次实际结算费率。</p>
    </details>
  </section>;
}
