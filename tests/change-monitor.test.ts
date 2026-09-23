// Synthetic endpoints test deterministic interpretation, not trading performance.
import { describe, expect, it } from 'vitest';
import { analyzeChange, BASELINE_TOLERANCE_MS, DEFAULT_CHANGE_RULE, isChangeRule, selectChangeBaselines,
  type ChangeCondition, type ChangeRule } from '../src/shared/changeMonitor';
import type { AssetRow, HistoryPoint } from '../src/shared/types';

const now = Date.UTC(2026, 8, 23, 12);
const start = now - 5 * 60_000;
function point(timestamp: number, changes: Partial<HistoryPoint> = {}): HistoryPoint {
  return { assetId: 'test', timestamp, availableAt: timestamp, oiUsd: 1000, oiQuantity: 100,
    marketCapUsd: 8000, fdvUsd: 10_000, oiToFdv: 10, oiToMarketCap: 12.5, priceUsd: 10,
    complete: true, oiSourceTime: timestamp - 1000, priceSourceTime: timestamp - 1000,
    sourceSkewMs: 0, samplingIntervalMs: 30_000, contractSetKey: 'TESTUSDT:1', ...changes };
}
const asset: AssetRow = { id: 'test', symbol: 'TEST', name: 'Synthetic only', contracts: ['TESTUSDT'],
  priceUsd: 10, oiUsd: 1050, oiQuantity: 105, marketCapUsd: 8240, fdvUsd: 10_300,
  oiToFdv: null, oiToMarketCap: null, circulatingSupply: 800, maxSupply: 1000,
  updatedAt: now, oiUpdatedAt: now, priceUpdatedAt: now, supplyUpdatedAt: now,
  complete: true, alertEligible: true, issues: [], supplySource: null, mappingStatus: 'verified',
  evidence: { contracts: [], supply: null, mapping: 'Synthetic only' } };
function rule(changes: Partial<ChangeRule> = {}): ChangeRule {
  return { ...DEFAULT_CHANGE_RULE, oi: { ...DEFAULT_CHANGE_RULE.oi }, fdv: { ...DEFAULT_CHANGE_RULE.fdv }, ...changes };
}
function condition(changes: Partial<ChangeCondition> = {}): ChangeCondition {
  return { ...DEFAULT_CHANGE_RULE.oi, ...changes };
}
function run(current: Partial<HistoryPoint> = {}, initial: Partial<HistoryPoint> = {}, options = rule()) {
  return analyzeChange(asset, point(now, { oiQuantity: 105, oiUsd: 1050, fdvUsd: 10_300, ...current }), point(start, initial), options, now);
}

describe('configurable change rule validation', () => {
  it('has the approved defaults and permits inclusive parameter boundaries', () => {
    expect(DEFAULT_CHANGE_RULE).toEqual({ windowMinutes: 5, oiBasis: 'quantity',
      oi: { enabled: true, direction: 'either', threshold: 5 }, fdv: { enabled: true, direction: 'either', threshold: 3 }, combine: 'all' });
    expect(isChangeRule(rule())).toBe(true);
    expect(isChangeRule(rule({ windowMinutes: 1, oi: condition({ threshold: 0 }) }))).toBe(true);
    expect(isChangeRule(rule({ windowMinutes: 10_080, oi: condition({ threshold: 1_000_000 }), oiBasis: 'usd', combine: 'any' }))).toBe(true);
  });
  it.each([null, [], {}, { ...rule(), windowMinutes: 0 }, { ...rule(), windowMinutes: 10_081 },
    { ...rule(), windowMinutes: 1.5 }, { ...rule(), windowMinutes: Infinity }, { ...rule(), windowMinutes: '5' },
    { ...rule(), oiBasis: 'ratio' }, { ...rule(), combine: 'both' },
    { ...rule(), oi: condition({ threshold: NaN }) }, { ...rule(), oi: condition({ threshold: -1 }) },
    { ...rule(), oi: condition({ threshold: Infinity }) }, { ...rule(), oi: condition({ threshold: 1_000_001 }) },
    { ...rule(), oi: { enabled: 1, direction: 'up', threshold: 5 } },
    { ...rule(), oi: { enabled: true, direction: 'positive', threshold: 5 } },
    { ...rule(), oi: { enabled: true, direction: 'up', threshold: '5' } },
    { ...rule(), oi: condition({ enabled: false }), fdv: condition({ enabled: false }) },
  ])('rejects malformed or unsafe configuration %#', value => expect(isChangeRule(value)).toBe(false));
});

