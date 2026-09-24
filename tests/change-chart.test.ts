// Synthetic observations test chart semantics, never exchange coverage or trading performance.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { analyzeChange, DEFAULT_CHANGE_RULE, type ChangeRule } from '../src/shared/changeMonitor';
import type { AssetRow, HistoryPoint } from '../src/shared/types';
import ChangeChart, { prepareChangeChart, preparePositionChart } from '../src/web/ChangeChart';

const end = Date.UTC(2026, 8, 23, 12), start = end - 300_000;
const asset: AssetRow = { id: 'test', symbol: 'TEST', name: 'Synthetic only', contracts: ['TESTUSDT'],
  priceUsd: 10, oiUsd: 1000, oiQuantity: 100, fdvUsd: 10_000, marketCapUsd: null,
  oiToFdv: null, oiToMarketCap: null, circulatingSupply: null, maxSupply: 1000,
  updatedAt: end, oiUpdatedAt: end, priceUpdatedAt: end, supplyUpdatedAt: end,
  complete: true, alertEligible: true, issues: [], supplySource: null, mappingStatus: 'verified',
  evidence: { contracts: [], supply: null, mapping: 'Synthetic only' } };
function point(at: number, changes: Partial<HistoryPoint> = {}): HistoryPoint {
  return { assetId: asset.id, timestamp: at, availableAt: at, oiUsd: 1000, oiQuantity: 100,
    fdvUsd: 10_000, marketCapUsd: null, oiToFdv: null, oiToMarketCap: null, complete: true,
    oiSourceTime: at - 1000, priceSourceTime: at - 1000, sourceSkewMs: 0,
    samplingIntervalMs: 30_000, contractSetKey: 'TESTUSDT:1', ...changes };
}
function chart(points: HistoryPoint[] = [], initial = point(start), latest = point(end, { oiQuantity: 105, oiUsd: 1100, fdvUsd: 10_300 }), rule: ChangeRule = DEFAULT_CHANGE_RULE) {
  const result = analyzeChange(asset, latest, initial, rule, end);
  return { result, values: prepareChangeChart(points, result, rule) };
}

