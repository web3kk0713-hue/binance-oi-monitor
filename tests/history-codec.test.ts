// Codec fixtures are synthetic and must never be interpreted as market observations.
import { describe, expect, it } from 'vitest';
import { appendSample, compactSampleHour, HISTORY_HOUR, unpackSamples, type SampleHour } from '../src/web/historyCodec';
import type { HistoryPoint } from '../src/shared/types';

const hour = Date.UTC(2026, 8, 23, 10);
function point(timestamp: number, change: Partial<HistoryPoint> = {}): HistoryPoint {
  return { assetId: 'test', timestamp, availableAt: timestamp, oiUsd: 50, marketCapUsd: 80, fdvUsd: 100,
    oiToFdv: 50, oiToMarketCap: 62.5, complete: true, oiQuantity: 5, priceUsd: 10,
    oiSourceTime: timestamp - 1000, priceSourceTime: timestamp - 2000, sourceSkewMs: 1000,
    samplingIntervalMs: 30_000, contractSetKey: 'TESTUSDT:1', ...change };
}
function pack(points: HistoryPoint[]) {
  let record: SampleHour | undefined;
  for (const point of points) record = appendSample(record, point);
  if (!record) throw new Error('Test fixture needs observations');
  return record;
}

describe('packed actual-time history codec', () => {
  it('retains both half-minute samples, exact times, and source metadata after out-of-order insertion', () => {
    const early = point(hour + 1234);
    const late = point(hour + 31_987);
    const record = pack([late, early]);
    expect(unpackSamples(record)).toEqual([early, late]);
    expect(record.hour).toBe(hour);
    expect(record.contractSets).toEqual(['TESTUSDT:1']);
  });

  it('keeps zeros distinct from missing values and does not divide by zero', () => {
    const decoded = unpackSamples(pack([
      point(hour + 1000, { oiUsd: 0, oiQuantity: 0 }),
      point(hour + 31_000, { oiUsd: null, oiQuantity: null, fdvUsd: null, marketCapUsd: null, priceUsd: null }),
      point(hour + 61_000, { fdvUsd: 0, marketCapUsd: 0 }),
    ]));
    expect(decoded[0]).toMatchObject({ oiUsd: 0, oiQuantity: 0, oiToFdv: 0, oiToMarketCap: 0 });
    expect(decoded[1]).toMatchObject({ oiUsd: null, oiQuantity: null, oiToFdv: null, oiToMarketCap: null, priceUsd: null });
    expect(decoded[2]).toMatchObject({ fdvUsd: 0, marketCapUsd: 0, oiToFdv: null, oiToMarketCap: null });
  });

  it('invalidates incomplete/invalid values without dropping the original timestamps', () => {
    const decoded = unpackSamples(pack([
      point(hour + 1000, { complete: false }),
      point(hour + 31_000, { oiUsd: NaN, oiQuantity: Infinity, fdvUsd: Infinity }),
    ]));
    expect(decoded[0]).toMatchObject({ timestamp: hour + 1000, availableAt: hour + 1000,
      oiUsd: null, oiQuantity: null, fdvUsd: null, marketCapUsd: null, priceUsd: null, complete: false });
    expect(decoded[1]).toMatchObject({ oiUsd: null, oiQuantity: null, fdvUsd: null });
  });

  it('updates a duplicate asOf without making a second observation and retains separate contract identities', () => {
    const decoded = unpackSamples(pack([
      point(hour + 1000), point(hour + 31_000),
      point(hour + 1000, { oiUsd: 75, contractSetKey: 'TESTUSDT:1|TESTUSDC:1' }),
    ]));
    expect(decoded).toHaveLength(2);
    expect(decoded[0]).toMatchObject({ timestamp: hour + 1000, oiUsd: 75, oiToFdv: 75, contractSetKey: 'TESTUSDT:1|TESTUSDC:1' });
    expect(decoded[1].contractSetKey).toBe('TESTUSDT:1');
  });

  it('rejects fabricated availability, mismatched assets, and wrong hourly groups', () => {
    expect(() => appendSample(undefined, point(hour, { availableAt: hour + 1 }))).toThrow();
    expect(() => appendSample(undefined, point(NaN))).toThrow();
    const record = pack([point(hour + 1000)]);
    expect(() => appendSample(record, point(hour + 31_000, { assetId: 'other' }))).toThrow();
    expect(() => appendSample(record, point(hour + HISTORY_HOUR))).toThrow();
  });

  it('does not relabel a one-minute observation as a thirty-second sample', () => {
    const record = pack([point(hour + 1000)]);
    expect(() => appendSample(record, point(hour + 31_000, { samplingIntervalMs: 60_000 }))).toThrow();
  });

  it('compacts an older-than-seven-day hour to each minute’s last real sample without moving its timestamp', () => {
    const oldHour = hour - 8 * 24 * HISTORY_HOUR;
    const points = [1000, 31_123, 61_000, 94_567].map((offset, i) => point(oldHour + offset, { oiUsd: 50 + i }));
    const compacted = compactSampleHour(pack(points));
    const decoded = unpackSamples(compacted);
    expect(decoded.map(point => point.timestamp)).toEqual([oldHour + 31_123, oldHour + 94_567]);
    expect(decoded.map(point => point.availableAt)).toEqual([oldHour + 31_123, oldHour + 94_567]);
    expect(decoded.map(point => point.oiUsd)).toEqual([51, 53]);
    expect(decoded.every(point => point.samplingIntervalMs === 60_000)).toBe(true);
    expect(unpackSamples(compactSampleHour(compacted))).toEqual(decoded);
  });

  it('does not fill missing minutes during compaction', () => {
    const decoded = unpackSamples(compactSampleHour(pack([point(hour + 1000), point(hour + 181_000)])));
    expect(decoded.map(point => point.timestamp)).toEqual([hour + 1000, hour + 181_000]);
  });
});