describe('as-of baseline selection', () => {
  it('selects the nearest known pre-target endpoint for each asset without mutating input', () => {
    const oldest = point(start - 40_000);
    const nearest = point(start - 1000);
    const other = point(start, { assetId: 'other' });
    const points = [nearest, oldest, other, point(start + 1)];
    expect(selectChangeBaselines(points, start)).toEqual([nearest, other]);
    expect(points).toEqual([nearest, oldest, other, point(start + 1)]);
  });
  it('includes the 45-second boundary but never uses a later or already missing metric as an excuse to shift the window', () => {
    expect(BASELINE_TOLERANCE_MS).toBe(45_000);
    expect(selectChangeBaselines([point(start - 45_000)], start)).toHaveLength(1);
    expect(selectChangeBaselines([point(start - 45_001), point(start + 1)], start)).toEqual([]);
    const invalid = point(start, { oiQuantity: null, fdvUsd: null, complete: false });
    expect(selectChangeBaselines([point(start - 30_000), invalid], start)).toEqual([invalid]);
  });
  it('requires actual availability, excludes lookahead, and does not reconstruct legacy minute labels', () => {
    const { availableAt: _availability, ...legacy } = point(start);
    expect(selectChangeBaselines([legacy, point(start, { availableAt: start + 1 }), point(start, { availableAt: start - 1 })], start)).toEqual([]);
    expect(selectChangeBaselines([point(start, { availableAt: NaN }), point(NaN), point(Infinity)], start)).toEqual([]);
    expect(selectChangeBaselines([point(start)], NaN)).toEqual([]);
  });
  it('prefers the earliest known observation for duplicate endpoint times', () => {
    const first = point(start - 10_000, { availableAt: start - 9000, oiQuantity: 100 });
    const revision = point(start - 10_000, { availableAt: start - 8000, oiQuantity: 999 });
    expect(selectChangeBaselines([revision, first], start)).toEqual([first]);
  });
});

describe('independent OI and FDV endpoint changes', () => {
  it('measures independent exact percentage changes and not OI/FDV ratio', () => {
    expect(run()).toMatchObject({ oiPct: 5, fdvPct: 3, oiMatched: true, fdvMatched: true,
      status: 'hit', matched: true, evaluable: true, startAt: start, endAt: now });
    expect(run().reason).toContain('仅比较区间端点');
    const references = run();
    expect(references.baseline?.fdvUsd).toBe(10_000);
    expect(references.latest.fdvUsd).toBe(10_300);
  });
  it('offers native quantity and USD notional without treating a price-only move as more quantity', () => {
    const sameQuantity = { oiQuantity: 100, oiUsd: 1050 };
    expect(run(sameQuantity)).toMatchObject({ oiPct: 0, oiMatched: false, fdvPct: 3, status: 'below' });
    expect(run(sameQuantity, {}, rule({ oiBasis: 'usd' }))).toMatchObject({ oiPct: 5, oiMatched: true, status: 'hit' });
  });
  it.each([
    ['up', 105, true], ['up', 95, false], ['down', 95, true], ['down', 105, false],
    ['either', 95, true], ['either', 105, true], ['either', 104.999, false],
  ] as const)('applies %s to quantity %s with inclusive sign-aware thresholds', (direction, quantity, matched) => {
    expect(run({ oiQuantity: quantity }, {}, rule({ oi: condition({ direction }) })).oiMatched).toBe(matched);
  });
  it('uses exact decimal comparisons before display rounding', () => {
    expect(run({ oiQuantity: 0.315 }, { oiQuantity: 0.3 }).oiPct).toBe(5);
    expect(run({ oiQuantity: 0.315 }, { oiQuantity: 0.3 }).oiMatched).toBe(true);
    expect(run({ oiQuantity: 0.31499999999999 }, { oiQuantity: 0.3 }).oiMatched).toBe(false);
    expect(run({ oiQuantity: 0.285 }, { oiQuantity: 0.3 }, rule({ oi: condition({ direction: 'down' }) })).oiPct).toBe(-5);
    expect(run({ oiQuantity: 0.285 }, { oiQuantity: 0.3 }, rule({ oi: condition({ direction: 'down' }) })).oiMatched).toBe(true);
  });
  it('allows a real zero final value but never divides by a zero initial value', () => {
    expect(run({ oiQuantity: 0, fdvUsd: 0 })).toMatchObject({ oiPct: -100, fdvPct: -100, status: 'hit' });
    expect(run({}, { oiQuantity: 0 })).toMatchObject({ oiPct: null, oiMatched: null, fdvPct: 3, status: 'unavailable' });
    expect(run({}, { fdvUsd: 0 })).toMatchObject({ oiPct: 5, fdvPct: null, fdvMatched: null, status: 'unavailable' });
  });
  it.each([null, NaN, Infinity, -1])('preserves the independent metric when a current value is invalid: %s', value => {
    expect(run({ oiQuantity: value })).toMatchObject({ oiPct: null, oiMatched: null, fdvPct: 3, fdvMatched: true });
    expect(run({ fdvUsd: value })).toMatchObject({ oiPct: 5, oiMatched: true, fdvPct: null, fdvMatched: null });
    expect(run({}, { oiQuantity: value })).toMatchObject({ oiPct: null, fdvPct: 3 });
    expect(run({}, { fdvUsd: value })).toMatchObject({ oiPct: 5, fdvPct: null });
  });
  it('does not rebuild FDV from the present asset price or supply', () => {
    const row = { ...asset, fdvUsd: 99_999, maxSupply: 99_999, priceUsd: 99_999 };
    expect(analyzeChange(row, point(now, { fdvUsd: null }), point(start), rule(), now).fdvPct).toBeNull();
    expect(analyzeChange(row, point(now, { fdvUsd: 10_300 }), point(start), rule(), now).fdvPct).toBe(3);
  });
  it('does not coerce numeric overflow into a threshold hit', () => {
    expect(run({ oiQuantity: Number.MAX_VALUE }, { oiQuantity: Number.MIN_VALUE }).oiMatched).toBeNull();
  });
});

