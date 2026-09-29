import { useEffect, useMemo, useRef, useState } from 'react';
import Decimal from 'decimal.js';
import { proposePositionAdvice, proposeStructureRiskPlan, type PositionAdvice } from '../shared/positionAdvice';
import { RISK_PROPOSAL_TTL_MS, stepPositionRisk } from '../shared/positionRisk';
import type { PositionRiskState } from '../shared/positionTypes';
import type { DirectionConfig } from '../shared/directionConfig';
import type { StructureAdvice, StructureHistory, StructureResult } from '../shared/structureTypes';
import { createStructureComputationClient } from './structureComputation';
import { structureHistoryClient } from './structureResources';
import { usePrivatePositions } from './PrivatePositionsContext';
import { MetricHelp } from './MetricHelp';
import { clockTime, dateTime } from './format';

function amount(value: string, signed = false) {
  const d = new Decimal(value);
  if (d.isZero()) return '0';
  const result = !d.isZero() && d.abs().lt('.01') ? d.toPrecision(3)
    : d.toDecimalPlaces(2).toNumber().toLocaleString('en-US', { maximumFractionDigits: 2 });
  return `${signed && d.gt(0) ? '+' : ''}${result}`;
}

export function PositionAdvicePanel({ state, onDone }: { state: PositionRiskState; onDone: () => void }) {
  const [legacy, setLegacy] = useState(false);
  return <><div className="advice-mode" aria-label="离场建议方法"><button type="button" aria-pressed={!legacy} onClick={() => setLegacy(false)}>历史结构方案</button>
    <button type="button" aria-pressed={legacy} onClick={() => setLegacy(true)}>旧版波动方案</button></div>
    {legacy ? <><p className="advice-caution">旧版：1分钟 ATR 规则，不使用历史支撑压力，也没有持有期限。</p><AtrPositionAdvicePanel state={state} onDone={onDone}/></>
      : <StructurePositionAdvicePanel state={state} onDone={onDone}/>}</>;
}

