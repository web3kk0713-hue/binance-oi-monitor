// Synthetic observations verify metric semantics and guards, not predictive trading performance.
import { describe, expect, it } from 'vitest';
import { analyzePosition, POSITION_THRESHOLDS } from '../src/shared/positionContext';
import type { AssetRow, HistoryPoint } from '../src/shared/types';

const now = Date.UTC(2026, 8, 24, 12);
const start = now - 5 * 60_000;
function point(timestamp: number, changes: Partial<HistoryPoint> = {}): HistoryPoint {
  return { assetId: 'test', timestamp, availableAt: timestamp, oiUsd: 1000, oiQuantity: 100,
    marketCapUsd: 8000, fdvUsd: 10_000, oiToFdv: 10, oiToMarketCap: 12.5, priceUsd: 10,
    complete: true, oiSourceTime: timestamp - 1000, priceSourceTime: timestamp - 1000,
    sourceSkewMs: 0, samplingIntervalMs: 30_000, contractSetKey: 'TESTUSDT:1', ...changes };
}
const asset: AssetRow = { id: 'test', symbol: 'TEST', name: 'Synthetic only', contracts: ['TESTUSDT'],
  priceUsd: 10, oiUsd: 1050, oiQuantity: 105, marketCapUsd: 8000, fdvUsd: 10_000,
  oiToFdv: 10.5, oiToMarketCap: null, circulatingSupply: 800, maxSupply: 1000,
  updatedAt: now, oiUpdatedAt: now, priceUpdatedAt: now, supplyUpdatedAt: now,
  complete: true, alertEligible: true, issues: [], supplySource: null, mappingStatus: 'verified',
  evidence: { contracts: [], supply: null, mapping: 'Synthetic only' } };
function run(current: Partial<HistoryPoint> = {}, initial: Partial<HistoryPoint> = {}) {
  return analyzePosition(asset, point(now, { oiQuantity: 105, oiUsd: 1050, ...current }), point(start, initial), 5, now);
}

describe('OI and price observational context', () => {
  it('uses an explicit 5% OI observation line and inclusive 0.5% price deadband', () => {
    expect(POSITION_THRESHOLDS).toEqual({ oiPct: 5, flatPricePct: 0.5 });
    expect(run()).toMatchObject({ assetId: 'test', symbol: 'TEST', windowMinutes: 5,
      startAt: start, endAt: now, oiQuantityPct: 5, oiUsdPct: 5, pricePct: 0, fdvPct: 0,
      pattern: 'build_flat', label: '增仓横盘', supplyChanged: false, issues: [] });
    expect(run().reason).toContain('不是多空指令');
    expect(run().reason).toContain('不代表资金净流入或实际杠杆');
    expect(run().reason).toContain('仅比较区间端点');
  });
  it.each([
    [105, 10.05, 'build_flat', '增仓横盘'], [105, 9.95, 'build_flat', '增仓横盘'],
    [105, 10.1, 'build_up', '增仓上涨'], [105, 9.9, 'build_down', '增仓下跌'],
    [95, 10.1, 'unwind_up', '减仓上涨'], [95, 9.9, 'unwind_down', '减仓下跌'],
    [95, 10.05, 'unwind_flat', '减仓横盘'], [95, 9.95, 'unwind_flat', '减仓横盘'],
    [104.9999, 12, 'quiet', '持仓变化未达观察线'], [95.0001, 9, 'quiet', '持仓变化未达观察线'],
  ] as const)('describes quantity %s and price %s without inferring position direction', (oiQuantity, priceUsd, pattern, label) => {
    expect(run({ oiQuantity, priceUsd })).toMatchObject({ pattern, label });
  });
  it('does not round either observation threshold before assigning the pattern', () => {
    expect(run({ oiQuantity: 0.315, priceUsd: 0.3015 }, { oiQuantity: 0.3, priceUsd: 0.3 }).pattern).toBe('build_flat');
    expect(run({ oiQuantity: 0.31499999999999 }, { oiQuantity: 0.3 }).pattern).toBe('quiet');
    expect(run({ oiQuantity: 0.285 }, { oiQuantity: 0.3 }).pattern).toBe('unwind_flat');
    expect(run({ priceUsd: 10.050000000001 }).pattern).toBe('build_up');
    expect(run({ priceUsd: 9.949999999999 }).pattern).toBe('build_down');
  });
  it('does not call a price-only increase more OI quantity or independent FDV momentum', () => {
    const result = run({ oiQuantity: 100, oiUsd: 1100, priceUsd: 11, fdvUsd: 11_000 });
    expect(result).toMatchObject({ oiQuantityPct: 0, oiUsdPct: 10, pricePct: 10, fdvPct: 10,
      oiToFdvPct: 10, oiToFdvChangePct: 0, oiToFdvDeltaPp: 0, pattern: 'quiet', supplyChanged: false });
  });
  it('keeps price and OI context when FDV or max supply is unavailable', () => {
    const result = run({ fdvUsd: null, priceUsd: 10.1 }, { fdvUsd: null });
    expect(result).toMatchObject({ oiQuantityPct: 5, oiUsdPct: 5, pricePct: 1, fdvPct: null,
      oiToFdvPct: null, oiToFdvChangePct: null, oiToFdvDeltaPp: null, pattern: 'build_up', supplyChanged: false });
    expect(result.issues.some(issue => issue.startsWith('FDV：'))).toBe(true);
  });
  it('does not manufacture missing history from current asset values or cached ratio fields', () => {
    const result = run({ oiToFdv: 9999, priceUsd: null, fdvUsd: null });
    expect(result).toMatchObject({ pricePct: null, fdvPct: null, oiToFdvPct: null, pattern: 'unavailable' });
    expect(run({ oiToFdv: 9999 }, { oiToFdv: 8888 }).oiToFdvPct).toBe(10.5);
  });
});