describe('time, identity and composition guards', () => {
  it('requires a known pre-target baseline and tolerates at most 45 seconds of endpoint offset', () => {
    expect(analyzeChange(asset, point(now), null, rule(), now)).toMatchObject({ status: 'unavailable', startAt: null });
    expect(analyzeChange(asset, point(now), point(start + 1), rule(), now).status).toBe('unavailable');
    expect(analyzeChange(asset, point(now), point(start - 45_000), rule(), now).status).toBe('below');
    expect(analyzeChange(asset, point(now), point(start - 45_001), rule(), now).status).toBe('unavailable');
    expect(run({}, { availableAt: start + 1 }).status).toBe('unavailable');
  });
  it.each([
    { timestamp: now + 1 }, { availableAt: now + 1 }, { availableAt: undefined },
    { timestamp: NaN }, { availableAt: Infinity }, { availableAt: now - 1 }, { assetId: 'other' },
  ])('rejects invalid latest time or identity %#', change => {
    expect(run(change)).toMatchObject({ oiPct: null, fdvPct: null, status: 'unavailable' });
  });
  it('rejects wrong baseline identity, invalid now and unknown baseline availability', () => {
    expect(run({}, { assetId: 'other' }).status).toBe('unavailable');
    expect(run({}, { availableAt: undefined }).status).toBe('unavailable');
    expect(analyzeChange(asset, point(now), point(start), rule(), NaN).status).toBe('unavailable');
  });
  it('accepts the inclusive 90-second freshness boundary and rejects stale data, not just stale fetches', () => {
    const old = point(now - 90_000, { oiSourceTime: now - 90_000, priceSourceTime: now - 90_000 });
    expect(analyzeChange(asset, old, point(start - 90_000), rule(), now).status).toBe('below');
    expect(analyzeChange(asset, old, point(start - 90_000), rule(), now + 1).status).toBe('unavailable');
    expect(run({ oiSourceTime: now - 90_000 }).oiPct).toBe(5);
    expect(run({ oiSourceTime: now - 90_001 })).toMatchObject({ oiPct: null, fdvPct: 3 });
    expect(run({}, { oiSourceTime: start - 90_001 })).toMatchObject({ oiPct: null, fdvPct: 3 });
  });
  it.each([null, NaN, now + 1])('rejects missing or future OI source time without hiding valid FDV: %s', source => {
    expect(run({ oiSourceTime: source })).toMatchObject({ oiPct: null, fdvPct: 3 });
  });
  it('validates price source time independently for FDV and USD OI but not native OI', () => {
    expect(run({ priceSourceTime: now + 1 })).toMatchObject({ oiPct: 5, fdvPct: null });
    expect(run({ priceSourceTime: now - 90_001 })).toMatchObject({ oiPct: 5, fdvPct: null });
    expect(run({ priceSourceTime: null }, {}, rule({ oiBasis: 'usd' }))).toMatchObject({ oiPct: null, fdvPct: null });
    expect(run({}, { priceSourceTime: start + 1 })).toMatchObject({ oiPct: 5, fdvPct: null });
  });
  it.each([
    { complete: false }, { contractSetKey: undefined }, { contractSetKey: '' }, { contractSetKey: ' ' },
    { contractSetKey: 'TESTUSDT:1000' }, { sourceSkewMs: null }, { sourceSkewMs: -1 },
    { sourceSkewMs: NaN }, { sourceSkewMs: 30_001 },
  ] as Partial<HistoryPoint>[])('guards incomplete or changed OI composition and bad source skew %#', change => {
    expect(run(change)).toMatchObject({ oiPct: null, fdvPct: 3 });
    expect(run({}, change)).toMatchObject({ oiPct: null, fdvPct: 3 });
  });
  it('accepts exactly 30 seconds skew and does not require intervening continuous samples', () => {
    expect(run({ sourceSkewMs: 30_000 }, { sourceSkewMs: 30_000 })).toMatchObject({ oiPct: 5, status: 'hit' });
    expect(run({ samplingIntervalMs: 60_000 }, { samplingIntervalMs: 60_000 }).status).toBe('hit');
  });
});

