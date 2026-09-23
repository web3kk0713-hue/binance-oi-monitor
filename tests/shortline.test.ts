// Synthetic observations validate interpretation and time gates, not predictive trading accuracy.
import { describe, expect, it } from 'vitest';
import { analyzeShortline } from '../src/shared/shortline';
import type { HistoryPoint } from '../src/shared/types';

const now = Date.UTC(2026, 8, 23, 10);
const cadence = 30_000;
function point(timestamp: number, quantity = 100, price = 10): HistoryPoint {
  return { assetId: 'test', timestamp, availableAt: timestamp, oiUsd: quantity * price, marketCapUsd: price * 800,
    fdvUsd: price * 1000, oiToFdv: quantity / 10, oiToMarketCap: quantity / 8, complete: true,
    oiQuantity: quantity, priceUsd: price, oiSourceTime: timestamp - 1000, priceSourceTime: timestamp - 1000,
    sourceSkewMs: 0, samplingIntervalMs: cadence, contractSetKey: 'TESTUSDT:1' };
}
function window(end = now) { return Array.from({ length: 11 }, (_, i) => point(end - 300_000 + i * cadence, 100 + i)); }

describe('rolling five-minute original-quantity analysis', () => {
  it('uses both half-minute samples and isolates quantity growth from USD OI', () => {
    const result = analyzeShortline(window(), 'test', now);
    expect(result).toMatchObject({ status: 'ready', startAt: now - 300_000, endAt: now, observations: 11 });
    expect(result.oiQuantityChange).toBeCloseTo(10);
    expect(result.oiUsdChange).toBeCloseTo(10);
    expect(result.priceChange).toBe(0);
  });

  it('does not call a price-only rise new OI quantity and does not require FDV for this comparison', () => {
    const points = Array.from({ length: 11 }, (_, i) => ({ ...point(now - 300_000 + i * cadence, 100, 10 + i / 10),
      fdvUsd: null, marketCapUsd: null, oiToFdv: null, oiToMarketCap: null }));
    const result = analyzeShortline(points, 'test', now);
    expect(result.status).toBe('ready');
    expect(result.oiQuantityChange).toBe(0);
    expect(result.priceChange).toBeCloseTo(10);
    expect(result.oiUsdChange).toBeCloseTo(10);
  });

  it('selects the baseline at or before the five-minute source target, not the closest later source', () => {
    const points = Array.from({ length: 12 }, (_, i) => ({ ...point(now - 330_000 + i * cadence, 100 + i),
      oiSourceTime: now - 330_000 + i * cadence - 5000, priceSourceTime: now - 330_000 + i * cadence - 5000 }));
    // This point is closer to the target but is four seconds later than it.
    points[1].oiSourceTime = points[1].timestamp - 1000;
    points[1].priceSourceTime = points[1].timestamp - 1000;
    const result = analyzeShortline(points, 'test', now);
    expect(result.status).toBe('ready');
    expect(result.startAt).toBe(now - 330_000);
    expect(result.oiQuantityChange).toBeCloseTo(11);
  });

  it('never uses a future or not-yet-available point and deduplicates the same actual timestamp', () => {
    const points = [...window(), { ...point(now, 999), availableAt: now + 1 }, point(now + 1, 999),
      { ...point(now, 999), assetId: 'another' }];
    const result = analyzeShortline(points, 'test', now);
    expect(result.observations).toBe(11);
    expect(result.oiQuantityChange).toBeCloseTo(10);
    const revised = analyzeShortline([...window(), point(now, 120)], 'test', now);
    expect(revised.observations).toBe(11);
    expect(revised.oiQuantityChange).toBeCloseTo(20);
  });

  it('does not compare different contract compositions or unit multipliers', () => {
    const points = window();
    points[3].contractSetKey = 'TESTUSDT:1000';
    expect(analyzeShortline(points, 'test', now)).toMatchObject({ status: 'composition', oiQuantityChange: null });
  });

  it.each([
    ['missing native quantity', { oiQuantity: null }],
    ['negative native quantity', { oiQuantity: -1 }],
    ['invalid native quantity', { oiQuantity: NaN }],
    ['zero price', { priceUsd: 0 }],
    ['missing source skew', { sourceSkewMs: null }],
    ['source skew greater than thirty seconds', { sourceSkewMs: 30_001 }],
    ['future source time', { oiSourceTime: now + 1 }],
    ['old or compacted minute point', { samplingIntervalMs: 60_000 }],
    ['incomplete point', { complete: false }],
  ] as Array<[string, Partial<HistoryPoint>]>)('rejects %s as a current shortline sample', (_name, change) => {
    const points = window(); Object.assign(points[10], change);
    expect(analyzeShortline(points, 'test', now)).toMatchObject({ status: 'unavailable', oiQuantityChange: null });
  });

  it('separates stale source data from a fresh fetch and refuses legacy rows without known availability', () => {
    const points = window(); points[10].oiSourceTime = now - 60_001;
    expect(analyzeShortline(points, 'test', now).status).toBe('stale');
    expect(analyzeShortline(window(now - 60_001), 'test', now).status).toBe('stale');
    const legacy = window().map(({ availableAt: _unknown, ...point }) => point);
    expect(analyzeShortline(legacy, 'test', now)).toMatchObject({ status: 'warming', oiQuantityChange: null });
  });

  it('refuses missing, delayed, or repeated observations within the window', () => {
    const missing = window(); missing.splice(4, 2);
    expect(analyzeShortline(missing, 'test', now).status).toBe('gap');
    const incomplete = window(); incomplete[4].complete = false;
    expect(analyzeShortline(incomplete, 'test', now).status).toBe('gap');
    const delayed = window(); delayed[4].priceSourceTime = delayed[4].availableAt! - 45_001;
    expect(analyzeShortline(delayed, 'test', now).status).toBe('gap');
    const repeated = window(); repeated[4].oiSourceTime = repeated[3].oiSourceTime;
    expect(analyzeShortline(repeated, 'test', now).status).toBe('gap');
  });

  it('does not silently accept one entirely missed thirty-second observation', () => {
    const points = window(); points.splice(4, 1);
    expect(analyzeShortline(points, 'test', now)).toMatchObject({ status: 'gap', oiQuantityChange: null });
  });

  it('warms up when no pre-target baseline exists, and never divides by a zero baseline', () => {
    expect(analyzeShortline(window().slice(1), 'test', now).status).toBe('warming');
    const zeroBaseline = window(); zeroBaseline[0].oiQuantity = 0;
    expect(analyzeShortline(zeroBaseline, 'test', now)).toMatchObject({ status: 'warming', oiQuantityChange: null });
    const closed = window(); closed[10] = point(now, 0);
    expect(analyzeShortline(closed, 'test', now).oiQuantityChange).toBe(-100);
  });
});
