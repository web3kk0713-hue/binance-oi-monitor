import type { DirectionConfig } from './directionConfig';
import type { FlowMarket } from './flowTypes';
import type { MarkObservation } from './positionTypes';
import type { StructureHistory } from './structureTypes';

/** A conditional entry watch, not a filled position or a profitability claim. */
export interface MarketPlan {
  version: 'entry-structure-v1'; id: string; market: FlowMarket; side: 'long' | 'short';
  generatedAt: number; asOf: number; referencePrice: string; tickSize: string;
  entryLow: string; entryHigh: string; stopPrice: string; targetPrice: string; netRewardRisk: string;
  roundTripCostBps: 12; waitUntil: number; holdingLimitMs: number; directionConfig: DirectionConfig;
  historyFrom: number; historyTo: number;
  support: { price: string; confirmedAt: number }; resistance: { price: string; confirmedAt: number };
  atr15: string; buffer: string; reasons: string[];
}
export interface MarketPlanInput {
  id: string; market: FlowMarket; side: 'long' | 'short'; history: StructureHistory;
  reference: MarkObservation; now: number; holdingLimitMs: number; directionConfig: DirectionConfig;
}
export type MarketPlanResult = { status: 'ready'; plan: MarketPlan } | { status: 'unavailable'; reason: string };
