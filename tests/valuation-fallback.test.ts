// Synthetic observations exercise denominator semantics, not market performance.
import { describe, expect, it } from 'vitest';
import { analyzeChange, DEFAULT_CHANGE_RULE } from '../src/shared/changeMonitor';
import { analyzePosition } from '../src/shared/positionContext';
import { evaluateAlerts } from '../src/shared/alerts';
import { toHistoryPoint } from '../src/shared/history';
import { selectValuation, valuationPair, hasFreshMarketCapEvidence } from '../src/shared/valuation';
import { DEFAULT_THRESHOLDS, type AssetRow, type HistoryPoint, type Snapshot } from '../src/shared/types';

const now = 1_790_064_000_000, start = now - 300_000;
function point(at: number, patch: Partial<HistoryPoint> = {}): HistoryPoint {
  return { assetId: 'test', timestamp: at, availableAt: at, complete: true, oiUsd: 70, oiQuantity: 7,
    priceUsd: 10, fdvUsd: null, marketCapUsd: 100, oiToFdv: null, oiToMarketCap: 70,
    oiSourceTime: at, priceSourceTime: at, sourceSkewMs: 0, contractSetKey: 'TESTUSDT:1', ...patch };
}
function asset(patch: Partial<AssetRow> = {}): AssetRow {
  return { id: 'test', symbol: 'TEST', name: 'Synthetic only', contracts: ['TESTUSDT'], priceUsd: 10,
    oiUsd: 70, fdvUsd: null, marketCapUsd: 100, oiToFdv: null, oiToMarketCap: 70,
    circulatingSupply: 10, maxSupply: null, updatedAt: now, oiUpdatedAt: now, priceUpdatedAt: now,
    supplyUpdatedAt: now, complete: true, alertEligible: true, issues: [], supplySource: null,
    mappingStatus: 'unmapped', evidence: { contracts: [{ symbol: 'TESTUSDT', baseAsset: 'TEST', quoteAsset: 'USDT',
      openInterest: '7', markPrice: '10', indexPrice: '10', quoteUsd: '1', oiTime: now, priceTime: now,
      quoteTime: now, oiUsd: 70, unitMultiplier: 1 }], supply: null, mapping: 'synthetic', marketCap: {
        provider: 'Binance', upstream: 'CoinMarketCap', contractSymbol: 'TESTUSDT', circulatingSupply: 10,
        unitMultiplier: 1, sourceTime: now - 300_000, fetchedAt: now,
        url: 'https://fapi.binance.com/futures/data/openInterestHist?symbol=TESTUSDT&period=5m&limit=1' } }, ...patch };
}
function snapshot(row = asset()): Snapshot {
  return { schemaVersion: 1, mode: 'direct', startedAt: now - 1000, asOf: now, durationMs: 1000,
    universe: { assets: 1, contracts: 1 }, coverage: { oi: 1, marketCap: 1, fdv: 0, eligible: 1, failedContracts: 0 }, assets: [row], errors: [] };
}

