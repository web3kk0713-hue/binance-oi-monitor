import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatAlertPushPayload } from '../server/push';
import type { AlertEvent } from '../src/shared/types';

const baseEvent: AlertEvent = { id: 'test-alert', assetId: 'binance:TEST', symbol: 'TEST', level: 'danger',
  ratio: 25, oiUsd: 250_000, fdvUsd: 1_000_000, timestamp: Date.UTC(2026, 8, 29) };
const url = 'https://example.test/monitor/';
const event = (changes: Partial<AlertEvent> = {}): AlertEvent => ({ ...baseEvent, ...changes });

describe('server valuation alert payload copy', () => {
  it('preserves the legacy FDV label and original value', () => {
    const source = event(), payload = formatAlertPushPayload(source, url);
    expect(payload.title).toBe('高风险 · TEST OI/FDV 25.0%');
    expect(payload.body).toBe('合约 OI $250,000，FDV $1,000,000');
    expect(payload).toMatchObject({ event: source, url, tag: 'oi-fdv:binance:TEST' });
  });

  it('uses the selected FDV value before the legacy field', () => {
    expect(formatAlertPushPayload(event({ valuationBasis: 'fdv', valuationUsd: 2_000_000 }), url).body)
      .toBe('合约 OI $250,000，FDV $2,000,000');
  });

  it('labels a market-cap event and selected value without calling it FDV', () => {
    const payload = formatAlertPushPayload(event({ fdvUsd: null, valuationBasis: 'marketCap', valuationUsd: 500_000 }), url);
    expect(payload.title).toContain('OI/流通市值'); expect(payload.body).toBe('合约 OI $250,000，流通市值 $500,000');
    expect(payload.title + payload.body).not.toContain('FDV');
  });

  it.each([undefined, null])('does not substitute raw FDV when market-cap valuation is %s', valuationUsd => {
    const payload = formatAlertPushPayload(event({ valuationBasis: 'marketCap', valuationUsd }), url);
    expect(payload.body).toBe('合约 OI $250,000，流通市值 暂无数据');
    expect(payload.body).not.toContain('1,000,000');
  });

  it('handles unavailable legacy FDV without throwing', () => {
    const payload = formatAlertPushPayload(event({ fdvUsd: null }), url);
    expect(payload.body).toBe('合约 OI $250,000，FDV 暂无数据');
  });

  it('uses a generic label and never falls back to FDV for an explicit null basis', () => {
    const payload = formatAlertPushPayload(event({ valuationBasis: null, valuationUsd: null }), url);
    expect(payload.title).toContain('OI/估值'); expect(payload.body).toBe('合约 OI $250,000，估值 暂无数据');
    expect(payload.title + payload.body).not.toContain('FDV');
  });

  it.each([NaN, Infinity, -1, 0])('does not format an invalid selected valuation %s as an amount', valuationUsd => {
    expect(formatAlertPushPayload(event({ valuationBasis: 'marketCap', valuationUsd }), url).body)
      .toBe('合约 OI $250,000，流通市值 暂无数据');
  });
});

describe('foreground valuation alert notifications', () => {
  const showNotification = vi.fn(async () => {});
  beforeEach(() => {
    vi.resetModules(); showNotification.mockClear();
    const worker = { showNotification };
    vi.stubGlobal('document', { baseURI: url });
    vi.stubGlobal('window', { Notification: {}, isSecureContext: true });
    vi.stubGlobal('Notification', { permission: 'granted' });
    vi.stubGlobal('navigator', { serviceWorker: { register: vi.fn(async () => worker), ready: Promise.resolve(worker) } });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it.each([
    [event(), 'FDV'],
    [event({ valuationBasis: 'fdv', valuationUsd: 1_000_000 }), 'FDV'],
    [event({ valuationBasis: 'marketCap', valuationUsd: 500_000, fdvUsd: null }), '流通市值'],
    [event({ valuationBasis: null, valuationUsd: null, fdvUsd: null }), '估值'],
  ])('retains the event basis in title and body', async (source, label) => {
    const { showAlertNotification } = await import('../src/web/notifications');
    await showAlertNotification(source);
    expect(showNotification).toHaveBeenCalledExactlyOnceWith(`TEST · OI/${label} 达到 25%`, expect.objectContaining({
      body: `OI / ${label} 已触发红色提醒。点击查看该币种和数据来源。`,
      tag: source.id, requireInteraction: false, data: { assetId: source.assetId, url: `${url}?asset=binance%3ATEST` },
    }));
  });

  it('retains non-market test-notification copy and does not route to an asset', async () => {
    const { showAlertNotification } = await import('../src/web/notifications');
    await showAlertNotification(event({ valuationBasis: 'marketCap', fdvUsd: null }), true);
    expect(showNotification).toHaveBeenCalledExactlyOnceWith('OI 监测 · 测试提醒', expect.objectContaining({
      body: '系统通知已就绪。这是一条测试消息，不代表实时行情。', tag: 'oi-test-notification', requireInteraction: false,
      data: expect.objectContaining({ assetId: undefined }),
    }));
  });
});
