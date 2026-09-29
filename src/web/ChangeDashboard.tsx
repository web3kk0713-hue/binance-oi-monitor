import { lazy, memo, Suspense, useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { DEFAULT_CHANGE_RULE, isChangeRule, type ChangeCondition, type ChangeDirection, type ChangeRule } from '../shared/changeMonitor';
import { displayedAsset } from '../shared/reliability';
import { selectValuation, valuationLabel } from '../shared/valuation';
import type { Snapshot } from '../shared/types';
import { clockTime, dateTime, money, percent, signed } from './format';
import { readLocal, writeLocal, type Settings } from './storage';
import { useHistory } from './useMonitor';
import { useChangeMonitor } from './useChangeMonitor';
import { useSharedFlowMonitor } from './FlowMonitorContext';
import { selectFlowContext } from '../shared/flowContext';
import { createDirectionEvaluator } from './directionWorkspace';
import { DirectionBadge } from './DirectionPanel';
import { DirectionControls } from './DirectionControls';
import { useDirectionSettings } from './DirectionSettingsContext';
import { PositionBadge, PositionHighlights, PositionPanel } from './PositionPanel';
import { MetricHelp } from './MetricHelp';
import { changeDataNotice, changeEmptyState } from './changePresentation';
import './change.css';

const ChangeChart = lazy(() => import('./ChangeChart'));
type RuleDraft = { window: string; oiBasis: ChangeRule['oiBasis']; combine: ChangeRule['combine']; oi: { enabled: boolean; direction: ChangeDirection; threshold: string }; fdv: { enabled: boolean; direction: ChangeDirection; threshold: string } };
export function readChangeRule(): ChangeRule {
  const saved = readLocal<unknown>('change-rule:v1', null);
  return isChangeRule(saved) ? saved : structuredClone(DEFAULT_CHANGE_RULE);
}
function toDraft(rule: ChangeRule): RuleDraft { return { window: String(rule.windowMinutes), oiBasis: rule.oiBasis, combine: rule.combine,
  oi: { ...rule.oi, threshold: String(rule.oi.threshold) }, fdv: { ...rule.fdv, threshold: String(rule.fdv.threshold) } }; }
export function parseChangeDraft(draft: RuleDraft): ChangeRule | null {
  if (!draft.window.trim() || draft.oi.enabled && !draft.oi.threshold.trim() || draft.fdv.enabled && !draft.fdv.threshold.trim()) return null;
  const rule = { windowMinutes: Number(draft.window), oiBasis: draft.oiBasis, combine: draft.combine,
    oi: { ...draft.oi, threshold: draft.oi.enabled ? Number(draft.oi.threshold) : DEFAULT_CHANGE_RULE.oi.threshold }, fdv: { ...draft.fdv, threshold: draft.fdv.enabled ? Number(draft.fdv.threshold) : DEFAULT_CHANGE_RULE.fdv.threshold } };
  return isChangeRule(rule) ? rule : null;
}
function conditionText(name: string, condition: ChangeCondition) {
  if (!condition.enabled) return `${name} 不限制`;
  return `${name} ${condition.direction === 'up' ? '上涨 ≥' : condition.direction === 'down' ? '下跌 ≥' : '涨跌幅绝对值 ≥'} ${condition.threshold}%`;
}
function changeConditionsSummary(rule: ChangeRule): string {
  const oiLabel = rule.oiBasis === 'quantity' ? 'OI 数量' : 'OI 金额';
  return `${conditionText(oiLabel, rule.oi)} · ${rule.combine === 'all' ? '且' : '或'} · ${conditionText('估值（FDV优先）', rule.fdv)}`;
}
export function changeRuleSummary(rule: ChangeRule): string {
  return `变化比较：过去 ${rule.windowMinutes} 分钟 · ${changeConditionsSummary(rule)}`;
}
const changeClass = (value: number | null) => value === null || value === 0 ? '' : value > 0 ? 'change-up' : 'change-down';
const quantity = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('en-US', { maximumSignificantDigits: 7 });
const PAGE_SIZE = 25;
const magnitude = (value: number | null) => value === null ? -1 : Math.abs(value);
export function changeSourceCooldown(snapshot: Snapshot | null, now: number): number {
  const until = Math.max(0, Number.isFinite(snapshot?.retryAt) ? snapshot!.retryAt! : 0, ...(snapshot?.errors ?? []).flatMap(error => {
    // Supply providers have independent retries and must not pause Binance OI refresh.
    if (!/^BINANCE_[A-Z_]+:\s*RATE_LIMIT_COOLDOWN:\s*fapi\.binance\.com(?:\s|$)/.test(error)) return [];
    const match = error.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/);
    const time = match ? Date.parse(match[0]) : NaN;
    return Number.isFinite(time) ? [time] : [];
  }));
  return Math.max(0, Math.ceil((until - now) / 1000));
}

