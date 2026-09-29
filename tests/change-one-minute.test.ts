// Synthetic observations exercise production comparison/codec functions, not live market data or trading accuracy.
import { describe, expect, it } from 'vitest';
import { analyzeChange, DEFAULT_CHANGE_RULE, selectChangeBaselines, type ChangeRule } from '../src/shared/changeMonitor';
import { toHistoryPoint } from '../src/shared/history';
import type { AssetRow, HistoryPoint } from '../src/shared/types';
import { appendSample, HISTORY_HOUR, unpackSamples, type SampleHour } from '../src/web/historyCodec';

const at = Date.UTC(2026, 8, 29, 12, 59, 40);
const minute = 60_000;

function asset(timestamp: number, quantity = 100, price = 10, withSupply = true): AssetRow {
  return {
    id: 'synthetic:ONE', symbol: 'ONE', name: 'Synthetic only', contracts: ['ONEUSDT'],
    priceUsd: price, oiUsd: quantity * price, oiQuantity: quantity,
    marketCapUsd: withSupply ? price * 800 : null, fdvUsd: withSupply ? price * 1000 : null,
    oiToFdv: withSupply ? quantity / 10 : null, oiToMarketCap: withSupply ? quantity / 8 : null,
    circulatingSupply: withSupply ? 800 : null, maxSupply: withSupply ? 1000 : null,
    updatedAt: timestamp, oiUpdatedAt: timestamp - 1000, priceUpdatedAt: timestamp - 1000,
    supplyUpdatedAt: withSupply ? timestamp - 1000 : null, complete: true, alertEligible: withSupply,
    issues: withSupply ? [] : ['Synthetic supply unavailable'], supplySource: withSupply ? 'CoinGecko' : null,
    mappingStatus: withSupply ? 'verified' : 'unmapped',
    evidence: {
      mapping: 'Synthetic only',
      contracts: [{ symbol: 'ONEUSDT', baseAsset: 'ONE', quoteAsset: 'USDT', openInterest: String(quantity),
        markPrice: String(price), indexPrice: String(price), quoteUsd: '1', oiUsd: quantity * price,
        oiTime: timestamp - 1000, priceTime: timestamp - 1000, quoteTime: timestamp - 1000, unitMultiplier: 1 }],
      supply: withSupply ? { provider: 'CoinGecko', id: 'synthetic-one', circulating: 800, total: 1000, max: 1000,
        updatedAt: timestamp - 1000, fetchedAt: timestamp - 1000, url: 'https://example.invalid/synthetic' } : null,
    },
  };
}

function observation(value: AssetRow, startedAt = value.updatedAt - 1000): HistoryPoint {
  return toHistoryPoint(value, { startedAt, asOf: value.updatedAt, collectionIntervalMs: 30_000 });
}

/** Use the real hourly codec, including an hour boundary, without a browser or persistent writes. */
function roundTrip(points: HistoryPoint[]): HistoryPoint[] {
  const records = new Map<string, SampleHour>();
  for (const point of points) {
    const key = `${point.assetId}:${Math.floor(point.timestamp / HISTORY_HOUR)}`;
    records.set(key, appendSample(records.get(key), point));
  }
  return [...records.values()].flatMap(unpackSamples).sort((left, right) => left.timestamp - right.timestamp);
}

function rule(windowMinutes = 1, oiOnly = false): ChangeRule {
  return { ...DEFAULT_CHANGE_RULE, windowMinutes, oi: { ...DEFAULT_CHANGE_RULE.oi },
    fdv: { ...DEFAULT_CHANGE_RULE.fdv, enabled: !oiOnly } };
}

function compare(values: AssetRow[], config = rule()) {
  const points = roundTrip(values.map(value => observation(value)));
  const latest = points.at(-1)!;
  const baseline = selectChangeBaselines(points, latest.timestamp - config.windowMinutes * minute)
    .find(point => point.assetId === latest.assetId) ?? null;
  return analyzeChange(values.at(-1)!, latest, baseline, config, latest.timestamp);
}

