import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { FlowHistory, FlowMarket } from '../src/shared/flowTypes';

// Expose help content for copy/contract assertions; shared MetricHelp has its own interaction tests.
vi.mock('../src/web/MetricHelp', () => ({ MetricHelp: ({ label, children }: { label: string; children: ReactNode }) =>
  createElement('span', { 'data-help': label }, children) }));
import { FlowHistoryRecovery } from '../src/web/FlowDashboard';
import { FlowCharts } from '../src/web/FlowCharts';

const market: FlowMarket = { key: 'futures:TESTUSDT', venue: 'futures', symbol: 'TESTUSDT', baseAsset: 'TEST', quoteAsset: 'USDT', assetId: 'synthetic-test' };
const at = Date.UTC(2026, 8, 29, 12);
const complete = { pending: false, missingCandles: 0, missingOi: 0, message: null };
function recoveryHtml(recovery: FlowHistory['recovery'], extra: { loading?: boolean; isReplay?: boolean; isSpot?: boolean } = {}) {
  return renderToStaticMarkup(createElement(FlowHistoryRecovery, { recovery, loading: false, isReplay: false, ...extra }));
}
function chartHtml(oi: FlowHistory['oi'] = [], eventTime: number | null = null) {
  return renderToStaticMarkup(createElement(FlowCharts, { history: { market, from: at, to: at + 300_000, candles: [], events: [], depth: [], oi },
    interval: 1, from: at, to: at + 300_000, observedUntil: at + 600_000, selectedEventId: null, eventTime, onSelectEvent: vi.fn() }));
}

describe('browser history recovery presentation', () => {
  it('shows complete, pending and remaining gaps without conflating them', () => {
    expect(recoveryHtml(complete)).toContain('当前区间已补齐');
    expect(recoveryHtml(undefined, { loading: true })).toContain('历史补取中');
    const pending = recoveryHtml({ ...complete, pending: true, missingCandles: 12, missingOi: 3 });
    expect(pending).toContain('历史补取中'); expect(pending).toContain('缺 12 根 K线 / 3 个 OI 点');
    const missing = recoveryHtml({ ...complete, missingCandles: 2, missingOi: 1 });
    expect(missing).toContain('历史仍有缺口'); expect(missing).not.toContain('当前区间已补齐');
  });

  it('surfaces the failed recovery message safely instead of claiming success', () => {
    const html = recoveryHtml({ ...complete, missingOi: 4, message: '接口暂不可用 <script>unsafe</script>' });
    expect(html).toContain('历史补取未完成'); expect(html).toContain('接口暂不可用 &lt;script&gt;unsafe&lt;/script&gt;');
    expect(html).not.toContain('<script>'); expect(html).not.toContain('当前区间已补齐');
  });

  it('states selected-range limits and the lower precision without promising reconstructed alerts', () => {
    const html = recoveryHtml(complete);
    expect(html).toContain('role="status"'); expect(html).toContain('data-help="历史补取范围"');
    expect(html).toContain('当前标的与所看区间'); expect(html).toContain('最多 7 天');
    expect(html).toContain('K线 1m / 单合约 OI 5m'); expect(html).toContain('不插值或补造 30 秒观测');
    expect(html).toContain('FDV、大额成交事件、历史盘口与个人持仓提醒不能据此恢复');
    expect(html).toContain('不参与实时报警'); expect(html).toContain('当时已经收到的证据');
  });

  it('does not show historical-recovery status in event replay or pretend spot has OI', () => {
    expect(recoveryHtml({ ...complete, pending: true }, { isReplay: true })).toBe('');
    const spot = recoveryHtml({ ...complete, missingCandles: 2 }, { isSpot: true });
    expect(spot).toContain('现货无 OI'); expect(spot).not.toContain('/ 0 个 OI 点');
  });

  it('treats historical-only OI as visible chart data and explains ordinary versus replay emptiness', () => {
    const historicalOnly = chartHtml([{ marketKey: market.key, timestamp: at, receivedAt: at + 400_000, quantity: 11, source: 'rest-5m' }]);
    expect(historicalOnly).toContain('aria-hidden="false"'); expect(historicalOnly).not.toContain('这个区间还没有可用行情');
    expect(chartHtml()).toContain('可补取的 K线与 5m OI 以官方返回为准');
    expect(chartHtml([], at)).toContain('后来补取的数据不进入本次回放');
  });
});
