import type { MarkObservation } from './positionTypes';

/** Public order-flow contracts. Prices and amounts retain the market's quote currency (NOT silently USD). */
export type FlowVenue = 'futures' | 'spot';
export interface FlowMarket { key: string; venue: FlowVenue; symbol: string; baseAsset: string; quoteAsset: string; assetId: string; }
export interface FlowCandle {
  marketKey: string; openTime: number; closeTime: number; open: number; high: number; low: number; close: number;
  volume: number; quoteVolume: number; takerBuyQuote: number; trades: number; closed: boolean;
  sourceTime: number; receivedAt: number; source: 'rest' | 'stream';
}
export interface FlowTrade {
  marketKey: string; id: string; price: string; quantity: string; quoteQuantity: string;
  timestamp: number; receivedAt: number; side: 'buy' | 'sell';
}
export interface FlowQuote {
  marketKey: string; markPrice: number; indexPrice: number; fundingRate: number | null;
  nextFundingTime: number | null; fundingIntervalHours: number | null; timestamp: number; receivedAt: number;
}
export interface FlowOi { marketKey: string; quantity: number; timestamp: number; receivedAt: number; }
export interface FlowDepth {
  marketKey: string; timestamp: number; receivedAt: number; bid: number; ask: number;
  bidDepthQuote: number; askDepthQuote: number; bandBps: number; spreadBps: number;
  buySlippageBps: number | null; sellSlippageBps: number | null; orderSizeQuote: number;
  complete: boolean; reason: string | null;
}
export type FlowEventKind = 'large_buy' | 'large_sell' | 'buy_pressure' | 'sell_pressure' | 'breakout_up' | 'breakout_down' | 'flow_divergence' | 'liquidity_drop';
export interface FlowEvidence { label: string; value: number | null; unit: string; baseline?: number | null; }
export interface FlowOutcome { minutes: 1 | 5 | 15; price: number; changePct: number; availableAt: number; entryPrice?: number; entryAt?: number; }
export interface FlowEvent {
  id: string; ruleVersion: 'flow-v1'; marketKey: string; symbol: string; assetId: string; venue: FlowVenue;
  quoteAsset: string; kind: FlowEventKind; severity: 'info' | 'warning'; title: string;
  timestamp: number; detectedAt: number; referencePrice: number; evidence: FlowEvidence[];
  reason: string; invalidation: string; dataStatus: 'complete'; rawTrade?: FlowTrade;
  outcomes: FlowOutcome[];
}
export interface FlowMetrics {
  market: FlowMarket; asOf: number; status: 'warming' | 'live' | 'stale' | 'disconnected'; reason: string;
  price: number | null; priceChange5m: number | null; volume5m: number | null; buyShare5m: number | null;
  delta5m: number | null; volumeMultiple: number | null; vwap5m: number | null; range5mPct: number | null;
  atr14: number | null; oiChange5m: number | null; funding: FlowQuote | null; depth: FlowDepth | null;
  baselineWindows: number; tradeSamples: number; largeTradeThreshold: number | null;
  lastTradeAt: number | null; lastCandleAt: number | null;
}
export interface FlowStatus {
  mode: 'direct' | 'server'; startedAt: number; asOf: number; connectedStreams: number; totalStreams: number;
  markets: number; readyMarkets: number; warmingMarkets: number; staleMarkets: number;
  backfilledMarkets: number; errors: string[]; retentionDays: number; scope: string;
}
export interface FlowSnapshot {
  schemaVersion: 1; status: FlowStatus; rows: FlowMetrics[]; events: FlowEvent[];
  /** Independent raw mark-price observations, never inferred from trades or gated by funding metadata. */
  marks?: MarkObservation[];
}
export interface FlowHistory { market: FlowMarket | null; candles: FlowCandle[]; events: FlowEvent[]; depth: FlowDepth[]; oi: FlowOi[]; from: number; to: number; }
export interface FlowUpdate { candles: FlowCandle[]; events: FlowEvent[]; depth: FlowDepth[]; oi: FlowOi[]; }
export interface FlowFeedOptions {
  mode: 'direct' | 'server'; onUpdate?: (update: FlowUpdate) => void | Promise<void>;
  onChange?: () => void; fetcher?: typeof fetch; now?: () => number;
  /** Tests may use an injected socket factory; production uses the platform WebSocket. */
  socketFactory?: (url: string) => WebSocket;
}
