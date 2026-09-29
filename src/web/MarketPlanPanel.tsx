import { useEffect, useRef, useState, type FormEvent } from 'react';
import { assessDirection } from '../shared/direction';
import { directionPreset, directionSellThreshold } from '../shared/directionConfig';
import type { EntryWatch } from '../shared/entryWatch';
import type { FlowMarket, FlowSnapshot } from '../shared/flowTypes';
import type { MarketPlan, MarketPlanResult } from '../shared/marketPlanTypes';
import type { MarkObservation } from '../shared/positionTypes';
import { DIRECTION_LABELS } from './DirectionControls';
import { useDirectionSettings } from './DirectionSettingsContext';
import { useSharedFlowMonitor } from './FlowMonitorContext';
import { useMarketPlans } from './MarketPlansContext';
import { usePrivatePositions } from './PrivatePositionsContext';
import { createMarketPlanComputationClient } from './marketPlanComputation';
import { structureHistoryClient } from './structureResources';
import { clockTime, dateTime } from './format';
import './marketPlan.css';

type Props = { marketKey?: string | null; assetId?: string; replay?: boolean };
const errorText = (error: unknown) => error instanceof Error ? error.message : '未完成操作，请重试。';
const phaseLabel: Record<EntryWatch['phase'], string> = { watching: '等待条件', ready: '条件已齐 · 未成交', invalidated: '条件失效', expired: '等待已到期', filled: '已记录实际成交', stopped: '已停止观察' };

/** Explicit spot/USDC selection is never replaced with another futures market. */
export function selectPlanMarket(flow: FlowSnapshot | null, marketKey?: string | null, assetId?: string): FlowMarket | null {
  const rows = (flow?.rows ?? []).filter(row => (!marketKey || row.market.key === marketKey)
    && (!assetId || row.market.assetId === assetId));
  const eligible = rows.filter(row => row.market.venue === 'futures' && row.market.quoteAsset === 'USDT'
    && row.market.key === `futures:${row.market.symbol}`);
  if (!marketKey && !assetId || eligible.length !== 1 || marketKey && rows.length !== 1) return null;
  return eligible[0].market;
}
export function freshPlanReference(mark: MarkObservation | null, marketKey: string, now: number): mark is MarkObservation {
  return !!mark && mark.marketKey === marketKey && Number.isSafeInteger(mark.sourceTime) && mark.sourceTime > 0
    && Number.isSafeInteger(mark.receivedAt) && mark.sourceTime <= mark.receivedAt && mark.receivedAt <= now && now - mark.sourceTime <= 15_000;
}

export function MarketPlanPrices({ plan }: { plan: MarketPlan }) {
  return <dl className="market-plan-prices"><div className="market-plan-entry"><dt>{plan.side === 'long' ? '做多' : '做空'}进场区间 · USDT</dt><dd>{plan.entryLow} – {plan.entryHigh}</dd></div>
    <div><dt>结构止损</dt><dd>{plan.stopPrice}</dd></div><div><dt>第一目标</dt><dd>{plan.targetPrice}</dd></div></dl>;
}
export function MarketPlanRules({ plan }: { plan: MarketPlan }) {
  const config = plan.directionConfig;
  return <details className="market-plan-method"><summary>条件、成本与价位依据</summary>
    <p>冻结方向档位：{DIRECTION_LABELS[directionPreset(config)]}。采纳后必须出现结束时间晚于采纳时刻的新 5m 窗口，OI ≥ +{config.oiPct}%，价格{plan.side === 'long' ? '涨幅' : '跌幅'} &gt; {config.pricePct}%，
      {plan.side === 'long' ? `主动买占比 ≥ ${config.flowSharePct}%、净主动成交为正` : `主动买占比 ≤ ${directionSellThreshold(config.flowSharePct)}%、净主动成交为负`}，且当前标记价进入冻结区间。不是仅触价提醒。{config.requireSpot ? '必须现货同向确认。' : '现货明确反向时不确认。'}</p>
    <p>最差区间价按往返 {plan.roundTripCostBps} bps 的估算成本复核，剩余收益风险比 {plan.netRewardRisk}；成本假设不保证覆盖实际费用、资金费和滑点，也不是收益率。</p>
    {plan.reasons.map((reason, index) => <p key={index}>{reason}</p>)}
    <p>参考标记价 {plan.referencePrice} · {dateTime(plan.asOf)}。历史截至 {dateTime(plan.historyTo)}；报价单位 {plan.tickSize}。</p>
    <p>支撑 {plan.support.price}、压力 {plan.resistance.price}；15m ATR {plan.atr15}、缓冲 {plan.buffer}。方向或价格变化不自动移动冻结价位。</p>
    <p><a href="https://developers.binance.com/en/docs/derivatives/usds-margined-futures/market-data/rest-api/Mark-Price-Kline-Candlestick-Data" target="_blank" rel="noreferrer">币安标记价历史口径</a>。未核定个人可承受亏损或强平距离，不保证成交或最大亏损。</p>
  </details>;
}

