import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DIRECTION_CONFIG } from '../src/shared/directionConfig';
import { createPositionRisk, stepPositionRisk } from '../src/shared/positionRisk';
import type { ManualPosition, PositionBook, PositionMarketFrame, PositionRiskEvent, PositionRiskState, RiskPlanDraft } from '../src/shared/positionTypes';
import type { AlertEvent } from '../src/shared/types';
import type { FlowEvent } from '../src/shared/flowTypes';
import type { usePrivatePositions } from '../src/web/PrivatePositionsContext';

const mock = vi.hoisted(() => ({ runtime: null as unknown, flow: { data: { events: [] as unknown[] }, error: null as string | null } }));
vi.mock('../src/web/PrivatePositionsContext', () => ({ usePrivatePositions: () => mock.runtime }));
vi.mock('../src/web/FlowMonitorContext', () => ({ useSharedFlowMonitor: () => mock.flow }));
import MyPositions from '../src/web/MyPositions';
import RiskAlertCenter from '../src/web/RiskAlertCenter';

type Runtime = ReturnType<typeof usePrivatePositions>;
const NOW = Date.UTC(2026, 8, 25, 12);
function position(changes: Partial<ManualPosition> = {}): ManualPosition {
  return { id: 'p1', marketKey: 'futures:TESTUSDT', symbol: 'TESTUSDT', assetId: 'binance:TEST', side: 'long',
    entryPrice: '100', margin: '100', leverage: '10', createdAt: NOW - 60_000, ...changes };
}
function frame(markPrice = '100', at = NOW): PositionMarketFrame {
  return { mark: { marketKey: 'futures:TESTUSDT', markPrice, sourceTime: at, receivedAt: at, source: 'binance-mark-stream' }, atr: null, signal: null };
}
const plan = (changes: Partial<RiskPlanDraft> = {}): RiskPlanDraft => ({ stopPrice: '95', takeProfitPrice: '120', trailing: null,
  signalWeakening: false, directionConfig: { ...DEFAULT_DIRECTION_CONFIG }, method: 'manual', generatedAt: NOW, ...changes });
function armed(changes: Partial<ManualPosition> = {}, draft = plan()): PositionRiskState {
  const result = stepPositionRisk(createPositionRisk(position(changes)), { type: 'confirm', frame: frame(), now: NOW, plan: draft, expectedPlanRevision: 0 });
  if (result.error) throw new Error(result.error);
  return result.state;
}
function triggered(offset = 1000) {
  const result = stepPositionRisk(armed(), { type: 'tick', frame: frame('94', NOW + offset), now: NOW + offset });
  if (result.error || !result.events[0]) throw new Error(result.error ?? 'Missing fixture event');
  return result;
}
function runtime(states: PositionRiskState[] = [], events: PositionRiskEvent[] = [], changes: Partial<Runtime> = {}): Runtime {
  const book: PositionBook = { schemaVersion: 1, revision: 1, updatedAt: NOW, positions: states, events, notified: [] };
  return { book, loaded: true, error: '', now: NOW, frames: new Map(states.map(state => [state.position.id, frame()])),
    issues: new Map(), markets: [], config: { ...DEFAULT_DIRECTION_CONFIG }, popups: [],
    add: vi.fn(async () => '00000000-0000-4000-8000-000000000001' as const), confirm: vi.fn(async () => {}), close: vi.fn(async () => {}), dismiss: vi.fn(), ...changes };
}
const renderPositions = () => renderToStaticMarkup(createElement(MyPositions));
const riskProps = () => ({ alerts: [] as AlertEvent[], onPosition: vi.fn(), onAsset: vi.fn<(id: string) => void>(),
  onFlow: vi.fn<(event: FlowEvent) => void>(), onSettings: vi.fn() });
const renderRisks = (props = riskProps()) => renderToStaticMarkup(createElement(RiskAlertCenter, props));
// Only inspect semantic SSR output here; this does not claim click, tooltip, or layout acceptance.
function visibleValues(html: string) {
  const values = html.split('<div class="private-values">')[1] ?? '';
  return [...values.matchAll(/<strong[^>]*>(.*?)<\/strong>/g)].slice(0, 4).map(match => match[1]);
}
beforeEach(() => { mock.runtime = runtime(); mock.flow = { data: { events: [] }, error: null }; });