describe('one-minute change monitoring uses the selected window', () => {
  it('starts unavailable, then compares one minute after 60 seconds while five minutes is still warming', () => {
    const initial = asset(at);
    expect(compare([initial])).toMatchObject({ status: 'unavailable', matched: false, startAt: null });
    const values = [initial, asset(at + 30_000, 102, 10.1), asset(at + minute, 105, 10.3)];
    expect(compare(values)).toMatchObject({ status: 'hit', matched: true, oiPct: 5, fdvPct: 3,
      startAt: at, endAt: at + minute });
    expect(compare(values, rule(5))).toMatchObject({ status: 'unavailable', matched: false,
      startAt: null, oiPct: null, fdvPct: null });
  });

  it('uses the one-minute baseline even when a different five-minute result is available', () => {
    const values = [asset(at, 100), asset(at + 4 * minute, 200), asset(at + 5 * minute, 210, 10.3)];
    const oneMinute = rule(); oneMinute.oi.threshold = 10;
    const fiveMinutes = { ...oneMinute, windowMinutes: 5 };
    expect(compare(values, oneMinute)).toMatchObject({ status: 'below', matched: false,
      oiPct: 5, fdvPct: 3, startAt: at + 4 * minute });
    expect(compare(values, fiveMinutes)).toMatchObject({ status: 'hit', matched: true,
      oiPct: 110, fdvPct: 3, startAt: at });
    expect(oneMinute).toMatchObject({ windowMinutes: 1, oi: { threshold: 10 } });
  });

  it('preserves valid OI and exact availability times when FDV is absent, without fabricating FDV', () => {
    const values = [asset(at, 100, 10, false), asset(at + 30_017, 102, 10, false),
      asset(at + minute, 106, 10, false)];
    const points = roundTrip(values.map(value => observation(value)));
    expect(points.map(point => point.timestamp)).toEqual([at, at + 30_017, at + minute]);
    expect(points.every(point => point.availableAt === point.timestamp && point.complete
      && point.oiQuantity !== null && point.fdvUsd === null && point.samplingIntervalMs === 30_000)).toBe(true);
    expect(compare(values, rule(1, true))).toMatchObject({ status: 'hit', matched: true, oiPct: 6,
      fdvPct: null, fdvMatched: null, startAt: at });
    // Requiring both metrics must not silently turn this into an OI-only hit.
    expect(compare(values)).toMatchObject({ status: 'unavailable', matched: false,
      oiPct: 6, oiMatched: true, fdvPct: null, fdvMatched: null });
  });
});

describe('one-minute baseline honesty and collection jitter', () => {
  it.each([
    [45_000, 'hit', true],
    [45_001, 'unavailable', false],
    [-1, 'unavailable', false],
  ] as const)('handles a baseline offset of %s ms without interpolation or lookahead', (earlyBy, status, matched) => {
    const latestAt = at + 3 * minute;
    const baselineAt = latestAt - minute - earlyBy;
    const result = compare([asset(baselineAt, 100), asset(latestAt, 106, 10.4)]);
    expect(result).toMatchObject({ status, matched, startAt: matched ? baselineAt : null });
    if (matched) {
      expect(result.endAt - result.startAt!).toBe(105_000);
      expect(result).toMatchObject({ oiPct: 6, fdvPct: 4 });
    } else expect(result).toMatchObject({ oiPct: null, fdvPct: null });
  });

  it('does not manufacture a hit when variable completion durations leave a 46-second baseline gap', () => {
    // All five rounds start 30s apart and finish within the existing 27s budget.
    const starts = [0, 30_000, 60_000, 90_000, 120_000];
    const durations = [25_000, 1000, 25_000, 1000, 17_000];
    const values = starts.map((start, index) => asset(at + start + durations[index],
      index === starts.length - 1 ? 106 : 100, 10, false));
    const points = roundTrip(values.map((value, index) => observation(value, at + starts[index])));
    expect(points.map(point => point.timestamp - at)).toEqual([25_000, 31_000, 85_000, 91_000, 137_000]);
    const latest = points.at(-1)!;
    const target = latest.timestamp - minute;
    const earlier = points.filter(point => point.timestamp <= target).at(-1)!;
    expect(target - earlier.timestamp).toBe(46_000);
    const baselines = selectChangeBaselines(points, target);
    expect(baselines).toEqual([]);
    const result = analyzeChange(values.at(-1)!, latest, baselines[0] ?? null, rule(1, true), latest.timestamp);
    expect(result).toMatchObject({ status: 'unavailable', matched: false, startAt: null, oiPct: null });
    expect(result.reason).toContain('窗口起点附近尚无已知可用观测');
  });
});