export function MarketPlanCandidate({ plan, adopting, onAdopt }: { plan: MarketPlan; adopting: boolean; onAdopt(): void }) {
  const runtime = useMarketPlans();
  // A worker result causes a local render between provider ticks. Check the actual
  // render clock, otherwise a fresh result looks like a future/expired candidate.
  const checkedAt = Date.now();
  const saved = runtime.book.watches.some(watch => watch.plan.id === plan.id);
  const existing = runtime.book.watches.some(watch => watch.plan.market.key === plan.market.key && (watch.phase === 'watching' || watch.phase === 'ready'));
  const expired = checkedAt < plan.generatedAt || checkedAt - plan.generatedAt > 60_000;
  if (saved) return <p className="market-plan-caption" role="status">已采纳，冻结方案见下方进场观察。</p>;
  return <><MarketPlanPrices plan={plan}/><div className="market-plan-timing"><span>等待截止 {dateTime(plan.waitUntil)}（最多 30 分钟）</span><span>成交后最长持有 {plan.holdingLimitMs / 60_000} 分钟</span></div>
    <div className="market-plan-actions"><p>{expired ? '候选已过期，请重新分析。60 秒限制不影响已采纳观察。' : existing ? '本合约已有观察，请先停止原观察后再采纳。' : '候选生成后 60 秒内可采纳；采纳不会下单或创建真实持仓。'}</p>
      <button className="button primary" type="button" disabled={adopting || !runtime.loaded || !!runtime.error || expired || existing} onClick={onAdopt}>{adopting ? '保存观察中…' : '采纳并开始条件观察'}</button></div><MarketPlanRules plan={plan}/></>;
}

