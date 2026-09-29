import { lazy, Suspense, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import Decimal from 'decimal.js';
import { structureHistoryClient as historyClient } from './structureResources';
import { STRUCTURE_INTERVAL_MS, STRUCTURE_LOOKBACK_MS, type StructureAdvice, type StructureHistory, type StructureLevel, type StructureResult, type StructureReplay } from '../shared/structureTypes';
import type { MarkObservation, PositionRiskState } from '../shared/positionTypes';
import { usePrivatePositions } from './PrivatePositionsContext';
import { useStructureShadow } from './StructureShadowContext';
import { useSharedFlowMonitor } from './FlowMonitorContext';
import { MetricHelp } from './MetricHelp';
import { dateTime, signed } from './format';
import { createStructureComputationClient } from './structureComputation';
import './structureLab.css';

const StructureChart = lazy(() => import('./StructureChart'));
type Tab = 'current' | 'replay' | 'records';
const errorText = (e: unknown) => e instanceof Error ? e.message : '暂时不可用，请稍后重试。';
export function researchAmount(value: string, signedValue = false) {
  const d = new Decimal(value);
  const number = d.isZero() ? '0' : d.abs().lt('.01') ? d.toSignificantDigits(3).toString()
    : d.toDecimalPlaces(2).toNumber().toLocaleString('en-US', { maximumFractionDigits: 2 });
  return `${signedValue && d.gt(0) ? '+' : ''}${number}`;
}
function Level({ title, level }: { title: string; level: StructureLevel | null }) {
  return <div className="structure-level"><span>{title}</span><strong>{level?.price ?? '暂无有效价位'}</strong>
    {level ? <small>估算盈亏 {researchAmount(level.pnl, true)} USDT<br/>{researchAmount(level.returnOnMarginPct, true)}% 输入保证金</small> : <small>不为凑目标而外推</small>}</div>;
}
export function StructureDetails({ advice }: { advice: StructureAdvice }) {
  return <>
    <div className="structure-levels"><Level title="候选止损" level={advice.stop}/>
      <Level title={new Decimal(advice.target1.pnl).lt(0) ? '第一目标 · 减亏' : '第一目标'} level={advice.target1}/>
      <Level title={advice.target2 && new Decimal(advice.target2.pnl).lt(0) ? '第二目标 · 减亏' : '第二目标'} level={advice.target2}/></div>
    <p className="structure-risk">从参考价到止损还可能减少 {researchAmount(advice.additionalRisk)} USDT（{researchAmount(advice.additionalRiskPct)}% 输入保证金）
      <MetricHelp label="候选风险">触线盈亏按输入的开仓价计算；额外风险是从方案参考价到止损的盈亏减少。数量=开仓保证金×杠杆÷开仓价。均未计手续费、资金费、滑点，不是最大亏损保证，不估算强平。</MetricHelp></p>
    <p className="structure-warning">未核定可承受亏损与强平距离，不能据此认定风险合适。仅验证候选，不启用正式离场提醒。</p>
    <div className="structure-trends" aria-label="已收盘价格背景">{advice.trends.map(trend => <span key={trend.interval}>
      {trend.interval} <strong>{({ up: '上行', down: '下行', flat: '持平', unavailable: '不足' })[trend.direction]}</strong>
      {trend.changePct !== null ? ` ${researchAmount(trend.changePct, true)}%` : ''}</span>)}
      <MetricHelp label="多周期价格背景">分别比较各周期最近六根已收盘标记价 K 线的首根开盘与末根收盘。不是上涨概率，也不是四个独立确认信号；未收盘周期不参与。</MetricHelp></div>
    <details className="private-method"><summary>价位依据与数据口径</summary>
      {advice.reasons.map((reason, i) => <p key={i}>{reason}</p>)}
      <p>参考标记价 {advice.referencePrice} · {dateTime(advice.asOf)}。历史截止 {dateTime(advice.historyTo)}。</p>
      <p>15m ATR14：{advice.atr15}；缓冲：{advice.buffer}；报价单位：{advice.tickSize}。最近目标距离 / 止损距离：{researchAmount(advice.remainingRewardRisk)} 倍，不是收益率。</p>
      {advice.warnings.map((warning, i) => <p key={i}>{warning}</p>)}
      <p>本版不模拟分批成交或移动止盈，不自动放宽止损。历史 OI、成交方向与资金费未纳入回放。</p>
      <p><a href="https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data" target="_blank" rel="noreferrer">币安原始接口口径</a> · markPriceKlines / 5m；exchangeInfo / PRICE_FILTER。</p>
    </details>
  </>;
}

export default function StructureLab({ state, recordsOnly = false }: { state: PositionRiskState; recordsOnly?: boolean }) {
  const runtime = usePrivatePositions(), shadow = useStructureShadow(), flow = useSharedFlowMonitor();
  // The position book is cloned each tick. Stable scalar identity preserves replay/zoom and avoids repeated analysis.
  const positionKey = JSON.stringify(state.position);
  const position = useMemo(() => ({ ...state.position }), [positionKey]);
  const [tab, setTab] = useState<Tab>(recordsOnly ? 'records' : 'current'), [history, setHistory] = useState<StructureHistory | null>(null);
  const [proposal, setProposal] = useState<StructureResult | null>(null), [loading, setLoading] = useState(true);
  const frozenProposal = useRef<StructureResult | null>(null);
  const [reference, setReference] = useState<MarkObservation | null>(null);
  const [error, setError] = useState(''), [reload, setReload] = useState(0), [saving, setSaving] = useState(false);
  const [cursor, setCursor] = useState(0), [horizon, setHorizon] = useState(4);
  const replayCursor = useDeferredValue(cursor);
  const computer = useRef<ReturnType<typeof createStructureComputationClient> | null>(null);
  const [computeError, setComputeError] = useState(''), [liveBusy, setLiveBusy] = useState(false), [replayBusy, setReplayBusy] = useState(false);
  const [replayResult, setReplayResult] = useState<{ cursor: number; horizon: number; result: StructureResult; outcome: StructureReplay | null } | null>(null);
  useEffect(() => {
    if (recordsOnly) return;
    const client = createStructureComputationClient(); computer.current = client;
    return () => { client.close(); computer.current = null; };
  }, [recordsOnly, reload]);
  useEffect(() => {
    if (recordsOnly) { setTab('records'); setLoading(false); return; }
    const controller = new AbortController(); setLoading(true); setError(''); setComputeError(''); setProposal(null); frozenProposal.current = null; setReference(null); setReplayResult(null);
    void historyClient.load(position.symbol, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setHistory(value);
      setCursor(Math.max(Math.ceil(STRUCTURE_LOOKBACK_MS / STRUCTURE_INTERVAL_MS) - 1, value.candles.length - 49));
    }).catch(e => { if (!controller.signal.aborted) { setHistory(null); setError(errorText(e)); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [position.symbol, reload, recordsOnly]);
  // Freeze one input while a calculation is in flight: fast market ticks must not starve a slow worker.
  useEffect(() => {
    if (tab !== 'current' || !history || loading || proposal && (proposal.status === 'ready' || proposal.code !== 'stale')) return;
    if (reference && !proposal) return;
    const mark = runtime.frames.get(position.id)?.mark;
    const at = Date.now();
    if (!mark || mark.sourceTime < position.createdAt || mark.sourceTime > at || at - mark.sourceTime > 15_000 || mark.receivedAt > at
      || runtime.error || runtime.issues.get(position.id) || reference && mark.sourceTime <= reference.sourceTime) return;
    // A stale result must become pending again, otherwise every tick replaces its retry input.
    frozenProposal.current = null; setProposal(null);
    setReference({ ...mark });
  }, [tab, history, loading, proposal, reference, runtime.frames, runtime.error, runtime.issues, position]);
  // Freeze the displayed result until explicit reanalysis; this effect does not depend on market heartbeats.
  useEffect(() => {
    if (tab !== 'current' || !computer.current || !history || loading || !reference) return;
    if (frozenProposal.current && (frozenProposal.current.status === 'ready' || frozenProposal.current.code !== 'stale')) return;
    let disposed = false; setLiveBusy(true);
    void computer.current.analyze({ position, history, reference, now: Date.now(), mode: 'live' }).then(({ result }) => {
      if (!disposed) { frozenProposal.current = result; setProposal(result); setComputeError(''); }
    }).catch(e => { if (!disposed && (e as Error).name !== 'AbortError') setComputeError(errorText(e)); })
      .finally(() => { if (!disposed) setLiveBusy(false); });
    return () => { disposed = true; setLiveBusy(false); };
  }, [tab, history, loading, reference, position]);
  const advice = proposal?.status === 'ready' ? proposal.advice : null;
  const records = shadow.book.records.filter(record => record.advice.position.id === state.position.id);
  const active = records.some(record => record.stoppedAt === null);
  useEffect(() => {
    if (tab !== 'replay' || loading || !history || !computer.current) return;
    const candle = history.candles[replayCursor]; if (!candle) return;
    const at = candle.closeTime + 1;
    let disposed = false; setReplayBusy(true);
    void computer.current.analyze({ position: { ...position, entryPrice: candle.close, createdAt: at,
      ...(position.openedAt === undefined ? {} : { openedAt: at }) }, history,
      reference: { marketKey: history.marketKey, markPrice: candle.close, sourceTime: at, receivedAt: at, source: 'binance-premium-rest' },
      now: Date.now(), mode: 'replay' }, horizon * 3_600_000).then(({ result, replay }) => {
      if (!disposed) { setReplayResult({ cursor: replayCursor, horizon, result, outcome: replay }); setComputeError(''); }
    }).catch(e => { if (!disposed && (e as Error).name !== 'AbortError') setComputeError(errorText(e)); })
      .finally(() => { if (!disposed) setReplayBusy(false); });
    return () => { disposed = true; };
  }, [tab, loading, history, replayCursor, horizon, position]);
  const replay = replayResult?.cursor === replayCursor && replayResult.horizon === horizon ? replayResult : null;
  async function save() {
    if (!advice || saving) return; setSaving(true); setError('');
    try { await shadow.save(advice); setTab('records'); } catch (e) { setError(errorText(e)); }
    finally { setSaving(false); }
  }
  async function stop(id: string) {
    setError(''); try { await shadow.stop(id); } catch (e) { setError(errorText(e)); }
  }
  const row = flow.data?.rows?.find(row => row.market.key === state.position.marketKey);
  const contextReady = !!row && row.status === 'live' && row.asOf <= runtime.now && runtime.now - row.asOf <= 30_000;
  const latestMark = runtime.frames.get(state.position.id)?.mark;
  const markReady = !!latestMark && latestMark.sourceTime <= runtime.now && runtime.now - latestMark.sourceTime <= 15_000
    && latestMark.receivedAt <= runtime.now && !runtime.error && !runtime.issues.get(state.position.id);
  return <section className="structure-lab" aria-label={`${state.position.symbol} 结构验证`}>
    <header className="structure-header"><div><h3>结构验证 <span>研究版</span></h3><p>正式提醒保持不变 · 页内约 5 秒采样 · 关页 / 休眠会中断</p></div>
      {!recordsOnly ? <button className="button text-button" onClick={() => setReload(n => n + 1)} disabled={loading}>重新分析</button> : null}</header>
    <nav className="structure-tabs" aria-label="结构验证视图">{(recordsOnly ? [['records', `观察记录 ${records.length}`]] as const : [['current', '当前候选'], ['replay', '历史回放'], ['records', `观察记录 ${records.length}`]] as const).map(([id, label]) =>
      <button key={id} type="button" aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>)}</nav>
    {error || computeError || shadow.error ? <p className="private-error" role="alert">{error || computeError || shadow.error}</p> : null}
    {tab !== 'records' && loading ? <div className="structure-empty" role="status">读取 {state.position.symbol} 最近 14 天原始标记价…<small>仅按需读取当前合约，不扫描所有币种历史。</small></div> : null}
    {tab === 'current' && !loading ? <>
      {advice ? <><StructureDetails advice={advice}/><Suspense fallback={<div className="chart-loading">加载价格图…</div>}>{history ? <StructureChart history={history} advice={advice} horizonMs={0}/> : null}</Suspense>
        <div className="structure-action"><span>{active ? '原观察价位已冻结，重新分析不会替换。' : runtime.now - advice.generatedAt > 60_000 ? '候选已过期，请重新分析后保存；已保存的观察不会过期。' : '保存后只记录触线，不弹正式离场提醒。'}</span>
          <button className="button primary" disabled={saving || !shadow.loaded || !!shadow.error || active || !markReady || runtime.now - advice.generatedAt > 60_000} onClick={() => void save()}>{saving ? '保存中…' : '保存并开始观察'}</button></div>
        {!markReady ? <p className="structure-warning">当前标记价不可用或过期，暂停开始新观察。</p> : null}</>
        : <div className="structure-empty" role="status"><strong>{liveBusy ? '正在核对结构与风险…' : '暂不给候选价位'}</strong><p>{proposal?.status === 'unavailable' ? proposal.reason : history ? '使用同合约已收盘历史与新鲜标记价。' : '历史未加载成功，请重试。'}</p><small>不使用固定百分比补凑方案；现有正式提醒规则不受影响。</small></div>}
      <details className="private-method"><summary>当前辅助信息（不用于历史回放）</summary><p>OI 数量 5m {contextReady ? signed(row.oiChange5m) : '—'}；合约主动买入 {contextReady && row.buyShare5m !== null ? `${row.buyShare5m.toFixed(1)}%` : '—'}。
        <MetricHelp label="辅助信息">OI 增加不等于开多，主动买入也不等于新增多仓。这是现有完整 5m 口径的当前信息，不与结构指标简单计票，不作为过去时点证据。</MetricHelp></p>
        <p>{contextReady ? `更新 ${dateTime(row.asOf)}。` : '当前辅助数据不足或过期。'}资金费与历史成交确认暂未纳入本版候选计算。</p></details>
    </> : null}
    {tab === 'replay' && history && !loading ? <>
      <div className="structure-replay-controls"><label>假设开仓时间<input aria-label="历史回放时间" type="range" min={Math.ceil(STRUCTURE_LOOKBACK_MS / STRUCTURE_INTERVAL_MS) - 1} max={history.candles.length - 1} step="1" value={cursor} onChange={event => setCursor(Number(event.target.value))}/><strong>{dateTime(history.candles[replayCursor]?.closeTime + 1)}{cursor !== replayCursor ? ' · 正在计算' : ''}</strong></label>
        <label>向后观察<select value={horizon} onChange={event => setHorizon(Number(event.target.value))}><option value={1}>1 小时</option><option value={4}>4 小时</option><option value={24}>24 小时</option></select></label></div>
      <p className="structure-warning">假设当时以标记价新开仓，沿用输入保证金和杠杆；不是你真实仓位的历史收益。只诊断 5m 触线，不模拟成交。</p>
      {replay?.result.status === 'ready' ? <><StructureDetails advice={replay.result.advice}/>
        <div className="structure-outcome" role="status"><strong>{({ stop: '先触及止损线', target1: '先触及第一目标', ambiguous: '同根双触线 · 顺序未知', unresolved: '观察期内未触线', incomplete: '观察数据不足' })[replay.outcome!.outcome]}</strong><p>{replay.outcome!.reason}</p><small>已检查 {replay.outcome!.bars} 根闭合 5m K 线 · 截止 {dateTime(replay.outcome!.observedTo)}</small></div>
        <Suspense fallback={<div className="chart-loading">加载回放图…</div>}><StructureChart history={history} advice={replay.result.advice} horizonMs={horizon * 3_600_000}/></Suspense></>
        : <div className="structure-empty" role="status">{replayBusy ? '正在回放该时点…' : replay?.result.status === 'unavailable' ? replay.result.reason : '该时点无可用结果。'}<small>历史拒绝样本保留，不只展示能给出价位的时点。</small></div>}
      <p className="structure-footnote">前 7 天用于准备历史；后 7 天可选择回放。按历史收盘即视为已知的理想条件计算，不能证明实时收益。</p>
    </> : null}
    {tab === 'records' ? <><p className="structure-footnote">仅本机保存，刷新不改价；不会上传持仓。最多 100 份，满后停止新增、不静默删旧记录。清除浏览器数据会丢失记录。</p>
      {!shadow.loaded ? <p className="structure-empty">读取验证记录…</p> : !records.length ? <p className="structure-empty">尚未保存观察方案。先查看当前候选，再决定是否记录。</p> : records.map(record => <article className="structure-record" key={record.id}>
        <div className="structure-record-heading"><strong>{record.stoppedAt !== null ? '已停止观察' : !markReady || shadow.error ? '观察暂停 · 行情或存储不可用' : '本页正在观察'}</strong><small>{dateTime(record.startedAt)}</small>
          {record.stoppedAt === null ? <button className="button text-button" onClick={() => void stop(record.id)}>停止观察</button> : null}</div>
        <p>止损 {record.advice.stop.price} · 第一目标 {record.advice.target1.price}{record.advice.target2 ? ` · 第二目标 ${record.advice.target2.price}` : ''}</p>
        {record.gap ? <p className="structure-warning">存在刷新或行情中断缺口，只记录实际观测，未触线不代表期间没有触线。</p> : <p className="structure-footnote">约 5 秒取一次最新标记价，期间触线后回撤可能漏记，不是逐条行情审计。</p>}
        {record.touches.length ? <ul>{record.touches.map(touch => <li key={touch.rule}>{({ stop: '止损线', target1: '第一目标', target2: '第二目标' })[touch.rule]} · 观测价 {touch.price} · {dateTime(touch.sourceTime)}{touch.afterGap ? ' · 中断后观测' : ''}</li>)}</ul> : <p className="structure-footnote">尚无已观测触线记录。</p>}
        <details className="private-method"><summary>查看冻结方案</summary><StructureDetails advice={record.advice}/></details>
      </article>)}
      <p className="structure-warning">记录不是已成交或已平仓。当前没有常驻后台，关页后无法继续观察。</p></> : null}
  </section>;
}
