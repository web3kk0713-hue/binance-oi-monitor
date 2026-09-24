import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { FlowEvent, FlowEventKind, FlowHistory, FlowMetrics } from '../shared/flowTypes';
import type { Snapshot } from '../shared/types';
import type { Settings } from './storage';
import { FLOW_RULES } from '../shared/orderflow';
import { useSharedFlowMonitor } from './FlowMonitorContext';
import { useChangeMonitor } from './useChangeMonitor';
import { DEFAULT_CHANGE_RULE } from '../shared/changeMonitor';
import { selectFlowContext } from '../shared/flowContext';
import { PositionHighlights, PositionPanel } from './PositionPanel';
import { Icon } from './Icons';
import { age, clockTime, dateTime, percent, signed } from './format';
import { notificationSupport, registerNotifications } from './notifications';
import './flow.css';

const FlowCharts = lazy(() => import('./FlowCharts').then(module => ({ default: module.FlowCharts })));
const EMPTY_EVENTS: FlowEvent[] = [];
const EMPTY_ROWS: FlowMetrics[] = [];
const KINDS: { value: string; label: string; kinds: FlowEventKind[] }[] = [
  { value: 'all', label: '全部异常', kinds: [] },
  { value: 'large', label: '大额成交', kinds: ['large_buy', 'large_sell'] },
  { value: 'pressure', label: '持续压力', kinds: ['buy_pressure', 'sell_pressure'] },
  { value: 'breakout', label: '放量突破', kinds: ['breakout_up', 'breakout_down'] },
  { value: 'divergence', label: '价量背离', kinds: ['flow_divergence'] },
  { value: 'liquidity', label: '盘口变薄', kinds: ['liquidity_drop'] },
];
type FlowRange = 'event' | '1h' | '24h' | '7d';
const RANGE_HOURS: Record<Exclude<FlowRange, 'event'>, number> = { '1h': 1, '24h': 24, '7d': 168 };
function number(value: number | null | undefined, compact = false): string {
  return value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('en-US', compact ? { notation: 'compact', maximumFractionDigits: 2 } : { maximumSignificantDigits: 7 });
}
function bps(value: number | null | undefined): string { return value == null || !Number.isFinite(value) ? '—' : value > 0 && value < .01 ? '<0.01 bp' : `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })} bp`; }
function direction(kind: FlowEventKind): string { return ['large_buy', 'buy_pressure', 'breakout_up'].includes(kind) ? 'buy' : ['large_sell', 'sell_pressure', 'breakout_down'].includes(kind) ? 'sell' : 'neutral'; }
function statusText(row: FlowMetrics | undefined): string { return !row ? '等待市场' : row.status === 'live' ? '数据就绪' : row.status === 'warming' ? '预热中' : row.status === 'stale' ? '行情过期' : '连接中断'; }