describe('manual-position page status and trust boundaries', () => {
  it('renders a clear empty state and local-only, non-trading limitation', () => {
    const html = renderPositions();
    expect(html).toContain('先录入一笔持仓'); expect(html).toContain('0 个未关闭');
    expect(html).toContain('本机持仓监控'); expect(html).toContain('关页 / 休眠后停止 · 不连接交易账户');
    expect(html).toContain('手工估算，不是交易所实际仓位'); expect(html).toContain('离场提醒不保证成交');
  });
  it('keeps entry disabled while storage is loading, rather than offering an empty replacement book', () => {
    mock.runtime = runtime([], [], { loaded: false });
    const html = renderPositions();
    expect(html).toContain('正在读取本机持仓'); expect(html).not.toContain('先录入一笔持仓');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>录入持仓<\/button>/);
  });
  it('shows a storage failure as a visible alert instead of hiding it in help content', () => {
    mock.runtime = runtime([], [], { error: '本机记录校验失败，监控暂停', loaded: false });
    expect(renderPositions()).toContain('role="alert">本机记录校验失败，监控暂停');
  });
  it('shows drafts as unarmed even when a fresh mark can estimate PnL', () => {
    mock.runtime = runtime([createPositionRisk(position())], [], { frames: new Map([['p1', frame('110')]]) });
    const html = renderPositions();
    expect(html).toContain('待确认方案'); expect(html).toContain('提醒尚未启用'); expect(html).toContain('设置风险方案');
    expect(html).not.toContain('计划已启用'); expect(visibleValues(html)[0]).toBe('100');
  });
  it('shows armed plan prices and the review action without implying an exchange order', () => {
    mock.runtime = runtime([armed()]);
    const html = renderPositions();
    expect(html).toContain('计划已启用'); expect(html).toContain('标记价监控中'); expect(html).toContain('查看 / 修改方案');
    expect(html).toContain('保护价 / 止盈价'); expect(visibleValues(html)[3]).toBe('95'); expect(html).toContain('止盈 120');
    expect(html).toContain('我已离场'); expect(html).not.toContain('已自动平仓');
  });
  it('shows an observed price trigger without treating the position as closed', () => {
    const result = triggered();
    const state = runtime([result.state], result.events, { now: NOW + 1000, frames: new Map([['p1', frame('94', NOW + 1000)]]) });
    mock.runtime = state;
    const before = structuredClone(state.book), html = renderPositions();
    expect(html).toContain('已触发提醒 · 未确认离场'); expect(html).toContain('1 个未关闭');
    expect(html).toContain('保护价已触发'); expect(html).toContain('仅提醒，未执行平仓');
    expect(html).not.toContain('已标记离场 · 1 笔'); expect(state.book).toEqual(before);
    expect(state.close).not.toHaveBeenCalled(); expect(state.confirm).not.toHaveBeenCalled(); expect(state.add).not.toHaveBeenCalled();
  });
  it.each(['同一源时间出现冲突标记价', '乱序观测已隔离', '标记价过期'])('hides mark-based valuations when runtime reports %s', issue => {
    mock.runtime = runtime([armed()], [], { frames: new Map([['p1', frame('110')]]), issues: new Map([['p1', issue]]) });
    const html = renderPositions();
    expect(html).toContain(`监控暂停 · ${issue}`); expect(visibleValues(html)).toEqual(['—', '—', '100', '95']);
    expect(html).toContain('相对输入保证金'); expect(html).toContain('—%'); expect(html).not.toContain('标记价监控中');
  });
  it.each(['missing', 'stale', 'future', 'wrong-market'] as const)('does not display an actionable live valuation for a %s mark', kind => {
    const data = frame('110');
    if (kind === 'missing') data.mark = null;
    if (kind === 'stale') data.mark = { ...data.mark!, sourceTime: NOW - 15_001, receivedAt: NOW - 15_001 };
    if (kind === 'future') data.mark = { ...data.mark!, sourceTime: NOW + 1, receivedAt: NOW + 1 };
    if (kind === 'wrong-market') data.mark = { ...data.mark!, marketKey: 'futures:OTHERUSDT' };
    mock.runtime = runtime([armed()], [], { frames: new Map([['p1', data]]) });
    const html = renderPositions();
    expect(html).toContain('数据不可用 · 监控暂停'); expect(visibleValues(html).slice(0, 2)).toEqual(['—', '—']);
  });
  it('labels a usable REST fallback as degraded with a missed-touch warning', () => {
    const data = frame('110'); data.mark!.source = 'binance-premium-rest';
    mock.runtime = runtime([armed()], [], { frames: new Map([['p1', data]]) });
    const html = renderPositions();
    expect(html).toContain('REST 降级 · 可能漏过短暂触线'); expect(visibleValues(html)[0]).toBe('100');
  });
  it('preserves tiny prices and nonzero tiny PnL rather than formatting them as zero', () => {
    const state = createPositionRisk(position({ entryPrice: '0.0000000001', margin: '0.0001', leverage: '1' }));
    mock.runtime = runtime([state], [], { frames: new Map([['p1', frame('0.000000000123')]]) });
    const html = renderPositions(), values = visibleValues(html);
    expect(values[1]).toBe('1.230e-10'); expect(values[0]).toBe('0.00002300');
    expect(values[0]).not.toBe('0'); expect(values[1]).not.toBe('0'); expect(html).toContain('开仓 1.000e-10');
  });
  it('keeps side-aware gains and losses distinct', () => {
    const long = createPositionRisk(position()), short = createPositionRisk(position({ side: 'short' }));
    mock.runtime = runtime([long], [], { frames: new Map([['p1', frame('110')]]) });
    expect(renderPositions()).toContain('<strong class="change-up">100</strong>');
    mock.runtime = runtime([short], [], { frames: new Map([['p1', frame('110')]]) });
    const html = renderPositions(); expect(html).toContain('空单'); expect(html).toContain('<strong class="change-down">-100</strong>');
  });
  it('shows trailing activation/best-price evidence without adding a trigger', () => {
    const initial = armed({}, plan({ takeProfitPrice: '150', trailing: { activationPrice: '110', callbackPct: '5' } }));
    const result = stepPositionRisk(initial, { type: 'tick', frame: frame('120', NOW + 1000), now: NOW + 1000 });
    mock.runtime = runtime([result.state], [], { now: NOW + 1000, frames: new Map([['p1', frame('120', NOW + 1000)]]) });
    const html = renderPositions(); expect(html).toContain('已激活 · 已观察最佳价 120'); expect(html).toContain('回撤 5%');
    expect(html).not.toContain('已触发提醒 · 未确认离场');
  });
  it('only shows current-plan events on a position card while retaining older history in the risk center', () => {
    const result = triggered(), old = { ...result.events[0], id: 'p1:1:stop', title: '旧版事件' };
    const current = { ...old, id: 'p1:2:stop', planRevision: 2, title: '当前事件' };
    result.state.plan!.revision = 2;
    mock.runtime = runtime([result.state], [current, old], { now: NOW + 1000, frames: new Map([['p1', frame('94', NOW + 1000)]]) });
    expect(renderPositions()).toContain('当前事件'); expect(renderPositions()).not.toContain('旧版事件');
    expect(renderRisks()).toContain('旧版事件'); expect(renderRisks()).toContain('计划 v2');
  });
  it('separates manually closed history and warns it has not verified exchange execution', () => {
    const state = stepPositionRisk(armed(), { type: 'close', now: NOW + 1000 }).state;
    mock.runtime = runtime([state]);
    const html = renderPositions(); expect(html).toContain('0 个未关闭'); expect(html).toContain('已标记离场 · 1 笔');
    expect(html).toContain('手工标记；未核实交易所成交'); expect(html).not.toContain('class="private-position ');
  });
  it('provides compact accessible help controls while essential limitations remain directly visible', () => {
    mock.runtime = runtime([armed()]);
    const html = renderPositions();
    expect(html).toContain('aria-label="估算浮盈亏说明"'); expect(html).toContain('aria-label="标记价说明"');
    expect(html).toContain('aria-expanded="false"'); expect(html).not.toContain('role="tooltip"');
    expect(html).toContain('手工估算，不是交易所实际仓位');
  });
});

