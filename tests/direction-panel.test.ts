import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DirectionAssessment } from '../src/shared/direction';
import { DEFAULT_DIRECTION_CONFIG, DIRECTION_PRESETS } from '../src/shared/directionConfig';
import { DirectionBadge, DirectionPanel } from '../src/web/DirectionPanel';

const result: DirectionAssessment = { bias: 'long', quality: 'valid', label: '偏多候选', confirmation: '待现货确认 · 不宜直接开仓',
  reason: '同合约5分钟增仓上涨', evidence: ['OI +8% · 价格 +2%'], risks: ['缺少现货确认'],
  invalidation: '数据过期即退回观望', marketKey: 'futures:TESTUSDT', symbol: 'TESTUSDT',
  asOf: Date.UTC(2026, 8, 25, 1), windowStart: Date.UTC(2026, 8, 25, 0, 55), windowEnd: Date.UTC(2026, 8, 25, 1), ruleVersion: 'direction-v2', config: DEFAULT_DIRECTION_CONFIG };

describe('visible directional advice', () => {
  it('keeps direction, missing confirmation, reason and withdrawal visible before disclosure', () => {
    const html = renderToStaticMarkup(createElement(DirectionPanel, { value: result }));
    const primary = html.split('<details')[0];
    for (const text of ['偏多候选', '固定 5m', '同合约5分钟增仓上涨', '待现货确认', '不宜直接开仓', '撤销条件', '数据过期即退回观望', '未回测盈利能力']) expect(primary).toContain(text);
    expect(html).toContain('不是止损价或自动平仓');
  });
  it('does not turn a replay into an event-time recommendation', () => {
    const html = renderToStaticMarkup(createElement(DirectionPanel, { value: result, replay: true }));
    expect(html.split('<details')[0]).toContain('这是当前建议，不是历史事件发生时的建议');
  });
  it('renders short and wait labels textually, not through color alone', () => {
    for (const [bias, label] of [['short', '偏空候选'], ['wait', '观望 · 暂不交易']] as const) {
      const html = renderToStaticMarkup(createElement(DirectionBadge, { value: { ...result, bias, label }, detail: true }));
      expect(html).toContain(label);
      expect(html).toContain(result.confirmation);
    }
  });
  it('keeps fixed direction rules separate from user-defined change filters', () => {
    const html = renderToStaticMarkup(createElement(DirectionPanel, { value: result }));
    expect(html).toContain('不拼接自定义变化窗口');
    expect(html).toContain('不默认 8 小时');
  });
  it('renders the active thresholds, not stale standard-rule text', () => {
    const html = renderToStaticMarkup(createElement(DirectionPanel, { value: { ...result, config: DIRECTION_PRESETS.sensitive } }));
    expect(html).toContain('灵敏');
    expect(html).toContain('≥ +1%');
    expect(html).toContain('≥55%');
    expect(html).toContain('≤45%');
    expect(html).not.toContain('≥ +5%');
  });
});
