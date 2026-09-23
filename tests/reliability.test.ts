import { describe, expect, it } from 'vitest';
import { displayedAsset, retainLastGood } from '../src/shared/reliability';
import { evaluateAlerts } from '../src/shared/alerts';
import { analyzeChange, DEFAULT_CHANGE_RULE } from '../src/shared/changeMonitor';
import { toHistoryPoint } from '../src/shared/history';
import { DEFAULT_THRESHOLDS, type AssetRow, type HistoryPoint, type Snapshot } from '../src/shared/types';

const NOW = Date.UTC(2026, 8, 23, 10);
function row(at = NOW): AssetRow {
  return { id: 'binance:TEST', symbol: 'TEST', name: 'Synthetic only', contracts: ['TESTUSDT'],
    priceUsd: 2, oiUsd: 120, oiQuantity: 60, marketCapUsd: 80, fdvUsd: 100, oiToFdv: 120, oiToMarketCap: 150,
    circulatingSupply: 40, maxSupply: 50, updatedAt: at, oiUpdatedAt: at - 1000, priceUpdatedAt: at - 2000, supplyUpdatedAt: at,
    complete: true, alertEligible: true, issues: [], supplySource: 'CoinGecko', mappingStatus: 'verified',
    evidence: { contracts: [{ symbol: 'TESTUSDT', baseAsset: 'TEST', quoteAsset: 'USDT', openInterest: '60', markPrice: '2',
      indexPrice: '2', quoteUsd: '1', oiTime: at - 1000, priceTime: at - 2000, quoteTime: at - 2000, oiUsd: 120, unitMultiplier: 1 }],
    supply: { provider: 'CoinGecko', id: 'test', circulating: 40, total: 50, max: 50, updatedAt: at, fetchedAt: at,
      providerPriceUsd: 2, url: 'https://example.invalid/synthetic' }, mapping: 'Synthetic only' } };
}
function snapshot(at = NOW, asset = row(at)): Snapshot {
  return { schemaVersion: 1, mode: 'direct', startedAt: at - 5000, asOf: at, durationMs: 5000, collectionIntervalMs: 30_000,
    universe: { contracts: 1, assets: 1 }, coverage: { oi: asset.oiUsd === null ? 0 : 1, marketCap: asset.marketCapUsd === null ? 0 : 1,
      fdv: asset.fdvUsd === null ? 0 : 1, eligible: asset.alertEligible ? 1 : 0, failedContracts: asset.complete ? 0 : 1 },
    assets: [asset], errors: asset.complete ? [] : ['BINANCE_PARTIAL: synthetic failure'] };
}
function failure(at: number): Snapshot {
  const asset = row(at);
  Object.assign(asset, { oiUsd: null, oiQuantity: null, oiToFdv: null, oiToMarketCap: null, complete: false, alertEligible: false, oiUpdatedAt: null });
  Object.assign(asset.evidence.contracts[0]!, { openInterest: null, oiTime: null, oiUsd: null, error: 'synthetic failure' });
  return snapshot(at, asset);
}

