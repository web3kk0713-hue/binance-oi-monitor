import { toHistoryPoint } from './history';
import type { AssetRow, HistoryPoint, Snapshot } from './types';

type DisplayValues = Pick<HistoryPoint, 'oiUsd' | 'oiQuantity' | 'priceUsd' | 'marketCapUsd' | 'fdvUsd' | 'oiToFdv' | 'oiToMarketCap'>;
const RETENTION_MS = 7 * 86_400_000;
const SOURCE_MAX_AGE_MS = 90_000;
const SOURCE_MAX_SKEW_MS = 30_000;
const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const positive = (value: unknown): value is number => nonnegative(value) && value > 0;
const validSource = (value: unknown, at: number) => validTime(value) && value <= at && at - value <= SOURCE_MAX_AGE_MS;

function contractKey(asset: AssetRow): string | null {
  const contracts = asset.contracts;
  const evidence = asset.evidence.contracts;
  if (!contracts.length || contracts.length !== evidence.length || new Set(contracts).size !== contracts.length) return null;
  const symbols = new Set<string>();
  for (const contract of evidence) {
    if (!contract.symbol.trim() || /[|:]/.test(contract.symbol) || symbols.has(contract.symbol) || !contracts.includes(contract.symbol)
      || !Number.isFinite(contract.unitMultiplier ?? 1) || (contract.unitMultiplier ?? 1) <= 0) return null;
    symbols.add(contract.symbol);
  }
  return evidence.map(contract => `${contract.symbol}:${contract.unitMultiplier ?? 1}`).sort().join('|');
}

function acceptable(point: HistoryPoint | undefined, asset: AssetRow, asOf: number): point is HistoryPoint {
  const key = contractKey(asset);
  return !!point && validTime(asOf) && point.assetId === asset.id && !!key && point.contractSetKey === key
    && validTime(point.timestamp) && validTime(point.availableAt) && point.availableAt >= point.timestamp && point.availableAt <= asOf
    && asOf - point.timestamp <= RETENTION_MS && point.complete === true
    && nonnegative(point.oiUsd) && nonnegative(point.oiQuantity) && positive(point.priceUsd)
    && [point.marketCapUsd, point.fdvUsd, point.oiToFdv, point.oiToMarketCap].every(value => value === null || nonnegative(value))
    && validSource(point.oiSourceTime, point.availableAt) && point.oiSourceTime! <= point.timestamp
    && validSource(point.priceSourceTime, point.availableAt) && point.priceSourceTime! <= point.timestamp
    && nonnegative(point.sourceSkewMs) && point.sourceSkewMs <= SOURCE_MAX_SKEW_MS;
}

function observedPoint(asset: AssetRow, snapshot: Snapshot): HistoryPoint | undefined {
  if (!contractKey(asset) || !asset.evidence.contracts.every(contract =>
    [contract.oiTime, contract.priceTime, contract.quoteTime].every(time => validSource(time, snapshot.asOf)))) return undefined;
  return toHistoryPoint(asset, snapshot);
}

function maskUnverifiedValuations(point: HistoryPoint, current: AssetRow): HistoryPoint {
  const supply = current.evidence.supply;
  const identityValid = current.mappingStatus === 'verified' && !!supply && positive(supply.providerPriceUsd);
  const capValid = identityValid && positive(current.circulatingSupply) && positive(supply.circulating);
  const fdvValid = identityValid && positive(current.maxSupply) && positive(supply.max);
  return { ...point, ...(capValid ? {} : { marketCapUsd: null, oiToMarketCap: null }),
    ...(fdvValid ? {} : { fdvUsd: null, oiToFdv: null }) };
}

function values(point: AssetRow | HistoryPoint): DisplayValues {
  return { oiUsd: point.oiUsd, oiQuantity: point.oiQuantity, priceUsd: point.priceUsd,
    marketCapUsd: point.marketCapUsd, fdvUsd: point.fdvUsd, oiToFdv: point.oiToFdv, oiToMarketCap: point.oiToMarketCap };
}

export function retainLastGood(current: Snapshot, previous?: Snapshot | null): Snapshot {
  const lastGood: Record<string, HistoryPoint> = {};
  const priorAssets = new Map(previous?.assets.map(asset => [asset.id, asset]));
  for (const asset of current.assets) {
    const oldAsset = priorAssets.get(asset.id);
    const candidates = [previous?.lastGood?.[asset.id], current.lastGood?.[asset.id],
      oldAsset && previous ? observedPoint(oldAsset, previous) : undefined, observedPoint(asset, current)];
    for (const point of candidates) {
      if (acceptable(point, asset, current.asOf) && (!lastGood[asset.id] || point.timestamp >= lastGood[asset.id]!.timestamp)) lastGood[asset.id] = point;
    }
    if (lastGood[asset.id]) lastGood[asset.id] = maskUnverifiedValuations(lastGood[asset.id]!, asset);
  }
  return { ...current, lastGood };
}

export function displayedAsset(asset: AssetRow, snapshot: Snapshot | null): { values: DisplayValues; retainedAt: number | null } {
  const retained = !asset.complete || !nonnegative(asset.oiUsd) || !nonnegative(asset.oiQuantity) ? snapshot?.lastGood?.[asset.id] : undefined;
  return snapshot && acceptable(retained, asset, snapshot.asOf)
    ? { values: values(maskUnverifiedValuations(retained, asset)), retainedAt: retained.timestamp } : { values: values(asset), retainedAt: null };
}
