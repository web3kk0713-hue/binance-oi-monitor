import type { DirectionConfig } from './directionConfig';
import type { StructureAdvice } from './structureTypes';

/** Private, manually declared linear USDT positions. Never part of public market snapshots. */
export interface ManualPosition {
  id: string; marketKey: string; symbol: string; assetId: string; side: 'long' | 'short';
  entryPrice: string; margin: string; leverage: string; createdAt: number;
  /** Actual exchange fill time entered by the user; absent in legacy records. */
  openedAt?: number;
  /** Carries the reviewed market-plan preference only; no reminder is armed by this field. */
  suggestedHoldingLimitMs?: number;
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
  method: 'atr-example' | 'manual' | 'structure-v1'; generatedAt: number;
  structure?: StructureAdvice;
  holdingLimitMs?: number;
}
export interface ConfirmedRiskPlan extends RiskPlanDraft {
  revision: number; confirmedAt: number;
  /** Frozen at adoption. Reanalysis must not move an active deadline. */
  deadlineAt?: number; timingBasis?: 'opened-at' | 'adopted-at';
}
export type PositionRule = 'stop' | 'take-profit' | 'trailing' | 'signal-weakening' | 'time-exit';
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