describe('OI / FDV chart endpoint consistency', () => {
  it('uses quantity and FDV from the exact same baseline and matches the monitor endpoints', () => {
    const { result, values } = chart();
    expect(values[0]).toEqual({ at: start, oi: 0, fdv: 0 });
    expect(values.at(-1)?.oi).toBeCloseTo(result.oiPct!);
    expect(values.at(-1)?.fdv).toBeCloseTo(result.fdvPct!);
    expect(values.at(-1)?.oi).toBeCloseTo(5);
  });

  it('switches USD OI without changing the FDV baseline', () => {
    const { result, values } = chart([], undefined, undefined, { ...DEFAULT_CHANGE_RULE, oiBasis: 'usd' });
    expect(result.oiPct).toBe(10);
    expect(values.at(-1)?.oi).toBeCloseTo(10);
    expect(values.at(-1)?.fdv).toBeCloseTo(3);
  });

  it('does not show old-asset, pre-baseline, future or unknown-availability points', () => {
    const at = start + 60_000;
    const values = chart([point(at, { assetId: 'other' }), point(start - 1), point(end + 1),
      point(at + 1, { availableAt: undefined }), point(at + 2, { availableAt: end + 1 })]).values;
    expect(values.filter(value => value.oi !== null).map(value => value.at)).toEqual([start, end]);
  });

  it('does not resurrect a missing baseline from unrelated history', () => {
    const latest = point(end), result = analyzeChange(asset, latest, null, DEFAULT_CHANGE_RULE, end);
    expect(prepareChangeChart([point(start), point(start + 30_000)], result, DEFAULT_CHANGE_RULE)).toEqual([]);
  });

  it('breaks a missing-observation gap without changing genuine zero values', () => {
    const at = start + 90_000;
    const values = chart([point(at, { oiQuantity: 0, fdvUsd: 0 })]).values;
    expect(values.find(value => value.at === start + 30_000)).toEqual({ at: start + 30_000, oi: null, fdv: null });
    expect(values.find(value => value.at === at)).toEqual({ at, oi: -100, fdv: -100 });
  });

  it('preserves each independent metric when the other baseline is zero or missing', () => {
    expect(chart([], point(start, { oiQuantity: 0 })).values.at(-1)?.oi).toBeNull();
    expect(chart([], point(start, { oiQuantity: 0 })).values.at(-1)?.fdv).toBeCloseTo(3);
    expect(chart([], point(start, { fdvUsd: null })).values.at(-1)?.fdv).toBeNull();
    expect(chart([], point(start, { fdvUsd: null })).values.at(-1)?.oi).toBeCloseTo(5);
  });

  it('breaks OI on contract-composition changes while retaining a known independent FDV', () => {
    const at = start + 30_000;
    const values = chart([point(at, { contractSetKey: 'TESTUSDT:1000', fdvUsd: 10_100 })]).values;
    expect(values.find(value => value.at === at)?.oi).toBeNull();
    expect(values.find(value => value.at === at)?.fdv).toBeCloseTo(1);
  });

  it('does not let incomplete OI hide a frozen, valid FDV endpoint', () => {
    const { result, values } = chart([], undefined, point(end, { complete: false, oiQuantity: 105, fdvUsd: 10_300 }));
    expect(result).toMatchObject({ oiPct: null, fdvPct: 3 });
    expect(values.at(-1)?.oi).toBeNull();
    expect(values.at(-1)?.fdv).toBeCloseTo(result.fdvPct!);
  });

  it('rejects a source time after its actual observation, even if it precedes later availability', () => {
    const at = start + 30_000;
    const values = chart([point(at, { oiSourceTime: at + 1, priceSourceTime: at + 1, availableAt: at + 1000 })]).values;
    expect(values.find(value => value.at === at)).toEqual({ at, oi: null, fdv: null });
  });

  it('does not turn a post-target baseline rejected by the monitor into a valid curve', () => {
    const { result, values } = chart([], point(start + 1));
    expect(result).toMatchObject({ oiPct: null, fdvPct: null, status: 'unavailable' });
    expect(values.some(value => value.oi !== null || value.fdv !== null)).toBe(false);
  });

  it('never returns NaN or Infinity to the plotting domain', () => {
    const values = chart([], point(start, { oiQuantity: Number.MIN_VALUE }), point(end, { oiQuantity: Number.MAX_VALUE })).values;
    expect(values.every(value => value.oi === null || Number.isFinite(value.oi))).toBe(true);
    expect(values.at(-1)?.oi).toBeNull();
  });
});

function positionChart(points: HistoryPoint[] = [], initial = point(start, { priceUsd: 10 }),
  latest = point(end, { oiQuantity: 110, oiUsd: 1150, fdvUsd: 10_500, priceUsd: 10.5 }), rule: ChangeRule = DEFAULT_CHANGE_RULE) {
  const result = analyzeChange(asset, latest, initial, rule, end);
  return { result, values: preparePositionChart(points, result, rule) };
}

