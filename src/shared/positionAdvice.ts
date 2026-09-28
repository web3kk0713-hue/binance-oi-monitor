import Decimal from 'decimal.js';
import { isDirectionConfig, type DirectionConfig } from './directionConfig';
import { proposeRiskPlan, valuePosition } from './positionRisk';
import type { ManualPosition, PositionMarketFrame, RiskPlanDraft } from './positionTypes';

const D = Decimal.clone({ precision: 80 });
export interface PositionAdvice {
  plan: RiskPlanDraft;
  referencePrice: string;
  markSourceTime: number;
  atr: string;
  currentPnl: string;
  stopPnl: string;
  targetPnl: string;
  stopReturnPct: string;
  targetReturnPct: string;
  additionalRisk: string;
  additionalRiskPct: string;
  targetStillLoss: boolean;
  signalStatus: 'aligned' | 'opposed' | 'wait' | 'unavailable';
  signalReason: string;
}

/** A frozen explanation of the existing volatility rule, not a new strategy or an AI prediction. */
export function proposePositionAdvice(position: ManualPosition, frame: PositionMarketFrame, now: number,
  config: DirectionConfig): { advice: PositionAdvice | null; error: string | null } {
  const result = proposeRiskPlan(position, frame, now, config);
  if (!result.plan) return { advice: null, error: result.error };
  const plan = result.plan, valuation = valuePosition(position, frame, now)!;
  const quantity = new D(valuation.quantity), sign = position.side === 'long' ? 1 : -1;
  const pnlAt = (price: string) => quantity.mul(new D(price).minus(position.entryPrice)).mul(sign);
  const stopPnl = pnlAt(plan.stopPrice), targetPnl = pnlAt(plan.takeProfitPrice);
  const additionalRisk = new D(valuation.pnl).minus(stopPnl);
  const signal = frame.signal;
  const signalReady = !!signal && signal.valid === true && signal.marketKey === position.marketKey
    && Number.isSafeInteger(signal.asOf) && signal.asOf <= now && now - signal.asOf <= 30_000
    && Number.isSafeInteger(signal.windowEnd) && signal.windowEnd > 0 && signal.windowEnd % 60_000 === 0
    && signal.windowEnd <= signal.asOf && signal.asOf - signal.windowEnd < 60_000 && now - signal.windowEnd <= 90_000
    && isDirectionConfig(signal.config) && signal.config.oiPct === config.oiPct && signal.config.pricePct === config.pricePct
    && signal.config.flowSharePct === config.flowSharePct && signal.config.requireSpot === config.requireSpot;
  const signalStatus: PositionAdvice['signalStatus'] = !signalReady || !['long', 'short', 'wait'].includes(signal!.bias)
    ? 'unavailable' : signal!.bias === 'wait' ? 'wait' : signal!.bias === position.side ? 'aligned' : 'opposed';
  const signalReason = {
    aligned: '当前有效5分钟信号与持仓同向；建议按保护方案跟踪，不把同向信号当作加仓依据。',
    opposed: '当前有效5分钟信号与持仓反向；建议优先防守并关注离场风险，不代表必然反转。',
    wait: '当前5分钟信号没有确认方向；建议先安排价格保护，不因观望信号推迟止损。',
    unavailable: '方向数据不足或过期；本次只给价格保护建议，不判断持仓方向是否有利。',
  }[signalStatus];
  return { advice: { plan, referencePrice: valuation.markPrice, markSourceTime: frame.mark!.sourceTime,
    atr: frame.atr!.value, currentPnl: valuation.pnl, stopPnl: stopPnl.toFixed(), targetPnl: targetPnl.toFixed(),
    stopReturnPct: stopPnl.div(position.margin).mul(100).toFixed(),
    targetReturnPct: targetPnl.div(position.margin).mul(100).toFixed(),
    additionalRisk: additionalRisk.toFixed(), additionalRiskPct: additionalRisk.div(position.margin).mul(100).toFixed(),
    targetStillLoss: targetPnl.lt(0), signalStatus, signalReason }, error: null };
}