describe('risk center historical-event semantics', () => {
  it('shows a private empty state and separate market/valuation categories', () => {
    const html = renderRisks();
    expect(html).toContain('暂无持仓触线记录'); expect(html).toContain('前往我的持仓');
    expect(html).toContain('本机记录，关页后不监控。触发提醒不代表已经平仓。');
    expect(html).toContain('持仓触线'); expect(html).toContain('市场异常'); expect(html).toContain('OI / FDV');
  });
  it('includes event identity, plan revision and gap context without running a callback', () => {
    const result = triggered(21_000); mock.runtime = runtime([result.state], result.events);
    const props = riskProps(), html = renderRisks(props);
    expect(html).toContain('TESTUSDT · 保护价已触发'); expect(html).toContain('计划 v1');
    expect(html).toContain('中断后首次观测'); expect(html).toContain('实际首次触发时间未知'); expect(html).toContain('查看持仓');
    for (const callback of [props.onPosition, props.onAsset, props.onFlow, props.onSettings]) expect(callback).not.toHaveBeenCalled();
  });
  it('distinguishes signal weakening from a price-line trigger', () => {
    const event = { ...triggered().events[0], id: 'p1:1:signal-weakening', rule: 'signal-weakening' as const,
      title: '持仓方向信号减弱', message: '连续两个有效闭合分钟窗口不再支持原方向；不是确定反转或平仓指令' };
    mock.runtime = runtime([], [event]);
    const html = renderRisks(); expect(html).toContain('观察提醒'); expect(html).toContain('不是确定反转或平仓指令');
    expect(html).not.toContain('>价格触线<');
  });
  it('does not mix public market events into the default private risk list', () => {
    mock.flow.data.events = [{ id: 'public', title: 'PUBLIC_EVENT_MUST_NOT_BECOME_PRIVATE' }];
    const html = renderRisks(); expect(html).toContain('市场异常 <span>1</span>');
    expect(html).not.toContain('PUBLIC_EVENT_MUST_NOT_BECOME_PRIVATE'); expect(html).toContain('暂无持仓触线记录');
  });
  it('surfaces storage errors without claiming an empty log proves safety', () => {
    mock.runtime = runtime([], [], { error: '提醒存储暂不可用；请检查交易所仓位' });
    expect(renderRisks()).toContain('role="alert">提醒存储暂不可用；请检查交易所仓位');
  });
  it('escapes persisted event text rather than treating it as HTML', () => {
    const event = { ...triggered().events[0], title: '<img src=x onerror=alert(1)>', message: '<script>bad()</script>' };
    mock.runtime = runtime([], [event]);
    const html = renderRisks(); expect(html).toContain('&lt;img'); expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>'); expect(html).not.toContain('<img src=x');
  });
});
