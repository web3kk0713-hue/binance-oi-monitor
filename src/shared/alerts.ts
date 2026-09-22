import { DEFAULT_THRESHOLDS, type AlertEvent, type AlertLevel, type AlertState, type Snapshot, type Thresholds } from './types';

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
    if (!row.complete || !row.alertEligible || row.oiToFdv === null || !Number.isFinite(row.oiToFdv)
      || row.oiUsd === null || !Number.isFinite(row.oiUsd) || row.oiUsd < 0
      || row.fdvUsd === null || !Number.isFinite(row.fdvUsd) || row.fdvUsd <= 0) continue;
    const timestamps = [row.oiUpdatedAt, row.priceUpdatedAt];
    if (timestamps.some(time => time === null || !Number.isFinite(time) || now - time > 90_000 || time - now > 15_000)) continue;
    if (row.supplyUpdatedAt === null || !Number.isFinite(row.supplyUpdatedAt) || now - row.supplyUpdatedAt > 2 * 3600_000 || row.supplyUpdatedAt - now > 15_000) continue;
    const old = previous[row.id] ?? { assetId: row.id, lastLevel: 0, lastSentAt: 0 };
    const oldLevel = Number.isInteger(old.lastLevel) && old.lastLevel >= 0 && old.lastLevel <= 3 ? old.lastLevel : 0;
    const currentLevel = levelForRatio(row.oiToFdv, thresholds);
    const levelRecovered = oldLevel > currentLevel && row.oiToFdv < boundaries[oldLevel] - 5;
    let rememberedLevel = levelRecovered ? currentLevel : oldLevel;
    const escalating = currentLevel > oldLevel;
    const cooled = now - old.lastSentAt >= thresholds.cooldownMinutes * 60_000;
    if (currentLevel > 0 && (escalating || cooled)) {
      const level = levels[currentLevel - 1];
      events.push({ id: `${row.id}:${snapshot.asOf}:${level}`, assetId: row.id, symbol: row.symbol, level, ratio: row.oiToFdv, oiUsd: row.oiUsd, fdvUsd: row.fdvUsd, timestamp: snapshot.asOf });
      rememberedLevel = currentLevel;
      states[row.id] = { assetId: row.id, lastLevel: rememberedLevel, lastSentAt: now };
    } else {
      states[row.id] = { ...old, assetId: row.id, lastLevel: rememberedLevel };
    }
  }
  return { events, states };
}
