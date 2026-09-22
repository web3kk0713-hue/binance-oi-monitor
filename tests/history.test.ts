import { describe, expect, it } from 'vitest';
import { analyzeHistory, historySeries, relativeChange, toHistoryPoint } from '../src/shared/history';
import type { AssetRow, HistoryPoint } from '../src/shared/types';
import { signed, signedMoney } from '../src/web/format';

const now = Date.UTC(2026, 8, 22, 10);
const minute = 60_000;
function point(timestamp: number, oiUsd = 50, fdvUsd: number | null = 100): HistoryPoint {
  return { assetId: 'test', timestamp, oiUsd, fdvUsd, marketCapUsd: 80, oiToFdv: 50, oiToMarketCap: 62.5, complete: true };
}
function asset(): AssetRow {
  return { id: 'test', symbol: 'TEST', name: 'Synthetic only', contracts: [], priceUsd: 1, oiUsd: 50, marketCapUsd: 80, fdvUsd: 100,
    oiToFdv: 50, oiToMarketCap: 62.5, circulatingSupply: 80, maxSupply: 100, updatedAt: now,
    oiUpdatedAt: now, priceUpdatedAt: now, supplyUpdatedAt: now, complete: true, alertEligible: true, issues: [], supplySource: 'CoinGecko', mappingStatus: 'verified',
    evidence: { contracts: [], mapping: 'Synthetic only', supply: { provider: 'CoinGecko', id: 'test', circulating: 80, total: 100, max: 100, updatedAt: now, fetchedAt: now, url: 'https://example.invalid' } } };
}

describe('honest history comparisons', () => {
  it('does not round a small nonzero ratio change to negative zero', () => {
    expect(signed(-0.0002, ' pp', 4)).toBe('-0.0002 pp');
    expect(signed(-0.000001, ' pp', 4)).toBe('−<0.0001 pp');
    expect(signedMoney(-12_000)).toBe('−$12.0K');
  });
  it.each([72, 168])('compares %s-hour minute series with one common baseline', hours => {
    const start = now - hours * 60 * minute;
    const input = Array.from({ length: hours * 60 + 1 }, (_, i) => point(start + i * minute, 50 + i, 100 + i));
    const result = analyzeHistory(input, 'test', hours, now);
    expect(result.coversWindow).toBe(true);
    expect(result.validPoints).toBe(result.expectedPoints);
    expect(result.baseline?.timestamp).toBe(start);
    expect(result.oiChange).toBeCloseTo(hours * 60 / 50 * 100);
    expect(result.fdvChange).toBeCloseTo(hours * 60);
    expect(result.ratioDifference).toBeCloseTo((50 + hours * 60) / (100 + hours * 60) * 100 - 50);
  });
  it('does not label a short sample as a seven-day change, and distinguishes percentage points', () => {
    const result = analyzeHistory([point(now - minute), point(now, 90, 120)], 'test', 168, now);
    expect(result.coversWindow).toBe(false);
    expect(result.oiChange).toBeCloseTo(80);
    expect(result.fdvChange).toBeCloseTo(20);
    expect(result.ratioDifference).toBe(25);
  });
  it('does not choose different start dates when FDV arrives later', () => {
    const result = analyzeHistory([point(now - 2 * minute, 10, null), point(now - minute, 50, 100), point(now, 100, 110)], 'test', 72, now);
    expect(result.baseline?.timestamp).toBe(now - minute);
    expect(result.oiChange).toBe(100);
    const series = historySeries(result.points, result.baseline, 'change');
    expect(series[0].oiUsd).toBeNull();
    expect(series[1].oiUsd).toBe(0);
    expect(series[2].fdvUsd).toBeCloseTo(10);
  });
  it('keeps zero OI distinct from missing data and does not divide by zero', () => {
    const result = analyzeHistory([point(now - minute, 0), point(now, 5)], 'test', 72, now);
    expect(result.oiChange).toBeNull();
    expect(result.oiDifference).toBe(5);
    expect(result.ratioDifference).toBe(5);
    expect(relativeChange(0, 100)).toBe(-100);
  });
  it('does not present stale or one-point data as a current change', () => {
    expect(analyzeHistory([point(now)], 'test', 168, now).oiChange).toBeNull();
    const stale = analyzeHistory([point(now - 6 * minute), point(now - 3 * minute, 90)], 'test', 168, now);
    expect(stale.stale).toBe(true);
    expect(stale.oiChange).toBeNull();
  });
  it('drops other assets, future and out-of-window points, deduplicates and keeps gaps', () => {
    const result = analyzeHistory([point(now), point(now - 4 * minute), point(now + minute), point(now - 73 * 60 * minute),
      { ...point(now - 3 * minute), assetId: 'other' }, { ...point(now - 2 * minute), complete: false }, point(now, 70)], 'test', 72, now);
    expect(result.points).toHaveLength(3);
    expect(result.latest?.oiUsd).toBe(70);
    expect(result.points[1].fdvUsd).toBeNull();
    const series = historySeries(result.points, result.baseline, 'amount');
    expect(series).toHaveLength(5);
    expect(series[1].oiUsd).toBeNull();
    expect(series[3].oiUsd).toBeNull();
  });
});

describe('collection-time history validity', () => {
  it('uses the collection start minute despite varying completion duration', () => {
    const row = asset();
    const first = toHistoryPoint(row, { startedAt: now - 10_000, asOf: now + 10_000 });
    const second = toHistoryPoint(row, { startedAt: now + 50_000, asOf: now + 55_000 });
    expect(second.timestamp - first.timestamp).toBe(minute);
  });
  it('keeps valid OI but rejects expired supply independently', () => {
    const row = asset();
    row.supplyUpdatedAt = now - 120 * minute;
    row.evidence.supply!.updatedAt = row.supplyUpdatedAt;
    expect(toHistoryPoint(row, { startedAt: now, asOf: now }).fdvUsd).toBe(100);
    row.supplyUpdatedAt--;
    expect(toHistoryPoint(row, { startedAt: now, asOf: now })).toMatchObject({ oiUsd: 50, fdvUsd: null, marketCapUsd: null, oiToFdv: null, complete: true });
  });
  it('rejects stale fetches, unknown mapping, invalid numbers and incomplete markets', () => {
    const row = asset();
    row.evidence.supply!.fetchedAt = now - 121 * minute;
    expect(toHistoryPoint(row, { startedAt: now, asOf: now }).fdvUsd).toBeNull();
    row.evidence.supply!.fetchedAt = now;
    row.mappingStatus = 'unmapped';
    expect(toHistoryPoint(row, { startedAt: now, asOf: now }).fdvUsd).toBeNull();
    row.mappingStatus = 'verified'; row.oiUsd = NaN;
    expect(toHistoryPoint(row, { startedAt: now, asOf: now }).oiUsd).toBeNull();
    row.complete = false;
    expect(toHistoryPoint(row, { startedAt: now, asOf: now })).toMatchObject({ oiUsd: null, fdvUsd: null, complete: false });
  });
});