function ChangeDashboard({ settings, snapshot, historyVersion, error, storageError, collecting, retryAt = 0, onRefresh, onOpenSettings }: {
  settings: Settings; snapshot: Snapshot | null; historyVersion: number; error: string | null; storageError: string | null;
  collecting: boolean; retryAt: number; onRefresh: () => void; onOpenSettings: () => void;
}) {
  const [rule, setRule] = useState(readChangeRule);
  const [draft, setDraft] = useState(() => toDraft(rule));
  const [message, setMessage] = useState('');
  const [formError, setFormError] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterSummary = useRef<HTMLElement>(null);
  const [query, setQuery] = useState(''); const search = useDeferredValue(query.trim().toUpperCase());
  const [scope, setScope] = useState<'hit' | 'all' | 'unavailable'>('hit');
  const [sort, setSort] = useState<'oi' | 'fdv' | 'ratio'>('oi');
  const [pattern, setPattern] = useState('all');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const monitor = useChangeMonitor(snapshot, settings, rule, historyVersion);
  const flow = useSharedFlowMonitor();
  const { config: directionConfig } = useDirectionSettings();
  const positions = useMemo(() => monitor.rows.map(row => row.position), [monitor.rows]);
  const displayById = useMemo(() => new Map((snapshot?.assets ?? []).map(asset => [asset.id, displayedAsset(asset, snapshot)])), [snapshot]);
  const retainedCount = [...displayById.values()].filter(display => display.retainedAt !== null).length;
  const searched = useMemo(() => monitor.rows.filter(row => !search || row.symbol.toUpperCase().includes(search)), [monitor.rows, search]);
  const hits = searched.filter(row => row.matched).length;
  const unavailable = searched.filter(row => !row.evaluable).length;
  const filtered = useMemo(() => searched.filter(row => (scope === 'all' || (scope === 'hit' ? row.matched : !row.evaluable))
    && (pattern === 'all' || row.position.pattern === pattern))
    .sort((a, b) => Number(b.matched) - Number(a.matched) || magnitude(sort === 'oi' ? b.oiPct : sort === 'fdv' ? b.fdvPct : b.position.oiToFdvChangePct)
      - magnitude(sort === 'oi' ? a.oiPct : sort === 'fdv' ? a.fdvPct : a.position.oiToFdvChangePct) || a.symbol.localeCompare(b.symbol)), [searched, scope, sort, pattern]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)); const activePage = Math.min(page, pages);
  const selected = monitor.rows.find(row => row.assetId === selectedId) ?? filtered[0] ?? monitor.rows.find(row => row.symbol === 'BTC') ?? monitor.rows[0];
  const selectedValuationName = selected ? valuationLabel(selected.valuationBasis === undefined ? selectValuation(selected.latest).basis : selected.valuationBasis) : '估值';
  const renderNow = Date.now();
  const evaluateDirection = createDirectionEvaluator(flow.data, renderNow, directionConfig);
  const selectedFlowKey = selectFlowContext(flow.data, selected?.assetId, renderNow).futures?.marketKey ?? null;
  useEffect(() => { flow.selectMarket(selectedFlowKey); }, [flow.selectMarket, selectedFlowKey]);
  const history = useHistory(selected?.assetId, Math.ceil((rule.windowMinutes + 1) / 60), settings, historyVersion);
  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(rule));
  const oiLabel = rule.oiBasis === 'quantity' ? 'OI 数量' : 'OI 金额';
  const stale = Boolean(snapshot && monitor.now - snapshot.asOf > 90_000);
  const partial = Boolean(snapshot && (snapshot.coverage.failedContracts > 0 || snapshot.coverage.oi < snapshot.universe.assets));
  const displayNow = Date.now();
  const cooldown = Math.max(changeSourceCooldown(snapshot, displayNow), Math.max(0, Math.ceil((retryAt - displayNow) / 1000)));
  const dataNotice = changeDataNotice({ snapshot, rule, rows: monitor.rows, now: displayNow, loading: monitor.loading });
  const emptyState = monitor.loading || !filtered.length ? changeEmptyState({ snapshot, rule, rows: searched, scope,
    loading: monitor.loading, now: displayNow, error: monitor.error, hasQuery: Boolean(search), hasPattern: pattern !== 'all' }) : null;
  function apply(event: FormEvent) {
    event.preventDefault(); const next = parseChangeDraft(draft);
    if (!next) { setFormError('请启用至少一项条件，窗口填 1–10080 整数分钟，阈值填 0–1000000。'); setFiltersOpen(true); return; }
    setFormError('');
    setRule(next); setDraft(toDraft(next)); setPage(1);
    setMessage(writeLocal('change-rule:v1', next) ? '参数已保存并生效' : '参数已生效，但浏览器不允许保存；刷新后可能丢失');
    setFiltersOpen(false);
    filterSummary.current?.focus();
  }
  function conditionEditor(key: 'oi' | 'fdv', label: string) {
    const condition = draft[key];
    return <fieldset className="change-condition"><legend><label><input type="checkbox" checked={condition.enabled} onChange={event => setDraft(previous => ({ ...previous, [key]: { ...previous[key], enabled: event.target.checked } }))}/>{label}</label></legend>
      <select aria-label={`${label}方向`} disabled={!condition.enabled} value={condition.direction} onChange={event => setDraft(previous => ({ ...previous, [key]: { ...previous[key], direction: event.target.value as ChangeDirection } }))}>
        <option value="either">双向 · 绝对值 ≥</option><option value="up">上涨 ≥</option><option value="down">下跌 ≥</option></select>
      <label className="change-number"><input aria-label={`${label}阈值`} type="number" min="0" max="1000000" step="any" required disabled={!condition.enabled} value={condition.threshold} onChange={event => setDraft(previous => ({ ...previous, [key]: { ...previous[key], threshold: event.target.value } }))}/><span>%</span></label>
    </fieldset>;
  }
  return <main className="workspace change-monitor">
    <div className="connection-bar"><span className="connection-badge"><i className={`status-dot ${error || stale || partial || !snapshot ? 'warning-dot' : ''}`}/>{settings.mode === 'direct' ? '浏览器采集' : '后台模式'}</span><span className="change-connection-note">{settings.mode === 'direct' ? '关页或休眠会中断；沿用本机真实历史' : '使用已配置后台的观测历史'}</span><button onClick={onOpenSettings}>连接设置</button></div>
    <div className="page-heading"><h1>OI / 估值变化</h1><div className="refresh-controls"><div className="refresh-meta"><strong>{snapshot ? `最近更新 ${clockTime(snapshot.asOf)}` : '等待数据'}</strong><span>{cooldown ? `源接口冷却 ${cooldown}s` : collecting ? '正在更新…' : '行情更新：目标每 30 秒'}</span></div><button className="button secondary" onClick={() => { onRefresh(); monitor.refresh(); }} disabled={collecting || cooldown > 0}>刷新</button></div></div>
    {cooldown > 0 ? <div className="source-retry-note" role="status">源接口冷却中，{cooldown} 秒后自动重试；手动刷新不会跳过冷却。</div> : null}
    {error || storageError || monitor.error || stale ? <div className="status-message stale-message" role="alert">{error ? `${settings.mode === 'server' ? '后台数据状态' : '本机采集状态'}：${error}` : monitor.error || (stale ? `${settings.mode === 'server' ? '后台快照' : '本机行情'}已过期，暂停命中判断。` : storageError)}{error && storageError ? ` ${storageError}` : ''}</div> : null}
    {snapshot ? <div className="change-source-status" role="status"><span>本轮合约完整 {Math.max(0, snapshot.universe.contracts - snapshot.coverage.failedContracts)} / {snapshot.universe.contracts}</span><span>本轮 OI 有值 {snapshot.coverage.oi} / {snapshot.universe.assets} 币种</span><span>本轮估值有值 {snapshot.assets.filter(asset => selectValuation(asset).basis !== null).length} / {snapshot.universe.assets} 币种</span>{retainedCount > 0 ? <strong>保留旧值 {retainedCount} 个币种，不用于变化、命中或告警。</strong> : null}<details><summary>缺失原因与源状态</summary><p>合约数与合并后的币种数不同。金额有值不等于已有所选窗口的有效起点；估值优先 FDV，缺失时使用有效流通市值；两者均缺失时留空。标为“上次有效”的数值仅供参考，不计入本轮覆盖率。</p>{snapshot.errors.map((issue, index) => <p key={index}>{issue}</p>)}<ul>{snapshot.assets.filter(asset => asset.issues.length).slice(0, 30).map(asset => <li key={asset.id}>{asset.symbol}：{asset.issues.join('；')}</li>)}</ul><p>最多列出 30 个币种；比较起点问题见下方“暂不可判断”。</p></details></div> : null}
    {dataNotice ? <div className={`change-data-notice ${dataNotice.severity}`} role="status"><strong>{dataNotice.title}</strong><span>{dataNotice.detail}{dataNotice.retryAt ? `供应量服务将在 ${clockTime(dataNotice.retryAt)} 后自动重试。` : ''}</span></div> : null}
    <details className="change-filter-disclosure" open={filtersOpen} onToggle={event => setFiltersOpen(event.currentTarget.open)}>
      <summary ref={filterSummary} aria-label={changeRuleSummary(rule)}><strong>变化比较：过去 {rule.windowMinutes} 分钟</strong><span className="change-filter-rule">{changeConditionsSummary(rule)}</span>{dirty ? <span className="change-filter-dirty">有未应用修改</span> : null}<span className="change-filter-action">{filtersOpen ? '收起' : '调整'}</span></summary>
      <form className="change-controls" aria-label="变化监控参数" onSubmit={apply} onChange={() => setFormError('')}>
      <div className="change-options"><label>比较多久前<span className="change-number"><input aria-label="比较多久前（分钟）" type="number" min="1" max="10080" step="1" required value={draft.window} onChange={event => setDraft(previous => ({ ...previous, window: event.target.value }))}/><span>分钟</span></span></label>
        <div className="change-presets" aria-label="比较时间快捷选择">{[{ label: '1分钟', value: 1 }, { label: '5分钟', value: 5 }, { label: '1小时', value: 60 }, { label: '24小时', value: 1440 }, { label: '7天', value: 10080 }].map(item => <button type="button" key={item.value} aria-pressed={Number(draft.window) === item.value} onClick={() => setDraft(previous => ({ ...previous, window: String(item.value) }))}>{item.label}</button>)}</div>
        <label>OI 口径<select aria-label="OI变化口径" value={draft.oiBasis} onChange={event => setDraft(previous => ({ ...previous, oiBasis: event.target.value as ChangeRule['oiBasis'] }))}><option value="quantity">原始数量（排除价格影响）</option><option value="usd">美元名义金额（含价格影响）</option></select></label>
        <label>组合条件<select aria-label="条件组合" value={draft.combine} onChange={event => setDraft(previous => ({ ...previous, combine: event.target.value as ChangeRule['combine'] }))}><option value="all">同时满足</option><option value="any">任一满足</option></select></label>
      </div>
      <div className="change-rule-row">{conditionEditor('oi', 'OI 变化')}{conditionEditor('fdv', '估值变化（FDV优先）')}<div className="change-apply"><button className="button primary" type="submit">应用参数</button><button className="button text-button" type="button" onClick={() => { setDraft(toDraft(structuredClone(DEFAULT_CHANGE_RULE))); setMessage('默认参数已填入，点击应用参数生效'); }}>恢复默认</button></div></div>
      <div className="change-active-rule"><span>生效规则：过去 {rule.windowMinutes} 分钟 · {conditionText(oiLabel, rule.oi)} · {rule.combine === 'all' ? '且' : '或'} · {conditionText('估值（FDV优先）', rule.fdv)}</span>{dirty ? <strong>有未应用修改</strong> : <span role="status">{message}</span>}</div>
      {formError ? <p className="status-message" role="alert">{formError}</p> : null}
      </form>
    </details>
    {message && !filtersOpen ? <p className="change-filter-save" role="status">{message}</p> : null}
    <DirectionControls/>
    <section className="change-results" aria-label="变化监控结果">
      <div className="change-results-head"><div className="change-tabs">{([{ key: 'hit', label: '命中', count: hits }, { key: 'all', label: '全部', count: searched.length }, { key: 'unavailable', label: '暂不可判断', count: unavailable }] as const).map(item => <button key={item.key} aria-pressed={scope === item.key} onClick={() => { setScope(item.key); setPage(1); }}>{item.label}<span>{monitor.loading ? '…' : item.count}</span></button>)}</div><label className="change-pattern-filter"><span className="sr-only">筛选持仓联动</span><select aria-label="筛选持仓联动" value={pattern} onChange={event => { setPattern(event.target.value); setScope('all'); setPage(1); }}><option value="all">全部联动</option><option value="build_flat">增仓 · 价格近乎不变</option><option value="build_up">增仓 · 价格上涨</option><option value="build_down">增仓 · 价格下跌</option><option value="unwind_up">减仓 · 价格上涨</option><option value="unwind_down">减仓 · 价格下跌</option><option value="unwind_flat">减仓 · 价格近乎不变</option><option value="quiet">OI 变化未达观察门槛</option><option value="unavailable">联动不可比较</option></select></label><label className="change-search"><span className="sr-only">搜索监控币种</span><input aria-label="搜索监控币种" placeholder="搜索币种" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }}/></label></div>
      <div className="change-table-scroll"><table><thead><tr>
        <th>币种</th>
        <th>5分钟多空参考<MetricHelp label="当前方向建议">独立使用最近 5 根已收盘的 1 分钟 K 线，以及同合约 OI 和主动成交；不随上方变化比较时间改变，也不影响变化命中。候选不是立即开仓指令，缺数据、过期或信号冲突时观望。</MetricHelp></th>
        <th>持仓 / 价格联动<MetricHelp label="持仓价格联动">只描述所选窗口起止 OI 数量与价格的组合，例如增仓上涨。每笔合约同时有多空双方，标签不证明主力开仓或必然涨跌。</MetricHelp></th>
        <th><button onClick={() => setSort('oi')} aria-label="按OI变化幅度排序">{oiLabel}变化 {sort === 'oi' ? '↓' : ''}</button><MetricHelp label={`${oiLabel}变化`}>{rule.oiBasis === 'quantity' ? '归一化后的未平仓合约数量变化，排除价格影响。' : '未平仓合约的美元名义金额变化，同时含数量和价格影响。'}（终点 ÷ 起点 − 1）×100%，不是资金净流入。</MetricHelp><small className="change-column-window">过去 {rule.windowMinutes} 分钟</small></th>
        <th>价格变化<MetricHelp label="表格价格变化">与 OI、估值使用同一对快照的指数价格涨跌幅。这里只看窗口两端，不证明中间连续上涨或下跌。</MetricHelp><small className="change-column-window">过去 {rule.windowMinutes} 分钟</small></th>
        <th><button onClick={() => setSort('fdv')} aria-label="按估值变化幅度排序">估值变化 {sort === 'fdv' ? '↓' : ''}</button><MetricHelp label="估值变化（FDV优先）">优先 FDV，缺失时使用有效流通市值。只比较同一估值口径的起止点，FDV 与流通市值切换时不计算变化。供给口径变化也会影响它，不是独立的资金流向证据。</MetricHelp><small className="change-column-window">过去 {rule.windowMinutes} 分钟</small></th>
        <th><button onClick={() => setSort('ratio')} aria-label="按占比相对变化排序">OI / 估值占比 {sort === 'ratio' ? '↓' : ''}</button><MetricHelp label="占比、相对变化与 pp">占比 = OI 美元名义额 ÷ 选定估值 ×100%；估值优先 FDV，缺失时使用流通市值。从 10% 到 12% 是相对 +20%、增加 2 pp（百分点）；不是将两个涨跌幅相除，也不是账户杠杆。</MetricHelp></th>
        <th>{retainedCount ? '最近可用' : '当前'} {oiLabel}<MetricHelp label={oiLabel}>{rule.oiBasis === 'quantity' ? '按币种将合约未平仓数量归一化后合计。' : '该币种未平仓合约的美元名义金额合计，不是保证金或实际投入本金。'}“上次有效”表示旧观测，不参与当前命中或告警。</MetricHelp></th>
        <th>{retainedCount ? '最近可用' : '当前'}估值<MetricHelp label="估值（FDV优先）">FDV 使用最大供应量，流通市值使用流通供应量；优先采用有效 FDV，缺失时采用有效流通市值。每行注明实际口径，两者均缺失时留空，不代表零。</MetricHelp></th>
        <th>实际比较时刻<MetricHelp label="实际比较时刻">起点取目标时刻之前最近的真实观测，最多允许早 45 秒；两项共用起止时刻。起点不够或快照过期会标为不可比较。</MetricHelp></th><th>判断</th>
      </tr></thead><tbody>
        {!monitor.loading ? filtered.slice((activePage - 1) * PAGE_SIZE, activePage * PAGE_SIZE).map(row => {
          const display = displayById.get(row.assetId);
          const values = display?.values ?? row.latest;
          const valuation = selectValuation(values);
          const valuationName = valuationLabel(row.valuationBasis === undefined ? selectValuation(row.latest).basis : row.valuationBasis);
          const retainedAt = display?.retainedAt;
          const direction = evaluateDirection(row.assetId);
          const retainedNote = retainedAt != null ? <small className="retained-value-note" title={dateTime(retainedAt)}>上次有效 {clockTime(retainedAt)}（非实时）</small> : null;
          return <tr key={row.assetId} className={`${row.matched ? 'change-hit-row' : ''} ${selected?.assetId === row.assetId ? 'change-selected-row' : ''}`}><td><button className="change-asset" aria-pressed={selected?.assetId === row.assetId} onClick={() => setSelectedId(row.assetId)}>{row.symbol}</button></td><td className="change-direction-cell"><DirectionBadge value={direction} detail/></td><td className="change-position-cell"><PositionBadge value={row.position}/>{row.position.supplyChanged ? <small className="change-ratio-sub">供给口径变化</small> : null}</td><td className={changeClass(row.oiPct)}><strong>{signed(row.oiPct, '%', 3)}</strong>{row.oiMatched === true ? <span className="change-hit-mark">达标</span> : null}</td><td className={changeClass(row.position.pricePct)}><strong>{signed(row.position.pricePct, '%', 3)}</strong></td><td className={changeClass(row.fdvPct)}><strong>{signed(row.fdvPct, '%', 3)}</strong><small className="change-unit">{valuationName}</small>{row.fdvMatched === true ? <span className="change-hit-mark">达标</span> : null}</td><td><strong>{percent(row.position.oiToFdvPct)}</strong><small className="change-unit">{valuationLabel(row.position.valuationBasis === undefined ? selectValuation(row.latest).basis : row.position.valuationBasis)}</small><small className={`change-ratio-sub ${changeClass(row.position.oiToFdvChangePct)}`}>相对 {signed(row.position.oiToFdvChangePct, '%', 3)}</small><small className="change-ratio-sub">{signed(row.position.oiToFdvDeltaPp, ' pp', 3)}</small></td><td>{rule.oiBasis === 'quantity' ? <>{quantity(values.oiQuantity)}<small className="change-unit">{row.symbol}</small>{values.oiQuantity != null ? retainedNote : null}</> : <>{money(values.oiUsd)}{values.oiUsd != null ? retainedNote : null}</>}</td><td>{money(valuation.valueUsd)}<small className="change-unit">{valuation.label}</small>{valuation.valueUsd != null ? retainedNote : null}</td><td className="change-time" title={`${dateTime(row.startAt)} — ${dateTime(row.endAt)}`}>{row.startAt ? `${clockTime(row.startAt)} → ${clockTime(row.endAt)}` : '缺少起点'}</td><td><span className={`change-status ${row.status}`} title={row.reason}>{row.matched ? '命中' : row.evaluable ? '未达标' : '不可比较'}</span><small className="change-reason">{row.reason}</small></td></tr>;
        }) : null}
      </tbody></table></div>
      {emptyState ? <div className="change-empty" role="status"><strong>{emptyState.title}</strong><span>{emptyState.detail}</span></div> : null}
      <div className="change-pagination"><span>仅描述起止观测的净变化，不证明中间连续走势；缺失值显示 —</span><div><button disabled={activePage === 1} onClick={() => setPage(activePage - 1)}>上一页</button><span>{activePage} / {pages}</span><button disabled={activePage === pages} onClick={() => setPage(activePage + 1)}>下一页</button></div></div>
    </section>
    <PositionHighlights rows={positions} windowMinutes={rule.windowMinutes} loading={monitor.loading} onSelect={setSelectedId}/>
    <PositionPanel value={selected?.position} flow={flow.data} now={renderNow} preferredMarketKey={selectedFlowKey} loading={monitor.loading}/>
    {selected ? <section className="change-detail" aria-label="选中标的变化曲线"><div className="change-detail-heading"><h2>{selected.symbol}<span>{oiLabel} / {selectedValuationName}</span></h2><span>{selected.startAt ? `${dateTime(selected.startAt)} — ${dateTime(selected.endAt)}` : '尚无可比较的历史起点'}</span></div><div className="change-detail-values"><span>{oiLabel} <strong className={changeClass(selected.oiPct)}>{signed(selected.oiPct, '%', 3)}</strong></span><span>{selectedValuationName} <strong className={changeClass(selected.fdvPct)}>{signed(selected.fdvPct, '%', 3)}</strong></span><span>{selected.reason}</span></div>
      {history.error ? <div className="change-empty">历史曲线读取失败：{history.error}</div> : <Suspense fallback={<div className="change-empty">加载变化曲线…</div>}><ChangeChart points={history.points} result={selected} rule={rule} loading={history.loading}/></Suspense>}
      <details className="change-evidence"><summary>计算口径与起止证据</summary><p>涨跌幅 =（终点值 ÷ 起点值 − 1）× 100%。起点取目标时刻之前最近的真实观测，最多容许早 45 秒；两项使用同一对观测时刻。最新行情超过 90 秒停止判断。曲线遇到缺口断开；筛选是端点净变化，不要求窗口内每个点都有数据。</p><p>数量 OI 按同币种合约倍率归一后求和；金额 OI 含价格影响。估值优先 FDV，缺失时采用有效流通市值；两端口径不同不计算估值变化及占比变化。供应变化也会影响涨跌幅，不代表实时核实了供应量。默认双向取绝对值；下跌 3% 表示涨跌幅 ≤ −3%。关闭某项则该项不限制。</p><pre>{JSON.stringify({ rule, baseline: selected.baseline, latest: selected.latest }, null, 2)}</pre></details>
    </section> : null}
  </main>;
}

export default memo(ChangeDashboard);