/** Load only the selected position; market heartbeats never restart a calculation in flight. */
function StructurePositionAdvicePanel({ state, onDone }: { state: PositionRiskState; onDone: () => void }) {
  const runtime = usePrivatePositions(), key = JSON.stringify(state.position);
  const position = useMemo(() => ({ ...state.position }), [key]);
  const [history, setHistory] = useState<StructureHistory | null>(null), [loading, setLoading] = useState(true);
  const [candidate, setCandidate] = useState<{ result: StructureResult; config: DirectionConfig; revision: number } | null>(null);
  const [error, setError] = useState(''), [computing, setComputing] = useState(false), [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0), [minutes, setMinutes] = useState(() => (state.plan?.holdingLimitMs ?? position.suggestedHoldingLimitMs ?? 14_400_000) / 60_000);
  const computer = useRef<ReturnType<typeof createStructureComputationClient> | null>(null);
  const active = useRef(false), epoch = useRef(0), lastReference = useRef(0);
  const current = useRef({ runtime, state }); current.current = { runtime, state };
  useEffect(() => {
    const generation = ++epoch.current, controller = new AbortController();
    const client = createStructureComputationClient(); computer.current = client;
    active.current = false; lastReference.current = 0; setLoading(true); setHistory(null); setCandidate(null); setError(''); setComputing(false);
    void structureHistoryClient.load(position.symbol, controller.signal).then(value => {
      if (epoch.current === generation && !controller.signal.aborted) setHistory(value);
    }).catch(e => { if (!controller.signal.aborted && epoch.current === generation) setError(e instanceof Error ? e.message : '历史加载失败，请重试'); })
      .finally(() => { if (!controller.signal.aborted && epoch.current === generation) setLoading(false); });
    return () => { ++epoch.current; controller.abort(); client.close(); computer.current = null; active.current = false; };
  }, [position, reload]);
  useEffect(() => {
    if (loading || !history || !computer.current || active.current || error
      || candidate && (candidate.result.status === 'ready' || candidate.result.code !== 'stale')) return;
    const live = current.current, at = Date.now(), mark = live.runtime.frames.get(position.id)?.mark;
    if (!mark || live.runtime.error || live.runtime.issues.get(position.id) || mark.sourceTime < position.createdAt
      || mark.sourceTime > at || mark.receivedAt > at || at - mark.sourceTime > 15_000 || mark.sourceTime <= lastReference.current) return;
    active.current = true; lastReference.current = mark.sourceTime; setComputing(true);
    const generation = epoch.current, config = { ...live.runtime.config }, revision = live.state.plan?.revision ?? 0;
    void computer.current.analyze({ position, history, reference: { ...mark }, now: at, mode: 'live' }).then(({ result }) => {
      if (generation === epoch.current) setCandidate({ result, config, revision });
    }).catch(e => { if (generation === epoch.current && (e as Error).name !== 'AbortError') setError(e instanceof Error ? e.message : '结构分析失败，请重试'); })
      .finally(() => { if (generation === epoch.current) { active.current = false; setComputing(false); } });
  }, [position, history, loading, candidate, runtime.now, runtime.frames, error]);
  const advice = candidate?.result.status === 'ready' ? candidate.result.advice : null;
  // Worker completion can arrive between the shared five-second clock ticks.
  const checkedAt = Date.now();
  const proposal = advice ? proposeStructureRiskPlan(position, advice, candidate!.config, checkedAt, minutes * 60_000) : null;
  const frame = runtime.adviceFrameFor(position, checkedAt, candidate?.config ?? runtime.config);
  const blocked = runtime.error || runtime.issues.get(position.id) || proposal?.error || (proposal?.plan
    ? stepPositionRisk(state, { type: 'confirm', plan: proposal.plan, expectedPlanRevision: candidate!.revision, frame, now: checkedAt }).error : null);
  async function adopt() {
    if (!proposal?.plan || blocked || saving) return;
    setSaving(true); setError('');
    try { await runtime.confirm(position.id, proposal.plan, candidate!.revision); onDone(); }
    catch (e) { setError(e instanceof Error ? e.message : '建议未采纳，请重试'); }
    finally { setSaving(false); }
  }
  return <section className="risk-plan-editor position-advice" aria-label={`${position.symbol} 系统离场建议`}>
    <div className="private-section-heading"><div><h3>系统离场建议</h3><small>历史结构 · 试验规则，未经盈利验证</small></div>
      <button type="button" className="button text-button" disabled={loading || saving} onClick={() => setReload(n => n + 1)}>重新分析</button></div>
    {state.plan ? <p className="advice-existing">当前 v{state.plan.revision} 提醒计划保持不变；只有采纳本次建议才会替换。</p>
      : <p className="private-note">你不用填写止损止盈参数。采纳后才开始提醒，录入持仓不等于开启提醒。</p>}
    {advice ? <StructureRiskDetails advice={advice}/> : <div className="advice-wait" role="status"><strong>{loading ? '正在读取原始历史 K 线…' : computing ? '正在计算支撑、压力与风险…' : '暂不给出结构价位'}</strong>
      <p>{candidate?.result.status === 'unavailable' ? candidate.result.reason : '需要同合约完整历史与新鲜标记价，不用固定百分比补凑价位。'}</p><small>当前没有新提醒计划被启用。</small></div>}
    <label className="advice-holding">最长持有<select value={minutes} onChange={e => setMinutes(Number(e.target.value))} disabled={saving}>
      <option value={30}>30分钟</option><option value={60}>1小时</option><option value={120}>2小时</option><option value={240}>4小时</option></select>
      <MetricHelp label="最长持有">这是退出检查期限，不是预测持有时长。止损或目标先到就先提醒；不会要求至少持有30分钟。期限不会让提醒自动平仓。</MetricHelp></label>
    <p className="advice-time">{position.openedAt === undefined ? `未填写实际开仓时间，从采纳时开始计 ${minutes} 分钟。` : `从实际开仓 ${dateTime(position.openedAt)} 起计，截止 ${dateTime(position.openedAt + minutes * 60_000)}。`}
      {position.openedAt !== undefined && position.openedAt + minutes * 60_000 <= runtime.now ? '已超过所选期限，采纳后即提醒检查离场。' : ''}</p>
    {advice ? <p className="advice-time">标记价 {advice.referencePrice} · {dateTime(advice.asOf)}；生成后60秒内可采纳，启用后价位和期限冻结。</p> : null}
    {blocked || error ? <p className="private-error" role="status">{blocked || error}</p> : null}
    <p className="advice-caution">仅在页面运行时提醒，关页／休眠会中断。未在交易所挂保护单，未核定强平价。</p>
    <div className="private-form-footer"><span>止损／目标／时限到达时提醒；不会自动成交</span><div className="private-actions">
      <button type="button" className="button text-button" disabled={saving} onClick={onDone}>{state.plan ? '保留原方案' : '暂不采纳'}</button>
      <button type="button" className="button primary" disabled={!proposal?.plan || !!blocked || saving || !!error} onClick={() => void adopt()}>{saving ? '正在启用…' : state.plan ? '采纳建议并替换提醒' : '采纳建议并开启提醒'}</button>
    </div></div>
  </section>;
}

