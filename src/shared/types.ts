/** All ratios are percentages (72 means 72%), all times epoch milliseconds. */
export type AlertLevel = 'warning' | 'danger' | 'critical';
export interface Thresholds { warning: number; danger: number; critical: number; cooldownMinutes: number; }
export const DEFAULT_THRESHOLDS: Thresholds = { warning: 70, danger: 90, critical: 100, cooldownMinutes: 30 };
export interface SourceStamp { provider: string; url: string; observedAt: number; sourceTime: number | null; }
export interface ContractEvidence {
  symbol: string; baseAsset: string; quoteAsset: string;
  openInterest: string | null; markPrice: string | null; indexPrice: string | null;
  quoteUsd: string | null; oiTime: number | null; priceTime: number | null;
  oiUsd: number | null; error?: string;
  quoteTime?: number | null; sources?: SourceStamp[];
}
export interface SupplyEvidence {
  provider: 'CoinMarketCap' | 'CoinGecko'; id: string;
  circulating: number | null; total: number | null; max: number | null;
  updatedAt: number; fetchedAt: number; url: string;
  mappingUrl?: string;
  /** Provider USD token price used only to reject inconsistent identity mappings. */
  providerPriceUsd?: number | null;
}
export interface AssetRow {
  id: string; symbol: string; name: string; contracts: string[];
  priceUsd: number | null; oiUsd: number | null;
  marketCapUsd: number | null; fdvUsd: number | null;
  oiToFdv: number | null; oiToMarketCap: number | null;
  circulatingSupply: number | null; maxSupply: number | null;
  updatedAt: number; oiUpdatedAt: number | null; priceUpdatedAt: number | null; supplyUpdatedAt: number | null;
  complete: boolean; alertEligible: boolean; issues: string[];
  supplySource: string | null; mappingStatus: 'verified' | 'unmapped';
  evidence: { contracts: ContractEvidence[]; supply: SupplyEvidence | null; mapping: string };
}
export interface Snapshot {
  schemaVersion: 1; mode: 'direct' | 'server'; startedAt: number; asOf: number;
  durationMs: number; universe: { contracts: number; assets: number };
  coverage: { oi: number; marketCap: number; fdv: number; eligible: number; failedContracts: number };
  assets: AssetRow[]; errors: string[];
}
export interface CollectionProgress { stage: string; done: number; total: number; failed: number; }
export interface HistoryPoint {
  assetId: string; timestamp: number; oiUsd: number | null; marketCapUsd: number | null;
  fdvUsd: number | null; oiToFdv: number | null; oiToMarketCap: number | null;
  complete: boolean;
}
export interface AlertEvent {
  id: string; assetId: string; symbol: string; level: AlertLevel;
  ratio: number; oiUsd: number; fdvUsd: number; timestamp: number;
}
export interface AlertState { assetId: string; lastLevel: number; lastSentAt: number; }
export interface CollectorOptions {
  mode?: 'direct' | 'server'; concurrency?: number; cmcApiKey?: string;
  fetcher?: typeof fetch;
  initialSnapshot?: Snapshot;
}
export interface Collector {
  collect(options?: { signal?: AbortSignal; onProgress?: (progress: CollectionProgress) => void }): Promise<Snapshot>;
}
export interface BackendStatus {
  mode: 'server'; version: string; collecting: boolean; lastSuccess: number | null;
  storage: string; pushEnabled: boolean; retentionDays: number; lastError: string | null;
}