describe('ratio levels, relative changes and percentage points', () => {
  it('reports USD OI +15% and FDV +5% as ratio +9.5238%, not 3x cash inflow', () => {
    const result = run({ oiUsd: 1150, priceUsd: 10.5, fdvUsd: 10_500 });
    expect(result).toMatchObject({ oiUsdPct: 15, fdvPct: 5, supplyChanged: false });
    expect(result.oiToFdvPct).toBeCloseTo(10.95238095238, 10);
    expect(result.oiToFdvChangePct).toBeCloseTo(9.52380952381, 10);
    expect(result.oiToFdvDeltaPp).toBeCloseTo(0.95238095238, 10);
    expect(result.oiToFdvChangePct).not.toBe(3);
  });
  it('keeps the relative and percentage-point signs when OI/FDV decreases', () => {
    const result = run({ oiQuantity: 95, oiUsd: 950, priceUsd: 10.5, fdvUsd: 10_500 });
    expect(result.oiToFdvPct).toBeCloseTo(9.04761904762, 10);
    expect(result.oiToFdvChangePct).toBeCloseTo(-9.52380952381, 10);
    expect(result.oiToFdvDeltaPp).toBeCloseTo(-0.95238095238, 10);
  });
  it('can display a valid current ratio during baseline warmup without inventing changes', () => {
    const result = analyzePosition(asset, point(now, { oiUsd: 1050 }), null, 5, now);
    expect(result).toMatchObject({ oiToFdvPct: 10.5, oiToFdvChangePct: null, oiToFdvDeltaPp: null,
      oiQuantityPct: null, pricePct: null, pattern: 'unavailable', startAt: null });
    expect(result.reason).toContain('窗口起点');
  });
  it('allows a real final zero OI but never divides by zero initial OI or zero FDV', () => {
    expect(run({ oiQuantity: 0, oiUsd: 0 })).toMatchObject({ oiQuantityPct: -100, oiUsdPct: -100,
      oiToFdvPct: 0, oiToFdvChangePct: -100, oiToFdvDeltaPp: -10, pattern: 'unwind_flat' });
    expect(run({}, { oiQuantity: 0, oiUsd: 0 })).toMatchObject({ oiQuantityPct: null, oiUsdPct: null,
      oiToFdvPct: 10.5, oiToFdvChangePct: null, oiToFdvDeltaPp: 10.5, pattern: 'unavailable' });
    expect(run({ fdvUsd: 0 })).toMatchObject({ fdvPct: -100, oiToFdvPct: null,
      oiToFdvChangePct: null, oiToFdvDeltaPp: null, pattern: 'build_flat' });
    expect(run({}, { fdvUsd: 0 })).toMatchObject({ fdvPct: null, oiToFdvPct: 10.5,
      oiToFdvChangePct: null, oiToFdvDeltaPp: null });
  });
  it.each([null, NaN, Infinity, -1])('rejects invalid price without suppressing valid native OI: %s', priceUsd => {
    expect(run({ priceUsd })).toMatchObject({ oiQuantityPct: 5, pricePct: null, pattern: 'unavailable', oiToFdvPct: null });
  });
  it.each([null, NaN, Infinity, -1])('rejects invalid FDV without suppressing valid price: %s', fdvUsd => {
    expect(run({ fdvUsd })).toMatchObject({ oiQuantityPct: 5, pricePct: 0, fdvPct: null,
      oiToFdvPct: null, oiToFdvChangePct: null, pattern: 'build_flat' });
  });
  it.each([null, NaN, Infinity, -1])('rejects invalid OI values independently: %s', oi => {
    expect(run({ oiQuantity: oi })).toMatchObject({ oiQuantityPct: null, oiUsdPct: 5, pattern: 'unavailable' });
    expect(run({ oiUsd: oi })).toMatchObject({ oiQuantityPct: 5, oiUsdPct: null, oiToFdvPct: null, pattern: 'build_flat' });
  });
  it('treats missing or zero price denominators and overflowing ratios as unavailable', () => {
    expect(run({}, { priceUsd: 0 })).toMatchObject({ pricePct: null, oiToFdvChangePct: null, pattern: 'unavailable' });
    expect(run({ priceUsd: 0 })).toMatchObject({ pricePct: -100, oiToFdvPct: null, supplyChanged: false });
    expect(run({ oiUsd: Number.MAX_VALUE, fdvUsd: Number.MIN_VALUE })).toMatchObject({ oiToFdvPct: null, oiToFdvChangePct: null });
    expect(run({ oiQuantity: Number.MAX_VALUE }, { oiQuantity: Number.MIN_VALUE })).toMatchObject({ oiQuantityPct: null, pattern: 'unavailable' });
  });
});