export function MarketFillForm({ watch, onCancel, onSaved }: { watch: EntryWatch; onCancel(): void; onSaved(): void }) {
  const runtime = useMarketPlans();
  const [entryPrice, setEntryPrice] = useState(''), [margin, setMargin] = useState(''), [leverage, setLeverage] = useState(''), [openedAt, setOpenedAt] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    const timestamp = new Date(openedAt).getTime();
    const active = watch.phase === 'watching' || watch.phase === 'ready';
    const latestAllowed = Math.min(Date.now(), watch.plan.waitUntil, active ? Infinity : watch.lastEvaluatedAt);
    if (!Number.isSafeInteger(timestamp) || timestamp < watch.adoptedAt || timestamp > latestAllowed) { setError('成交时间必须在采纳后、观察有效期间内；其他成交请到“我的持仓”直接录入。'); return; }
    if (![entryPrice, margin, leverage].every(value => value.trim() !== '')) { setError('请手工填写真实成交价、保证金与杠杆。'); return; }
    setBusy(true); setError('');
    try { await runtime.recordFill(watch.plan.id, { entryPrice, margin, leverage, openedAt: timestamp }); onSaved(); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return <form className="market-fill" aria-label={`${watch.plan.market.symbol} 记录实际成交`} onSubmit={submit}>
    <h4>记录交易所实际成交</h4><p className="market-plan-boundary">仅在你已成交后填写，不会下单或自动启用离场提醒。</p>
    <div className="market-fill-grid"><label>实际开仓价 · USDT<input aria-label="实际开仓价" type="number" inputMode="decimal" min="0" step="any" required value={entryPrice} onChange={e => setEntryPrice(e.target.value)}/></label>
      <label>实际开仓保证金 · USDT<input aria-label="实际开仓保证金" type="number" inputMode="decimal" min="0" step="any" required value={margin} onChange={e => setMargin(e.target.value)}/></label>
      <label>实际杠杆 · 倍<input aria-label="实际杠杆" type="number" inputMode="decimal" min="1" max="125" step="any" required value={leverage} onChange={e => setLeverage(e.target.value)}/></label>
      <label>实际成交时间 · 本地时区<input aria-label="实际成交时间" type="datetime-local" step="1" required value={openedAt} onChange={e => setOpenedAt(e.target.value)}/></label></div>
    <p className="market-plan-caption">可迟录观察有效期间的成交；其他成交请直接到“我的持仓”录入。保存后需重新核对并采纳结构保护，进场价位不会直接变成正式保护单。</p>
    <div className="market-watch-buttons"><button className="button primary" type="submit" disabled={busy || !runtime.loaded}>{busy ? '记录中…' : '保存实际成交'}</button><button className="button text-button" type="button" onClick={onCancel} disabled={busy}>取消</button></div>
    {error ? <p className="market-plan-error" role="alert">{error}</p> : null}
  </form>;
}

function FilledPositionStatus({ positionId }: { positionId: string | null }) {
  const positions = usePrivatePositions();
  const state = positions.book.positions.find(item => item.position.id === positionId);
  if (!positions.loaded) return <p className="market-watch-reason" role="status">正在读取关联实际仓位…</p>;
  if (positions.error) return <p className="market-plan-boundary">实际仓位状态暂不可核验。<a href="?view=positions">去我的持仓核查</a></p>;
  if (!state) return <p className="market-plan-boundary">未找到关联实际仓位，请核查。<a href="?view=positions">查看我的持仓</a></p>;
  if (state.phase === 'closed') return <p className="market-watch-reason">实际仓位已登记离场 · {dateTime(state.closedAt)}（手工登记，未核实交易所成交）。<a href="?view=positions">查看持仓记录</a></p>;
  if (state.plan) return <p className="market-plan-success">{state.phase === 'triggered' ? '离场提醒已触发' : '离场提醒已启用'} · v{state.plan.revision}。{state.phase === 'triggered' ? '尚未登记离场。' : ''}<a href="?view=positions">查看当前持仓保护</a></p>;
  return <p className="market-plan-boundary">实际仓位已记录，离场提醒未启用。<a href="?view=positions">去我的持仓核对并采纳结构保护</a></p>;
}

function MarketWatch({ watch, readOnly }: { watch: EntryWatch; readOnly: boolean }) {
  const runtime = useMarketPlans(), [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const checkedAt = Date.now();
  const active = watch.phase === 'watching' || watch.phase === 'ready';
  const mark = runtime.markFor(watch.plan.market.key);
  const paused = active && (!freshPlanReference(mark, watch.plan.market.key, checkedAt) || !!runtime.error);
  async function stop() { if (busy) return; setBusy(true); setError(''); try { await runtime.stop(watch.plan.id); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } }
  return <article className="market-watch" aria-label={`${watch.plan.market.symbol} ${phaseLabel[watch.phase]}`}>
    <div className="market-watch-heading"><strong>{watch.plan.market.symbol} · {watch.plan.side === 'long' ? '做多' : '做空'}<span className={`market-watch-phase ${watch.phase}`}>{paused ? '观察暂停 · 数据或存储不可用' : phaseLabel[watch.phase]}</span></strong>
      {!readOnly ? <div className="market-watch-buttons">{watch.phase !== 'filled' && !watch.fillIntent ? <button className="button secondary" type="button" onClick={() => setEditing(value => !value)} disabled={busy || !runtime.loaded}>{editing ? '收起成交录入' : '记录实际成交'}</button> : null}
        {active && !watch.fillIntent ? <button className="button text-button" type="button" onClick={() => void stop()} disabled={busy || !runtime.loaded}>{busy ? '停止中…' : '停止观察'}</button> : null}</div> : null}</div>
    <MarketPlanPrices plan={watch.plan}/>{watch.phase === 'filled' ? <FilledPositionStatus positionId={watch.filledPositionId}/> : <p className="market-watch-reason">{watch.reason}</p>}
    <div className="market-watch-meta">等待截止 {dateTime(watch.plan.waitUntil)} · 最长持有 {watch.plan.holdingLimitMs / 60_000} 分钟 · 采纳 {clockTime(watch.adoptedAt)}</div>
    {watch.gap ? <p className="market-plan-boundary">观察曾中断，只确认恢复后实际数据，不推断离线期间条件。</p> : null}
    {watch.fillIntent && watch.phase !== 'filled' ? <p className="market-plan-boundary" role="status">实际成交记录正在恢复，请勿重复录入；原始输入已保留。</p> : null}
    {!readOnly && editing && watch.phase !== 'filled' && !watch.fillIntent ? <MarketFillForm watch={watch} onCancel={() => setEditing(false)} onSaved={() => setEditing(false)}/> : null}
    {error ? <p className="market-plan-error" role="alert">{error}</p> : null}<MarketPlanRules plan={watch.plan}/>
  </article>;
}

/** Reused by the risk center; does not open another feed or analysis worker. */
export function MarketWatchList({ marketKey, readOnly = false }: { marketKey?: string; readOnly?: boolean }) {
  const runtime = useMarketPlans();
  const [showHistory, setShowHistory] = useState(false);
  const watches = runtime.book.watches.filter(watch => !marketKey || watch.plan.market.key === marketKey);
  const active = watches.filter(watch => watch.phase === 'watching' || watch.phase === 'ready');
  const history = watches.filter(watch => watch.phase !== 'watching' && watch.phase !== 'ready');
  // Keep current work and the newest completion visible; don't mount up to 100 historical detail forms on every tick.
  const visible = [...active, ...(showHistory ? history : history.slice(0, 1))];
  return <section className="market-watches" aria-label="已采纳的进场观察"><h3>进场观察{watches.length ? ` · ${watches.length}` : ''}</h3>
    {runtime.error ? <p className="market-plan-error" role="alert">{runtime.error}</p> : null}
    {!runtime.loaded ? <p className="market-plan-empty">读取本机进场观察…</p> : !watches.length ? <p className="market-plan-empty">尚无已采纳计划。分析当前市场后，你可以选择开始条件观察。</p>
      : visible.map(watch => <MarketWatch key={watch.plan.id} watch={watch} readOnly={readOnly}/>)}
    {runtime.loaded && history.length > 1 ? <button className="button text-button" type="button" aria-expanded={showHistory} onClick={() => setShowHistory(value => !value)}>{showHistory ? '收起较早记录' : `查看较早观察记录 ${history.length - 1}`}</button> : null}
    <p className="market-plan-caption">仅本机保存 · 非自动交易 · 关页 / 休眠会暂停。最多 5 个活跃观察、100 份历史；条件已齐不等于已经成交。</p>
  </section>;
}

function MarketPlanSession({ market, replay }: { market: FlowMarket | null; replay: boolean }) {
  const flow = useSharedFlowMonitor(), runtime = useMarketPlans(), { config } = useDirectionSettings();
  const checkedAt = Date.now();
  const direction = assessDirection(flow.data, market?.assetId, checkedAt, market?.key, config);
  const [chosenSide, setChosenSide] = useState<'long' | 'short' | ''>(''), [holding, setHolding] = useState(240);
  const [result, setResult] = useState<MarketPlanResult | null>(null), [busy, setBusy] = useState(false), [adopting, setAdopting] = useState(false), [error, setError] = useState('');
  const pending = useRef<{ controller: AbortController; computer: ReturnType<typeof createMarketPlanComputationClient> } | null>(null);
  const latest = useRef({ runtime, market }); latest.current = { runtime, market };
  const side = chosenSide || (direction.bias === 'wait' ? '' : direction.bias);
  const cancel = () => { pending.current?.controller.abort(); pending.current?.computer.close(); pending.current = null; };
  useEffect(() => () => cancel(), []);
  const clear = () => { cancel(); setBusy(false); setResult(null); setError(''); };
  async function analyze() {
    if (!market || !side || replay || adopting) return;
    cancel(); setResult(null); setError(''); setBusy(true); setChosenSide(side);
    const task = { controller: new AbortController(), computer: createMarketPlanComputationClient() }; pending.current = task;
    const frozenConfig = { ...config }, frozenMarket = { ...market }, frozenSide = side, holdingLimitMs = holding * 60_000;
    try {
      const history = await structureHistoryClient.load(frozenMarket.symbol, task.controller.signal);
      if (task.controller.signal.aborted || pending.current !== task) return;
      const now = Date.now(), reference = latest.current.runtime.markFor(frozenMarket.key);
      if (!freshPlanReference(reference, frozenMarket.key, now)) throw new Error('当前标记价缺失或超过 15 秒，请等待行情恢复后重新分析。');
      const output = await task.computer.analyze({ id: crypto.randomUUID(), market: frozenMarket, side: frozenSide, history, reference: { ...reference },
        now, holdingLimitMs, directionConfig: frozenConfig });
      if (!task.controller.signal.aborted && pending.current === task) setResult(output);
    } catch (e) { if (!task.controller.signal.aborted && pending.current === task) setError(errorText(e)); }
    finally { task.computer.close(); if (pending.current === task) { pending.current = null; setBusy(false); } }
  }
  const plan = result?.status === 'ready' ? result.plan : null;
  const saved = plan ? runtime.book.watches.some(watch => watch.plan.id === plan.id) : false;
  async function adopt() {
    if (!plan || adopting || replay || saved) return;
    if (Date.now() - plan.generatedAt > 60_000) { setError('候选已超过 60 秒，请重新分析；已采纳计划不受影响。'); return; }
    setAdopting(true); setError(''); try { await runtime.adopt(plan); } catch (e) { setError(errorText(e)); } finally { setAdopting(false); }
  }
  return <section className="market-plan" aria-label="市场进场计划"><div className="market-plan-heading"><div><h3>进场计划</h3><small>{market?.symbol ?? '仅支持明确选择的 USDT 永续合约'} · 结构价位与条件观察</small></div></div>
    <p className="market-plan-boundary">未验证收益 · 非自动交易 · 关页 / 休眠会暂停观察。</p>
    {replay ? <p className="market-plan-empty">历史事件回看仅供查看，不分析或采纳当前进场计划。请返回实时市场。</p>
      : !market ? <p className="market-plan-empty">请选择有明确行情身份的 USDT 永续合约。不会把现货、USDC 或缺失市场自动换成其他合约。</p>
      : <><div className="market-plan-controls"><label>条件方向<select aria-label="进场计划方向" value={side} disabled={adopting} onChange={e => { clear(); setChosenSide(e.target.value as 'long' | 'short' | ''); }}><option value="">选择做多或做空</option><option value="long">做多条件观察</option><option value="short">做空条件观察</option></select></label>
        <label>成交后最长持有<select aria-label="最长持有时间" value={holding} disabled={adopting} onChange={e => { clear(); setHolding(Number(e.target.value)); }}>{[30, 60, 120, 240].map(minutes => <option key={minutes} value={minutes}>{minutes} 分钟</option>)}</select></label>
        <button className="button secondary" type="button" disabled={!side || busy || adopting} onClick={() => void analyze()}>{busy ? '读取历史并分析…' : plan ? '重新分析进场计划' : '分析进场计划'}</button></div>
        {direction.bias === 'wait' || side && side !== direction.bias ? <p className="market-plan-caption">当前方向未确认。选择方向只建立条件计划，仍须等待新的 5m 确认，不表示现在可以进场。</p> : null}
        {!result && !busy ? <p className="market-plan-empty">点击后才读取本合约历史。采纳后等待新 5m 方向条件与进场区间同时满足。</p> : null}
        {busy ? <p className="market-plan-caption" role="status">仅按需读取当前合约的已收盘历史，在后台计算结构价位。</p> : null}
        {result?.status === 'unavailable' ? <p className="market-plan-empty" role="status">{result.reason}</p> : null}
        {plan ? <MarketPlanCandidate plan={plan} adopting={adopting} onAdopt={() => void adopt()}/> : null}</>}
    {error ? <p className="market-plan-error" role="alert">{error}</p> : null}
    {market ? <MarketWatchList marketKey={market.key} readOnly={replay}/> : null}
  </section>;
}

export default function MarketPlanPanel({ marketKey, assetId, replay = false }: Props) {
  const flow = useSharedFlowMonitor();
  const market = selectPlanMarket(flow.data, marketKey, assetId);
  // A market/replay change unmounts the old session synchronously: no stale adoption action survives a selection change.
  return <MarketPlanSession key={`${marketKey ?? market?.key ?? ''}:${assetId ?? ''}:${replay}`} market={market} replay={replay}/>;
}
