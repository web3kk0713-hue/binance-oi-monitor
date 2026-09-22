import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { evaluateAlerts, validThresholds } from '../shared/alerts';
import type { AlertEvent, AlertState, AssetRow, Snapshot, Thresholds } from '../shared/types';
import { Icon } from './Icons';
import { age, clockTime, dateTime, money, percent, tokenPrice } from './format';
import { connectPush, disconnectPush, notificationSupport, registerNotifications, requestNotifications, showAlertNotification } from './notifications';
import { loadPushRegistration, readAlerts, readAlertStates, readSettings, writeLocal, type Settings } from './storage';
import { backendGet, useHistory, useMonitor } from './useMonitor';

const ScatterChart = lazy(() => import('./Charts').then((m) => ({ default: m.ScatterChart })));
const HistoryCharts = lazy(() => import('./Charts').then((m) => ({ default: m.HistoryCharts })));
const EMPTY_ASSETS: AssetRow[] = [];
const PAGE_SIZE = 25;
const RANGES = [{ label: '1 小时', hours: 1 }, { label: '24 小时', hours: 24 }, { label: '7 天', hours: 168 }, { label: '30 天', hours: 720 }];
type SortKey = 'oiUsd' | 'marketCapUsd' | 'fdvUsd' | 'oiToFdv' | 'oiToMarketCap';
type Filter = 'all' | 'alerts' | 'favorites' | 'missing';
function levelClass(ratio: number | null, thresholds: Thresholds) { return ratio === null ? 'muted' : ratio >= thresholds.critical ? 'critical' : ratio >= thresholds.danger ? 'danger' : ratio >= thresholds.warning ? 'warning' : 'normal'; }
function current(row: AssetRow, now: number) { return row.oiUpdatedAt !== null && row.priceUpdatedAt !== null && now - row.oiUpdatedAt <= 90_000 && now - row.priceUpdatedAt <= 90_000 && row.oiUpdatedAt - now <= 15_000 && row.priceUpdatedAt - now <= 15_000; }
function safeSourceUrl(value: string): string | undefined { try { const url = new URL(value); return url.protocol === 'https:' ? url.href : undefined; } catch { return undefined; } }

function Dialog({ title, children, onClose, className = '', description }: { title: string; children: ReactNode; onClose: () => void; className?: string; description?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => { dialog.current?.showModal(); return () => { dialog.current?.close(); }; }, []);
  return <dialog ref={dialog} className={`dialog ${className}`} aria-label={title} onCancel={(e) => { e.preventDefault(); closeRef.current(); }} onClick={(e) => { if (e.target === e.currentTarget) closeRef.current(); }}>
    <div className="dialog-inner"><div className="dialog-heading"><div><h2>{title}</h2>{description ? <p>{description}</p> : null}</div><button className="icon-button" onClick={onClose} aria-label="关闭弹窗"><Icon name="close" /></button></div>{children}</div>
  </dialog>;
}

