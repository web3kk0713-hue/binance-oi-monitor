import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { FlowEvent } from '../src/shared/flowTypes';
import { EventEvidence, flowEvidenceHelp } from '../src/web/FlowDashboard';

describe('event-time evidence help', () => {
  it('keeps volume, large-trade, depth and spread baselines distinct', () => {
    expect(flowEvidenceHelp('5m成交额').baseline).toContain('成交额的中位数');
    expect(flowEvidenceHelp('聚合成交额').baseline).toContain('事件当时的大额筛选门槛');
    expect(flowEvidenceHelp('聚合成交额').baseline).toContain('99.5 百分位');
    expect(flowEvidenceHelp('范围内双边深度').baseline).toContain('双边挂单金额中位数');
    expect(flowEvidenceHelp('价差').baseline).toContain('买卖价差中位数');
  });
  it('makes percentage denominators, OI units and amount abbreviations explicit', () => {
    expect(flowEvidenceHelp('主动买入占比').value).toContain('÷ 总成交额 ×100%');
    expect(flowEvidenceHelp('主动买入占比').value).toContain('不是买额÷卖额');
    expect(flowEvidenceHelp('连续原始OI约5m变化').value).toContain('原始数量');
    expect(flowEvidenceHelp('连续原始OI约5m变化').value).toContain('排除价格影响');
    expect(flowEvidenceHelp('聚合成交额').value).toContain('K=千、M=百万、B=十亿');
  });
  it('does not invent a definition or window for unknown fields and unexplained baselines', () => {
    const unknown = flowEvidenceHelp('未记录口径字段');
    expect(unknown.value).toContain('尚无已核验');
    expect(unknown.value).toContain('不推测时间窗口或分母');
    expect(unknown.baseline).toContain('尚未核验');
    expect(flowEvidenceHelp('主动买入占比').baseline).toContain('尚未核验');
  });
  it('puts separate accessible help next to each evidence value, baseline and outcome horizon', () => {
    const now = Date.UTC(2026, 8, 25, 12);
    const event = { id: 'fixture', assetId: 'TEST', marketKey: 'futures:TESTUSDT', venue: 'futures', symbol: 'TESTUSDT', quoteAsset: 'USDT',
      kind: 'large_buy', title: '测试事件', severity: 'warning', timestamp: now - 60_000, detectedAt: now - 59_000,
      ruleVersion: 'flow-v1', referencePrice: 100, reason: '测试', invalidation: '测试', dataStatus: 'complete',
      evidence: [{ label: '聚合成交额', value: 110_000, unit: 'USDT', baseline: 100_000 },
        { label: '主动买入占比', value: 32, unit: '%' }], outcomes: [] } as FlowEvent;
    const html = renderToStaticMarkup(createElement(EventEvidence, { event, now, onExport: () => undefined }));
    for (const label of ['事件聚合成交额说明', '聚合成交额基准说明', '事件主动买入占比说明', '1分钟后价格变化说明', '5分钟后价格变化说明', '15分钟后价格变化说明']) expect(html).toContain(label);
    expect(html).toContain('不是策略收益');
    expect(html).toContain('首个完整、按时收到的收盘价起算');
  });
});