describe('price and OI/FDV level-relative historical curves', () => {
  it('compares all four series with the exact same baseline, not a division of percentage changes', () => {
    const { values } = positionChart();
    expect(values[0]).toEqual({ at: start, oi: 0, fdv: 0, price: 0, ratio: 0 });
    expect(values.at(-1)).toMatchObject({ at: end, oi: 10, fdv: 5, price: 5 });
    expect(values.at(-1)?.ratio).toBeCloseTo(9.5238095238, 8);
    expect(values.at(-1)?.ratio).not.toBe(3);
  });

  it('keeps the ratio derived from USD OI even when the displayed OI basis is quantity', () => {
    const quantity = positionChart().values.at(-1)!;
    const usd = positionChart([], undefined, undefined, { ...DEFAULT_CHANGE_RULE, oiBasis: 'usd' }).values.at(-1)!;
    expect(quantity.oi).toBe(10);
    expect(usd.oi).toBe(15);
    expect(usd.ratio).toBe(quantity.ratio);
    expect(usd.price).toBe(quantity.price);
    expect(usd.fdv).toBe(quantity.fdv);
  });

  it('supports real interior observations without treating each one as another five-minute window', () => {
    const at = start + 60_000;
    const values = positionChart([point(at, { priceUsd: 10.2, oiUsd: 1122, fdvUsd: 10_200 })]).values;
    expect(values.find(value => value.at === at)).toMatchObject({ oi: 0, fdv: 2, price: 2 });
    expect(values.find(value => value.at === at)?.ratio).toBeCloseTo(10);
  });

  it('preserves a separately valid price when FDV is missing at either endpoint', () => {
    expect(positionChart([], point(start, { priceUsd: 10, fdvUsd: null })).values.at(-1))
      .toMatchObject({ oi: 10, fdv: null, price: 5, ratio: null });
    expect(positionChart([], undefined, point(end, { priceUsd: 10.5, fdvUsd: null })).values.at(-1))
      .toMatchObject({ oi: 0, fdv: null, price: 5, ratio: null });
  });

  it('preserves zero and negative relative changes without inventing a zero-denominator result', () => {
    expect(positionChart([], undefined, point(end, { oiQuantity: 0, oiUsd: 0, priceUsd: 10, fdvUsd: 10_000 })).values.at(-1))
      .toEqual({ at: end, oi: -100, fdv: 0, price: 0, ratio: -100 });
    expect(positionChart([], point(start, { oiUsd: 0, priceUsd: 10 })).values.at(-1))
      .toMatchObject({ oi: 10, fdv: 5, price: 5, ratio: null });
    expect(positionChart([], undefined, point(end, { priceUsd: 9, fdvUsd: 9000, oiUsd: 800 })).values.at(-1)?.ratio)
      .toBeCloseTo(-11.1111111111);
  });

  it.each([
    { complete: false }, { contractSetKey: undefined }, { contractSetKey: '' }, { contractSetKey: 'TESTUSDT:1000' },
    { sourceSkewMs: undefined }, { sourceSkewMs: NaN }, { sourceSkewMs: 30_001 },
  ])('suppresses ratio for incomplete or incomparable OI metadata %j while retaining price', changes => {
    const at = start + 30_000;
    expect(positionChart([point(at, { priceUsd: 10.2, ...changes })]).values.find(value => value.at === at))
      .toMatchObject({ oi: null, fdv: 0, price: 2, ratio: null });
  });

  it('checks actual OI-to-price source skew even when declared aggregate skew is zero', () => {
    const at = start + 60_000;
    const values = positionChart([point(at, { priceUsd: 10, oiSourceTime: at - 31_001, priceSourceTime: at - 1000 })]).values;
    expect(values.find(value => value.at === at)).toMatchObject({ oi: 0, price: 0, ratio: null });
    const boundary = positionChart([point(at, { priceUsd: 10, oiSourceTime: at - 31_000, priceSourceTime: at - 1000 })]).values;
    expect(boundary.find(value => value.at === at)?.ratio).toBe(0);
  });

  it.each([null, 0, -1, NaN, Infinity])('requires a positive finite FDV and price for the ratio: %s', value => {
    expect(positionChart([], undefined, point(end, { priceUsd: 10, fdvUsd: value })).values.at(-1)?.ratio).toBeNull();
    expect(positionChart([], undefined, point(end, { priceUsd: value as number })).values.at(-1)?.ratio).toBeNull();
  });

  it('does not substitute stored ratio fields for valid independently recomputed source levels', () => {
    expect(positionChart([], undefined, point(end, { priceUsd: 10.5, fdvUsd: 10_500, oiUsd: 1150, oiToFdv: 999 })).values.at(-1)?.ratio)
      .toBeCloseTo(9.5238095238, 8);
  });

  it('requires valid source freshness at actual availability for every point', () => {
    const at = start + 30_000;
    const values = positionChart([point(at, { availableAt: at + 1000, priceUsd: 10, oiSourceTime: at - 89_001 })]).values;
    expect(values.find(value => value.at === at)).toMatchObject({ oi: null, fdv: 0, price: 0, ratio: null });
    const expiredPrice = positionChart([point(at, { priceUsd: 10, priceSourceTime: at - 90_001 })]).values;
    expect(expiredPrice.find(value => value.at === at)).toMatchObject({ oi: 0, fdv: null, price: null, ratio: null });
  });

  it('retains valid observations at source freshness boundaries', () => {
    const at = start + 60_000;
    const values = positionChart([point(at, { priceUsd: 10, oiSourceTime: at - 90_000, priceSourceTime: at - 90_000 })]).values;
    expect(values.find(value => value.at === at)).toEqual({ at, oi: 0, fdv: 0, price: 0, ratio: 0 });
  });

  it('rejects future source timestamps even when an observation became available later', () => {
    const at = start + 30_000;
    const values = positionChart([point(at, { priceUsd: 10, availableAt: at + 1000, oiSourceTime: at + 1, priceSourceTime: at + 1 })]).values;
    expect(values.find(value => value.at === at)).toEqual({ at, oi: null, fdv: null, price: null, ratio: null });
  });

  it('breaks every curve over a missing-observation gap and preserves actual null rows', () => {
    const at = start + 90_000;
    const values = positionChart([point(at, { priceUsd: null, oiQuantity: null, fdvUsd: null, oiUsd: null })]).values;
    expect(values.find(value => value.at === start + 30_000)).toEqual({ at: start + 30_000, oi: null, fdv: null, price: null, ratio: null });
    expect(values.find(value => value.at === at)).toEqual({ at, oi: null, fdv: null, price: null, ratio: null });
  });

  it('rejects malformed, unavailable, wrong-asset and out-of-window observation metadata', () => {
    const at = start + 30_000;
    const values = positionChart([point(at, { availableAt: NaN }), point(at + 1, { availableAt: Infinity }),
      point(at + 2, { availableAt: undefined }), point(at + 3, { availableAt: at + 2 }),
      point(at + 4, { assetId: 'other' }), point(at + 5, { availableAt: end + 1 }),
      point(start - 1), point(end + 1), point(NaN)]).values;
    expect(values.filter(value => value.price !== null).map(value => value.at)).toEqual([start, end]);
    expect(values.every(value => Number.isFinite(value.at))).toBe(true);
  });

  it('does not resurrect missing, late or malformed baseline metadata', () => {
    const { result } = positionChart();
    expect(preparePositionChart([point(start, { priceUsd: 10 })], { ...result, baseline: null }, DEFAULT_CHANGE_RULE)).toEqual([]);
    for (const changes of [{ availableAt: NaN }, { availableAt: undefined }, { availableAt: start + 1 }, { timestamp: start + 1 }, { timestamp: start - 45_001 }]) {
      expect(positionChart([], point(start, { priceUsd: 10, ...changes })).values).toEqual([]);
    }
  });

  it('keeps historical chart observations available when the current endpoint is stale', () => {
    const initial = point(start, { priceUsd: 10 });
    const latest = point(end, { priceUsd: 10.5, fdvUsd: 10_500, oiUsd: 1150 });
    const result = analyzeChange(asset, latest, initial, DEFAULT_CHANGE_RULE, end + 90_001);
    expect(result.oiPct).toBeNull();
    const values = preparePositionChart([], result, DEFAULT_CHANGE_RULE);
    expect(values.at(-1)?.price).toBe(5);
    expect(values.at(-1)?.ratio).toBeCloseTo(9.5238095238, 8);
    const markup = renderToStaticMarkup(createElement(ChangeChart, { points: [], result, rule: DEFAULT_CHANGE_RULE, loading: false, now: end + 90_001 }));
    expect(markup).toContain('端点已过期或不可用，不代表当前值');
    expect(markup).toContain('显示 OI/FDV 占比相对变化');
  });

  it('renders independently available price history even when both OI and FDV are unavailable', () => {
    const { result } = positionChart([], point(start, { priceUsd: 10, oiQuantity: null, fdvUsd: null }),
      point(end, { priceUsd: 10.5, oiQuantity: null, fdvUsd: null }));
    const markup = renderToStaticMarkup(createElement(ChangeChart, { points: [], result, rule: DEFAULT_CHANGE_RULE, loading: false, now: end }));
    expect(markup).toContain('change-chart');
    expect(markup).not.toContain('缺少有效比较起点');
    expect(markup).toContain('共同起点 = 0%');
  });

  it('never returns NaN or Infinity from extreme but finite source values', () => {
    const values = positionChart([], point(start, { oiQuantity: Number.MIN_VALUE, oiUsd: Number.MIN_VALUE, priceUsd: Number.MIN_VALUE, fdvUsd: Number.MIN_VALUE }),
      point(end, { oiQuantity: Number.MAX_VALUE, oiUsd: Number.MAX_VALUE, priceUsd: Number.MAX_VALUE, fdvUsd: Number.MIN_VALUE })).values;
    expect(values.every(value => [value.oi, value.fdv, value.price, value.ratio].every(metric => metric === null || Number.isFinite(metric)))).toBe(true);
    expect(values.at(-1)).toMatchObject({ oi: null, price: null, ratio: null });
  });
});
