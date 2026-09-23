// Synthetic observations test chart semantics, never exchange coverage or trading performance.
import { describe, expect, it } from 'vitest';
import { analyzeChange, DEFAULT_CHANGE_RULE, type ChangeRule } from '../src/shared/changeMonitor';
import type { AssetRow, HistoryPoint } from '../src/shared/types';
import { prepareChangeChart } from '../src/web/ChangeChart';

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