describe('shared time, completeness and composition guards', () => {
  it.each([
    { timestamp: now + 1 }, { availableAt: now + 1 }, { availableAt: undefined },
    { timestamp: NaN }, { availableAt: Infinity }, { availableAt: now - 1 }, { assetId: 'other' },
  ] as Partial<HistoryPoint>[])('does not show current or changing values from invalid latest endpoint %#', changes => {
    expect(run(changes)).toMatchObject({ oiQuantityPct: null, oiUsdPct: null, pricePct: null,
      fdvPct: null, oiToFdvPct: null, oiToFdvChangePct: null, pattern: 'unavailable' });
  });
  it('requires a valid same-asset pre-window baseline and never shifts or interpolates it', () => {
    expect(run({}, { assetId: 'other' })).toMatchObject({ oiToFdvPct: 10.5, oiToFdvChangePct: null, oiQuantityPct: null });
    expect(run({}, { availableAt: undefined }).pattern).toBe('unavailable');
    expect(run({}, { availableAt: start + 1 }).pattern).toBe('unavailable');
    expect(run({}, { timestamp: start + 1, availableAt: start + 1 }).pattern).toBe('unavailable');
    expect(analyzePosition(asset, point(now, { oiQuantity: 105 }), point(start - 45_000), 5, now).pattern).toBe('build_flat');
    expect(analyzePosition(asset, point(now), point(start - 45_001), 5, now).pattern).toBe('unavailable');
  });
  it.each([0, 1.5, 10_081, NaN, Infinity])('rejects invalid observation windows: %s', window => {
    expect(analyzePosition(asset, point(now), point(start), window, now)).toMatchObject({ pattern: 'unavailable', oiToFdvPct: null });
  });
  it('rejects invalid now, old samples and old sources even when fetch timestamps are recent', () => {
    expect(analyzePosition(asset, point(now), point(start), 5, NaN).oiToFdvPct).toBeNull();
    const old = point(now - 90_000, { oiSourceTime: now - 90_000, priceSourceTime: now - 90_000 });
    expect(analyzePosition(asset, old, point(start - 90_000), 5, now).pattern).toBe('quiet');
    expect(analyzePosition(asset, old, point(start - 90_000), 5, now + 1)).toMatchObject({ pattern: 'unavailable', oiToFdvPct: null });
    expect(run({ oiSourceTime: now - 90_001 })).toMatchObject({ oiQuantityPct: null, pricePct: 0, oiToFdvPct: null });
    expect(run({}, { oiSourceTime: start - 90_001 })).toMatchObject({ oiQuantityPct: null, pricePct: 0, oiToFdvChangePct: null });
  });
  it.each([null, NaN, now + 1])('rejects unknown or future OI sources: %s', oiSourceTime => {
    expect(run({ oiSourceTime })).toMatchObject({ oiQuantityPct: null, oiUsdPct: null, pricePct: 0, oiToFdvPct: null });
  });
  it.each([null, NaN, now + 1, now - 90_001])('rejects unknown, future or stale price sources independently: %s', priceSourceTime => {
    expect(run({ priceSourceTime })).toMatchObject({ oiQuantityPct: 5, oiUsdPct: null, pricePct: null,
      fdvPct: null, oiToFdvPct: null, pattern: 'unavailable' });
  });
  it.each([
    { complete: false }, { contractSetKey: undefined }, { contractSetKey: '' }, { contractSetKey: ' ' },
    { contractSetKey: 'TESTUSDT:1000' }, { sourceSkewMs: null }, { sourceSkewMs: -1 },
    { sourceSkewMs: NaN }, { sourceSkewMs: 30_001 },
  ] as Partial<HistoryPoint>[])('refuses OI comparison with incomplete or different contracts/skew %#', changes => {
    expect(run(changes)).toMatchObject({ oiQuantityPct: null, oiUsdPct: null, pricePct: 0, oiToFdvChangePct: null, pattern: 'unavailable' });
    expect(run({}, changes)).toMatchObject({ oiQuantityPct: null, oiUsdPct: null, pricePct: 0, oiToFdvChangePct: null, pattern: 'unavailable' });
  });
  it('accepts known 30-second skew but independently checks aggregate source alignment for ratios and linkage', () => {
    expect(run({ sourceSkewMs: 30_000 }, { sourceSkewMs: 30_000 })).toMatchObject({ oiQuantityPct: 5, oiToFdvPct: 10.5, oiToFdvChangePct: 5 });
    expect(run({ oiSourceTime: now - 31_000 })).toMatchObject({ oiToFdvPct: 10.5, pattern: 'build_flat' });
    expect(run({ oiSourceTime: now - 31_001 })).toMatchObject({ oiToFdvPct: null, oiToFdvChangePct: null,
      oiQuantityPct: 5, pricePct: 0, pattern: 'unavailable' });
    expect(run({}, { oiSourceTime: start - 31_001 })).toMatchObject({ oiToFdvPct: 10.5, oiToFdvChangePct: null,
      oiQuantityPct: 5, pricePct: 0, pattern: 'unavailable' });
    expect(run({ oiSourceTime: now - 31_001 }).reason).toContain('最新OI 与价格源时间偏差');
    expect(run({}, { oiSourceTime: start - 31_001 }).reason).toContain('起点OI 与价格源时间偏差');
  });
});