describe('display-only last successful observation', () => {
  it('keeps the original successful values and times through two failed rounds, then replaces them on recovery', () => {
    const first = retainLastGood(snapshot());
    const failed = failure(NOW + 30_000);
    const retained = retainLastGood(failed, first);
    expect(displayedAsset(retained.assets[0]!, retained)).toEqual({ values: { oiUsd: 120, oiQuantity: 60, priceUsd: 2,
      marketCapUsd: 80, fdvUsd: 100, oiToFdv: 120, oiToMarketCap: 150 }, retainedAt: NOW });
    expect(retained.assets).toBe(failed.assets);
    expect(retained.coverage).toBe(failed.coverage);
    expect(retained.errors).toBe(failed.errors);
    expect(retained.assets[0]).toMatchObject({ oiUsd: null, complete: false, alertEligible: false });
    expect(retained.lastGood?.['binance:TEST']).toMatchObject({ timestamp: NOW, availableAt: NOW,
      oiSourceTime: NOW - 1000, priceSourceTime: NOW - 2000 });
    const twice = retainLastGood(failure(NOW + 60_000), retained);
    expect(displayedAsset(twice.assets[0]!, twice).retainedAt).toBe(NOW);
    const recovered = snapshot(NOW + 90_000);
    recovered.assets[0]!.oiUsd = 160;
    recovered.assets[0]!.oiQuantity = 80;
    recovered.assets[0]!.oiToFdv = 160;
    recovered.assets[0]!.oiToMarketCap = 200;
    const final = retainLastGood(recovered, twice);
    expect(displayedAsset(final.assets[0]!, final)).toMatchObject({ values: { oiUsd: 160 }, retainedAt: null });
    expect(final.lastGood?.['binance:TEST']).toMatchObject({ timestamp: NOW + 90_000, oiUsd: 160 });
  });

  it('restores display-only values from a persisted failed snapshot after reload without inventing a new observation', () => {
    const failed = retainLastGood(failure(NOW + 30_000), snapshot());
    const restored = retainLastGood(JSON.parse(JSON.stringify(failed)) as Snapshot);
    expect(displayedAsset(restored.assets[0]!, restored)).toMatchObject({ values: { oiUsd: 120, fdvUsd: 100 }, retainedAt: NOW });
    expect(restored.lastGood?.['binance:TEST']).toEqual(failed.lastGood?.['binance:TEST']);
    expect(restored.asOf).toBe(NOW + 30_000);
    expect(restored.assets[0]!.complete).toBe(false);
  });

  it('evicts old, removed, future and contract-unit-incompatible observations instead of displaying a different market', () => {
    const first = retainLastGood(snapshot());
    const expired = retainLastGood(failure(NOW + 7 * 86_400_000 + 1), first);
    expect(expired.lastGood).toEqual({});
    expect(displayedAsset(expired.assets[0]!, expired).retainedAt).toBeNull();
    const boundary = retainLastGood(failure(NOW + 7 * 86_400_000), first);
    expect(displayedAsset(boundary.assets[0]!, boundary).retainedAt).toBe(NOW);
    const removed = retainLastGood({ ...failure(NOW + 30_000), assets: [] }, first);
    expect(removed.lastGood).toEqual({});
    const changed = failure(NOW + 30_000);
    changed.assets[0]!.evidence.contracts[0]!.unitMultiplier = 1000;
    expect(retainLastGood(changed, first).lastGood).toEqual({});
    changed.assets[0]!.evidence.contracts[0]!.unitMultiplier = 1;
    changed.assets[0]!.contracts.push('TESTUSDC');
    expect(retainLastGood(changed, first).lastGood).toEqual({});
    const future = { ...first, asOf: NOW - 1, assets: failure(NOW - 1).assets };
    expect(retainLastGood(future).lastGood).toEqual({});
  });

  it.each<[string, (asset: AssetRow) => void]>([
    ['future OI clock', asset => { asset.oiUpdatedAt = NOW + 1; asset.evidence.contracts[0]!.oiTime = NOW + 1; }],
    ['missing aggregate price clock', asset => { asset.priceUpdatedAt = null; }],
    ['missing constituent price clock', asset => { asset.evidence.contracts[0]!.priceTime = null; }],
    ['missing FX clock', asset => { asset.evidence.contracts[0]!.quoteTime = null; }],
    ['stale OI clock', asset => { asset.oiUpdatedAt = NOW - 90_001; asset.evidence.contracts[0]!.oiTime = NOW - 90_001; }],
    ['clock skew over 30 seconds', asset => { asset.evidence.contracts[0]!.quoteTime = NOW - 32_000; }],
    ['nonfinite OI', asset => { asset.oiUsd = Number.POSITIVE_INFINITY; }],
    ['missing native quantity', asset => { asset.oiQuantity = null; }],
    ['invalid price', asset => { asset.priceUsd = 0; }],
    ['invalid unit multiplier', asset => { asset.evidence.contracts[0]!.unitMultiplier = Number.NaN; }],
    ['duplicate contract evidence', asset => { asset.evidence.contracts.push({ ...asset.evidence.contracts[0]! }); }],
  ])('does not cache a nominally complete asset with %s', (_name, mutate) => {
    const input = snapshot();
    mutate(input.assets[0]!);
    expect(retainLastGood(input).lastGood).toEqual({});
  });

  it.each<[string, (point: HistoryPoint) => void]>([
    ['incomplete point', point => { point.complete = false; }],
    ['unknown availability', point => { delete point.availableAt; }],
    ['future availability', point => { point.availableAt = NOW + 30_001; }],
    ['wrong asset identity', point => { point.assetId = 'binance:OTHER'; }],
    ['future source clock', point => { point.oiSourceTime = NOW + 1; }],
    ['stale source clock at original observation', point => { point.priceSourceTime = NOW - 90_001; }],
    ['unknown source skew', point => { point.sourceSkewMs = null; }],
    ['invalid native quantity', point => { point.oiQuantity = -1; }],
    ['nonfinite valuation', point => { point.fdvUsd = Number.POSITIVE_INFINITY; }],
  ])('rejects a persisted display point with %s', (_name, mutate) => {
    const input = failure(NOW + 30_000);
    input.lastGood = structuredClone(retainLastGood(snapshot()).lastGood!);
    mutate(input.lastGood['binance:TEST']!);
    expect(retainLastGood(input).lastGood).toEqual({});
    expect(displayedAsset(input.assets[0]!, input).retainedAt).toBeNull();
  });

  it('never mixes retained OI with a current price or valuation, and clears structurally invalid old FDV', () => {
    const first = retainLastGood(snapshot());
    const input = failure(NOW + 30_000);
    Object.assign(input.assets[0]!, { priceUsd: 10, marketCapUsd: 400, fdvUsd: 500 });
    const kept = retainLastGood(input, first);
    expect(displayedAsset(kept.assets[0]!, kept)).toMatchObject({ values: { oiUsd: 120, priceUsd: 2, fdvUsd: 100, oiToFdv: 120 }, retainedAt: NOW });
    Object.assign(input.assets[0]!, { maxSupply: null, fdvUsd: null });
    input.assets[0]!.evidence.supply!.max = null;
    const noMax = retainLastGood(input, first);
    expect(displayedAsset(noMax.assets[0]!, noMax)).toMatchObject({ values: { oiUsd: 120, fdvUsd: null, oiToFdv: null, marketCapUsd: 80 }, retainedAt: NOW });
    expect(noMax.lastGood?.['binance:TEST']).toMatchObject({ fdvUsd: null, oiToFdv: null });
    input.assets[0]!.mappingStatus = 'unmapped';
    const unmapped = retainLastGood(input, first);
    expect(displayedAsset(unmapped.assets[0]!, unmapped)).toMatchObject({ values: { oiUsd: 120, fdvUsd: null,
      marketCapUsd: null, oiToFdv: null, oiToMarketCap: null }, retainedAt: NOW });
    expect(first.lastGood?.['binance:TEST']?.fdvUsd).toBe(100);
  });

  it('does not reuse a former valuation after a complete round has established its structural absence', () => {
    const current = snapshot(NOW + 30_000);
    Object.assign(current.assets[0]!, { fdvUsd: null, oiToFdv: null, maxSupply: null, alertEligible: false });
    current.assets[0]!.evidence.supply!.max = null;
    const retained = retainLastGood(current, snapshot());
    expect(displayedAsset(retained.assets[0]!, retained)).toMatchObject({ values: { oiUsd: 120, fdvUsd: null }, retainedAt: null });
    const laterFailure = retainLastGood(failure(NOW + 60_000), retained);
    expect(displayedAsset(laterFailure.assets[0]!, laterFailure)).toMatchObject({ values: { oiUsd: 120, fdvUsd: null, oiToFdv: null }, retainedAt: NOW + 30_000 });
  });

  it('uses the last whole observation for missing native OI, but does not confuse a real zero with a failure', () => {
    const previous = snapshot();
    const missing = snapshot(NOW + 30_000);
    missing.assets[0]!.oiQuantity = null;
    const retained = retainLastGood(missing, previous);
    expect(displayedAsset(retained.assets[0]!, retained)).toMatchObject({ values: { oiQuantity: 60 }, retainedAt: NOW });
    const zero = snapshot(NOW + 60_000);
    Object.assign(zero.assets[0]!, { oiQuantity: 0, oiUsd: 0, oiToFdv: 0, oiToMarketCap: 0 });
    const recovered = retainLastGood(zero, retained);
    expect(displayedAsset(recovered.assets[0]!, recovered)).toMatchObject({ values: { oiQuantity: 0, oiUsd: 0 }, retainedAt: null });
    expect(recovered.lastGood?.['binance:TEST']?.timestamp).toBe(NOW + 60_000);
  });

  it('keeps failed history, alert and change inputs failed even though the UI can show the last valid observation', () => {
    const first = snapshot();
    const baseline = toHistoryPoint(first.assets[0]!, first);
    const input = failure(NOW + 5 * 60_000);
    const original = JSON.stringify(input);
    const failed = retainLastGood(input, first);
    const latest = toHistoryPoint(failed.assets[0]!, failed);
    expect(displayedAsset(failed.assets[0]!, failed)).toMatchObject({ values: { oiUsd: 120, fdvUsd: 100 }, retainedAt: NOW });
    expect(latest).toMatchObject({ timestamp: NOW + 5 * 60_000, complete: false, oiUsd: null, oiQuantity: null, fdvUsd: null, oiToFdv: null });
    expect(evaluateAlerts(failed, DEFAULT_THRESHOLDS, {}, failed.asOf).events).toEqual([]);
    expect(analyzeChange(failed.assets[0]!, latest, baseline, DEFAULT_CHANGE_RULE, failed.asOf)).toMatchObject({
      oiPct: null, fdvPct: null, matched: false, evaluable: false, status: 'unavailable' });
    expect(JSON.stringify(input)).toBe(original);
  });
});
