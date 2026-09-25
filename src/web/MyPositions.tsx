import { useState, type FormEvent } from 'react';
import Decimal from 'decimal.js';
import { proposeRiskPlan, valuePosition } from '../shared/positionRisk';
import type { PositionRiskState, RiskPlanDraft } from '../shared/positionTypes';
import { usePrivatePositions } from './PrivatePositionsContext';
import { clockTime } from './format';
import './privatePositions.css';
import { MetricHelp } from './MetricHelp';

const number = (value: string | undefined | null, places = 4) => {
  if (value == null) return '—';
  try { const decimal = new Decimal(value); if (!decimal.isFinite()) return '—';
    if (!decimal.isZero() && decimal.abs().lt(new Decimal(10).pow(-places))) return decimal.toPrecision(4);
    return decimal.toDecimalPlaces(places).toNumber().toLocaleString('en-US', { maximumFractionDigits: places }); } catch { return '—'; }
};
const errorText = (e: unknown) => e instanceof Error ? e.message : '操作未保存，请重试。';
const sideLabel = (state: PositionRiskState) => state.position.side === 'long' ? '多单' : '空单';

function PositionEntry({ onSaved, onCancel }: { onSaved: (id: string) => void; onCancel: () => void }) {
  const runtime = usePrivatePositions();
  const [symbol, setSymbol] = useState(''), [side, setSide] = useState<'long' | 'short'>('long');
  const [entryPrice, setEntry] = useState(''), [margin, setMargin] = useState(''), [leverage, setLeverage] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return; setError('');
    const market = runtime.markets.find(m => m.symbol === symbol.trim().toUpperCase());
    if (!market) { setError('从目录选择完整合约代码，例如 BTCUSDT。'); return; }
    setBusy(true);
    try { const id = await runtime.add({ marketKey: market.key, symbol: market.symbol, assetId: market.assetId, side, entryPrice, margin, leverage }); onSaved(id); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return <form className="position-entry" onSubmit={submit} aria-label="录入手工持仓">
    <div className="private-section-heading"><h2>录入持仓</h2><button type="button" className="button text-button" onClick={onCancel}>取消</button></div>
    <div className="private-form-grid"><label>USDT 永续合约<input list="position-contracts" value={symbol} onChange={e => setSymbol(e.target.value)} placeholder="BTCUSDT" required autoComplete="off"/><datalist id="position-contracts">{runtime.markets.map(m => <option key={m.key} value={m.symbol}/>)}</datalist></label>
      <label>方向<select value={side} onChange={e => setSide(e.target.value as 'long' | 'short')}><option value="long">做多</option><option value="short">做空</option></select></label>
      <label>开仓价<input type="number" step="any" min="0" aria-label="开仓价" value={entryPrice} onChange={e => setEntry(e.target.value)} required/></label>
      <label>开仓保证金 · USDT<MetricHelp label="开仓保证金">填这笔仓位开仓时占用的保证金，不是账户总余额。本页按保证金×杠杆÷开仓价估算数量，加减仓或调整保证金后需重新核对。</MetricHelp><input type="number" step="any" min="0" aria-label="开仓保证金 USDT" value={margin} onChange={e => setMargin(e.target.value)} required/></label>
      <label>开仓杠杆 · 倍<MetricHelp label="杠杆">5×表示本页估算名义仓位为输入保证金的5倍。收益和亏损都会相对保证金放大；这里只做估算，不计算交易所强平价。</MetricHelp><input type="number" step="any" min="1" max="125" aria-label="开仓杠杆" value={leverage} onChange={e => setLeverage(e.target.value)} required/></label></div>
    <div className="private-form-footer"><span>按保证金 × 杠杆估算仓位；录入后仍需确认风险方案。</span><button className="button primary" disabled={busy || !runtime.loaded}>{busy ? '保存中…' : '保存并查看方案'}</button></div>
    {error ? <p className="private-error" role="alert">{error}</p> : null}
  </form>;
}

function PlanEditor({ state, onDone }: { state: PositionRiskState; onDone: () => void }) {
  const runtime = usePrivatePositions(), frame = runtime.frames.get(state.position.id)!;
  const [proposal] = useState(() => state.plan ? { plan: state.plan, error: null } : proposeRiskPlan(state.position, frame, runtime.now, runtime.config));
  const [draft, setDraft] = useState<RiskPlanDraft>(() => proposal.plan ?? { stopPrice: '', takeProfitPrice: '', trailing: null, signalWeakening: false,
    directionConfig: runtime.config, method: 'manual' as const, generatedAt: Date.now() });
  const [error, setError] = useState(proposal.error ?? ''), [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const revision = state.plan?.revision ?? 0;
  function patch(next: Partial<RiskPlanDraft>) { setDraft(old => ({ ...old, ...next, method: 'manual', generatedAt: Date.now() })); setReviewed(false); setError(''); }
  function propose() {
    const result = proposeRiskPlan(state.position, frame, runtime.now, runtime.config);
    if (result.plan) { setDraft(result.plan); setReviewed(false); setError(''); }
    else setError(result.error ?? '缺少可用标记价或 ATR，不能生成方案。');
  }
  async function confirm(event: FormEvent) {
    event.preventDefault(); if (!reviewed || busy) return; setBusy(true); setError('');
    try { await runtime.confirm(state.position.id, draft, revision); onDone(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  function estimate(price: string) {
    try { const q = new Decimal(state.position.margin).mul(state.position.leverage).div(state.position.entryPrice);
      return q.mul(new Decimal(price).minus(state.position.entryPrice)).mul(state.position.side === 'long' ? 1 : -1).toFixed(2); } catch { return null; }
  }
  return <form className="risk-plan-editor" onSubmit={confirm} aria-label={`${state.position.symbol} 风险方案`}>
    <div className="private-section-heading"><div><h3>确认风险方案</h3><small>{state.position.symbol} · {sideLabel(state)} · {state.plan ? `当前 v${revision} 仍有效，确认后替换` : '尚未启用'}</small></div><div className="private-actions"><button type="button" className="button secondary" onClick={propose}>生成波动方案</button><button type="button" className="button text-button" onClick={onDone}>收起</button></div></div>
    <p className="private-note">波动方案为未回测试验：2 × ATR14 距离保护，2R 止盈。<MetricHelp label="ATR 与 R 风险距离">ATR14是最近14个真实波幅的平均值，这里用15根闭合1分钟K线计算。它表示价格波动大小，不判断涨跌方向。R指本方案当前价到保护价的价格距离；2R止盈指目标距离为其两倍，不是盈利概率或保证收益。</MetricHelp>你确认后才启用，仅提醒、不下单。</p>
    <div className="private-form-grid plan-grid"><label>保护 / 止损价<MetricHelp label="保护价">标记价触及这个价格时提醒。多单通常设在当前价下方，空单相反。不是自动止损单；价格跳空、断流可能导致晚于该价提醒。</MetricHelp><input type="number" step="any" min="0" aria-label="保护止损价" value={draft.stopPrice} onChange={e => patch({ stopPrice: e.target.value })} required/><small>触线估算盈亏 {number(estimate(draft.stopPrice), 2)} USDT</small></label>
      <label>止盈价<MetricHelp label="止盈价">标记价到达你确认的目标价时提醒，不自动卖出或买回。“触线估算盈亏”从实际输入开仓价计算，未计费用。</MetricHelp><input type="number" step="any" min="0" aria-label="止盈价" value={draft.takeProfitPrice} onChange={e => patch({ takeProfitPrice: e.target.value })} required/><small>触线估算盈亏 {number(estimate(draft.takeProfitPrice), 2)} USDT</small></label></div>
    <div className="plan-options"><label><input type="checkbox" aria-label="启用移动保护" checked={draft.trailing !== null} onChange={e => patch({ trailing: e.target.checked ? { activationPrice: '', callbackPct: '' } : null })}/>移动保护<MetricHelp label="移动保护">价格向持仓有利方向达到激活价后，记录已观察到的最佳价；从最佳价回撤指定百分比时提醒。关页期间高低点不可知。</MetricHelp></label><label><input type="checkbox" aria-label="方向信号连续两分钟转弱提醒" checked={draft.signalWeakening} onChange={e => patch({ signalWeakening: e.target.checked })}/>方向信号连续两分钟转弱提醒<MetricHelp label="方向信号转弱">启用后先观察到支持持仓方向的有效信号，再有连续两个相邻分钟结束的5m评估不再支持原方向，才提醒。不是任意等待120秒，也不把缺数、过期算作转弱。按确认计划时保存的参数判断，不代表确定反转。</MetricHelp></label></div>
    {draft.trailing ? <div className="private-form-grid plan-grid"><label>移动保护激活价<MetricHelp label="移动保护激活价">多单标记价涨到此价、空单跌到此价后，开始移动保护；未激活时不会按回撤比例触发。不是委托价。</MetricHelp><input type="number" step="any" min="0" required aria-label="移动保护激活价" value={draft.trailing.activationPrice} onChange={e => patch({ trailing: { ...draft.trailing!, activationPrice: e.target.value } })}/></label><label>从最佳标记价回撤 · %<MetricHelp label="移动回撤比例">分母是激活后已观察到的最佳标记价：多单取最高价，空单取最低价。多单从100回落到99，或空单从100反弹到101，都是1%。不是保证金亏损1%，离线期间的极值不可知。</MetricHelp><input type="number" step="any" min="0" max="50" required aria-label="从最佳标记价回撤百分比" value={draft.trailing.callbackPct} onChange={e => patch({ trailing: { ...draft.trailing!, callbackPct: e.target.value } })}/></label></div> : null}
    <details className="private-method"><summary>计算与监控限制</summary><p>ATR14 为同合约 15 根闭合 1 分钟 K 线的简单平均真实波幅。移动保护只跟踪启用后实际收到的行情；离线时可能漏过触线和高低点。信号方案保存确认时的方向参数，之后更改灵敏度不会改动本计划。手工估算未计手续费、资金费和滑点，不是交易所强平价、最大亏损或收益保证。</p></details>
    <div className="private-form-footer"><label className="plan-confirm-check"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)}/>我已核对价格，确认仅启用提醒</label><button className="button primary" disabled={!reviewed || busy}>{busy ? '校验并保存…' : '确认并启用此计划'}</button></div>
    {error ? <p className="private-error" role="alert">{error}</p> : null}
  </form>;
}

export default function MyPositions() {
  const runtime = usePrivatePositions(), [adding, setAdding] = useState(false), [editing, setEditing] = useState<string | null>(null);
  const [closeId, setCloseId] = useState<string | null>(null), [error, setError] = useState('');
  const open = runtime.book.positions.filter(s => s.phase !== 'closed'), closed = runtime.book.positions.filter(s => s.phase === 'closed');
  async function close(id: string) { try { await runtime.close(id); setCloseId(null); setError(''); } catch (e) { setError(errorText(e)); } }
  return <main className="workspace private-workspace">
    <div className="connection-bar"><span className="connection-badge"><span className="status-dot warning-dot"/>本机持仓监控</span><span className="connection-description">关页 / 休眠后停止 · 不连接交易账户</span></div>
    <div className="page-heading"><div><h1>我的持仓 <span>{open.length} 个未关闭</span></h1></div><button className="button primary" onClick={() => setAdding(true)} disabled={!runtime.loaded}>录入持仓</button></div>
    {runtime.error || error ? <div className="private-error" role="alert">{runtime.error || error}</div> : null}
    <p className="private-caution">手工估算，不是交易所实际仓位。离场提醒不保证成交，请在交易所设置保护单。</p>
    {adding ? <PositionEntry onSaved={id => { setAdding(false); setEditing(id); }} onCancel={() => setAdding(false)}/> : null}
    {!runtime.loaded ? <div className="private-empty">正在读取本机持仓…</div> : !open.length && !adding ? <div className="private-empty"><h2>先录入一笔持仓</h2><p>填写合约、开仓价、保证金与杠杆，再核对风险方案。</p><button className="button secondary" onClick={() => setAdding(true)}>录入持仓</button></div> : null}
    <section className="private-position-list" aria-label="未关闭的手工仓位">{open.map(state => {
      const frame = runtime.frames.get(state.position.id), issue = runtime.issues.get(state.position.id);
      const valuation = frame && !issue ? valuePosition(state.position, frame, runtime.now) : null;
      const freshness = issue ? `监控暂停 · ${issue}` : !valuation ? '数据不可用 · 监控暂停' : frame?.mark?.source === 'binance-premium-rest' ? 'REST 降级 · 可能漏过短暂触线' : '标记价监控中';
      return <article className={`private-position ${state.phase === 'triggered' ? 'has-trigger' : ''}`} key={state.position.id}>
        <div className="private-section-heading"><div className="private-position-title"><h2>{state.position.symbol}</h2><span className={state.position.side === 'long' ? 'change-up' : 'change-down'}>{sideLabel(state)} · {number(state.position.leverage, 2)}×</span><span className={`private-phase ${state.phase}`}>{state.phase === 'draft' ? '待确认方案' : state.phase === 'triggered' ? '已触发提醒 · 未确认离场' : '计划已启用'}</span></div><button className="button secondary" onClick={() => setEditing(editing === state.position.id ? null : state.position.id)}>{state.plan ? '查看 / 修改方案' : '设置风险方案'}</button></div>
        <div className={`private-feed-status ${!valuation ? 'warning' : ''}`}>{state.phase === 'draft' ? '提醒尚未启用' : freshness}{state.gap && valuation ? ' · 曾中断，仅按恢复后观测判断' : ''}{valuation && frame?.mark ? ` · ${clockTime(frame.mark.sourceTime)}` : ''}</div>
        <div className="private-values"><div><span>估算浮盈亏 · USDT<MetricHelp label="估算浮盈亏">数量估算=开仓保证金×杠杆÷开仓价。多单盈亏=数量×(标记价−开仓价)，空单反向；不含手续费、资金费和滑点，不是交易所结算记录。</MetricHelp></span><strong className={valuation && new Decimal(valuation.pnl).isNegative() ? 'change-down' : 'change-up'}>{number(valuation?.pnl, 2)}</strong><small>相对输入保证金<MetricHelp label="相对输入保证金收益率">估算浮盈亏÷输入的开仓保证金×100%。不是价格涨跌幅，也不等于已实现收益或账户总收益率。</MetricHelp> {number(valuation?.returnOnMarginPct, 2)}%</small></div><div><span>标记价 / 开仓价<MetricHelp label="标记价">币安发布的该合约参考价格，本页用于浮盈亏和触线提醒。不是最新成交价，也不是保证能成交的价格。</MetricHelp></span><strong>{number(valuation?.markPrice, 8)}</strong><small>开仓 {number(state.position.entryPrice, 8)}</small></div><div><span>输入保证金 · USDT</span><strong>{number(state.position.margin, 2)}</strong><small>估算数量 {number(valuation?.quantity, 8)}</small></div><div><span>保护价 / 止盈价</span><strong>{number(state.plan?.stopPrice, 8)}</strong><small>止盈 {number(state.plan?.takeProfitPrice, 8)}</small></div></div>
        {state.plan?.trailing ? <p className="private-trailing">移动保护{state.trailingActive ? `已激活 · 已观察最佳价 ${number(state.bestPrice, 8)}` : `等待激活价 ${number(state.plan.trailing.activationPrice, 8)}`} · 回撤 {number(state.plan.trailing.callbackPct, 6)}%</p> : null}
        {state.fired.length ? <div className="private-trigger-summary">{runtime.book.events.filter(e => e.positionId === state.position.id && e.planRevision === state.plan?.revision).map(e => <p key={e.id}><strong>{e.title}</strong> · {e.message}</p>)}</div> : null}
        {editing === state.position.id ? <PlanEditor key={`${state.position.id}:${state.plan?.revision ?? 0}`} state={state} onDone={() => setEditing(null)}/> : null}
        <div className="private-close-row">{closeId === state.position.id ? <><span>仅标记记录已离场，不会向交易所下单。</span><button className="button danger-button" onClick={() => void close(state.position.id)}>确认已在交易所离场</button><button className="button text-button" onClick={() => setCloseId(null)}>取消</button></> : <button className="button text-button" onClick={() => setCloseId(state.position.id)}>我已离场</button>}</div>
      </article>;
    })}</section>
    {closed.length ? <details className="private-closed"><summary>已标记离场 · {closed.length} 笔</summary>{closed.map(state => <p key={state.position.id}>{state.position.symbol} · {sideLabel(state)} · {clockTime(state.closedAt)} 手工标记；未核实交易所成交</p>)}</details> : null}
  </main>;
}
