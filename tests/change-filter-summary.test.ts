import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CHANGE_RULE } from '../src/shared/changeMonitor';
import { DEFAULT_DIRECTION_CONFIG } from '../src/shared/directionConfig';
import { DEFAULT_SETTINGS } from '../src/web/storage';
import ChangeDashboard, { changeRuleSummary } from '../src/web/ChangeDashboard';

vi.mock('../src/web/useChangeMonitor', () => ({ useChangeMonitor: () => ({ rows: [], now: Date.now(), loading: false, error: null, refresh: vi.fn() }) }));
vi.mock('../src/web/useMonitor', () => ({ useHistory: () => ({ points: [], loading: false, error: null }) }));
vi.mock('../src/web/FlowMonitorContext', () => ({ useSharedFlowMonitor: () => ({ data: null, selectMarket: vi.fn() }) }));
vi.mock('../src/web/DirectionSettingsContext', () => ({ useDirectionSettings: () => ({ config: DEFAULT_DIRECTION_CONFIG, apply: () => true, notice: '', revision: 0 }) }));
vi.mock('../src/web/PositionPanel', () => ({ PositionPanel: () => null, PositionHighlights: () => null, PositionBadge: () => null }));
afterEach(() => vi.unstubAllGlobals());

describe('collapsed change filter summary', () => {
  it('keeps the applied window, quantity basis, both thresholds and conjunction visible', () => {
    const summary = changeRuleSummary(DEFAULT_CHANGE_RULE);
    expect(summary).toContain(`变化比较：过去 ${DEFAULT_CHANGE_RULE.windowMinutes} 分钟`);
    expect(summary).toContain(`OI 数量 涨跌幅绝对值 ≥ ${DEFAULT_CHANGE_RULE.oi.threshold}%`);
    expect(summary).toContain(`FDV 涨跌幅绝对值 ≥ ${DEFAULT_CHANGE_RULE.fdv.threshold}%`);
    expect(summary).toContain(' · 且 · ');
  });
  it('distinguishes amount basis, down-only rules, disabled filters, and either-condition matching', () => {
    expect(changeRuleSummary({ ...DEFAULT_CHANGE_RULE, windowMinutes: 60, oiBasis: 'usd', combine: 'any',
      oi: { enabled: true, direction: 'down', threshold: 2.5 }, fdv: { ...DEFAULT_CHANGE_RULE.fdv, enabled: false } }))
      .toBe('变化比较：过去 60 分钟 · OI 金额 下跌 ≥ 2.5% · 或 · FDV 不限制');
  });
  it('names the applied one-minute comparison without implying a five-minute direction override', () => {
    const summary = changeRuleSummary({ ...DEFAULT_CHANGE_RULE, windowMinutes: 1 });
    expect(summary).toContain('变化比较：过去 1 分钟');
    expect(summary).not.toContain('5 分钟');
  });
  it('renders applied one-minute comparison before independent direction controls without resetting storage', () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ ...DEFAULT_CHANGE_RULE, windowMinutes: 1 }), setItem });
    const html = renderToStaticMarkup(createElement(ChangeDashboard, { settings: DEFAULT_SETTINGS, snapshot: null,
      historyVersion: 0, error: null, storageError: null, collecting: false, retryAt: 0, onRefresh: vi.fn(), onOpenSettings: vi.fn() }));
    expect(html).toContain('<strong>变化比较：过去 1 分钟</strong>');
    expect(html).toContain('aria-label="比较多久前（分钟）"');
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>1分钟<\/button>/);
    expect(html.indexOf('变化比较：过去 1 分钟')).toBeLessThan(html.indexOf('>多空参考'));
    const direction = html.slice(html.indexOf('aria-label="多空建议灵敏度"')).split('<details')[0];
    expect(direction).toContain('固定 5 分钟');
    expect(direction).toContain('只影响方向建议，不影响变化命中');
    expect(html).toContain('5分钟多空参考'); expect(html).toContain('行情更新：目标每 30 秒');
    expect(html).toContain('暂不可判断');
    expect((html.match(/class="change-column-window">过去 1 分钟/g) ?? [])).toHaveLength(3);
    expect(setItem).not.toHaveBeenCalled();
  });
});