function EventEvidence({ event, now, onExport }: { event: FlowEvent; now: number; onExport: () => void }) {
  return <section className="flow-event-evidence" aria-label="事件证据">
    <div className="flow-evidence-heading"><div><span className={`flow-kind ${direction(event.kind)}`}>{event.venue === 'futures' ? '合约' : '现货'}事件</span><h3>{event.title}</h3></div><button className="button text-button" onClick={onExport}><Icon name="download" size={15}/>导出证据</button></div>
    <div className="flow-event-time"><span>源时间 {dateTime(event.timestamp)}</span><span>发现于 {clockTime(event.detectedAt)}</span><span>规则 {event.ruleVersion} · 实验性</span></div>
    <div className="flow-evidence-grid">{event.evidence.map((evidence, index) => <div key={`${evidence.label}-${index}`}><span>{evidence.label}</span><strong>{number(evidence.value)} <small>{evidence.unit}</small></strong>{evidence.baseline != null ? <small>基准 {number(evidence.baseline)} {evidence.unit}</small> : null}</div>)}</div>
    <div className="flow-reasons"><p><strong>触发原因</strong>{event.reason}</p><p><strong>失效条件</strong>{event.invalidation}</p></div>
    <div className="flow-outcomes"><h4>随后价格表现 <span>不是策略收益</span></h4><div>{([1, 5, 15] as const).map(minutes => {
      const outcome = event.outcomes.find(item => item.minutes === minutes && item.availableAt <= now);
      return <div key={minutes}><span>{minutes} 分钟后</span><strong className={outcome ? outcome.changePct > 0 ? 'change-up' : outcome.changePct < 0 ? 'change-down' : '' : ''}>{outcome ? signed(outcome.changePct) : '—'}</strong><small>{outcome ? `${number(outcome.price)} ${event.quoteAsset}` : now < event.detectedAt + minutes * 60_000 + FLOW_RULES.outcomeEntryMaxDelayMs ? '等待后续观测' : '尚无完整可比路径'}</small></div>;
    })}</div><p>从发现事件后首个完整、按时收到的收盘价起算；触发价 {number(event.referencePrice)} {event.quoteAsset} 不等于可成交价。{event.outcomes.find(outcome => outcome.entryAt != null)?.entryAt ? `实际起点 ${dateTime(event.outcomes.find(outcome => outcome.entryAt != null)?.entryAt)}，${number(event.outcomes.find(outcome => outcome.entryPrice != null)?.entryPrice)} ${event.quoteAsset}。` : ''}不计手续费、滑点和资金费。</p></div>
    <details className="flow-raw-evidence"><summary>查看原始证据与字段 <Icon name="chevron" size={13}/></summary><pre>{JSON.stringify(event, null, 2)}</pre></details>
  </section>;
}

