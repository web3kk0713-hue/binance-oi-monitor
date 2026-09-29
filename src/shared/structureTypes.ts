import type { ManualPosition, MarkObservation } from './positionTypes';

/** Closed-candle structure proposals; explicit opt-in conversion is required before price/time reminders. */
export const STRUCTURE_INTERVAL_MS = 300_000;
export const STRUCTURE_LOOKBACK_MS = 7 * 86_400_000;
export interface StructureCandle {
  openTime: number; closeTime: number;
  open: string; high: string; low: string; close: string;
}
export interface StructureHistory {
  schemaVersion: 1; marketKey: string; symbol: string; tickSize: string;
  intervalMs: 300000; from: number; to: number; fetchedAt: number;
  candles: StructureCandle[];
}
export interface StructureLevel {
  price: string; structurePrice: string; confirmedAt: number;
  pnl: string; returnOnMarginPct: string;
}
export interface StructureTrend {
  interval: '5m' | '15m' | '1h' | '4h';
  direction: 'up' | 'down' | 'flat' | 'unavailable';
  changePct: string | null; from: number | null; to: number | null;
}
export interface StructureAdvice {
  version: 'structure-v1'; mode: 'live' | 'replay'; position: ManualPosition;
  generatedAt: number; asOf: number; referencePrice: string; tickSize: string;
  historyFrom: number; historyTo: number; atr15: string; buffer: string;
  quantity: string; currentPnl: string; additionalRisk: string; additionalRiskPct: string;
  remainingRewardRisk: string; stop: StructureLevel; target1: StructureLevel; target2: StructureLevel | null;
  trends: StructureTrend[]; reasons: string[]; warnings: string[];
}
export type StructureResult = { status: 'ready'; advice: StructureAdvice }
  | { status: 'unavailable'; code: 'identity' | 'invalid' | 'history' | 'stale' | 'structure' | 'space'; reason: string };
export interface StructureInput {
  position: ManualPosition; history: StructureHistory; reference: MarkObservation;
  now: number; mode: 'live' | 'replay';
}
export interface StructureReplay {
  outcome: 'stop' | 'target1' | 'ambiguous' | 'unresolved' | 'incomplete';
  touchedAt: number | null; observedTo: number; bars: number; reason: string;
}
export interface StructureTouch {
  rule: 'stop' | 'target1' | 'target2'; sourceTime: number; receivedAt: number; price: string; afterGap: boolean;
}
export interface StructureShadow {
  id: string; advice: StructureAdvice; startedAt: number; stoppedAt: number | null;
  lastMark: MarkObservation | null; gap: boolean; touches: StructureTouch[];
}
export interface StructureShadowBook {
  schemaVersion: 1; revision: number; updatedAt: number; records: StructureShadow[];
}
