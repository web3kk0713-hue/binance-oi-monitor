import { describe, expect, it } from 'vitest';
import { assessDirection } from '../src/shared/direction';
import { DIRECTION_PRESETS } from '../src/shared/directionConfig';
import type { FlowMetrics, FlowSnapshot, FlowVenue } from '../src/shared/flowTypes';
import { createDirectionEvaluator } from '../src/web/directionWorkspace';

const NOW = Date.UTC(2026, 8, 25, 12, 0, 5);
function metric(assetId: string, venue: FlowVenue, quoteAsset: string, bearish = false): FlowMetrics {
  const symbol = `${assetId}${quoteAsset}`, key = `${venue}:${symbol}`;
  return { market: { key, venue, symbol, baseAsset: assetId, quoteAsset, assetId },
    asOf: NOW, status: 'live', reason: '', price: 100, priceChange5m: bearish ? -2 : 2,
    volume5m: 100_000, buyShare5m: bearish ? 30 : 70, delta5m: bearish ? -40_000 : 40_000,
    volumeMultiple: 2, vwap5m: 99, range5mPct: 3, atr14: 1, oiChange5m: venue === 'futures' ? 12 : null,
    funding: venue === 'spot' ? null : { marketKey: key, markPrice: 100, indexPrice: 100, fundingRate: .0001,
      fundingIntervalHours: 8, nextFundingTime: NOW + 3_600_000, timestamp: NOW - 2000, receivedAt: NOW - 1000 },
    depth: null, baselineWindows: 12, tradeSamples: 1000, largeTradeThreshold: 100_000,
    lastTradeAt: NOW - 1000, lastCandleAt: NOW - 2000 };
}
function snapshot(rows: FlowMetrics[]): FlowSnapshot {
  return { schemaVersion: 1, rows, events: [], status: { mode: 'direct', startedAt: NOW - 3_600_000, asOf: NOW,
    connectedStreams: 1, totalStreams: 1, markets: rows.length, readyMarkets: rows.length, warmingMarkets: 0,
    staleMarkets: 0, backfilledMarkets: rows.length, errors: [], retentionDays: 7, scope: '' } };
}

describe('render-scoped direction index', () => {
  it('is exactly equivalent to the unindexed assessment over mixed markets and configurations', () => {
    const data = snapshot(Array.from({ length: 50 }, (_, index) => `TEST${index}`).flatMap((asset, index) => [
      metric(asset, 'futures', 'USDT', index % 2 === 1), metric(asset, 'futures', 'USDC', index % 3 === 1),
      metric(asset, 'spot', 'USDT', index % 4 === 1), metric(asset, 'spot', 'USDC', index % 5 === 1),
    ]));
    data.rows[0] = { ...data.rows[0], status: 'stale' };
    data.rows[1] = { ...data.rows[1], lastCandleAt: NOW - 91_000 };
    data.rows[4] = { ...data.rows[4], oiChange5m: null };
    const original = structuredClone(data);
    for (const config of Object.values(DIRECTION_PRESETS)) {
      const evaluate = createDirectionEvaluator(data, NOW, config);
      for (let index = 0; index < 50; index++) {
        const asset = `TEST${index}`;
        for (const key of [undefined, null, `futures:${asset}USDT`, `futures:${asset}USDC`, `spot:${asset}USDT`, 'futures:ABSENT']) {
          expect(evaluate(asset, key)).toEqual(assessDirection(data, asset, NOW, key, config));
        }
      }
    }
    expect(data).toEqual(original);
  });

  it('reuses only an exact asset/contract in this evaluation round', () => {
    const data = snapshot([metric('BTC', 'futures', 'USDT'), metric('BTC', 'futures', 'USDC', true)]);
    const evaluate = createDirectionEvaluator(data, NOW, DIRECTION_PRESETS.standard);
    expect(evaluate('BTC', 'futures:BTCUSDT')).toBe(evaluate('BTC', 'futures:BTCUSDT'));
    expect(evaluate('BTC', 'futures:BTCUSDT').bias).toBe('long');
    expect(evaluate('BTC', 'futures:BTCUSDC').bias).toBe('short');
    expect(evaluate('BTC', 'futures:BTCUSDT')).not.toBe(evaluate('BTC', 'futures:BTCUSDC'));
  });

  it('re-evaluates freshness even when the snapshot reference does not change', () => {
    const data = snapshot([metric('BTC', 'futures', 'USDT')]);
    const ready = createDirectionEvaluator(data, NOW + 30_000, DIRECTION_PRESETS.standard)('BTC');
    const expired = createDirectionEvaluator(data, NOW + 30_001, DIRECTION_PRESETS.standard)('BTC');
    expect(ready.bias).toBe('long');
    expect(expired.bias).toBe('wait');
    expect(expired.reason).toContain('过期');
    expect(expired).toEqual(assessDirection(data, 'BTC', NOW + 30_001));
  });

  it('re-evaluates applied thresholds and changed snapshot values', () => {
    const row = { ...metric('BTC', 'futures', 'USDT'), oiChange5m: 2, priceChange5m: .3, buyShare5m: 57 };
    const data = snapshot([row]);
    expect(createDirectionEvaluator(data, NOW, DIRECTION_PRESETS.sensitive)('BTC').bias).toBe('long');
    expect(createDirectionEvaluator(data, NOW, DIRECTION_PRESETS.standard)('BTC').bias).toBe('wait');
    expect(createDirectionEvaluator(snapshot([{ ...row, oiChange5m: -1 }]), NOW, DIRECTION_PRESETS.sensitive)('BTC').bias).toBe('wait');
  });

  it('preserves safe waiting results for missing, invalid, and unmatched inputs', () => {
    const data = snapshot([metric('BTC', 'futures', 'USDT')]);
    for (const value of [null, data, { ...data, schemaVersion: 2 } as unknown as FlowSnapshot,
      { ...data, rows: null } as unknown as FlowSnapshot,
      { ...data, rows: [null, {}, ...data.rows] } as unknown as FlowSnapshot]) {
      const evaluate = createDirectionEvaluator(value, NOW, DIRECTION_PRESETS.standard);
      for (const asset of [undefined, '', 'BTC', 'MISSING'])
        expect(evaluate(asset)).toEqual(assessDirection(value, asset, NOW));
    }
  });
});