export function StructureRiskDetails({ advice }: { advice: StructureAdvice }) {
  return <><div className="advice-prices"><div><span>建议止损价</span><strong>{advice.stop.price}</strong><small>触线估算盈亏 {amount(advice.stop.pnl, true)} USDT</small></div>
    <div><span>{new Decimal(advice.target1.pnl).lt(0) ? '减亏离场目标' : '建议止盈价'}</span><strong>{advice.target1.price}</strong><small>触线估算盈亏 {amount(advice.target1.pnl, true)} USDT</small></div></div>
    <p className="advice-conclusion">止损或第一目标到达时，建议检查并退出全部剩余仓位；提醒不等于已成交。首次目标之后不自动转追第二目标。</p>
    <p className="advice-risk">从参考价到止损还可能减少 {amount(advice.additionalRisk)} USDT（{amount(advice.additionalRiskPct)}% 输入保证金）。
      <MetricHelp label="结构风险">按输入保证金×杠杆÷开仓价估算数量；未计手续费、滑点、资金费，不是最大亏损承诺，也不能保证止损先于强平。</MetricHelp></p>
    {new Decimal(advice.target1.pnl).lt(0) ? <p className="advice-caution">第一目标仍是亏损，只是减亏目标，不代表回本。</p> : null}
    <details className="private-method"><summary>为什么选这些价位</summary>{advice.reasons.map(reason => <p key={reason}>{reason}</p>)}
      <p>近7天已收盘标记价；止损结构 {advice.stop.structurePrice}，目标结构 {advice.target1.structurePrice}。15分钟 ATR14 {advice.atr15}，缓冲 {advice.buffer}。</p>
      <p>剩余空间／风险 {amount(advice.remainingRewardRisk)} 倍，未扣成本，不是胜率。摆动点有至少30分钟确认延迟，支撑压力可能失效。</p>
      <p>本次仅按结构提醒，不叠加旧版移动保护和5分钟信号转弱退出。OI与成交是辅助信息，未纳入本方案的历史计算。</p></details></>;
}

/** Hold the legacy displayed proposal fixed until an explicit refresh. */
export function AtrPositionAdvicePanel({ state, onDone }: { state: PositionRiskState; onDone: () => void }) {
  const runtime = usePrivatePositions();
  const frame = useMemo(() => runtime.adviceFrameFor(state.position, runtime.now, runtime.config),
    [runtime.adviceFrameFor, state.position, runtime.now, runtime.config, runtime.frames]);
  const issue = runtime.issues.get(state.position.id), revision = state.plan?.revision ?? 0;
  const [proposal, setProposal] = useState(() => proposePositionAdvice(state.position, frame, runtime.now, runtime.config));
  const [expectedRevision, setExpectedRevision] = useState(revision);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  // A failed first read must not become an empty manual form. Freeze only the first complete proposal.
  useEffect(() => {
    if (proposal.advice || issue || runtime.error) return;
    const next = proposePositionAdvice(state.position, frame, runtime.now, runtime.config);
    if (next.advice || next.error !== proposal.error) { setProposal(next); if (next.advice) setExpectedRevision(revision); }
  }, [proposal.advice, proposal.error, issue, runtime.error, state.position, frame, runtime.now, runtime.config, revision]);
  const advice = proposal.advice;
  const blocked = runtime.error || issue || (advice ? stepPositionRisk(state, { type: 'confirm', plan: advice.plan,
    expectedPlanRevision: expectedRevision, frame, now: runtime.now }).error : proposal.error);
  function refresh() {
    if (busy) return;
    const next = proposePositionAdvice(state.position, frame, runtime.now, runtime.config);
    if (next.advice) { setProposal(next); setExpectedRevision(revision); setError(''); }
    else { setError(next.error ?? '行情暂不可用，等待恢复后重新分析。'); }
  }
  async function adopt() {
    if (!advice || blocked || busy) return;
    setBusy(true); setError('');
    try { await runtime.confirm(state.position.id, advice.plan, expectedRevision); onDone(); }
    catch (e) { setError(e instanceof Error ? e.message : '建议未采纳，请稍后重试。'); }
    finally { setBusy(false); }
  }
  return <section className="risk-plan-editor position-advice" aria-label={`${state.position.symbol} 系统离场建议`}>
    <div className="private-section-heading"><div><h3>系统离场建议</h3><small>{state.position.symbol} · {state.position.side === 'long' ? '多单' : '空单'} · 待你采纳</small></div>
      {advice ? <button type="button" className="button text-button" disabled={busy} onClick={refresh}>重新分析</button> : null}</div>
    {state.plan ? <p className="advice-existing">当前 v{revision} 提醒计划保持不变；只有采纳本次建议才会替换。</p> : <p className="private-note">你不用填写止损止盈参数。采纳后才开始提醒，录入持仓不等于开启提醒。</p>}
    {advice ? <AdviceDetails advice={advice}/> : <div className="advice-wait" role="status"><strong>正在等待可用行情，暂不给出价格建议</strong><p>{issue || proposal.error}</p><small>数据恢复后自动分析，不需要你填写参数。当前没有新提醒计划被启用。</small></div>}
    {advice ? <p className="advice-time">基于 {clockTime(advice.markSourceTime)} 的标记价 {advice.referencePrice} · 生成后 {RISK_PROPOSAL_TTL_MS / 1000} 秒内可采纳，过期需重新分析；已启用计划不受此时限影响。</p> : null}
    {advice && blocked ? <p className="private-error" role="status">{blocked}</p> : null}
    {error ? <p className="private-error" role="alert">{error}</p> : null}
    <div className="private-form-footer"><span>规则生成 · 未经收益验证 · 仅提醒，不自动交易</span><div className="private-actions">
      <button type="button" className="button text-button" disabled={busy} onClick={onDone}>{state.plan ? '保留原方案' : '暂不采纳'}</button>
      <button type="button" className="button primary" disabled={!advice || !!blocked || busy} onClick={() => void adopt()}>{busy ? '正在启用…' : state.plan ? '采纳建议并替换提醒' : '采纳建议并开启提醒'}</button>
    </div></div>
  </section>;
}

