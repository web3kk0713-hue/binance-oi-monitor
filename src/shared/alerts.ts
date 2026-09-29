import { DEFAULT_THRESHOLDS, type AlertEvent, type AlertLevel, type AlertState, type Snapshot, type Thresholds } from './types';
import { hasFreshMarketCapEvidence, selectValuation } from './valuation';

export function validThresholds(value: unknown): value is Thresholds {
  if (!value || typeof value !== 'object') return false;
  const t = value as Thresholds;
  return [t.warning, t.danger, t.critical, t.cooldownMinutes].every(Number.isFinite)
    && t.warning > 0 && t.warning < t.danger && t.danger < t.critical
    && t.critical <= 10000 && t.cooldownMinutes >= 1 && t.cooldownMinutes <= 1440;
}

export function levelForRatio(ratio: number, thresholds: Thresholds = DEFAULT_THRESHOLDS): number {
  return ratio >= thresholds.critical ? 3 : ratio >= thresholds.danger ? 2 : ratio >= thresholds.warning ? 1 : 0;
}

/** Never infer recovery from a failed round. Only complete, fresh source observations can alert or rearm. */
export function evaluateAlerts(snapshot: Snapshot, thresholds: Thresholds, previous: Record<string, AlertState>, now = Date.now()): { events: AlertEvent[]; states: Record<string, AlertState> } {
  const states = { ...previous };
  const events: AlertEvent[] = [];
  if (!validThresholds(thresholds) || !Number.isFinite(snapshot.asOf) || now - snapshot.asOf > 90_000 || snapshot.asOf - now > 15_000) return { events, states };
  const levels: AlertLevel[] = ['warning', 'danger', 'critical'];
  const boundaries = [0, thresholds.warning, thresholds.danger, thresholds.critical];
  for (const row of snapshot.assets) {
    const valuation = selectValuation(row);
    if (!row.complete || !row.alertEligible || valuation.ratio === null || valuation.valueUsd === null || valuation.basis === null
      || row.oiUsd === null || !Number.isFinite(row.oiUsd) || row.oiUsd < 0
      || (valuation.basis === 'fdv' && (row.oiToFdv === null || !Number.isFinite(row.oiToFdv)))) continue;
    const timestamps = [row.oiUpdatedAt, row.priceUpdatedAt];
    if (timestamps.some(time => time === null || !Number.isFinite(time) || now - time > 90_000 || time - now > 15_000)) continue;
    const independentCap = valuation.basis === 'marketCap' && !!row.evidence.marketCap;
    // An unrelated supply timestamp must never renew expired Binance/CMC evidence.
    if (independentCap && !hasFreshMarketCapEvidence(row, now)) continue;
    if (valuation.basis === 'marketCap' && !independentCap) {
      const supply = row.evidence.supply;
      if (row.mappingStatus !== 'verified' || !supply || !(supply.circulating! > 0) || !Number.isFinite(supply.circulating)
        || !(row.circulatingSupply! > 0) || !Number.isFinite(row.circulatingSupply)
        || [supply.updatedAt, supply.fetchedAt].some(time => !Number.isFinite(time) || time <= 0 || now - time > 2 * 3600_000 || time - now > 15_000)) continue;
    }
    if (!independentCap && (row.supplyUpdatedAt === null || !Number.isFinite(row.supplyUpdatedAt) || now - row.supplyUpdatedAt > 2 * 3600_000 || row.supplyUpdatedAt - now > 15_000)) continue;
    const old = previous[row.id] ?? { assetId: row.id, lastLevel: 0, lastSentAt: 0 };
    const sameBasis = (old.valuationBasis ?? 'fdv') === valuation.basis;
    const oldLevel = Number.isInteger(old.lastLevel) && old.lastLevel >= 0 && old.lastLevel <= 3 ? old.lastLevel : 0;
    const currentLevel = levelForRatio(valuation.ratio, thresholds);
    const levelRecovered = oldLevel > currentLevel && valuation.ratio < boundaries[oldLevel] - 5;
    let rememberedLevel = !sameBasis || levelRecovered ? currentLevel : oldLevel;
    // A denominator change is not market escalation. Respect the existing notification cooldown.
    const escalating = (!previous[row.id] || sameBasis) && currentLevel > oldLevel;
    const cooled = now - old.lastSentAt >= thresholds.cooldownMinutes * 60_000;
    if (currentLevel > 0 && (escalating || cooled)) {
      const level = levels[currentLevel - 1];
      events.push({ id: `${row.id}:${snapshot.asOf}:${valuation.basis}:${level}`, assetId: row.id, symbol: row.symbol, level,
        ratio: valuation.ratio, oiUsd: row.oiUsd, fdvUsd: valuation.basis === 'fdv' ? row.fdvUsd : null,
        valuationBasis: valuation.basis, valuationUsd: valuation.valueUsd, timestamp: snapshot.asOf });
      rememberedLevel = currentLevel;
      states[row.id] = { assetId: row.id, lastLevel: rememberedLevel, lastSentAt: now, valuationBasis: valuation.basis };
    } else {
      states[row.id] = { ...old, assetId: row.id, lastLevel: rememberedLevel, valuationBasis: valuation.basis };
    }
  }
  return { events, states };
}
