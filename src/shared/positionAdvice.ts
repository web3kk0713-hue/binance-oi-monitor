import Decimal from 'decimal.js';
import { isDirectionConfig, type DirectionConfig } from './directionConfig';
import { HOLDING_LIMITS_MS, proposeRiskPlan, RISK_PROPOSAL_TTL_MS, valuePosition } from './positionRisk';
import { validateStructureAdvice } from './structureReplay';
import type { ManualPosition, PositionMarketFrame, RiskPlanDraft } from './positionTypes';
import type { StructureAdvice } from './structureTypes';

const D = Decimal.clone({ precision: 80 });

/** Explicit bridge from a frozen live structure proposal to opt-in price/time reminders. */
export function proposeStructureRiskPlan(position: ManualPosition, advice: StructureAdvice, config: DirectionConfig,
  now: number, holdingLimitMs = position.suggestedHoldingLimitMs ?? 4 * 3_600_000): { plan: RiskPlanDraft | null; error: string | null } {
  const reject = (error: string) => ({ plan: null, error });
  if (!validateStructureAdvice(advice) || advice.mode !== 'live' || !isDirectionConfig(config)
    || !Number.isSafeInteger(now) || now <= 0 || !HOLDING_LIMITS_MS.includes(holdingLimitMs)) return reject('结构方案或持有上限无效，未启用提醒');
  if (!['id', 'marketKey', 'symbol', 'assetId', 'side', 'entryPrice', 'margin', 'leverage', 'createdAt', 'openedAt', 'suggestedHoldingLimitMs']
    .every(key => advice.position[key as keyof ManualPosition] === position[key as keyof ManualPosition])) return reject('结构方案与当前持仓不一致，请重新分析');
  if (now < advice.generatedAt || now - advice.generatedAt >= RISK_PROPOSAL_TTL_MS) return reject('结构建议已过期，请重新分析；原计划保持不变');
  if (new D(advice.additionalRisk).gte(position.margin)) return reject('到保护价的额外估算损失已达到录入保证金，不能采纳；请先在交易所核查强平风险');
  return { plan: { stopPrice: advice.stop.price, takeProfitPrice: advice.target1.price, trailing: null,
    signalWeakening: false, directionConfig: { ...config }, method: 'structure-v1', generatedAt: advice.generatedAt,
    structure: structuredClone(advice), holdingLimitMs }, error: null };
}
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
