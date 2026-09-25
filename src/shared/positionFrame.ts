import Decimal from 'decimal.js';
import { assessDirection } from './direction';
import { isDirectionConfig, type DirectionConfig } from './directionConfig';
import type { FlowSnapshot } from './flowTypes';
import { createPositionRisk, valuePosition } from './positionRisk';
import type { ManualPosition, MarkObservation, PositionMarketFrame } from './positionTypes';
import type { Snapshot } from './types';

const time = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const empty = (): PositionMarketFrame => ({ mark: null, atr: null, signal: null });

/** Read-only adapters over the existing feeds: no subscription, fetch, or last-good substitution. */
export function positionMarketFrame(position: ManualPosition, flowSnapshot: FlowSnapshot | null,
  valuationSnapshot: Snapshot | null, now: number, config: DirectionConfig): PositionMarketFrame {
  const frame = empty();
  try { createPositionRisk(position); } catch { return frame; }
  if (!time(now) || now < position.createdAt) return frame;
  const flowAsOf = flowSnapshot?.status?.asOf;
  const usableFlow = flowSnapshot?.schemaVersion === 1 && time(flowAsOf) && flowAsOf <= now && now - flowAsOf <= 30_000;
  const rows = Array.isArray(flowSnapshot?.rows) ? flowSnapshot.rows : [];
  const exactRows = usableFlow ? rows.filter(row => row?.market?.key === position.marketKey && row.market.symbol === position.symbol
    && row.market.assetId === position.assetId && row.market.venue === 'futures' && row.market.quoteAsset === 'USDT') : [];
  const row = exactRows.length === 1 ? exactRows[0] : null;
  const validCandidate = (mark: MarkObservation) => valuePosition(position, { mark, atr: null, signal: null }, now) !== null;
  // Multiple contradictory values at the latest timestamp are not resolved by array order.
  const choose = (marks: MarkObservation[]): { mark: MarkObservation | null; conflict: boolean } => {
    if (!marks.length) return { mark: null, conflict: false };
    const sorted = [...marks].sort((a, b) => b.sourceTime - a.sourceTime || a.receivedAt - b.receivedAt);
    const latest = sorted[0], sameTime = sorted.filter(mark => mark.sourceTime === latest.sourceTime);
    if (sameTime.some(mark => !new Decimal(mark.markPrice).eq(latest.markPrice))) return { mark: null, conflict: true };
    return { mark: { ...latest }, conflict: false };
  };
  const stream = row && Array.isArray(flowSnapshot?.marks) ? choose(flowSnapshot.marks.filter(mark => mark?.marketKey === position.marketKey
    && mark.source === 'binance-mark-stream' && mark.receivedAt <= flowAsOf! && validCandidate(mark))) : { mark: null, conflict: false };
  frame.mark = stream.mark;
  if (!frame.mark && !stream.conflict && valuationSnapshot?.schemaVersion === 1 && time(valuationSnapshot.asOf)
    && valuationSnapshot.asOf <= now && Array.isArray(valuationSnapshot.assets)) {
    const assets = valuationSnapshot.assets.filter(asset => asset?.id === position.assetId && Array.isArray(asset.contracts)
      && asset.contracts.includes(position.symbol) && Array.isArray(asset.evidence?.contracts));
    const candidates: MarkObservation[] = [];
    for (const asset of assets) for (const contract of asset.evidence.contracts) {
      if (contract?.symbol !== position.symbol || contract.quoteAsset !== 'USDT' || typeof contract.markPrice !== 'string'
        || !time(contract.priceTime) || !time(contract.priceObservedAt) || contract.priceObservedAt > valuationSnapshot.asOf) continue;
      const mark: MarkObservation = { marketKey: position.marketKey, markPrice: contract.markPrice, sourceTime: contract.priceTime,
        receivedAt: contract.priceObservedAt, source: 'binance-premium-rest' };
      if (validCandidate(mark)) candidates.push(mark);
    }
    frame.mark = choose(candidates).mark;
  }
  // atr14 is computed by the existing engine from 15 consecutive CLOSED 1m
  // candles. lastCandleAt is only feed freshness and may belong to an open candle.
  if (row && row.status === 'live' && time(row.asOf) && row.asOf <= flowAsOf! && now - row.asOf <= 30_000
    && time(row.lastCandleAt) && row.lastCandleAt <= row.asOf && now - row.lastCandleAt <= 90_000
    && typeof row.atr14 === 'number' && Number.isFinite(row.atr14) && row.atr14 > 0) {
    frame.atr = { marketKey: position.marketKey, value: String(row.atr14), asOf: row.asOf, lastCandleAt: row.lastCandleAt };
  }
  if (row && isDirectionConfig(config)) {
    const direction = assessDirection(flowSnapshot, position.assetId, now, position.marketKey, config);
    if (direction.marketKey === position.marketKey && direction.windowEnd !== null && direction.asOf !== null && direction.config) {
      frame.signal = { marketKey: direction.marketKey, windowEnd: direction.windowEnd, asOf: direction.asOf,
        valid: direction.quality === 'valid', bias: direction.bias, config: { ...direction.config } };
    }
  }
  return frame;
}
