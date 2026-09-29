import { DEFAULT_DIRECTION_CONFIG } from '../src/shared/directionConfig';
import type { MarketPlanInput } from '../src/shared/marketPlanTypes';
import { structureFixture } from './structure-fixture';

export function marketPlanFixture(side: 'long' | 'short' = 'long'): MarketPlanInput {
  const { history, reference, now } = structureFixture(side);
  return { id: 'entry-test', market: { key: 'futures:BTCUSDT', venue: 'futures', symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', assetId: 'binance:BTC' },
    side, history, reference, now, holdingLimitMs: 14_400_000, directionConfig: { ...DEFAULT_DIRECTION_CONFIG } };
}
