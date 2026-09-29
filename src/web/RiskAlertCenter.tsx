import { useEffect, useState } from 'react';
import type { AlertEvent } from '../shared/types';
import type { FlowEvent } from '../shared/flowTypes';
import { usePrivatePositions } from './PrivatePositionsContext';
import { useSharedFlowMonitor } from './FlowMonitorContext';
import { dateTime, percent } from './format';
import { useMarketPlans } from './MarketPlansContext';
import { MarketWatchList } from './MarketPlanPanel';

export default function RiskAlertCenter({ alerts, onPosition, onAsset, onFlow, onSettings, entryRequest = 0 }: {
  alerts: AlertEvent[]; onPosition: () => void; onAsset: (id: string) => void; onFlow: (event: FlowEvent) => void; onSettings: () => void;
  entryRequest?: number;
}) {
  const positions = usePrivatePositions(), flow = useSharedFlowMonitor(), entries = useMarketPlans();
  const [filter, setFilter] = useState<'positions' | 'entry' | 'market' | 'valuation'>(() =>
    entryRequest > 0 || typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('risk') === 'entry' ? 'entry' : 'positions');
  useEffect(() => { if (entryRequest > 0) setFilter('entry'); }, [entryRequest]);
  return <main className="workspace private-workspace">
    <div className="page-heading"><h1>风险提醒</h1><button className="button secondary" onClick={onSettings}>通知设置</button></div>
    <div className="risk-tabs" role="group" aria-label="提醒类别"><button aria-pressed={filter === 'positions'} onClick={() => setFilter('positions')}>持仓退出 <span>{positions.book.events.length}</span></button><button aria-pressed={filter === 'entry'} onClick={() => setFilter('entry')}>进场观察 <span>{entries.book.watches.length}</span></button><button aria-pressed={filter === 'market'} onClick={() => setFilter('market')}>市场异常 <span>{flow.data?.events.length ?? 0}</span></button><button aria-pressed={filter === 'valuation'} onClick={() => setFilter('valuation')}>OI / FDV <span>{alerts.length}</span></button></div>
    {positions.error ? <p className="private-error" role="alert">{positions.error}</p> : null}
    <p className="private-caution">{filter === 'positions' || filter === 'entry' ? '本机记录，关页后不监控。触发提醒不代表已成交或已平仓。' : '以下是历史触发记录，不代表当前仍满足条件。'}</p>
    {filter === 'entry' ? <><MarketWatchList/><section className="risk-event-list" aria-label="进场条件历史">{entries.book.events.map(event => <article key={event.id}><span className="risk-event-kind advisory">{event.kind === 'ready' ? '条件已齐' : event.kind === 'expired' ? '等待截止' : '计划失效'}</span><div><strong>{event.symbol}</strong><p>{event.message}</p><small>{dateTime(event.timestamp)} · 非成交记录{event.afterGap ? ' · 存在监控缺口' : ''}</small></div><button className="button secondary" onClick={() => onAsset(event.assetId)}>查看标的</button></article>)}</section></> : null}
    <section className="risk-event-list" aria-label="风险记录">
      {filter === 'positions' ? positions.book.events.length ? positions.book.events.map(e => <article key={e.id}><span className={`risk-event-kind ${e.rule === 'signal-weakening' ? 'advisory' : ''}`}>{e.rule === 'signal-weakening' ? '观察提醒' : e.rule === 'time-exit' ? '持有时限' : '价格触线'}</span><div><strong>{e.symbol} · {e.title}</strong><p>{e.message}</p><small>{dateTime(e.timestamp)} · 计划 v{e.planRevision}{e.afterGap ? ' · 中断后首次观测' : ''}</small></div><button className="button secondary" onClick={onPosition}>查看持仓</button></article>) : <div className="private-empty">暂无持仓退出记录<button className="button text-button" onClick={onPosition}>前往我的持仓</button></div> : null}
      {filter === 'market' ? (flow.data?.events.length ? flow.data.events.slice(0, 100).map(e => <article key={e.id}><span className="risk-event-kind advisory">市场异常</span><div><strong>{e.symbol} · {e.title}</strong><p>{e.reason}</p><small>{dateTime(e.timestamp)} · {e.venue === 'futures' ? '合约' : '现货'} · 实验性规则</small></div><button className="button secondary" onClick={() => onFlow(e)}>查看证据</button></article>) : <div className="private-empty">{flow.error ?? '暂无已记录的市场异常'}</div>) : null}
      {filter === 'valuation' ? alerts.length ? alerts.map(e => <article key={e.id}><span className="risk-event-kind advisory">估值阈值</span><div><strong>{e.symbol} · OI / FDV {percent(e.ratio)}</strong><p>合约持仓与完全稀释估值的规模比较，不单独决定多空。</p><small>{dateTime(e.timestamp)}</small></div><button className="button secondary" onClick={() => onAsset(e.assetId)}>查看标的</button></article>) : <div className="private-empty">暂无 OI / FDV 提醒记录</div> : null}
    </section>
  </main>;
}
