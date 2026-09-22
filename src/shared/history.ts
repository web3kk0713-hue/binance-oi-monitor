import type { AssetRow, HistoryPoint, Snapshot } from './types';

const MINUTE = 60_000;
const finite = (value: number | null) => value !== null && Number.isFinite(value) && value >= 0 ? value : null;
const ratio = (oi: number | null, value: number | null) => oi !== null && value !== null && value > 0 ? oi / value * 100 : null;
const fresh = (timestamp: number | null | undefined, now: number, maxAge: number) => timestamp != null && timestamp > 0 && timestamp <= now + 15_000 && now - timestamp <= maxAge;

/** Freeze valid values at collection time. Display-only stale values must not become history. */
export function toHistoryPoint(asset: AssetRow, snapshot: Pick<Snapshot, 'startedAt' | 'asOf'>): HistoryPoint {
  const complete = asset.complete && fresh(asset.oiUpdatedAt, snapshot.asOf, 90_000) && fresh(asset.priceUpdatedAt, snapshot.asOf, 90_000);
  const supply = asset.evidence.supply;
  const supplyValid = asset.mappingStatus === 'verified' && fresh(asset.supplyUpdatedAt, snapshot.asOf, 120 * MINUTE)
    && fresh(supply?.updatedAt, snapshot.asOf, 120 * MINUTE) && fresh(supply?.fetchedAt, snapshot.asOf, 120 * MINUTE);
  const oiUsd = complete ? finite(asset.oiUsd) : null;
  const marketCapUsd = complete && supplyValid ? finite(asset.marketCapUsd) : null;
  const fdvUsd = complete && supplyValid ? finite(asset.fdvUsd) : null;
  return { assetId: asset.id, timestamp: Math.floor(snapshot.startedAt / MINUTE) * MINUTE,
    oiUsd, marketCapUsd, fdvUsd, oiToFdv: ratio(oiUsd, fdvUsd), oiToMarketCap: ratio(oiUsd, marketCapUsd), complete };
}

export type HistoryView = 'change' | 'amount';
export function relativeChange(value: number | null, base: number | null): number | null {
  return value !== null && base !== null && base > 0 ? (value / base - 1) * 100 : null;
}

/** One shared baseline prevents OI and FDV from silently comparing different periods. */
export function analyzeHistory(input: HistoryPoint[], assetId: string | undefined, hours: number, now: number) {
  const start = now - hours * 3_600_000;
  const byMinute = new Map<number, HistoryPoint>();
  for (const raw of input) {
    if (raw.assetId !== assetId || !Number.isFinite(raw.timestamp) || raw.timestamp < start || raw.timestamp > now) continue;
    const oiUsd = raw.complete ? finite(raw.oiUsd) : null;
    const marketCapUsd = raw.complete ? finite(raw.marketCapUsd) : null;
    const fdvUsd = raw.complete ? finite(raw.fdvUsd) : null;
    byMinute.set(Math.floor(raw.timestamp / MINUTE) * MINUTE, { ...raw, oiUsd, marketCapUsd, fdvUsd,
      oiToFdv: ratio(oiUsd, fdvUsd), oiToMarketCap: ratio(oiUsd, marketCapUsd) });
  }
  const points = [...byMinute.values()].sort((a, b) => a.timestamp - b.timestamp);
  const baseline = points.find(point => point.oiUsd !== null && point.fdvUsd !== null && point.fdvUsd > 0)
    ?? points.find(point => point.oiUsd !== null || point.fdvUsd !== null) ?? null;
  const latest = points.at(-1) ?? null;
  const stale = latest !== null && now - latest.timestamp > 2 * MINUTE;
  const comparable = baseline !== null && latest !== null && latest.timestamp > baseline.timestamp && !stale;
  const difference = (key: 'oiUsd' | 'fdvUsd' | 'oiToFdv') => comparable && baseline[key] !== null && latest[key] !== null ? latest[key] - baseline[key] : null;
  return {
    points, baseline, latest, stale,
    coversWindow: comparable && baseline.timestamp - start <= MINUTE,
    validPoints: points.filter(point => point.oiUsd !== null && point.fdvUsd !== null && point.fdvUsd > 0).length,
    expectedPoints: Math.floor(hours * 60) + 1,
    oiChange: comparable ? relativeChange(latest.oiUsd, baseline.oiUsd) : null,
    fdvChange: comparable ? relativeChange(latest.fdvUsd, baseline.fdvUsd) : null,
    oiDifference: difference('oiUsd'), fdvDifference: difference('fdvUsd'), ratioDifference: difference('oiToFdv'),
  };
}

export function historySeries(points: HistoryPoint[], baseline: HistoryPoint | null, view: HistoryView): HistoryPoint[] {
  const result: HistoryPoint[] = [];
  for (const point of points) {
    const previous = result.at(-1);
    if (previous && point.timestamp - previous.timestamp > 90_000) result.push({ ...previous, timestamp: previous.timestamp + MINUTE,
      oiUsd: null, marketCapUsd: null, fdvUsd: null, oiToFdv: null, oiToMarketCap: null, complete: false });
    result.push(view === 'amount' ? point : { ...point,
      oiUsd: baseline && point.timestamp >= baseline.timestamp ? relativeChange(point.oiUsd, baseline.oiUsd) : null,
      marketCapUsd: baseline && point.timestamp >= baseline.timestamp ? relativeChange(point.marketCapUsd, baseline.marketCapUsd) : null,
      fdvUsd: baseline && point.timestamp >= baseline.timestamp ? relativeChange(point.fdvUsd, baseline.fdvUsd) : null,
    });
  }
  return result;
}