describe('three-valued condition composition', () => {
  it.each([
    ['all', 105, null, 'unavailable', false], ['any', 105, null, 'hit', true],
    ['all', 101, null, 'below', true], ['any', 101, null, 'unavailable', false],
    ['all', null, null, 'unavailable', false], ['any', null, null, 'unavailable', false],
    ['all', 101, 10_100, 'below', true], ['any', 101, 10_100, 'below', true],
    ['all', 105, 10_300, 'hit', true], ['any', 105, 10_300, 'hit', true],
  ] as const)('%s mode evaluates OI=%s FDV=%s as %s', (combine, oiQuantity, fdvUsd, status, evaluable) => {
    expect(run({ oiQuantity, fdvUsd }, {}, rule({ combine }))).toMatchObject({ status, evaluable, matched: status === 'hit' });
  });
  it('retains the unavailable metric reason even when the whole rule has a known outcome', () => {
    const hit = run({ fdvUsd: null }, {}, rule({ combine: 'any' }));
    expect(hit.reason).toContain('FDV：端点数值缺失或无效');
    expect(hit.fdvMatched).toBeNull();
    const below = run({ oiQuantity: 101, fdvUsd: null });
    expect(below.status).toBe('below');
    expect(below.reason).toContain('FDV：端点数值缺失或无效');
  });
  it.each(['all', 'any'] as const)('ignores disabled conditions in %s mode without hiding displayable changes', combine => {
    const oiOnly = rule({ combine, fdv: condition({ enabled: false }) });
    expect(run({ fdvUsd: null }, {}, oiOnly)).toMatchObject({ oiPct: 5, fdvPct: null, fdvMatched: null, status: 'hit' });
    expect(run({}, {}, oiOnly)).toMatchObject({ fdvPct: 3, fdvMatched: null, status: 'hit' });
    const fdvOnly = rule({ combine, oi: condition({ enabled: false }) });
    expect(run({ oiQuantity: null }, {}, fdvOnly)).toMatchObject({ oiPct: null, oiMatched: null, fdvPct: 3, status: 'hit' });
  });
  it('allows a zero threshold inclusively and still treats missing values as unknown', () => {
    expect(run({ oiQuantity: 100 }, {}, rule({ oi: condition({ threshold: 0 }) }))).toMatchObject({ oiPct: 0, oiMatched: true });
    expect(run({ oiQuantity: null }, {}, rule({ oi: condition({ threshold: 0 }) })).oiMatched).toBeNull();
  });
});
