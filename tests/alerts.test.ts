import { describe, expect, it } from 'vitest';
import { evaluateAlerts, validThresholds } from '../src/shared/alerts';
import { DEFAULT_THRESHOLDS, type AssetRow, type Snapshot } from '../src/shared/types';

const now = 1790064000000;
function sample(ratio = 72, patch: Partial<AssetRow> = {}): Snapshot {
  return { schemaVersion: 1, mode: 'direct', startedAt: now - 1000, asOf: now, durationMs: 1000,
    universe: { contracts: 1, assets: 1 }, coverage: { oi: 1, marketCap: 1, fdv: 1, eligible: 1, failedContracts: 0 }, errors: [],
    assets: [{ id: 'test', symbol: 'TEST', name: 'Explicit test fixture', contracts: ['TESTUSDT'], priceUsd: 1, oiUsd: ratio, marketCapUsd: 50, fdvUsd: 100, oiToFdv: ratio, oiToMarketCap: ratio * 2, circulatingSupply: 50, maxSupply: 100, updatedAt: now, oiUpdatedAt: now, priceUpdatedAt: now, supplyUpdatedAt: now, complete: true, alertEligible: true, issues: [], supplySource: 'test', mappingStatus: 'verified', evidence: { contracts: [], supply: null, mapping: 'test-only' }, ...patch }] };
}
describe('source-backed alert state machine', () => {
  it('alerts on exact boundaries, suppresses duplicates, escalates through cooldown', () => {
    const first = evaluateAlerts(sample(70), DEFAULT_THRESHOLDS, {}, now);
    expect(first.events[0].level).toBe('warning');
    expect(evaluateAlerts(sample(70), DEFAULT_THRESHOLDS, first.states, now + 1000).events).toHaveLength(0);
    const second = evaluateAlerts(sample(90), DEFAULT_THRESHOLDS, first.states, now + 1000);
    expect(second.events[0].level).toBe('danger');
    expect(evaluateAlerts(sample(100), DEFAULT_THRESHOLDS, second.states, now + 2000).events[0].level).toBe('critical');
  });
  it('never alerts on missing, stale, partial, impossible or future data', () => {
    for (const patch of [{ complete: false }, { alertEligible: false }, { fdvUsd: null }, { fdvUsd: 0 }, { oiToFdv: Infinity }, { oiUpdatedAt: now - 91000 }, { priceUpdatedAt: now + 16000 }, { supplyUpdatedAt: now - 7200001 }]) {
      expect(evaluateAlerts(sample(110, patch), DEFAULT_THRESHOLDS, {}, now).events).toHaveLength(0);
    }
    expect(evaluateAlerts({ ...sample(110), asOf: now - 91000 }, DEFAULT_THRESHOLDS, {}, now).events).toHaveLength(0);
  });
  it('preserves alert state through a failed collection and rearms only after real recovery', () => {
    const first = evaluateAlerts(sample(100), DEFAULT_THRESHOLDS, {}, now);
    const failed = evaluateAlerts(sample(0, { complete: false }), DEFAULT_THRESHOLDS, first.states, now);
    expect(failed.states).toEqual(first.states);
    const noise = evaluateAlerts(sample(99), DEFAULT_THRESHOLDS, first.states, now + 1000);
    expect(noise.states.test.lastLevel).toBe(3);
    const recovery = evaluateAlerts(sample(60), DEFAULT_THRESHOLDS, first.states, now + 1000);
    expect(recovery.states.test.lastLevel).toBe(0);
    expect(evaluateAlerts(sample(100), DEFAULT_THRESHOLDS, recovery.states, now + 2000).events).toHaveLength(1);
  });
  it('validates user threshold ordering and ranges', () => {
    expect(validThresholds(DEFAULT_THRESHOLDS)).toBe(true);
    for (const value of [null, {}, { ...DEFAULT_THRESHOLDS, warning: 100 }, { ...DEFAULT_THRESHOLDS, critical: NaN }, { ...DEFAULT_THRESHOLDS, cooldownMinutes: 0 }]) expect(validThresholds(value)).toBe(false);
  });
});
