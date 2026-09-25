import type { DirectionConfig } from './directionConfig';

/** Private, manually declared linear USDT positions. Never part of public market snapshots. */
export interface ManualPosition {
  id: string; marketKey: string; symbol: string; assetId: string; side: 'long' | 'short';
  entryPrice: string; margin: string; leverage: string; createdAt: number;
}
export interface MarkObservation {
  marketKey: string; markPrice: string; sourceTime: number; receivedAt: number;
  source: 'binance-mark-stream' | 'binance-premium-rest';
}
export interface PositionMarketFrame {
  mark: MarkObservation | null;
  atr: { marketKey: string; value: string; asOf: number; lastCandleAt: number } | null;
  signal: { marketKey: string; windowEnd: number; asOf: number; valid: boolean; bias: 'long' | 'short' | 'wait'; config: DirectionConfig } | null;
}
export interface RiskPlanDraft {
  stopPrice: string; takeProfitPrice: string;
  trailing: { activationPrice: string; callbackPct: string } | null;
  signalWeakening: boolean; directionConfig: DirectionConfig;
  method: 'atr-example' | 'manual'; generatedAt: number;
}
export interface ConfirmedRiskPlan extends RiskPlanDraft { revision: number; confirmedAt: number; }
export type PositionRule = 'stop' | 'take-profit' | 'trailing' | 'signal-weakening';
export interface PositionRiskEvent {
  id: string; positionId: string; planRevision: number; symbol: string; side: 'long' | 'short';
  rule: PositionRule; timestamp: number; sourceTime: number; markPrice: string;
  title: string; message: string; afterGap: boolean;
}
export interface PositionRiskState {
  position: ManualPosition; phase: 'draft' | 'armed' | 'triggered' | 'closed';
  plan: ConfirmedRiskPlan | null; lastMark: MarkObservation | null;
  bestPrice: string | null; trailingActive: boolean; fired: PositionRule[];
  signalBaseline: boolean; weakWindows: number; lastSignalWindow: number | null;
  gap: boolean; closedAt: number | null;
}
export interface PositionValuation { quantity: string; notional: string; pnl: string; returnOnMarginPct: string; markPrice: string; }
export type PositionRiskCommand =
  | { type: 'confirm'; plan: RiskPlanDraft; expectedPlanRevision: number; frame: PositionMarketFrame; now: number }
  | { type: 'tick'; frame: PositionMarketFrame; now: number }
  | { type: 'close'; now: number };
export interface PositionRiskResult { state: PositionRiskState; valuation: PositionValuation | null; events: PositionRiskEvent[]; error: string | null; }
export interface PositionBook {
  schemaVersion: 1; revision: number; positions: PositionRiskState[];
  events: PositionRiskEvent[]; notified: string[]; updatedAt: number;
}
