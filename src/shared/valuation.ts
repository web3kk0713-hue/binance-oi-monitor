import type { AssetRow, ValuationBasis } from './types';

type Values = { fdvUsd: number | null; marketCapUsd: number | null; oiUsd?: number | null };
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
export const MARKET_CAP_MAX_AGE_MS = 10 * 60_000;
const fresh = (time: number, now: number) => Number.isSafeInteger(time) && time > 0 && time <= now + 15_000 && now - time <= MARKET_CAP_MAX_AGE_MS;

export function valuationLabel(basis: ValuationBasis | null | undefined): 'FDV' | '流通市值' | '估值' {
  return basis === 'fdv' ? 'FDV' : basis === 'marketCap' ? '流通市值' : '估值';
}

/** Inputs must already be validated for their observation time. Never overwrites raw FDV. */
export function selectValuation(value: Values) {
  const basis: ValuationBasis | null = positive(value.fdvUsd) ? 'fdv' : positive(value.marketCapUsd) ? 'marketCap' : null;
  const valueUsd = basis === 'fdv' ? value.fdvUsd : basis === 'marketCap' ? value.marketCapUsd : null;
  const computed = valueUsd !== null && value.oiUsd != null && Number.isFinite(value.oiUsd) && value.oiUsd >= 0
    ? value.oiUsd / valueUsd * 100 : null;
  return { basis, valueUsd, ratio: computed !== null && Number.isFinite(computed) ? computed : null, label: valuationLabel(basis) };
}

export function valuationPair(current: Values, initial: Values) {
  const latest = selectValuation(current), baseline = selectValuation(initial);
  const issue = latest.basis === null || baseline.basis === null ? '估值端点缺失或无效'
    : latest.basis !== baseline.basis ? '估值口径切换（FDV / 流通市值），不跨口径计算变化' : null;
  return { latest, baseline, issue };
}

/** Independent validation: unavailable CoinGecko identity must not discard contract-bound CMC supply. */
export function hasFreshMarketCapEvidence(asset: AssetRow, now: number): boolean {
  const evidence = asset.evidence.marketCap;
  if (!evidence || evidence.provider !== 'Binance' || evidence.upstream !== 'CoinMarketCap'
    || !positive(evidence.circulatingSupply) || !positive(evidence.unitMultiplier)
    || !fresh(evidence.sourceTime, now) || !fresh(evidence.fetchedAt, now)) return false;
  const contract = asset.evidence.contracts.find(item => item.symbol === evidence.contractSymbol);
  if (!contract || !asset.contracts.includes(evidence.contractSymbol) || (contract.unitMultiplier ?? 1) !== evidence.unitMultiplier) return false;
  try {
    const url = new URL(evidence.url);
    return url.origin === 'https://fapi.binance.com' && !url.username && !url.password
      && url.pathname === '/futures/data/openInterestHist' && url.searchParams.get('symbol') === evidence.contractSymbol
      && url.searchParams.get('period') === '5m';
  } catch { return false; }
}