export default function FlowDashboard({ settings, snapshot, active, historyVersion, onOpenSettings }: { settings: Settings; snapshot: Snapshot | null; active: boolean; historyVersion: number; onOpenSettings: () => void }) {
  const monitor = useSharedFlowMonitor();
  const changes = useChangeMonitor(active ? snapshot : null, settings, DEFAULT_CHANGE_RULE, historyVersion);
  const positions = useMemo(() => changes.rows.map(row => row.position), [changes.rows]);
  const [now, setNow] = useState(Date.now);
  const [selectedKey, setSelectedKey] = useState<string | null>(() => new URLSearchParams(location.search).get('market'));
  const [selectedEvent, setSelectedEvent] = useState<FlowEvent | null>(null);
  const [pendingEventId, setPendingEventId] = useState<string | null>(() => new URLSearchParams(location.search).get('event'));
  const [kind, setKind] = useState('all');
  const [eventScope, setEventScope] = useState<'latest' | 'range'>('latest');
  const [venue, setVenue] = useState<'all' | 'futures' | 'spot'>('all');
  const [search, setSearch] = useState(''); const deferredSearch = useDeferredValue(search);
  const [marketSearch, setMarketSearch] = useState('');
  const [interval, setIntervalSize] = useState<1 | 5>(1);
  const [range, setRange] = useState<FlowRange>('1h');
  const [mobilePane, setMobilePane] = useState<'events' | 'chart'>('events');
  const [historyRecord, setHistoryRecord] = useState<{ key: string; data: FlowHistory } | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [requestVersion, setRequestVersion] = useState(0);
  const [notice, setNotice] = useState<{ event: FlowEvent; count: number } | null>(null);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const seen = useRef(new Set<string>());
  const initialized = useRef(false);
  const mountedAt = useRef(Date.now());
  const settingsRef = useRef(settings); settingsRef.current = settings;
  const historyFn = useRef(monitor.history); historyFn.current = monitor.history;
  const rows = monitor.data?.rows ?? EMPTY_ROWS;
  const events = monitor.data?.events ?? EMPTY_EVENTS;
  const chosen = selectedKey ? rows.find(row => row.market.key === selectedKey) : rows.find(row => row.market.venue === 'futures' && row.market.baseAsset === 'BTC') ?? rows[0];
  const marketKey = selectedKey ?? chosen?.market.key ?? null;
  const positionRow = changes.rows.find(row => row.assetId === chosen?.market.assetId);
  const position = positionRow?.position;
  const data = historyRecord?.key === marketKey ? historyRecord.data : null;
  const event = useMemo(() => {
    if (!selectedEvent || selectedEvent.marketKey !== marketKey) return null;
    return [selectedEvent, events.find(candidate => candidate.id === selectedEvent.id), data?.events.find(candidate => candidate.id === selectedEvent.id)]
      .filter((candidate): candidate is FlowEvent => Boolean(candidate)).sort((a, b) => b.outcomes.length - a.outcomes.length)[0];
  }, [selectedEvent, marketKey, events, data]);
  const isReplay = event !== null;
  const requestClock = isReplay && now > event.timestamp + 15 * 60_000 ? 0 : Math.floor(now / 10_000);
  const observedUntil = isReplay ? Math.min(Math.floor(now / 10_000) * 10_000, event.timestamp + 15 * 60_000) : Math.floor(now / 10_000) * 10_000;
  const chartTo = isReplay && range === 'event' ? event.timestamp + 15 * 60_000 : observedUntil;
  const chartFrom = isReplay && range === 'event' ? event.timestamp - 15 * 60_000 : chartTo - RANGE_HOURS[range === 'event' ? '1h' : range] * 3_600_000;
  const quote = chosen?.market.quoteAsset ?? data?.market?.quoteAsset ?? '报价币';
  const coverageEnd = Math.min(chartTo, observedUntil);
  const expectedMinutes = Math.max(0, Math.floor(coverageEnd / 60_000) - Math.ceil(chartFrom / 60_000));
  const coveredMinutes = new Set((data?.candles ?? []).filter(c => c.closed && c.openTime >= chartFrom && c.closeTime < coverageEnd
    && c.receivedAt <= coverageEnd && c.sourceTime <= coverageEnd).map(c => c.openTime)).size;
  const selectedMarketChoices = useMemo(() => rows.filter(row => `${row.market.symbol} ${row.market.baseAsset}`.toLowerCase().includes(marketSearch.trim().toLowerCase())), [rows, marketSearch]);
  const filteredEvents = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase(); const kinds = KINDS.find(item => item.value === kind)?.kinds ?? [];
    const candidates = eventScope === 'latest' ? events : [...new Map([...events, ...(data?.events ?? [])].filter(item => item.marketKey === marketKey && item.timestamp >= chartFrom && item.timestamp <= chartTo).map(item => [item.id, item])).values()];
    return candidates.filter(item => (venue === 'all' || item.venue === venue) && (!kinds.length || kinds.includes(item.kind))
      && (!query || `${item.symbol} ${item.title}`.toLowerCase().includes(query))).sort((a, b) => b.timestamp - a.timestamp);
  }, [events, data, eventScope, marketKey, chartFrom, chartTo, deferredSearch, venue, kind]);
  const chooseEvent = useCallback((next: FlowEvent) => { setSelectedKey(next.marketKey); setSelectedEvent(next); setPendingEventId(null); setRange('event'); setMobilePane('chart'); }, []);
  const chooseMarket = (key: string) => { setSelectedKey(key); setSelectedEvent(null); setPendingEventId(null); if (range === 'event') setRange('1h'); setMobilePane('chart'); };

  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(timer); }, []);
  useEffect(() => { if (active) monitor.selectMarket(marketKey ?? null); }, [marketKey, monitor.selectMarket, active]);
  useEffect(() => { initialized.current = false; seen.current.clear(); mountedAt.current = Date.now(); setNotice(null); }, [settings.mode, settings.backendUrl]);
  useEffect(() => {
    if (!monitor.data) return;
    if (!initialized.current) { events.forEach(item => seen.current.add(item.id)); initialized.current = true; return; }
    const receivedNow = Date.now();
    const fresh = events.filter(item => receivedNow - monitor.data!.status.asOf <= 30_000 && !seen.current.has(item.id) && item.severity === 'warning' && item.detectedAt >= mountedAt.current
      && item.detectedAt <= receivedNow && receivedNow - item.detectedAt <= 60_000 && item.timestamp <= receivedNow && receivedNow - item.timestamp <= 90_000);
    events.forEach(item => seen.current.add(item.id));
    if (seen.current.size > 20_000) seen.current = new Set(events.map(item => item.id));
    if (!fresh.length) return;
    const latest = fresh.sort((a, b) => b.detectedAt - a.detectedAt)[0];
    setNotice({ event: latest, count: fresh.length });
    if (settingsRef.current.notifications && notificationSupport() && Notification.permission === 'granted') {
      const target = new URL(document.baseURI); target.search = new URLSearchParams({ view: 'flow', market: latest.marketKey, event: latest.id }).toString();
      void registerNotifications().then(worker => worker.showNotification(`${latest.symbol} · ${latest.title}`, {
        body: `${latest.venue === 'futures' ? '合约' : '现货'}异常事件。${latest.reason} 实验性规则，非买卖指令。`,
        tag: `flow-${latest.id}`, requireInteraction: true, icon: new URL('favicon.svg', document.baseURI).href,
        data: { marketKey: latest.marketKey, eventId: latest.id, url: target.href },
      })).catch(() => setNotificationError('系统通知暂未送达，事件已保留在页面。'));
    }
  }, [events, monitor.data]);
  useEffect(() => {
    if (!pendingEventId) return;
    const match = events.find(item => item.id === pendingEventId) ?? data?.events.find(item => item.id === pendingEventId);
    if (match) chooseEvent(match);
  }, [pendingEventId, events, data, chooseEvent]);
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const listener = (message: MessageEvent) => {
      if (message.data?.type !== 'select-flow-event') return;
      if (typeof message.data.marketKey === 'string') setSelectedKey(message.data.marketKey);
      if (typeof message.data.eventId === 'string') setPendingEventId(message.data.eventId);
      setMobilePane('chart');
    };
    navigator.serviceWorker.addEventListener('message', listener); return () => navigator.serviceWorker.removeEventListener('message', listener);
  }, []);
  useEffect(() => {
    if (!active) return;
    if (!marketKey) { setHistoryRecord(null); return; }
    let stopped = false;
    const to = event ? Math.min(Date.now(), event.timestamp + 15 * 60_000) : undefined;
    const hours = range === 'event' ? .5 : RANGE_HOURS[range];
    setHistoryLoading(true); setHistoryError(null);
    void historyFn.current(marketKey, hours, to).then(result => {
      if (stopped) return;
      if (result.market && result.market.key !== marketKey) throw new Error('历史返回了不一致的交易对，已停止展示。');
      setHistoryRecord({ key: marketKey, data: result });
    }).catch((reason: unknown) => { if (!stopped) setHistoryError(reason instanceof Error ? reason.message : '历史读取失败'); })
      .finally(() => { if (!stopped) setHistoryLoading(false); });
    return () => { stopped = true; };
  }, [active, marketKey, range, event?.id, event?.timestamp, requestClock, requestVersion, settings.mode, settings.backendUrl]);

  const exportEvidence = () => {
    if (!event && !data) return;
    const payload = { schemaVersion: 1, exportedAt: new Date().toISOString(), market: chosen?.market ?? data?.market, event,
      range: { from: chartFrom, to: Math.min(chartTo, now), intervalMinutes: interval },
      definitions: { currency: 'native quote currency; not USD', delta: '2 * takerBuyQuote - quoteVolume', cvd: 'sum of candle delta in each continuous displayed segment; resets after gaps', oi: 'last actually observed raw quantity in each displayed candle interval', bubbles: 'recorded large-trade events only; not a complete trade tape' },
      history: data, currentMetrics: chosen ?? null,
      currentPositionContext: positionRow ? { description: 'Current aggregate snapshot context, not evidence known at the historical event time',
        metrics: position, baseline: positionRow.baseline, latest: positionRow.latest } : null };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `flow-${(chosen?.market.symbol ?? 'evidence').replace(/[^A-Z0-9_-]/gi, '')}-${event?.timestamp ?? Date.now()}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const depth = chosen?.depth && chosen.depth.complete && now - chosen.depth.receivedAt <= 15_000 ? chosen.depth : null;
  const status = monitor.data?.status;
  const feedOld = status ? now - status.asOf > 30_000 : false;
  const renderNow = Date.now();
  const selectedContext = selectFlowContext(monitor.data, chosen?.market.assetId, renderNow, marketKey);
  const tradeContext = chosen?.market.venue === 'spot' ? selectedContext.spot : selectedContext.futures;
  const tradeReady = tradeContext?.priceChange5m != null;

  return <main className="flow-workspace" id="flow-monitor">
    <div className="flow-statusbar"><span className={`flow-connection ${monitor.error || feedOld ? 'is-stale' : status?.readyMarkets ? 'is-live' : ''}`}><i/>{settings.mode === 'direct' ? '浏览器实时采集' : '后台持续监控'}</span><span>{status ? `${status.readyMarkets} / ${status.markets} 个市场就绪 · ${status.warmingMarkets} 个预热中` : '正在建立市场连接'}</span><span className="flow-mode-limit">{settings.mode === 'direct' ? '关页或休眠会中断；本机保留 7 天' : status ? `保留 ${status.retentionDays} 天 · ${status.connectedStreams}/${status.totalStreams} 路连接` : '后台状态尚未核实'}</span><button onClick={onOpenSettings}>{settings.mode === 'direct' ? '连接后台' : '连接设置'}<Icon name="chevron" size={12}/></button></div>
    {monitor.error || feedOld ? <div className="status-message error-message" role="alert"><Icon name="warning" size={17}/><span>{monitor.error ?? '快照超过 30 秒未更新。旧数据仅供回看。'}</span><button onClick={monitor.refresh}>重试</button></div> : null}
    {notice ? <div className={`flow-priority-notice ${direction(notice.event.kind)}`} role="alert"><Icon name="warning" size={21}/><div><strong>{notice.event.symbol} · {notice.event.title}</strong><p>{notice.count > 1 ? `本轮另有 ${notice.count - 1} 项异常 · ` : ''}{clockTime(notice.event.timestamp)} · 实验性事件，非买卖指令</p></div><button className="button secondary" onClick={() => { chooseEvent(notice.event); setNotice(null); }}>查看证据</button><button className="icon-button" aria-label="关闭事件提示" onClick={() => setNotice(null)}><Icon name="close" size={17}/></button></div> : null}
    {notificationError ? <div className="flow-inline-warning">{notificationError}<button onClick={() => setNotificationError(null)} aria-label="关闭通知提示"><Icon name="close" size={13}/></button></div> : null}
    <div className="flow-page-heading"><div><h1>异常监控<span>实验性规则</span></h1><p>发现异动，回到成交与持仓证据。</p></div><div className="flow-rule-summary"><span>大额成交</span><span>持续压力</span><span>放量突破</span><span>价量背离</span><span>盘口变薄</span></div></div>
    <PositionHighlights rows={positions} windowMinutes={5} loading={changes.loading} onSelect={assetId => {
      const key = selectFlowContext(monitor.data, assetId, Date.now()).futures?.marketKey;
      if (key) chooseMarket(key);
    }}/>
    {changes.error ? <div className="position-visible-warning" role="status">持仓比较起点不可用：{changes.error}</div> : null}
    <div className="flow-mobile-switch"><button className={mobilePane === 'events' ? 'selected' : ''} onClick={() => setMobilePane('events')}>异常事件 <span>{filteredEvents.length}</span></button><button className={mobilePane === 'chart' ? 'selected' : ''} onClick={() => setMobilePane('chart')}>{chosen?.market.symbol ?? '市场'}图表</button></div>
    <div className={`flow-layout flow-mobile-${mobilePane}`}>
      <aside className="flow-event-rail" aria-label="异常事件列表"><div className="flow-rail-heading"><h2>{eventScope === 'latest' ? '最新事件' : '区间事件'}<span>{filteredEvents.length}</span></h2><span>{status ? clockTime(status.asOf) : '等待数据'}</span></div>
        <div className="flow-event-scope" aria-label="事件范围"><button className={eventScope === 'latest' ? 'selected' : ''} aria-pressed={eventScope === 'latest'} onClick={() => setEventScope('latest')}>全市场最新</button><button className={eventScope === 'range' ? 'selected' : ''} aria-pressed={eventScope === 'range'} onClick={() => setEventScope('range')}>所选市场区间</button></div>
        <label className="flow-event-search"><Icon name="search" size={16}/><input aria-label="筛选异常事件" placeholder="搜索标的或事件" value={search} onChange={input => setSearch(input.target.value)}/>{search ? <button onClick={() => setSearch('')} aria-label="清空事件搜索"><Icon name="close" size={13}/></button> : null}</label>
        <div className="flow-event-filters"><select aria-label="事件类型" value={kind} onChange={input => setKind(input.target.value)}>{KINDS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select><select aria-label="事件市场类型" value={venue} onChange={input => setVenue(input.target.value as typeof venue)}><option value="all">合约与现货</option><option value="futures">仅合约</option><option value="spot">仅现货</option></select></div>
        <div className="flow-event-list">{filteredEvents.length ? filteredEvents.slice(0, 150).map(item => <button key={item.id} className={`flow-event-item ${direction(item.kind)} ${event?.id === item.id ? 'selected' : ''}`} onClick={() => chooseEvent(item)} aria-pressed={event?.id === item.id}><div><strong>{item.symbol}</strong><time dateTime={new Date(item.timestamp).toISOString()}>{clockTime(item.timestamp)}</time></div><span className="flow-event-title">{item.title}{item.severity === 'warning' ? <i>重点</i> : null}</span><div className="flow-event-meta"><span>{item.venue === 'futures' ? '合约' : '现货'} · {item.quoteAsset}</span><span>{item.evidence[0] ? `${item.evidence[0].label} ${number(item.evidence[0].value, true)} ${item.evidence[0].unit}` : '查看触发证据'}</span></div></button>) : <div className="flow-empty-events"><Icon name={search || kind !== 'all' || venue !== 'all' ? 'search' : 'chart'} size={29}/><strong>{search || kind !== 'all' || venue !== 'all' ? '没有匹配的事件' : status?.readyMarkets ? '当前没有新异常' : '市场正在预热'}</strong><p>{search || kind !== 'all' || venue !== 'all' ? '调整筛选，或查看全部事件。' : status?.readyMarkets ? '没有事件不代表没有行情。可选择右侧市场查看实数指标。' : '真实 K 线和成交样本达到要求后才触发事件，不填入模拟提醒。'}</p>{search || kind !== 'all' || venue !== 'all' ? <button className="button text-button" onClick={() => { setSearch(''); setKind('all'); setVenue('all'); }}>清除筛选</button> : <button className="button text-button flow-open-market" onClick={() => setMobilePane('chart')}>查看市场行情</button>}</div>}</div>
        <div className="flow-rail-footnote">最近 {Math.min(filteredEvents.length, 150)} 条{filteredEvents.length > 150 ? ` / ${filteredEvents.length} 条匹配` : ''} · 点击事件回放前后 15 分钟</div>
      </aside>
      <section className="flow-analysis" aria-label="事件行情分析">
        <div className="flow-market-toolbar"><div className="flow-market-select"><label htmlFor="flow-market">观察市场</label><input aria-label="搜索观察市场" placeholder="搜索交易对" value={marketSearch} onChange={input => setMarketSearch(input.target.value)}/><select id="flow-market" value={marketKey ?? ''} onChange={input => chooseMarket(input.target.value)}>{marketKey && !selectedMarketChoices.some(item => item.market.key === marketKey) ? <option value={marketKey}>{chosen?.market.symbol ?? marketKey}</option> : null}{!rows.length ? <option value="">等待市场清单</option> : null}{selectedMarketChoices.map(row => <option key={row.market.key} value={row.market.key}>{row.market.symbol} · {row.market.venue === 'futures' ? '合约' : '现货'}</option>)}</select></div><button className="flow-live-button" onClick={() => { setSelectedEvent(null); setPendingEventId(null); setRange('1h'); }} aria-pressed={!isReplay}><i className={!isReplay ? 'active' : ''}/>{isReplay ? '返回实时' : '实时观察'}</button></div>
        <div className="flow-asset-heading"><div><h2>{chosen?.market.symbol ?? '选择市场'}<span>{chosen?.market.venue === 'spot' ? '现货' : '永续合约'}</span></h2><strong>{number(chosen?.price)}<small>{quote}</small></strong></div><div className={`flow-readiness ${chosen?.status ?? 'warming'}`}><i/>{statusText(chosen)}<small>当前指标 {chosen ? clockTime(chosen.asOf) : '—'}</small></div></div>
        {chosen?.status !== 'live' || !chosen ? <p className="flow-market-reason"><Icon name="warning" size={14}/>{chosen?.reason ?? '等待市场数据。尚未取得的指标保持空值。'}</p> : null}
        <PositionPanel value={position} flow={monitor.data} now={renderNow} preferredMarketKey={marketKey} replay={isReplay} loading={changes.loading}/>
        <div className="flow-metrics-strip"><div><span>所选交易对成交额 / 5m <small>{quote}</small></span><strong>{number(tradeReady ? chosen?.volume5m : null, true)}</strong></div><div><span>放量倍数</span><strong>{!tradeReady || chosen?.volumeMultiple == null ? '—' : `${number(chosen.volumeMultiple)}×`}</strong></div><div><span>单合约 OI 数量 / 5m</span><strong>{signed(tradeReady ? chosen?.oiChange5m ?? null : null)}</strong></div></div>
        <div className="flow-secondary-metrics"><div><span>买卖价差</span><strong>{bps(depth?.spreadBps)}</strong></div><div><span>VWAP / 5m</span><strong>{number(tradeReady ? chosen?.vwap5m : null)}</strong></div><div><span>ATR / 14×1m</span><strong>{number(tradeReady ? chosen?.atr14 : null)}</strong></div></div>
        <div className="flow-chart-controls"><div className="flow-timeframe" aria-label="K线周期">{([1, 5] as const).map(minutes => <button key={minutes} className={interval === minutes ? 'selected' : ''} aria-pressed={interval === minutes} onClick={() => setIntervalSize(minutes)}>{minutes}m</button>)}</div><div className="flow-range" aria-label="证据时间范围">{isReplay ? <button className={range === 'event' ? 'selected' : ''} onClick={() => setRange('event')}>事件 ±15m</button> : null}{(['1h', '24h', '7d'] as const).map(item => <button key={item} className={range === item ? 'selected' : ''} aria-pressed={range === item} onClick={() => setRange(item)}>{item === '7d' ? '7 天' : item}</button>)}</div><span>{historyLoading ? '读取证据…' : isReplay ? '固定事件回放' : '随市场更新'}</span><button className="icon-button" aria-label="重新读取事件历史" onClick={() => setRequestVersion(version => version + 1)}><Icon name="refresh" size={15}/></button></div>
        {isReplay ? <><div className="flow-replay-banner"><span><Icon name="chart" size={15}/>{event.title}</span><strong>{dateTime(event.timestamp)}</strong><button onClick={() => { setSelectedEvent(null); setRange('1h'); }}>退出回放<Icon name="close" size={13}/></button></div><div className="flow-trigger-summary"><p><strong>触发</strong>{event.reason}</p><p><strong>失效</strong>{event.invalidation}</p></div></> : <div className="flow-readiness-summary"><span>放量基准 <strong>{chosen?.baselineWindows ?? 0}</strong> 个 5m 窗口</span><span>大额样本 <strong>{chosen?.tradeSamples ?? 0}</strong></span><span>动态门槛 <strong>{number(chosen?.largeTradeThreshold, true)}</strong> {quote}</span></div>}
        {!depth ? <div className="flow-coverage-note">盘口：{chosen?.depth?.reason ?? '当前市场尚无有效深度'} · {settings.mode === 'direct' ? '深度与现货仅覆盖已核实的所选交易对，不是全市场覆盖。' : '后台仅采集其已配置的深度与现货市场；切换标的不自动扩大覆盖。'}</div> : null}
        <div className="flow-chart-legend"><span><i className="buy"/>主动买</span><span><i className="sell"/>主动卖</span><span><i className="cvd"/>CVD</span><span><i className="oi"/>OI 数量</span><small>气泡仅为已记录大额成交；淡色 K 线未收盘</small></div>
        {historyError ? <div className="flow-history-error" role="alert"><Icon name="warning" size={17}/><span>{historyError}</span><button onClick={() => setRequestVersion(version => version + 1)}>重试</button></div> : null}
        {data ? <Suspense fallback={<div className="flow-chart-placeholder">加载联动图表…</div>}><FlowCharts history={data} interval={interval} from={chartFrom} to={chartTo} observedUntil={observedUntil} selectedEventId={event?.id ?? null} eventTime={event?.timestamp ?? null} onSelectEvent={chooseEvent}/></Suspense> : <div className="flow-chart-placeholder"><Icon name="chart" size={29}/><strong>{historyError ? '暂未取得历史证据' : historyLoading ? '正在读取源头历史' : '等待市场行情'}</strong><p>取得真实 K 线后显示。缺失数据不替换为演示曲线。</p></div>}
        <div className="flow-chart-notes"><span>{dateTime(chartFrom)} — {dateTime(Math.min(chartTo, now))}</span><span>CVD 从连续区间归零，缺口后重置；OI 每根取最后实测。金额单位均为 {quote}。</span></div>
        <div className="flow-coverage-note">区间已取得 {coveredMinutes.toLocaleString()} / {expectedMinutes.toLocaleString()} 根闭合 1m K线{coveredMinutes < expectedMinutes ? ' · 历史不足或存在缺口，不补造曲线' : ''}。OI 与事件从实际观测开始积累。</div>
        {event ? <EventEvidence event={event} now={now} onExport={exportEvidence}/> : <section className="flow-rule-evidence"><div><h3>当前规则上下文</h3><button className="button text-button" disabled={!data} onClick={exportEvidence}><Icon name="download" size={15}/>导出当前证据</button></div><p>主动成交差 Delta = 主动买入额 − 主动卖出额；CVD 为连续区间 Delta 累计。数值描述成交，不代表开多或开空。</p><dl><div><dt>放量基准</dt><dd>{chosen?.baselineWindows ?? 0} 个完整 5m 窗口</dd></div><div><dt>大额成交样本</dt><dd>{chosen?.tradeSamples ?? 0} 条近期观测</dd></div><div><dt>当前大额门槛</dt><dd>{number(chosen?.largeTradeThreshold, true)} {quote}</dd></div><div><dt>公开深度</dt><dd>{depth ? `±${number(depth.bandBps)} bp：买 ${number(depth.bidDepthQuote, true)} / 卖 ${number(depth.askDepthQuote, true)} ${quote}` : chosen?.depth?.reason ?? '未取得当前市场有效盘口'}</dd></div></dl></section>}
        <details className="flow-source-details"><summary>数据范围与接口来源 <Icon name="chevron" size={13}/></summary><p>{status?.scope ?? '仅展示已核实交易对；现货映射与公开深度覆盖不等于全市场覆盖。'}</p><p>历史最多保留 7 天，实际覆盖取决于已采集时长与存储。未采集、断流和无法核实的数据保留空缺。事件规则未经收益验证。</p><a href="https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/ws-streams/market" target="_blank" rel="noreferrer">Binance 官方合约行情流 <Icon name="external" size={12}/></a><a href="https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams" target="_blank" rel="noreferrer">Binance 官方现货行情流 <Icon name="external" size={12}/></a>{status?.errors.length ? <ul>{status.errors.map((error, index) => <li key={index}>{error}</li>)}</ul> : null}</details>
      </section>
    </div>
    <div className="flow-bottom-status"><span>{status?.scope ?? '等待官方市场清单与连接状态'}</span><span>交易对报价币分别统计，USDT / USDC 不混加为 USD。</span></div>
  </main>;
}