export function AdviceDetails({ advice }: { advice: PositionAdvice }) {
  const { plan } = advice;
  return <>
    <p className={`advice-conclusion ${advice.signalStatus === 'opposed' ? 'advice-caution' : ''}`}>{advice.signalReason}<MetricHelp label="建议的性质">这是现有波动保护规则与有效5分钟方向信号的解释，不是实时AI预测或已验证盈利策略。保护价从生成建议时的标记价计算，盈亏从你输入的开仓价计算。</MetricHelp></p>
    <div className="advice-prices">
      <div><span>建议保护价<MetricHelp label="建议保护价">多单标记价跌到此价、空单涨到此价时提醒检查是否离场。价格距建议时标记价2倍ATR；不是自动止损委托，也不是最大亏损保证。</MetricHelp></span><strong>{plan.stopPrice}</strong><small>触线估算盈亏 {amount(advice.stopPnl, true)} USDT · {amount(advice.stopReturnPct, true)}%</small></div>
      <div><span>{advice.targetStillLoss ? '建议目标离场价' : '建议止盈观察价'}<MetricHelp label="建议目标价">目标距离为保护距离的2倍，即4倍ATR。到价提醒检查是否离场，不保证能以此价成交；目标即使位于当前价有利一侧，也可能低于你的回本价。</MetricHelp></span><strong>{plan.takeProfitPrice}</strong><small>触线估算盈亏 {amount(advice.targetPnl, true)} USDT · {amount(advice.targetReturnPct, true)}%</small></div>
    </div>
    {advice.targetStillLoss ? <p className="advice-caution">达到目标价仍预计亏损，不是回本或获利承诺。</p> : null}
    <p className="advice-risk">从建议时价格到保护价，预计还会回吐／亏损 {amount(advice.additionalRisk)} USDT，相当于输入保证金的 {amount(advice.additionalRiskPct)}%。<MetricHelp label="额外风险与盈亏">额外风险是从建议时标记价走到保护价的盈亏减少；触线盈亏则从你的开仓价计算。百分比分母均为输入保证金，不是币价涨跌幅；未计手续费、资金费、滑点，不估算强平价。</MetricHelp></p>
    <div className="advice-followup"><strong>采纳后如何提醒</strong>
      <p>触及保护价或目标价时弹出离场提醒。</p>
      {plan.trailing ? <p>到 {plan.trailing.activationPrice} 启动移动保护；随后从已观察最佳标记价回撤 {plan.trailing.callbackPct}% 时提醒。<MetricHelp label="建议移动保护">多单从激活后的最高标记价向下回撤，空单从最低标记价向上反弹；分母为已观察最佳标记价。离线期间高低点不可知，关页／休眠可能漏过触线。</MetricHelp></p> : null}
      {plan.signalWeakening ? <p>方向信号持续转弱时提醒核查仓位。<MetricHelp label="建议的信号转弱提醒">需先观察到支持持仓方向的有效基线，再连续两个相邻分钟结束的5m评估不再支持原方向。缺数与过期不算转弱；反向信号不代表确定反转。采用本次建议保存的参数。</MetricHelp></p> : null}
    </div>
    <details className="private-method"><summary>为什么这样建议</summary><p>同合约15根闭合1分钟K线计算ATR14为 {advice.atr}，以2倍ATR留出波动空间、2R设目标、1R激活移动保护。这里的R是建议时标记价到保护价的距离，不是从开仓价计算的盈亏比。该规则未经盈利回测，未估算强平价，不能保证保护价先于强平触发。</p></details>
  </>;
}
