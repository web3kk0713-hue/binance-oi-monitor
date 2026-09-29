import { DEFAULT_DIRECTION_CONFIG } from '../src/shared/directionConfig';
import type { FlowMetrics, FlowSnapshot } from '../src/shared/flowTypes';
import { proposeMarketPlan } from '../src/shared/marketPlan';
import { structureFixture, STRUCTURE_TEST_NOW } from './structure-fixture';

export const ENTRY_NOW = STRUCTURE_TEST_NOW;
export const entryMarket = { key: 'futures:BTCUSDT', venue: 'futures' as const, symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', assetId: 'binance:BTC' };
export function entryPlan(side: 'long' | 'short' = 'long', id = 'watch-one') {
  const fixture = structureFixture(side);
  const result = proposeMarketPlan({ id, side, market: entryMarket, history: fixture.history, reference: fixture.reference,
    now: ENTRY_NOW, directionConfig: { ...DEFAULT_DIRECTION_CONFIG }, holdingLimitMs: 14_400_000 });
  if (result.status !== 'ready') throw new Error(result.reason);
  return result.plan;
}
export function entryFlow(now = ENTRY_NOW, price = '100', changes: Partial<FlowMetrics> = {}): FlowSnapshot {
  const row: FlowMetrics = { market: { ...entryMarket }, asOf: now, status: 'live', reason: '', price: Number(price), priceChange5m: 1,
    volume5m: 100_000, buyShare5m: 65, delta5m: 30_000, volumeMultiple: 2, vwap5m: Number(price), range5mPct: 2, atr14: 2,
    oiChange5m: 8, funding: null, depth: null, baselineWindows: 12, tradeSamples: 100, largeTradeThreshold: 1000,
    lastTradeAt: now - 1000, lastCandleAt: now - 1000, ...changes };
  return { schemaVersion: 1, rows: [row], marks: [{ marketKey: entryMarket.key, markPrice: price, sourceTime: now, receivedAt: now, source: 'binance-mark-stream' }],
    events: [], status: { mode: 'direct', startedAt: ENTRY_NOW - 3_600_000, asOf: now, connectedStreams: 1, totalStreams: 1,
      markets: 1, readyMarkets: 1, warmingMarkets: 0, staleMarkets: 0, backfilledMarkets: 1, errors: [], retentionDays: 7, scope: '' } };
}
