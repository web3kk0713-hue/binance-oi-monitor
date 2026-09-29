import Decimal from 'decimal.js';
import { STRUCTURE_INTERVAL_MS as STEP, STRUCTURE_LOOKBACK_MS as LOOKBACK, type StructureCandle, type StructureInput } from '../src/shared/structureTypes';

export const STRUCTURE_TEST_NOW = Date.UTC(2026, 8, 28);
const D = Decimal.clone({ precision: 80 });
/** Deterministic isolated pivots; ATR=2, buffer=.5, first remaining RR=2.2. Test data only. */
export function structureFixture(side: 'long' | 'short' = 'long', now = STRUCTURE_TEST_NOW): StructureInput {
  const candles: StructureCandle[] = Array.from({ length: LOOKBACK / STEP }, (_, index) => ({ openTime: now - LOOKBACK + index * STEP,
    closeTime: now - LOOKBACK + (index + 1) * STEP - 1, open: '100', high: '101', low: '99', close: '100' }));
  for (const [offset, price] of [[150, '98'], [180, '106'], [210, '110']] as const) {
    const bar = candles[candles.length - offset];
    if (price === '98') bar.low = price; else bar.high = price;
  }
  if (side === 'short') for (const bar of candles) {
    const high = bar.high, low = bar.low;
    bar.high = new D(200).minus(low).toFixed(); bar.low = new D(200).minus(high).toFixed();
  }
  return { mode: 'live', now,
    position: { id: 'test', marketKey: 'futures:BTCUSDT', symbol: 'BTCUSDT', assetId: 'binance:BTC', side,
      entryPrice: '100', margin: '100', leverage: '10', createdAt: now - 1000 },
    reference: { marketKey: 'futures:BTCUSDT', markPrice: '100', sourceTime: now, receivedAt: now, source: 'binance-mark-stream' },
    history: { schemaVersion: 1, marketKey: 'futures:BTCUSDT', symbol: 'BTCUSDT', tickSize: '.1', intervalMs: STEP,
      from: now - LOOKBACK, to: now, fetchedAt: now, candles } };
}
