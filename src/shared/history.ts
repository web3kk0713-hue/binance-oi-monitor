import { COLLECTION_INTERVAL_MS, type AssetRow, type HistoryPoint, type Snapshot } from './types';

const MINUTE = 60_000;
const finite = (value: number | null | undefined) => value != null && Number.isFinite(value) && value >= 0 ? value : null;
const ratio = (oi: number | null, value: number | null) => oi !== null && value !== null && value > 0 ? oi / value * 100 : null;
const fresh = (timestamp: number | null | undefined, now: number, maxAge: number) => timestamp != null && timestamp > 0 && timestamp <= now + 15_000 && now - timestamp <= maxAge;

/** Freeze valid values at collection time. Display-only stale values must not become history. */
export function toHistoryPoint(asset: AssetRow, snapshot: Pick<Snapshot, 'startedAt' | 'asOf' | 'collectionIntervalMs'>): HistoryPoint {
  const complete = asset.complete && fresh(asset.oiUpdatedAt, snapshot.asOf, 90_000) && fresh(asset.priceUpdatedAt, snapshot.asOf, 90_000);
  const supply = asset.evidence.supply;
  const supplyValid = asset.mappingStatus === 'verified' && fresh(asset.supplyUpdatedAt, snapshot.asOf, 120 * MINUTE)
    && fresh(supply?.updatedAt, snapshot.asOf, 120 * MINUTE) && fresh(supply?.fetchedAt, snapshot.asOf, 120 * MINUTE);
  const oiUsd = complete ? finite(asset.oiUsd) : null;
  const marketCapUsd = complete && supplyValid ? finite(asset.marketCapUsd) : null;
  const fdvUsd = complete && supplyValid ? finite(asset.fdvUsd) : null;
  const sourceTimes = asset.evidence.contracts.flatMap(contract => [contract.oiTime, contract.priceTime, contract.quoteTime])
    .filter((time): time is number => time != null && Number.isFinite(time) && time > 0);
  return { assetId: asset.id, timestamp: snapshot.asOf, availableAt: snapshot.asOf,
    oiUsd, marketCapUsd, fdvUsd, oiToFdv: ratio(oiUsd, fdvUsd), oiToMarketCap: ratio(oiUsd, marketCapUsd), complete,
    oiQuantity: complete ? finite(asset.oiQuantity) : null, priceUsd: complete ? finite(asset.priceUsd) : null,
    oiSourceTime: asset.oiUpdatedAt, priceSourceTime: asset.priceUpdatedAt,
    samplingIntervalMs: snapshot.collectionIntervalMs ?? MINUTE,
    contractSetKey: asset.evidence.contracts.map(contract => `${contract.symbol}:${contract.unitMultiplier ?? 1}`).sort().join('|'),
    sourceSkewMs: sourceTimes.length ? Math.max(...sourceTimes) - Math.min(...sourceTimes) : null,
  };
}

export type HistoryView = 'change' | 'amount';
export function relativeChange(value: number | null, base: number | null): number | null {
  return value !== null && base !== null && base > 0 ? (value / base - 1) * 100 : null;
}

/** One shared baseline prevents OI and FDV from silently comparing different periods. */
export function analyzeHistory(input: HistoryPoint[], assetId: string | undefined, hours: number, now: number) {
  const start = now - hours * 3_600_000;
  const byTimestamp = new Map<number, HistoryPoint>();
  for (const raw of input) {
    if (raw.assetId !== assetId || !Number.isFinite(raw.timestamp) || raw.timestamp < start || raw.timestamp > now || (raw.availableAt ?? raw.timestamp) > now) continue;
    const oiUsd = raw.complete ? finite(raw.oiUsd) : null;
    const marketCapUsd = raw.complete ? finite(raw.marketCapUsd) : null;
    const fdvUsd = raw.complete ? finite(raw.fdvUsd) : null;
    byTimestamp.set(raw.timestamp, { ...raw, oiUsd, marketCapUsd, fdvUsd,
      oiToFdv: ratio(oiUsd, fdvUsd), oiToMarketCap: ratio(oiUsd, marketCapUsd) });
  }
  const points = [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
  const baseline = points.find(point => point.oiUsd !== null && point.fdvUsd !== null && point.fdvUsd > 0)
    ?? points.find(point => point.oiUsd !== null || point.fdvUsd !== null) ?? null;
  const latest = points.at(-1) ?? null;
  const stale = latest !== null && now - latest.timestamp > 2 * MINUTE;
  const comparable = baseline !== null && latest !== null && latest.timestamp > baseline.timestamp && !stale;
  const samplingIntervalMs = latest?.samplingIntervalMs === COLLECTION_INTERVAL_MS ? COLLECTION_INTERVAL_MS : MINUTE;
  const difference = (key: 'oiUsd' | 'fdvUsd' | 'oiToFdv') => comparable && baseline[key] !== null && latest[key] !== null ? latest[key] - baseline[key] : null;
  return {
    points, baseline, latest, stale, samplingIntervalMs,
    legacyPoints: points.filter(point => point.availableAt === undefined).length,
    coversWindow: comparable && baseline.timestamp - start <= samplingIntervalMs,
    validPoints: points.filter(point => point.oiUsd !== null && point.fdvUsd !== null && point.fdvUsd > 0).length,
    expectedPoints: Math.floor(hours * 3_600_000 / samplingIntervalMs) + 1,
    oiChange: comparable ? relativeChange(latest.oiUsd, baseline.oiUsd) : null,
    fdvChange: comparable ? relativeChange(latest.fdvUsd, baseline.fdvUsd) : null,
    oiDifference: difference('oiUsd'), fdvDifference: difference('fdvUsd'), ratioDifference: difference('oiToFdv'),
  };
}

export function historySeries(points: HistoryPoint[], baseline: HistoryPoint | null, view: HistoryView): HistoryPoint[] {
  const result: HistoryPoint[] = [];
  for (const point of points) {
    const previous = result.at(-1);
    const interval = Math.max(previous?.samplingIntervalMs ?? MINUTE, point.samplingIntervalMs ?? MINUTE);
    if (previous && point.timestamp - previous.timestamp > interval * 1.5) result.push({ ...previous, timestamp: previous.timestamp + interval,
      oiUsd: null, marketCapUsd: null, fdvUsd: null, oiQuantity: null, priceUsd: null, oiToFdv: null, oiToMarketCap: null, complete: false });
    result.push(view === 'amount' ? point : { ...point,
      oiUsd: baseline && point.timestamp >= baseline.timestamp ? relativeChange(point.oiUsd, baseline.oiUsd) : null,
      marketCapUsd: baseline && point.timestamp >= baseline.timestamp ? relativeChange(point.marketCapUsd, baseline.marketCapUsd) : null,
      fdvUsd: baseline && point.timestamp >= baseline.timestamp ? relativeChange(point.fdvUsd, baseline.fdvUsd) : null,
    });
  }
  return result;
}
