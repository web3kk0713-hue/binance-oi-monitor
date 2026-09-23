import { describe, expect, it } from 'vitest';
import { mergeObservedCandles, mergeObservedOi } from '../src/web/flowStorage';
import type { FlowCandle } from '../src/shared/flowTypes';
const original: FlowCandle = { marketKey: 'futures:BTCUSDT', openTime: 60_000, closeTime: 119_999,
  open: 1, high: 2, low: 1, close: 2, volume: 10, quoteVolume: 15, takerBuyQuote: 10,
  trades: 10, closed: true, source: 'stream', sourceTime: 120_005, receivedAt: 120_010 };
describe('browser archive immutable observable time', () => {
  it('keeps first closed minute when reconnect REST backfill arrives later, even if a source revises its value', () => {
    const [saved] = mergeObservedCandles([original], [{ ...original, close: 1.5, source: 'rest', sourceTime: 119999, receivedAt: 180_000 }]);
    expect(saved).toEqual(original); expect(saved.receivedAt <= 130_000).toBe(true);
  });
  it('allows forming to become closed but never closed to forming', () => {
    const forming = { ...original, closed: false, receivedAt: 110_000, sourceTime: 109_999 };
    expect(mergeObservedCandles([forming], [original])).toEqual([original]);
    expect(mergeObservedCandles([original], [{ ...forming, receivedAt: 125_000 }])).toEqual([original]);
  });
  it('retains earliest observation for the same exchange OI timestamp', () => {
    const old = { marketKey: original.marketKey, timestamp: 120_000, receivedAt: 120_100, quantity: 100 };
    expect(mergeObservedOi([old], [{ ...old, receivedAt: 130_000 }])).toEqual([old]);
  });
});