function SettingsDialog({ settings, onSave, onClose, pushConnected, onConnectPush, onDisconnectPush, onEnableNotifications, onDisableNotifications, onTest }: {
  settings: Settings; onSave: (next: Settings) => Promise<void>; onClose: () => void; pushConnected: boolean;
  onConnectPush: () => Promise<void>; onDisconnectPush: () => Promise<void>; onEnableNotifications: () => Promise<void>; onDisableNotifications: () => Promise<void>; onTest: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState(notificationSupport() ? Notification.permission : 'unsupported');
  const action = async (fn: () => Promise<void>) => { setBusy(true); setError(null); try { await fn(); setPermission(notificationSupport() ? Notification.permission : 'unsupported'); } catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败，请重试。'); } finally { setBusy(false); } };
  const save = (event: FormEvent) => { event.preventDefault(); void action(async () => {
    if (!validThresholds(draft.thresholds)) throw new Error('阈值需要满足 0 < 黄色 < 红色 < 强提醒，冷却至少 1 分钟。');
    let backendUrl = draft.backendUrl.trim().replace(/\/+$/, '');
    if (draft.mode === 'server') {
      let url: URL; try { url = new URL(backendUrl); } catch { throw new Error('请输入完整后台地址，例如 https://monitor.example.com'); }
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('后台地址必须使用 HTTPS；本机开发地址可使用 HTTP。');
      if (url.username || url.password || url.search || url.hash) throw new Error('后台地址不能包含账号、密码、查询参数或锚点。');
      backendUrl = url.href.replace(/\/+$/, '');
    }
    await onSave({ ...draft, backendUrl, notifications: settings.notifications }); onClose();
  }); };
  return <Dialog title="监测设置" description="阈值对页内提醒和已连接的后台推送同时生效。" onClose={onClose} className="settings-dialog">
    <form onSubmit={save}>
      <fieldset><legend>OI / FDV 提醒阈值</legend><div className="threshold-inputs">
        {([{ key: 'warning', label: '黄色提醒', className: 'warning' }, { key: 'danger', label: '红色提醒', className: 'danger' }, { key: 'critical', label: '强提醒', className: 'critical' }] as const).map((item) => <label key={item.key}><span className={`threshold-label ${item.className}`}><i />{item.label}</span><span className="input-unit"><input type="number" min="0.1" step="0.1" required value={draft.thresholds[item.key]} onChange={(e) => setDraft((d) => ({ ...d, thresholds: { ...d.thresholds, [item.key]: Number(e.target.value) } }))} /><span>%</span></span></label>)}
      </div><label className="inline-field">同级提醒冷却 <span className="input-unit narrow"><input type="number" min="1" max="1440" required value={draft.thresholds.cooldownMinutes} onChange={(e) => setDraft((d) => ({ ...d, thresholds: { ...d.thresholds, cooldownMinutes: Number(e.target.value) } }))} /><span>分钟</span></span></label><p className="field-help">强提醒使用醒目弹窗。风险升级立即提醒；数据缺失或过期时不生成新告警。</p></fieldset>
      <fieldset><legend>数据连接</legend><div className="mode-options"><label className={draft.mode === 'direct' ? 'mode-option selected' : 'mode-option'}><input type="radio" name="mode" value="direct" checked={draft.mode === 'direct'} onChange={() => setDraft((d) => ({ ...d, mode: 'direct' }))} /><span><strong>浏览器直连</strong><small>官方公共接口 · 页面开启时采集</small></span></label><label className={draft.mode === 'server' ? 'mode-option selected' : 'mode-option'}><input type="radio" name="mode" value="server" checked={draft.mode === 'server'} onChange={() => setDraft((d) => ({ ...d, mode: 'server' }))} /><span><strong>连接持续运行的后台</strong><small>跨设备历史 · 后台采集与推送</small></span></label></div>
        {draft.mode === 'server' ? <label className="stacked-field">后台地址<input type="url" placeholder="https://monitor.example.com" value={draft.backendUrl} onChange={(e) => setDraft((d) => ({ ...d, backendUrl: e.target.value }))} required /><span className="field-help">先保存连接设置，再开启下方后台推送。</span></label> : <p className="field-help">直连模式关闭页面后暂停采集和提醒；后台标签页或设备休眠可能延迟采集。历史保存在本机浏览器，最多 30 天，取决于可用存储空间。{pushConnected ? '切回直连时会停用当前后台推送。' : ''}</p>}
      </fieldset>
      <fieldset><legend>系统通知</legend><div className="notification-setting"><div><strong>{permission === 'granted' ? settings.notifications ? '系统提醒已开启' : '已获权限，系统提醒已暂停' : permission === 'denied' ? '通知权限已被浏览器拒绝' : permission === 'unsupported' ? '此环境不支持系统通知' : '尚未开启系统通知'}</strong><p className="field-help">需要你主动授权，页内提醒始终可用。</p></div><button type="button" className="button secondary small" disabled={busy || permission === 'unsupported'} onClick={() => void action(settings.notifications ? onDisableNotifications : onEnableNotifications)}>{settings.notifications ? '暂停系统提醒' : '开启通知'}</button></div>
        <div className="notification-actions"><button type="button" className="button text-button" onClick={onTest}><Icon name="bell" size={16} />测试提醒</button>{settings.mode === 'server' ? <button type="button" className="button text-button" disabled={busy} onClick={() => void action(pushConnected ? onDisconnectPush : onConnectPush)}><Icon name="server" size={16} />{pushConnected ? '停用后台推送' : '开启后台推送'}</button> : <span className="muted small-text">连接后台后可接收页面关闭时的推送</span>}</div>
        {pushConnected ? <p className="success-note"><Icon name="check" size={14} /> 后台推送已连接；送达仍取决于设备在线状态和浏览器权限。</p> : null}
      </fieldset>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="dialog-actions"><button type="button" className="button secondary" onClick={onClose}>取消</button><button type="submit" className="button primary" disabled={busy}>{busy ? '正在保存…' : '保存设置'}</button></div>
    </form>
  </Dialog>;
}

function SourceDialog({ row, snapshot, onClose }: { row: AssetRow | undefined; snapshot: Snapshot | null; onClose: () => void }) {
  const exportSource = () => {
    if (!row) return;
    const blob = new Blob([JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), snapshotAt: snapshot?.asOf, methodology: { oi: 'Sum(openInterest × markPrice × quoteUsd)', marketCap: 'normalized Binance reference price × circulating supply', fdv: 'normalized Binance reference price × maximum supply', ratios: 'percent', missing: null }, asset: row }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `${row.symbol}-source-${snapshot?.asOf ?? Date.now()}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };
  return <Dialog title={row ? `${row.symbol} · 数据来源` : '数据来源与口径'} description="查看接口字段、原始单位和更新时间。所有金额统一换算为美元。" onClose={onClose} className="source-dialog drawer-dialog">
    <div className="source-methods"><div><span className="source-number">OI</span><p><strong>Binance 官方合约接口</strong><small>未平仓数量 × 标记价 × 报价币美元价格；同币种合约汇总一次。</small></p></div><div><span className="source-number">估值</span><p><strong>供应量 × Binance 参考价格</strong><small>流通市值采用流通量，FDV 采用最大供应量。没有可靠上限时 FDV 留空。</small></p></div></div>
    <p className="source-disclaimer">OI 是合约持仓的名义金额，流通市值和 FDV 是估值。比例用于发现异常规模，不直接代表方向或资金流入。</p>
    {row ? <><div className="source-summary"><span>映射状态</span><strong className={row.mappingStatus === 'verified' ? 'positive-text' : 'warning-text'}>{row.mappingStatus === 'verified' ? '已核对' : '待核对'}</strong><span>映射依据</span><span>{row.evidence.mapping}</span><span>行情时间</span><span>{dateTime(row.oiUpdatedAt)}</span><span>供应量时间</span><span>{dateTime(row.supplyUpdatedAt)}</span></div>
      {row.issues.length ? <div className="issues-box"><Icon name="warning" size={16} /><div><strong>当前数据限制</strong><ul>{row.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul></div></div> : null}
      <h3 className="source-section-title">合约接口字段 <span>{row.contracts.length} 个合约</span></h3>
      {row.evidence.contracts.map((contract) => <details className="evidence-block" key={contract.symbol}><summary>{contract.symbol}<span>{money(contract.oiUsd)} <Icon name="chevron" size={13} /></span></summary><div className="evidence-links"><a href={`https://fapi.binance.com/fapi/v1/openInterest?symbol=${encodeURIComponent(contract.symbol)}`} target="_blank" rel="noreferrer">官方 OI 接口 <Icon name="external" size={12} /></a><a href={`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${encodeURIComponent(contract.symbol)}`} target="_blank" rel="noreferrer">官方价格接口 <Icon name="external" size={12} /></a></div><pre>{JSON.stringify(contract, null, 2)}</pre></details>)}
      <h3 className="source-section-title">供应量字段</h3>{row.evidence.supply ? <details className="evidence-block"><summary>{row.evidence.supply.provider}<span>ID {row.evidence.supply.id}<Icon name="chevron" size={13} /></span></summary><div className="evidence-links"><a href={safeSourceUrl(row.evidence.supply.url)} target="_blank" rel="noreferrer">查看数据接口 <Icon name="external" size={12} /></a></div><pre>{JSON.stringify(row.evidence.supply, null, 2)}</pre></details> : <p className="field-help">尚未取得可验证供应量。市值、FDV 及其提醒保持不可用。</p>}
      <button className="button secondary export-button" onClick={exportSource}><Icon name="download" size={16} />导出当前币种来源 JSON</button>
    </> : <p className="field-help">取得首轮行情后，选择币种可查看对应接口字段。</p>}
    <div className="source-links"><a href="https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data" target="_blank" rel="noreferrer">Binance 官方文档 <Icon name="external" size={12} /></a><a href="https://support.coinmarketcap.com/hc/en-us/articles/360043396252-Supply-Circulating-Total-Max" target="_blank" rel="noreferrer">供应量定义 <Icon name="external" size={12} /></a></div>
  </Dialog>;
}

function AlertDialog({ alert, test, onClose, onSelect }: { alert: AlertEvent; test: boolean; onClose: () => void; onSelect: (id: string) => void }) {
  return <Dialog title={test ? '测试提醒' : 'OI 已达到强提醒阈值'} onClose={onClose} className="critical-dialog"><div className="critical-symbol"><Icon name="warning" size={24} /><span>{test ? 'TEST' : alert.symbol}</span><small>{test ? '仅用于验证通知效果' : 'OI / FDV'}</small></div><div className="critical-ratio">{percent(alert.ratio)}</div><p>{test ? '这是一条测试消息，不代表实时行情，也不会写入告警记录。' : `合约 OI ${money(alert.oiUsd)}，FDV ${money(alert.fdvUsd)}。请核对源头字段和数据时间。`}</p><div className="critical-time">{dateTime(alert.timestamp)}</div><div className="dialog-actions"><button className="button secondary" onClick={onClose}>知道了</button>{!test ? <button className="button danger-button" onClick={() => { onSelect(alert.assetId); onClose(); }}>查看币种</button> : null}</div></Dialog>;
}

function AlertList({ alerts, onSelect, onClose }: { alerts: AlertEvent[]; onSelect: (id: string) => void; onClose: () => void }) {
  return <Dialog title="提醒记录" description="只记录有效数据触发的提醒；测试消息不计入。" onClose={onClose} className="drawer-dialog alerts-dialog">{alerts.length ? <div className="alert-list">{alerts.map((alert) => <button className="alert-list-item" key={alert.id} onClick={() => { onSelect(alert.assetId); onClose(); }}><span className={`alert-icon ${alert.level}`}><Icon name="warning" size={17} /></span><span><strong>{alert.symbol} <span className={`ratio-text ${alert.level}`}>{percent(alert.ratio)}</span></strong><small>{dateTime(alert.timestamp)}</small></span><Icon name="chevron" size={15} /></button>)}</div> : <div className="dialog-empty"><Icon name="bell" size={30} /><strong>暂时没有触发提醒</strong><p>当可验证的 OI / FDV 达到阈值后，记录会出现在这里。</p></div>}</Dialog>;
}

export default function App() {
  const [settings, setSettings] = useState(readSettings);
  const [now, setNow] = useState(Date.now());
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(location.search).get('asset'));
  const [query, setQuery] = useState(''); const deferredQuery = useDeferredValue(query);
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({ key: 'oiToFdv', direction: 'desc' });
  const [page, setPage] = useState(1); const [hours, setHours] = useState(24);
  const [dialog, setDialog] = useState<'settings' | 'source' | 'alerts' | null>(null);
  const [alerts, setAlerts] = useState(readAlerts);
  const [activeAlert, setActiveAlert] = useState<{ event: AlertEvent; test: boolean } | null>(null);
  const [toastAlert, setToastAlert] = useState<AlertEvent | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pushConnected, setPushConnected] = useState(false);
  const alertStates = useRef<Record<string, AlertState> | null>(null);
  if (alertStates.current === null) alertStates.current = readAlertStates();
  const settingsRef = useRef(settings); settingsRef.current = settings;

  useEffect(() => { const interval = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(interval); }, []);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === '/' && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement) && !dialog) { event.preventDefault(); document.querySelector<HTMLInputElement>('.search-field input')?.focus(); } }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [dialog]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(null), 7_000); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => { if (!toastAlert) return; const timer = setTimeout(() => setToastAlert(null), 15_000); return () => clearTimeout(timer); }, [toastAlert]);
  useEffect(() => { void loadPushRegistration().then((value) => setPushConnected(Boolean(value))).catch(() => undefined);
    if ('serviceWorker' in navigator) {
      void registerNotifications().catch(() => undefined);
      const onMessage = (event: MessageEvent) => { if (event.data?.type === 'select-asset' && typeof event.data.assetId === 'string') setSelectedId(event.data.assetId); };
      navigator.serviceWorker.addEventListener('message', onMessage); return () => navigator.serviceWorker.removeEventListener('message', onMessage);
    }
  }, []);
  useEffect(() => {
    if (settings.mode !== 'server') return;
    const controller = new AbortController(); let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const saved = await backendGet<AlertEvent[]>(settings.backendUrl, '/api/v1/alerts?limit=100', controller.signal);
        if (!stopped && Array.isArray(saved)) setAlerts((previous) => {
          const byId = new Map([...previous, ...saved].map((event) => [event.id, event]));
          const next = [...byId.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, 150); writeLocal('alerts', next); return next;
        });
      } catch { /* The main connection banner reports backend connectivity. */ }
      if (!stopped) timer = setTimeout(() => void load(), 30_000);
    };
    void load(); return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [settings.mode, settings.backendUrl]);

  const onSnapshot = useCallback((snapshot: Snapshot) => {
    const result = evaluateAlerts(snapshot, settingsRef.current.thresholds, alertStates.current ?? {}, Date.now());
    alertStates.current = result.states; writeLocal('alert-states', result.states);
    if (!result.events.length) return;
    const events = result.events;
    setAlerts((previous) => { const next = [...events, ...previous].sort((a, b) => b.timestamp - a.timestamp).slice(0, 150); writeLocal('alerts', next); return next; });
    const highest = [...events].sort((a, b) => b.ratio - a.ratio)[0];
    if (highest.level === 'critical') setActiveAlert({ event: highest, test: false }); else setToastAlert(highest);
    if (settingsRef.current.notifications && !(settingsRef.current.mode === 'server' && pushConnected)) {
      // One visible system alert per round avoids flooding a newly opened browser.
      void showAlertNotification(highest).catch(() => setNotice('系统通知发送失败，提醒已保留在页内记录。'));
    }
  }, [pushConnected]);
  const monitor = useMonitor(settings, onSnapshot);
  const assets = monitor.snapshot?.assets ?? EMPTY_ASSETS;
  const selected = assets.find((row) => row.id === selectedId) ?? assets.find((row) => row.symbol === 'BTC') ?? assets[0];
  const history = useHistory(selected?.id, hours, settings, monitor.historyVersion);
  const snapshotStale = Boolean(monitor.snapshot && now - monitor.snapshot.asOf > 90_000);
  const favorites = useMemo(() => new Set(settings.favorites), [settings.favorites]);
  const alertCount = assets.filter((row) => row.alertEligible && current(row, now) && (row.oiToFdv ?? -1) >= settings.thresholds.warning).length;
  const totalOi = assets.reduce((sum, row) => sum + (row.oiUsd ?? 0), 0);
  const filtered = useMemo(() => {
    const search = deferredQuery.trim().toLowerCase();
    return assets.filter((row) => (!search || `${row.symbol} ${row.name} ${row.contracts.join(' ')}`.toLowerCase().includes(search))
      && (filter !== 'favorites' || favorites.has(row.id))
      && (filter !== 'alerts' || row.alertEligible && (row.oiToFdv ?? -1) >= settings.thresholds.warning)
      && (filter !== 'missing' || !row.complete || !row.alertEligible))
      .sort((a, b) => {
        const critical = Number(b.alertEligible && (b.oiToFdv ?? -1) >= settings.thresholds.critical) - Number(a.alertEligible && (a.oiToFdv ?? -1) >= settings.thresholds.critical);
        if (critical) return critical;
        const av = a[sort.key], bv = b[sort.key];
        if (av === null) return bv === null ? a.symbol.localeCompare(b.symbol) : 1;
        if (bv === null) return -1;
        return (sort.direction === 'asc' ? av - bv : bv - av) || a.symbol.localeCompare(b.symbol);
      });
  }, [assets, deferredQuery, filter, favorites, sort, settings.thresholds.warning, settings.thresholds.critical]);
  useEffect(() => setPage(1), [deferredQuery, filter, sort]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  const pageRows = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const changeSort = (key: SortKey) => setSort((previous) => ({ key, direction: previous.key === key && previous.direction === 'desc' ? 'asc' : 'desc' }));
  const toggleFavorite = (id: string) => setSettings((previous) => { const next = { ...previous, favorites: previous.favorites.includes(id) ? previous.favorites.filter((value) => value !== id) : [...previous.favorites, id] }; writeLocal('settings', next); return next; });
  const select = useCallback((id: string) => setSelectedId(id), []);
  const saveSettings = async (next: Settings) => {
    if (pushConnected && (next.mode !== 'server' || next.backendUrl !== settings.backendUrl)) { await disconnectPush(); setPushConnected(false); }
    else if (pushConnected && next.mode === 'server') await connectPush(next.backendUrl, next.thresholds);
    if (!writeLocal('settings', next)) throw new Error('无法保存设置，请检查浏览器是否允许本地存储。');
    setSettings(next); setNotice('设置已保存');
  };
  const enableNotifications = async () => { await requestNotifications(); setSettings((previous) => { const next = { ...previous, notifications: true }; writeLocal('settings', next); return next; }); setNotice('系统通知已开启'); };
  const connectBackendPush = async () => { await connectPush(settings.backendUrl, settings.thresholds); setPushConnected(true); await enableNotifications(); setNotice('后台推送已连接'); };
  const disconnectBackendPush = async () => { await disconnectPush(); setPushConnected(false); setNotice('后台推送已停用'); };
  const disableNotifications = async () => { if (pushConnected) await disconnectBackendPush(); setSettings((previous) => { const next = { ...previous, notifications: false }; writeLocal('settings', next); return next; }); setNotice('系统提醒已暂停，页内提醒继续运行'); };
  const testAlert = () => { const event: AlertEvent = { id: `test-${Date.now()}`, assetId: 'test', symbol: 'TEST', level: 'critical', ratio: 105, oiUsd: 105_000_000, fdvUsd: 100_000_000, timestamp: Date.now() }; setActiveAlert({ event, test: true }); void showAlertNotification(event, true).catch(() => setNotice('系统通知暂不可用，页内测试已显示。')); };
  const progressPercent = monitor.progress?.total ? Math.min(100, Math.round(monitor.progress.done / monitor.progress.total * 100)) : 0;
  const countdown = Math.max(0, Math.ceil((monitor.nextRun - now) / 1000));
  const headers: { label: string; key: SortKey; className?: string }[] = [{ label: '合约 OI', key: 'oiUsd', className: 'oi-column' }, { label: '流通市值', key: 'marketCapUsd' }, { label: 'FDV', key: 'fdvUsd' }, { label: 'OI / FDV', key: 'oiToFdv' }, { label: 'OI / 流通市值', key: 'oiToMarketCap' }];

  return <>
    <header className="topbar"><a className="brand" href="./" aria-label="OI 监测首页"><span className="brand-mark"><i/><i/><i/></span><span>OI<span className="brand-divider">/</span>估值监测</span><span className="brand-tag">Binance</span></a><nav aria-label="主导航"><button className="nav-item active" onClick={() => document.getElementById('market')?.scrollIntoView({ behavior: 'smooth' })}>市场总览</button><button className="nav-item" onClick={() => setDialog('alerts')}>提醒记录{alerts.length ? <span>{alerts.length}</span> : null}</button></nav><div className="header-actions"><button className="header-icon" onClick={() => setDialog('source')} title="查看数据来源" aria-label="查看数据来源"><Icon name="source" /></button><button className="header-settings" aria-label="监测设置" onClick={() => setDialog('settings')}><Icon name="settings" size={17} /><span>监测设置</span></button></div></header>
    <main className="workspace" id="market">
      <div className={`connection-bar ${settings.mode === 'server' ? 'server-mode' : ''}`}><span className="connection-badge"><span className={`status-dot ${monitor.error || snapshotStale ? 'warning-dot' : monitor.collecting ? 'loading-dot' : ''}`} />{settings.mode === 'direct' ? '浏览器直连' : '后台连接'}</span><span className="connection-description">{settings.mode === 'direct' ? '关闭页面暂停采集和提醒' : monitor.backend ? `后台独立采集 · ${monitor.backend.retentionDays} 天历史${pushConnected ? ' · 后台推送已开启' : ''}` : '正在检查后台运行状态'}</span><button onClick={() => setDialog('settings')}>{settings.mode === 'direct' ? '连接持续监测后台' : '管理连接'}<Icon name="chevron" size={12} /></button></div>
      <div className="page-heading"><div><h1>全市场监测<span>USDⓈ-M 永续</span></h1><p>追踪合约持仓规模与流通市值、完全稀释估值的关系</p></div><div className="refresh-controls"><div className="refresh-meta"><strong>{monitor.collecting ? settings.mode === 'direct' ? '正在采集源头数据' : '正在检查后台快照' : monitor.error ? '等待自动重试' : `${countdown} 秒后刷新`}</strong><span>{monitor.snapshot ? `最近一轮 ${clockTime(monitor.snapshot.asOf)}` : '首次采集通常需要约一分钟'}</span></div><button className="button secondary refresh-button" onClick={monitor.refresh} disabled={monitor.collecting} aria-label="立即刷新行情"><Icon name="refresh" className={monitor.collecting ? 'spinning' : ''} size={17}/><span>刷新</span></button></div></div>
      {monitor.collecting && settings.mode === 'direct' ? <div className="collection-progress" role="status"><div className="progress-track"><div style={{ width: `${Math.max(3, progressPercent)}%` }} /></div><span>{monitor.progress?.total ? `${monitor.progress.done} / ${monitor.progress.total}` : '连接官方接口…'}{monitor.progress?.failed ? ` · ${monitor.progress.failed} 项暂未取得` : ''}</span></div> : null}
      {monitor.error ? <div className="status-message error-message" role="alert"><Icon name="warning" size={17}/><span>{monitor.error} {monitor.snapshot ? '继续展示最近数据，旧数据不会产生新提醒。' : '检查网络或连接可访问官方接口的后台。'}</span><button onClick={monitor.refresh} disabled={monitor.collecting}>重试</button></div> : null}
      {snapshotStale ? <div className="status-message stale-message"><Icon name="warning" size={16}/><span>行情已超过 90 秒未更新。当前数值仅供回看，暂停生成新提醒。</span></div> : null}
      {monitor.storageError ? <div className="status-message stale-message"><Icon name="warning" size={16}/><span>{monitor.storageError}</span></div> : null}
      <section className="metrics-strip" aria-label="全市场摘要"><div className="metric"><span>监测合约 OI <small>USD</small></span><strong>{monitor.snapshot ? money(totalOi) : <span className="skeleton number-skeleton" />}</strong><small><i className="legend-dot oi-dot" />{monitor.snapshot ? `${monitor.snapshot.coverage.oi} 个币种取得 OI` : '等待 Binance 源头数据'}</small></div><div className="metric"><span>监测币种</span><strong>{monitor.snapshot ? monitor.snapshot.universe.assets.toLocaleString() : <span className="skeleton short-skeleton" />}<em>个</em></strong><small>{monitor.snapshot ? `${monitor.snapshot.universe.contracts} 个交易中永续合约` : '自动识别交易中的永续合约'}</small></div><div className="metric"><span>达到提醒阈值</span><strong className={alertCount ? 'warning-text' : ''}>{monitor.snapshot ? alertCount : <span className="skeleton short-skeleton" />}<em>个</em></strong><small><i className="legend-dot warning-dot-color" />OI / FDV ≥ {settings.thresholds.warning}%</small></div><div className="metric coverage-metric"><span>可验证 FDV 覆盖</span><strong>{monitor.snapshot ? monitor.snapshot.coverage.eligible : <span className="skeleton short-skeleton" />}<em>/ {monitor.snapshot?.universe.assets ?? '—'}</em></strong><small>{monitor.snapshot ? `市值 ${monitor.snapshot.coverage.marketCap} · FDV ${monitor.snapshot.coverage.fdv} · 缺失 ${Math.max(0, monitor.snapshot.universe.assets - monitor.snapshot.coverage.eligible)}` : '供应量缺失时保留空值'}</small></div></section>
      {monitor.snapshot?.errors.length ? <details className="data-health"><summary><Icon name="warning" size={15}/><span>{monitor.snapshot.errors.length} 项数据源提示{monitor.snapshot.coverage.failedContracts ? `，${monitor.snapshot.coverage.failedContracts} 个合约采集失败` : ''}</span><span>查看详情<Icon name="chevron" size={12}/></span></summary><ul>{monitor.snapshot.errors.map((error, i) => <li key={i}>{error}</li>)}</ul></details> : null}
      <div className="charts-grid">
        <section className="panel scatter-panel"><div className="panel-heading"><div><h2>持仓与估值分布</h2><p>每个点是一个币种，越靠近参考线，比值越高</p></div><span className="subtle-tag">对数坐标</span></div><div className="scatter-legend"><span><i className="legend-dot oi-dot"/>正常区间</span><span><i className="legend-line warning-line"/>{settings.thresholds.warning}%</span><span><i className="legend-line danger-line"/>{settings.thresholds.danger}%</span><span><i className="legend-line critical-line"/>{settings.thresholds.critical}%</span></div><Suspense fallback={<div className="chart-loading">正在加载图表…</div>}><ScatterChart assets={assets} thresholds={settings.thresholds} selectedId={selected?.id ?? null} onSelect={select}/></Suspense><div className="panel-footnote"><span>横轴 FDV / 纵轴 OI</span><span>点击散点查看详情</span></div></section>
        <section className="panel detail-panel"><div className="panel-heading detail-heading"><div className="selected-heading"><span className="coin-avatar large">{selected?.symbol.slice(0, 1) ?? '—'}</span><div><h2>{selected?.symbol ?? '币种详情'}<span className="selected-name">{selected?.name ?? '选择币种查看走势'}</span></h2><p>{selected ? <>{selected.contracts.length} 个合约 <span className="dot-divider"/> {tokenPrice(selected.priceUsd)}</> : '真实数据持续积累中'}</p></div></div><button className="button text-button source-button" aria-label="来源" onClick={() => setDialog('source')}><Icon name="source" size={15}/><span>来源</span></button></div>
          <div className="selected-metrics"><div><span><i className="legend-dot oi-dot"/>合约 OI</span><strong>{money(selected?.oiUsd)}</strong></div><div><span><i className="legend-dot cap-dot"/>流通市值</span><strong>{money(selected?.marketCapUsd)}</strong></div><div><span><i className="legend-dot fdv-dot"/>FDV</span><strong>{money(selected?.fdvUsd)}</strong></div><div><span>OI / FDV</span><strong className={levelClass(selected?.oiToFdv ?? null, settings.thresholds)}>{percent(selected?.oiToFdv)}</strong></div></div>
          <div className="history-toolbar"><div className="range-control" aria-label="历史时间范围">{RANGES.map((range) => <button key={range.hours} className={hours === range.hours ? 'selected' : ''} aria-pressed={hours === range.hours} onClick={() => setHours(range.hours)}>{range.label}</button>)}</div><span>{history.loading ? '读取历史…' : `${history.points.length.toLocaleString()} 个分钟点`}</span></div>
          <div className="history-chart-wrap">{history.error ? <div className="chart-empty"><strong>历史暂不可用</strong><p>{history.error}</p></div> : <Suspense fallback={<div className="chart-loading">正在加载图表…</div>}><HistoryCharts points={history.points} thresholds={settings.thresholds} hours={hours} symbol={selected?.symbol ?? ''} now={Math.max(monitor.snapshot?.asOf ?? 0, Math.floor(now / 60_000) * 60_000)}/></Suspense>}</div>
          <div className="detail-footnote"><div><span><i className="legend-line oi-line"/>OI / FDV</span><span><i className="legend-line cap-line dashed"/>OI / 流通市值</span></div><span>{history.points.length < 2 ? '曲线从真实采集时刻开始积累' : '采集中断保留空缺'}</span></div>
        </section>
      </div>
      <section className="panel market-panel"><div className="market-heading"><div><h2>全部币种<span>{filtered.length}</span></h2><p>同币种合约已聚合 · 美元计价</p></div><label className="search-field"><Icon name="search" size={16}/><input aria-label="搜索币种或合约" placeholder="搜索币种 / 合约" value={query} onChange={(e) => setQuery(e.target.value)}/>{query ? <button onClick={() => setQuery('')} aria-label="清空搜索"><Icon name="close" size={14}/></button> : <kbd>/</kbd>}</label></div>
        <div className="market-filters"><div className="filter-tabs">{([{ key: 'all', label: '全部' }, { key: 'alerts', label: '达到阈值' }, { key: 'favorites', label: '我的自选' }, { key: 'missing', label: '数据不完整' }] as const).map((item) => <button key={item.key} className={filter === item.key ? 'selected' : ''} onClick={() => setFilter(item.key)}>{item.key === 'favorites' ? <Icon name="star" size={13}/> : null}{item.label}</button>)}</div><span className="table-note">强提醒币种优先置顶</span></div>
        <div className="table-scroll"><table><thead><tr><th className="star-column"><span className="sr-only">自选</span></th><th className="asset-column">币种 / 合约</th>{headers.map((header) => <th key={header.key} className={header.className} aria-sort={sort.key === header.key ? sort.direction === 'desc' ? 'descending' : 'ascending' : 'none'}><button onClick={() => changeSort(header.key)}>{header.label}<span className={sort.key === header.key ? 'sort-active' : ''}>{sort.key === header.key && sort.direction === 'asc' ? '↑' : '↓'}</span></button></th>)}<th className="status-column">数据状态</th><th className="time-column">OI 更新时间</th></tr></thead><tbody>
          {pageRows.map((row) => <tr key={row.id} className={`${selected?.id === row.id ? 'selected-row' : ''} ${row.alertEligible && (row.oiToFdv ?? -1) >= settings.thresholds.critical ? 'critical-row' : ''}`}><td className="star-column"><button className={`star-button ${favorites.has(row.id) ? 'is-favorite' : ''}`} onClick={() => toggleFavorite(row.id)} aria-label={`${favorites.has(row.id) ? '取消自选' : '添加自选'} ${row.symbol}`} aria-pressed={favorites.has(row.id)}><Icon name="star" size={15}/></button></td><td className="asset-column"><button className="asset-button" onClick={() => select(row.id)} aria-pressed={selected?.id === row.id}><span className="coin-avatar">{row.symbol.slice(0, 1)}</span><span><strong>{row.symbol}</strong><small>{row.contracts.length} 个合约</small></span></button></td><td className="numeric oi-column">{money(row.oiUsd)}</td><td className="numeric">{money(row.marketCapUsd)}</td><td className="numeric">{money(row.fdvUsd)}</td><td className="numeric"><span className={`ratio-pill ${row.alertEligible && current(row, now) ? levelClass(row.oiToFdv, settings.thresholds) : 'unverified'}`}>{percent(row.oiToFdv)}</span></td><td className="numeric secondary-ratio">{percent(row.oiToMarketCap)}</td><td className="status-column"><button className={`data-status ${!current(row, now) ? 'stale' : !row.alertEligible ? 'incomplete' : 'verified'}`} onClick={() => { select(row.id); setDialog('source'); }} title={row.issues.join('\n') || '已取得可验证行情与供应量'}><i/>{!current(row, now) ? '行情过期' : !row.alertEligible ? row.fdvUsd === null ? 'FDV 缺失' : '待核对' : '可验证'}</button></td><td className="time-column" title={dateTime(row.oiUpdatedAt)}>{age(row.oiUpdatedAt, now)}</td></tr>)}
          {!pageRows.length ? <tr><td colSpan={9}><div className="table-empty">{!monitor.snapshot ? <><span className="loading-ring"/><strong>{monitor.error ? '暂未取得源头行情' : '正在建立第一轮市场快照'}</strong><p>{monitor.error ? '可以重试采集，或在设置中连接可访问数据源的后台。' : '每个合约独立查询，完成后显示真实数值。'}</p></> : <><Icon name={filter === 'favorites' ? 'star' : 'search'} size={27}/><strong>{filter === 'favorites' && !query ? '还没有自选币种' : '没有符合条件的币种'}</strong><p>{filter === 'favorites' && !query ? '点击币种左侧星标即可加入自选。' : '尝试其他关键词或切换筛选条件。'}</p><button className="button text-button" onClick={() => { setFilter('all'); setQuery(''); }}>查看全部币种</button></>}</div></td></tr> : null}
        </tbody></table></div><div className="pagination"><span>{filtered.length ? `${(currentPage - 1) * PAGE_SIZE + 1}–${Math.min(currentPage * PAGE_SIZE, filtered.length)} / ${filtered.length} 个币种` : '0 个币种'}</span><div><button className="pagination-arrow" disabled={currentPage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} aria-label="上一页"><Icon name="chevron" size={15}/></button><span>{currentPage} <em>/ {pages}</em></span><button className="pagination-arrow" disabled={currentPage >= pages} onClick={() => setPage((p) => p + 1)} aria-label="下一页"><Icon name="chevron" size={15}/></button></div><span>每页 {PAGE_SIZE} 项</span></div>
      </section>
      <footer className="page-footer"><span><i className="legend-dot oi-dot"/>OI / 价格：Binance 官方接口 <span className="dot-divider"/> 供应量：CoinMarketCap / CoinGecko</span><span>估值每分钟计算 · 供应量每小时刷新 <button onClick={() => setDialog('source')}>查看计算口径<Icon name="external" size={11}/></button></span></footer>
    </main>
    {dialog === 'settings' ? <SettingsDialog settings={settings} onSave={saveSettings} onClose={() => setDialog(null)} pushConnected={pushConnected} onConnectPush={connectBackendPush} onDisconnectPush={disconnectBackendPush} onEnableNotifications={enableNotifications} onDisableNotifications={disableNotifications} onTest={testAlert}/> : null}
    {dialog === 'source' ? <SourceDialog row={selected} snapshot={monitor.snapshot} onClose={() => setDialog(null)}/> : null}
    {dialog === 'alerts' ? <AlertList alerts={alerts} onSelect={select} onClose={() => setDialog(null)}/> : null}
    {activeAlert ? <AlertDialog alert={activeAlert.event} test={activeAlert.test} onClose={() => setActiveAlert(null)} onSelect={select}/> : null}
    <div className="toast-stack" aria-live="polite">{toastAlert ? <div className={`alert-toast ${toastAlert.level}`}><Icon name="warning" size={21}/><button onClick={() => { select(toastAlert.assetId); setDialog('source'); setToastAlert(null); }}><strong>{toastAlert.symbol} 达到 {percent(toastAlert.ratio)}</strong><span>OI / FDV 已触发提醒，点击核查来源</span></button><button className="icon-button" onClick={() => setToastAlert(null)} aria-label="关闭提醒"><Icon name="close" size={16}/></button></div> : null}{notice ? <div className="notice-toast"><Icon name="check" size={17}/><span>{notice}</span><button className="icon-button" onClick={() => setNotice(null)} aria-label="关闭提示"><Icon name="close" size={14}/></button></div> : null}</div>
  </>;
}