describe('supply revision awareness', () => {
  it('recognizes price-driven FDV changes without falsely calling fixed supply a revision', () => {
    expect(run({ priceUsd: 10.4, fdvUsd: 10_400 }).supplyChanged).toBe(false);
    expect(run({ priceUsd: 9.5, fdvUsd: 9500 }).supplyChanged).toBe(false);
  });
  it('flags positive and negative supply changes but keeps the raw FDV observation', () => {
    const increase = run({ priceUsd: 10, fdvUsd: 10_100 });
    expect(increase).toMatchObject({ pricePct: 0, fdvPct: 1, supplyChanged: true, pattern: 'build_flat' });
    expect(increase.issues.some(issue => issue.includes('供给修订'))).toBe(true);
    expect(increase.reason).toContain('隐含供应量有修订');
    expect(run({ priceUsd: 10, fdvUsd: 9900 })).toMatchObject({ fdvPct: -1, supplyChanged: true });
  });
  it('uses a strictly greater than 0.01% exact supply revision boundary', () => {
    expect(run({ fdvUsd: 10_001 }).supplyChanged).toBe(false);
    expect(run({ fdvUsd: 9999 }).supplyChanged).toBe(false);
    expect(run({ fdvUsd: 10_001.0000001 }).supplyChanged).toBe(true);
    expect(run({ fdvUsd: 9998.9999999 }).supplyChanged).toBe(true);
  });
  it('does not infer a supply revision from unavailable or untrusted endpoints', () => {
    expect(run({ fdvUsd: null }).supplyChanged).toBe(false);
    expect(run({ priceSourceTime: now + 1, fdvUsd: 20_000 }).supplyChanged).toBe(false);
    expect(run({}, { priceUsd: null }).supplyChanged).toBe(false);
    expect(run({ priceUsd: 0 }).supplyChanged).toBe(false);
  });
});
