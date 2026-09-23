import { describe, expect, it } from 'vitest';
import type { FlowCandle, FlowEvent, FlowHistory, FlowMarket, FlowOi } from '../src/shared/flowTypes';
import { prepareFlowChart, visibleFlowTrades } from '../src/web/FlowCharts';

const MINUTE = 60_000;
const start = Date.UTC(2026, 8, 23, 10);
const market: FlowMarket = { key: 'futures:TESTUSDC', venue: 'futures', symbol: 'TESTUSDC', baseAsset: 'TEST', quoteAsset: 'USDC', assetId: 'synthetic-test' };
function candle(index: number, overrides: Partial<FlowCandle> = {}): FlowCandle {
  return { marketKey: market.key, openTime: start + index * MINUTE, closeTime: start + (index + 1) * MINUTE - 1,
    open: 100 + index, high: 103 + index, low: 98 + index, close: 101 + index, volume: 2, quoteVolume: 100 + index * 10,
    takerBuyQuote: 60 + index * 5, trades: 10, closed: true, sourceTime: start + (index + 1) * MINUTE - 1,
    receivedAt: start + (index + 1) * MINUTE, source: 'stream', ...overrides };
}
function oi(seconds: number, quantity: number, overrides: Partial<FlowOi> = {}): FlowOi {
  return { marketKey: market.key, timestamp: start + seconds * 1000, receivedAt: start + seconds * 1000 + 100, quantity, ...overrides };
}
function history(candles: FlowCandle[] = [], extra: Partial<FlowHistory> = {}): FlowHistory {
  return { market, from: start, to: start + 10 * MINUTE, candles, events: [], depth: [], oi: [], ...extra };
}
function tradeEvent(id: string, overrides: Partial<FlowEvent> = {}): FlowEvent {
  return { id, ruleVersion: 'flow-v1', marketKey: market.key, symbol: market.symbol, assetId: market.assetId, venue: 'futures', quoteAsset: 'USDC',
    kind: 'large_buy', severity: 'warning', title: 'Synthetic test only', timestamp: start + MINUTE, detectedAt: start + MINUTE + 100,
    referencePrice: 100, evidence: [], reason: 'fixture', invalidation: 'fixture', dataStatus: 'complete', outcomes: [],
    rawTrade: { marketKey: market.key, id, price: '100', quantity: '1000', quoteQuantity: '100000', timestamp: start + MINUTE, receivedAt: start + MINUTE + 100, side: 'buy' }, ...overrides };
}

describe('honest order-flow chart preparation', () => {
  it('aggregates five consecutive real minutes with native quote amounts and OHLC semantics', () => {
    const result = prepareFlowChart(history(Array.from({ length: 5 }, (_, index) => candle(index))), 5, start, start + 5 * MINUTE - 1, start + 5 * MINUTE);
    expect(result).toHaveLength(1);
    expect(result[0].candle).toMatchObject({ open: 100, close: 105, low: 98, high: 107, volume: 10, quoteVolume: 600, takerBuyQuote: 350, trades: 50, closed: true });
    expect(result[0].delta).toBe(100);
    expect(result[0].cvd).toBe(100);
  });

  it('leaves a missing minute null and starts a new CVD segment after the gap', () => {
    const result = prepareFlowChart(history([0, 1, 3, 4].map(index => candle(index))), 1, start, start + 5 * MINUTE - 1, start + 5 * MINUTE);
    expect(result.map(bar => bar.cvd)).toEqual([20, 40, null, 20, 40]);
    expect(result[2]).toMatchObject({ candle: null, delta: null, cvd: null, oi: null });
  });

  it('does not assemble an ended five-minute candle from fewer than five contiguous observations', () => {
    const input = history([0, 1, 3, 4, 5, 6, 7, 8, 9].map(index => candle(index)));
    const result = prepareFlowChart(input, 5, start, start + 10 * MINUTE - 1, start + 10 * MINUTE);
    expect(result[0].candle).toBeNull();
    expect(result[0].cvd).toBeNull();
    expect(result[1].cvd).toBe(100);
    const missingLast = history([0, 1, 2, 3].map(index => candle(index)));
    expect(prepareFlowChart(missingLast, 5, start, start + 5 * MINUTE - 1, start + 5 * MINUTE)[0].candle).toBeNull();
  });

  it('keeps genuine zero Delta and zero OI distinct from absence', () => {
    const input = history([candle(0, { takerBuyQuote: 50 })], { oi: [oi(30, 0)] });
    const result = prepareFlowChart(input, 1, start, start + 2 * MINUTE - 1, start + 2 * MINUTE);
    expect(result[0]).toMatchObject({ delta: 0, cvd: 0, oi: 0 });
    expect(result[1]).toMatchObject({ candle: null, delta: null, cvd: null, oi: null });
  });

  it('uses only the last observed raw OI quantity per displayed bucket without carrying it forward', () => {
    const input = history([], { oi: [oi(240, 17), oi(30, 11), oi(210, 15), oi(245, 900, { marketKey: 'futures:OTHERUSDC' })] });
    const result = prepareFlowChart(input, 5, start, start + 10 * MINUTE - 1, start + 10 * MINUTE);
    expect(result.map(bar => bar.oi)).toEqual([17, null]);
  });

  it('excludes candles and OI not available at the as-of cutoff, including late receipts', () => {
    const cutoff = start + 3 * MINUTE;
    const input = history([candle(0), candle(1, { sourceTime: cutoff + 1 }), candle(2, { receivedAt: cutoff + 1 })],
      { oi: [oi(30, 10), oi(40, 99, { receivedAt: cutoff + 1 }), oi(181, 101)] });
    const result = prepareFlowChart(input, 1, start, start + 4 * MINUTE - 1, cutoff);
    expect(result.map(bar => bar.candle?.close ?? null)).toEqual([101, null, null, null]);
    expect(result.map(bar => bar.oi)).toEqual([10, null, null, null]);
  });

  it('prefers completed duplicate candles but never substitutes a future update', () => {
    const cutoff = start + 2 * MINUTE;
    const input = history([candle(0, { closed: false, close: 99 }), candle(0), candle(0, { close: 999, receivedAt: cutoff + 1 })]);
    expect(prepareFlowChart(input, 1, start, cutoff - 1, cutoff)[0].candle?.close).toBe(101);
  });

  it('allows only the actually observed current partial five-minute bar and labels it unclosed', () => {
    const cutoff = start + 2 * MINUTE + 30_000;
    const input = history([candle(0), candle(1), candle(2, { closed: false, sourceTime: cutoff, receivedAt: cutoff })]);
    const result = prepareFlowChart(input, 5, start, cutoff, cutoff);
    expect(result[0].candle).toMatchObject({ close: 103, closed: false, quoteVolume: 330 });
  });

  it('does not put not-yet-detected events or not-yet-received trades on the chart', () => {
    const cutoff = start + 2 * MINUTE;
    const receivedLater = tradeEvent('received-later'); receivedLater.rawTrade!.receivedAt = cutoff + 1;
    const input = history([], { events: [tradeEvent('ready'), tradeEvent('detected-later', { detectedAt: cutoff + 1 }), receivedLater,
      tradeEvent('future', { timestamp: cutoff + 1 }), tradeEvent('other', { marketKey: 'futures:OTHERUSDC' }), tradeEvent('not-a-trade-event', { kind: 'buy_pressure' })] });
    expect(visibleFlowTrades(input, start, start + 5 * MINUTE, cutoff).map(event => event.id)).toEqual(['ready']);
  });
});
