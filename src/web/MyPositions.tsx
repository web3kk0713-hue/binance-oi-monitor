import { useState, type FormEvent } from 'react';
import Decimal from 'decimal.js';
import { valuePosition } from '../shared/positionRisk';
import type { PositionRiskState } from '../shared/positionTypes';
import { usePrivatePositions } from './PrivatePositionsContext';
import { clockTime } from './format';
import './privatePositions.css';
import { MetricHelp } from './MetricHelp';
import { PositionAdvicePanel } from './PositionAdvicePanel';

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
    <div className="private-form-footer"><span>系统给出离场建议，你采纳后才提醒。</span><button className="button primary" disabled={busy || !runtime.loaded}>{busy ? '分析中…' : '分析我的仓位'}</button></div>
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
    {!runtime.loaded ? <div className="private-empty">正在读取本机持仓…</div> : !open.length && !adding ? <div className="private-empty"><h2>先录入一笔持仓</h2><p>只需填写仓位信息，系统给建议，你决定是否采纳。</p><button className="button secondary" onClick={() => setAdding(true)}>录入持仓</button></div> : null}
    <section className="private-position-list" aria-label="未关闭的手工仓位">{open.map(state => {
      const frame = runtime.frames.get(state.position.id), issue = runtime.issues.get(state.position.id);
      const valuation = frame && !issue ? valuePosition(state.position, frame, runtime.now) : null;
      const freshness = issue ? `监控暂停 · ${issue}` : !valuation ? '数据不可用 · 监控暂停' : frame?.mark?.source === 'binance-premium-rest' ? 'REST 降级 · 可能漏过短暂触线' : '标记价监控中';
      return <article className={`private-position ${state.phase === 'triggered' ? 'has-trigger' : ''}`} key={state.position.id}>
        <div className="private-section-heading"><div className="private-position-title"><h2>{state.position.symbol}</h2><span className={state.position.side === 'long' ? 'change-up' : 'change-down'}>{sideLabel(state)} · {number(state.position.leverage, 2)}×</span><span className={`private-phase ${state.phase}`}>{state.phase === 'draft' ? '待采纳建议' : state.phase === 'triggered' ? '已触发提醒 · 未确认离场' : '计划已启用'}</span></div><button className="button secondary" onClick={() => setEditing(editing === state.position.id ? null : state.position.id)}>{editing === state.position.id ? '收起建议' : state.plan ? '重新分析建议' : '查看系统建议'}</button></div>
        <div className={`private-feed-status ${!valuation ? 'warning' : ''}`}>{state.phase === 'draft' ? '提醒尚未启用' : freshness}{state.gap && valuation ? ' · 曾中断，仅按恢复后观测判断' : ''}{valuation && frame?.mark ? ` · ${clockTime(frame.mark.sourceTime)}` : ''}</div>
        <div className="private-values"><div><span>估算浮盈亏 · USDT<MetricHelp label="估算浮盈亏">数量估算=开仓保证金×杠杆÷开仓价。多单盈亏=数量×(标记价−开仓价)，空单反向；不含手续费、资金费和滑点，不是交易所结算记录。</MetricHelp></span><strong className={valuation && new Decimal(valuation.pnl).isNegative() ? 'change-down' : 'change-up'}>{number(valuation?.pnl, 2)}</strong><small>相对输入保证金<MetricHelp label="相对输入保证金收益率">估算浮盈亏÷输入的开仓保证金×100%。不是价格涨跌幅，也不等于已实现收益或账户总收益率。</MetricHelp> {number(valuation?.returnOnMarginPct, 2)}%</small></div><div><span>标记价 / 开仓价<MetricHelp label="标记价">币安发布的该合约参考价格，本页用于浮盈亏和触线提醒。不是最新成交价，也不是保证能成交的价格。</MetricHelp></span><strong>{number(valuation?.markPrice, 8)}</strong><small>开仓 {number(state.position.entryPrice, 8)}</small></div><div><span>输入保证金 · USDT</span><strong>{number(state.position.margin, 2)}</strong><small>估算数量 {number(valuation?.quantity, 8)}</small></div><div><span>保护价 / 止盈价</span><strong>{number(state.plan?.stopPrice, 8)}</strong><small>止盈 {number(state.plan?.takeProfitPrice, 8)}</small></div></div>
        {state.plan?.trailing ? <p className="private-trailing">移动保护{state.trailingActive ? `已激活 · 已观察最佳价 ${number(state.bestPrice, 8)}` : `等待激活价 ${number(state.plan.trailing.activationPrice, 8)}`} · 回撤 {number(state.plan.trailing.callbackPct, 6)}%</p> : null}
        {state.fired.length ? <div className="private-trigger-summary">{runtime.book.events.filter(e => e.positionId === state.position.id && e.planRevision === state.plan?.revision).map(e => <p key={e.id}><strong>{e.title}</strong> · {e.message}</p>)}</div> : null}
        {editing === state.position.id ? <PositionAdvicePanel key={state.position.id} state={state} onDone={() => setEditing(null)}/> : null}
        <div className="private-close-row">{closeId === state.position.id ? <><span>仅标记记录已离场，不会向交易所下单。</span><button className="button danger-button" onClick={() => void close(state.position.id)}>确认已在交易所离场</button><button className="button text-button" onClick={() => setCloseId(null)}>取消</button></> : <button className="button text-button" onClick={() => setCloseId(state.position.id)}>我已离场</button>}</div>
      </article>;
    })}</section>
    {closed.length ? <details className="private-closed"><summary>已标记离场 · {closed.length} 笔</summary>{closed.map(state => <p key={state.position.id}>{state.position.symbol} · {sideLabel(state)} · {clockTime(state.closedAt)} 手工标记；未核实交易所成交</p>)}</details> : null}
  </main>;
}
