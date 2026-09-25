import { describe, expect, it } from 'vitest';
import { DEFAULT_CHANGE_RULE } from '../src/shared/changeMonitor';
import { changeRuleSummary } from '../src/web/ChangeDashboard';

describe('collapsed change filter summary', () => {
  it('keeps the applied window, quantity basis, both thresholds and conjunction visible', () => {
    const summary = changeRuleSummary(DEFAULT_CHANGE_RULE);
    expect(summary).toContain(`${DEFAULT_CHANGE_RULE.windowMinutes}m`);
    expect(summary).toContain(`OI 数量 涨跌幅绝对值 ≥ ${DEFAULT_CHANGE_RULE.oi.threshold}%`);
    expect(summary).toContain(`FDV 涨跌幅绝对值 ≥ ${DEFAULT_CHANGE_RULE.fdv.threshold}%`);
    expect(summary).toContain(' · 且 · ');
  });
  it('distinguishes amount basis, down-only rules, disabled filters, and either-condition matching', () => {
    expect(changeRuleSummary({ ...DEFAULT_CHANGE_RULE, windowMinutes: 60, oiBasis: 'usd', combine: 'any',
      oi: { enabled: true, direction: 'down', threshold: 2.5 }, fdv: { ...DEFAULT_CHANGE_RULE.fdv, enabled: false } }))
      .toBe('60m · OI 金额 下跌 ≥ 2.5% · 或 · FDV 不限制');
  });
});