describe('FDV first with explicitly named market-cap fallback', () => {
  it('does not mutate or rename native FDV; cap is only selected when FDV is unusable', () => {
    const raw = point(now);
    expect(selectValuation(raw)).toEqual({ basis: 'marketCap', valueUsd: 100, ratio: 70, label: '流通市值' });
    expect(raw.fdvUsd).toBeNull();
    expect(selectValuation({ ...raw, fdvUsd: 200 })).toMatchObject({ basis: 'fdv', valueUsd: 200, ratio: 35 });
    expect(selectValuation({ ...raw, fdvUsd: 0 })).toMatchObject({ basis: 'marketCap' });
    expect(selectValuation({ ...raw, fdvUsd: NaN, marketCapUsd: -1 })).toMatchObject({ basis: null, valueUsd: null, ratio: null });
  });
  it('compares cap changes, not current cap against old FDV', () => {
    const result = analyzeChange(asset(), point(now, { oiQuantity: 7.7, marketCapUsd: 105 }), point(start), DEFAULT_CHANGE_RULE, now);
    expect(result).toMatchObject({ valuationBasis: 'marketCap', oiPct: 10, fdvPct: 5, matched: true });
    expect(result.reason).toContain('流通市值');
    const switched = analyzeChange(asset(), point(now, { oiQuantity: 7.7 }), point(start, { fdvUsd: 1000 }), DEFAULT_CHANGE_RULE, now);
    expect(switched).toMatchObject({ oiPct: 10, fdvPct: null, matched: false, evaluable: false });
    expect(switched.reason).toContain('估值口径切换');
    expect(valuationPair(point(now), point(start, { fdvUsd: 1000 })).issue).not.toBeNull();
  });
  it('keeps OI-only or any-condition rules usable across denominator changes', () => {
    const result = analyzeChange(asset(), point(now, { oiQuantity: 7.7 }), point(start, { fdvUsd: 1000 }),
      { ...DEFAULT_CHANGE_RULE, combine: 'any' }, now);
    expect(result).toMatchObject({ matched: true, fdvPct: null, valuationBasis: 'marketCap' });
  });
  it('names and calculates ratio context using circulating cap', () => {
    const context = analyzePosition(asset(), point(now, { oiUsd: 84, oiQuantity: 8.4, marketCapUsd: 105 }), point(start), 5, now);
    expect(context).toMatchObject({ valuationBasis: 'marketCap', fdvPct: 5, oiToFdvPct: 80, oiToFdvDeltaPp: 10 });
    expect(context.oiToFdvChangePct).toBeCloseTo(14.285714, 5);
  });
  it('does not infer ratio movement or a supply revision from changing denominator type', () => {
    const context = analyzePosition(asset(), point(now), point(start, { fdvUsd: 1000 }), 5, now);
    expect(context).toMatchObject({ oiToFdvPct: 70, fdvPct: null, oiToFdvChangePct: null, oiToFdvDeltaPp: null, supplyChanged: false });
    expect(context.issues.join(';')).toContain('估值口径切换');
  });
  it('freezes fresh contract-bound market cap without requiring unrelated CoinGecko mapping', () => {
    const row = asset();
    expect(hasFreshMarketCapEvidence(row, now)).toBe(true);
    expect(toHistoryPoint(row, snapshot(row))).toMatchObject({ marketCapUsd: 100, fdvUsd: null, oiToMarketCap: 70 });
    expect(hasFreshMarketCapEvidence(row, now + 300_001)).toBe(false);
    const invalid = asset({ evidence: { ...row.evidence, marketCap: { ...row.evidence.marketCap!, contractSymbol: 'OTHERUSDT' } } });
    expect(toHistoryPoint(invalid, snapshot(invalid)).marketCapUsd).toBeNull();
  });
  it('rejects unit mismatch, unknown hosts, missing or future cap timestamps', () => {
    const row = asset();
    for (const patch of [{ unitMultiplier: 1000 }, { sourceTime: now + 15_001 }, { fetchedAt: 0 },
      { url: 'https://untrusted.invalid/futures/data/openInterestHist?symbol=TESTUSDT&period=5m' }]) {
      expect(hasFreshMarketCapEvidence(asset({ evidence: { ...row.evidence, marketCap: { ...row.evidence.marketCap!, ...patch } } }), now)).toBe(false);
    }
  });
  it('emits a named cap alert with no fabricated fdvUsd even when traditional supply is unavailable', () => {
    const event = evaluateAlerts(snapshot(asset({ supplyUpdatedAt: null })), DEFAULT_THRESHOLDS, {}, now).events[0];
    expect(event).toMatchObject({ valuationBasis: 'marketCap', valuationUsd: 100, fdvUsd: null, ratio: 70, level: 'warning' });
  });
  it('never renews expired independent market cap with a different supplier timestamp', () => {
    const row = asset();
    row.evidence.marketCap!.sourceTime = now - 600_000;
    row.mappingStatus = 'verified';
    row.evidence.supply = { provider: 'CoinGecko', id: 'test', circulating: null, max: null, total: null,
      updatedAt: now, fetchedAt: now, url: 'https://api.coingecko.com/api/v3/coins/markets' };
    expect(evaluateAlerts(snapshot(row), DEFAULT_THRESHOLDS, {}, now).events).toHaveLength(1);
    expect(evaluateAlerts(snapshot(row), DEFAULT_THRESHOLDS, {}, now + 30_000).events).toEqual([]);
    expect(toHistoryPoint(row, { ...snapshot(row), asOf: now + 30_000 }).marketCapUsd).toBeNull();
  });
  it('validates the circulation and source times for conventional market-cap alerts', () => {
    const row = asset({ mappingStatus: 'verified' });
    delete row.evidence.marketCap;
    row.evidence.supply = { provider: 'CoinGecko', id: 'test', circulating: 10, max: null, total: null,
      updatedAt: now, fetchedAt: now, url: 'https://api.coingecko.com/api/v3/coins/markets' };
    expect(evaluateAlerts(snapshot(row), DEFAULT_THRESHOLDS, {}, now).events).toHaveLength(1);
    for (const patch of [{ circulating: null }, { updatedAt: now - 7_200_001 }, { fetchedAt: now + 15_001 }]) {
      const invalid = { ...row, evidence: { ...row.evidence, supply: { ...row.evidence.supply, ...patch } } };
      expect(evaluateAlerts(snapshot(invalid), DEFAULT_THRESHOLDS, {}, now).events).toEqual([]);
    }
  });
  it('does not misclassify a denominator switch as immediate market escalation during cooldown', () => {
    const fdv = evaluateAlerts(snapshot(asset({ fdvUsd: 100, oiToFdv: 70 })), DEFAULT_THRESHOLDS, {}, now);
    const switched = evaluateAlerts(snapshot(asset({ marketCapUsd: 50 })), DEFAULT_THRESHOLDS, fdv.states, now + 1000);
    expect(switched.events).toEqual([]);
    expect(switched.states.test).toMatchObject({ valuationBasis: 'marketCap', lastLevel: 3 });
  });
});
