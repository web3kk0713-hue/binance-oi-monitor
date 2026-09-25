import Decimal from 'decimal.js';
import { isDirectionConfig, type DirectionConfig } from './directionConfig';
import type { ConfirmedRiskPlan, ManualPosition, MarkObservation, PositionMarketFrame, PositionRiskCommand,
  PositionRiskEvent, PositionRiskResult, PositionRiskState, PositionRule, PositionValuation, RiskPlanDraft } from './positionTypes';

const D = Decimal.clone({ precision: 80 });
const RULES: PositionRule[] = ['stop', 'take-profit', 'trailing', 'signal-weakening'];
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const time = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function positive(value: unknown): Decimal | null {
  if (typeof value !== 'string' || value.length > 128 || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return null;
  try { const number = new D(value); return number.isFinite() && number.gt(0) && Math.abs(number.e) <= 100 ? number : null; }
  catch { return null; }
}
function validPosition(value: unknown): value is ManualPosition {
  if (!record(value)) return false;
  return typeof value.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value.id)
    && typeof value.symbol === 'string' && /^[A-Z0-9_]{1,36}USDT$/.test(value.symbol)
    && value.marketKey === `futures:${value.symbol}` && typeof value.assetId === 'string'
    && /^[A-Za-z0-9:_-]{1,120}$/.test(value.assetId) && (value.side === 'long' || value.side === 'short')
    && positive(value.entryPrice) !== null && positive(value.margin) !== null
    && positive(value.leverage)?.gte(1) === true && positive(value.leverage)?.lte(125) === true && time(value.createdAt);
}
const configEqual = (a: DirectionConfig, b: DirectionConfig) => a.oiPct === b.oiPct && a.pricePct === b.pricePct
  && a.flowSharePct === b.flowSharePct && a.requireSpot === b.requireSpot;
function validMarkShape(value: unknown, position: ManualPosition): value is MarkObservation {
  return record(value) && value.marketKey === position.marketKey && positive(value.markPrice) !== null
    && time(value.sourceTime) && time(value.receivedAt) && value.sourceTime <= value.receivedAt
    && (value.source === 'binance-mark-stream' || value.source === 'binance-premium-rest');
}
function freshMark(value: unknown, position: ManualPosition, now: number): value is MarkObservation {
  if (!time(now) || position.createdAt > now || !validMarkShape(value, position)) return false;
  const age = value.source === 'binance-mark-stream' ? 15_000 : 45_000;
  return value.receivedAt <= now && now - value.sourceTime <= age && now - value.receivedAt <= age;
}
function validPlan(value: unknown, position: ManualPosition): value is RiskPlanDraft {
  if (!record(value) || !positive(value.stopPrice) || !positive(value.takeProfitPrice)
    || !time(value.generatedAt) || value.generatedAt < position.createdAt || typeof value.signalWeakening !== 'boolean'
    || !isDirectionConfig(value.directionConfig) || (value.method !== 'atr-example' && value.method !== 'manual')) return false;
  const stop = new D(value.stopPrice as string), target = new D(value.takeProfitPrice as string);
  if (position.side === 'long' ? stop.gte(target) : stop.lte(target)) return false;
  if (value.trailing === null) return true;
  if (!record(value.trailing)) return false;
  const activation = positive(value.trailing.activationPrice), callback = positive(value.trailing.callbackPct);
  if (!activation || !callback || callback.gte(100)) return false;
  return position.side === 'long' ? activation.gt(stop) && activation.lt(target) : activation.lt(stop) && activation.gt(target);
}
function planCopy(plan: RiskPlanDraft): RiskPlanDraft {
  return { stopPrice: new D(plan.stopPrice).toFixed(), takeProfitPrice: new D(plan.takeProfitPrice).toFixed(),
    trailing: plan.trailing ? { activationPrice: new D(plan.trailing.activationPrice).toFixed(), callbackPct: new D(plan.trailing.callbackPct).toFixed() } : null,
    signalWeakening: plan.signalWeakening, directionConfig: { oiPct: plan.directionConfig.oiPct, pricePct: plan.directionConfig.pricePct,
      flowSharePct: plan.directionConfig.flowSharePct, requireSpot: plan.directionConfig.requireSpot }, method: plan.method, generatedAt: plan.generatedAt };
}
const sameDraft = (a: RiskPlanDraft, b: RiskPlanDraft) => JSON.stringify(planCopy(a)) === JSON.stringify(planCopy(b));

/** Strict recovery validation. Historical marks need not still be fresh; evaluation checks freshness again. */
export function validPositionState(value: unknown): value is PositionRiskState {
  if (!record(value) || !validPosition(value.position) || typeof value.phase !== 'string' || !['draft', 'armed', 'triggered', 'closed'].includes(value.phase)
    || typeof value.trailingActive !== 'boolean' || typeof value.signalBaseline !== 'boolean' || typeof value.gap !== 'boolean'
    || !integer(value.weakWindows) || value.weakWindows > 2
    || !(value.lastSignalWindow === null || time(value.lastSignalWindow) && value.lastSignalWindow % 60_000 === 0)
    || !(value.bestPrice === null || positive(value.bestPrice))
    || !Array.isArray(value.fired) || value.fired.length > RULES.length
    || !value.fired.every(rule => RULES.includes(rule as PositionRule)) || new Set(value.fired).size !== value.fired.length
    || !(value.closedAt === null || time(value.closedAt) && value.closedAt >= value.position.createdAt)
    || !(value.lastMark === null || validMarkShape(value.lastMark, value.position))) return false;
  if (value.phase === 'closed' ? value.closedAt === null : value.closedAt !== null) return false;
  if (value.plan === null) return (value.phase === 'draft' || value.phase === 'closed') && value.fired.length === 0
    && value.bestPrice === null && !value.trailingActive && !value.signalBaseline && value.weakWindows === 0 && value.lastSignalWindow === null;
  if (!validPlan(value.plan, value.position) || !record(value.plan) || !integer(value.plan.revision) || value.plan.revision < 1
    || !time(value.plan.confirmedAt) || value.plan.confirmedAt < value.plan.generatedAt || value.phase === 'draft' || value.lastMark === null) return false;
  if (value.phase === 'armed' && value.fired.length > 0 || value.phase === 'triggered' && value.fired.length === 0) return false;
  if (value.closedAt !== null && value.closedAt < value.plan.confirmedAt) return false;
  if (value.closedAt !== null && value.closedAt < value.lastMark.receivedAt) return false;
  if (value.lastMark.receivedAt < value.plan.confirmedAt - 45_000) return false;
  if (value.lastSignalWindow !== null && (value.lastSignalWindow > value.lastMark.receivedAt + 45_000
    || value.lastSignalWindow < value.plan.confirmedAt - 90_000)) return false;
  if (value.plan.trailing === null && (value.trailingActive || value.bestPrice !== null || value.fired.includes('trailing'))) return false;
  if (value.trailingActive && value.bestPrice === null) return false;
  if (!value.trailingActive && value.bestPrice !== null) return false;
  if (value.trailingActive && value.plan.trailing && (value.position.side === 'long'
    ? new D(value.bestPrice as string).lt(value.plan.trailing.activationPrice) : new D(value.bestPrice as string).gt(value.plan.trailing.activationPrice))) return false;
  if (value.fired.includes('trailing') && !value.trailingActive) return false;
  if (!value.plan.signalWeakening && (value.signalBaseline || value.weakWindows !== 0 || value.lastSignalWindow !== null || value.fired.includes('signal-weakening'))) return false;
  if (value.weakWindows > 0 && (!value.signalBaseline || value.lastSignalWindow === null)) return false;
  return true;
}

export function createPositionRisk(position: ManualPosition): PositionRiskState {
  if (!validPosition(position)) throw new Error('持仓输入无效：仅支持精确 USDT 合约、正数价格/保证金及1至125倍杠杆');
  return { position: { id: position.id, marketKey: position.marketKey, symbol: position.symbol, assetId: position.assetId,
    side: position.side, entryPrice: position.entryPrice, margin: position.margin, leverage: position.leverage, createdAt: position.createdAt },
    phase: 'draft', plan: null, lastMark: null, bestPrice: null,
    trailingActive: false, fired: [], signalBaseline: false, weakWindows: 0, lastSignalWindow: null, gap: false, closedAt: null };
}

export function valuePosition(position: ManualPosition, frame: PositionMarketFrame, now: number): PositionValuation | null {
  if (!validPosition(position) || !freshMark(frame?.mark, position, now)) return null;
  const notional = new D(position.margin).mul(position.leverage), quantity = notional.div(position.entryPrice);
  const pnl = quantity.mul(new D(frame.mark.markPrice).minus(position.entryPrice)).mul(position.side === 'long' ? 1 : -1);
  return { quantity: quantity.toFixed(), notional: notional.toFixed(), pnl: pnl.toFixed(),
    returnOnMarginPct: pnl.div(position.margin).mul(100).toFixed(), markPrice: new D(frame.mark.markPrice).toFixed() };
}

export function proposeRiskPlan(position: ManualPosition, frame: PositionMarketFrame, now: number, config: DirectionConfig): { plan: RiskPlanDraft | null; error: string | null } {
  if (!validPosition(position) || !isDirectionConfig(config)) return { plan: null, error: '持仓或方向参数无效' };
  if (!freshMark(frame?.mark, position, now)) return { plan: null, error: '缺少新鲜的同合约标记价，暂不生成方案' };
  const atr = frame.atr;
  if (!atr || atr.marketKey !== position.marketKey || !positive(atr.value) || !time(atr.asOf) || !time(atr.lastCandleAt)
    || atr.lastCandleAt > atr.asOf || atr.asOf > now || now - atr.asOf > 30_000 || now - atr.lastCandleAt > 90_000)
    return { plan: null, error: '同合约 ATR 数据缺失或过期；可等待完整数据或主动填写手动方案' };
  const price = new D(frame.mark.markPrice), unit = new D(atr.value), distance = unit.mul(2), side = position.side === 'long' ? 1 : -1;
  const activation = price.plus(distance.mul(side));
  const plan: RiskPlanDraft = { stopPrice: price.minus(distance.mul(side)).toFixed(), takeProfitPrice: price.plus(distance.mul(side).mul(2)).toFixed(),
    trailing: { activationPrice: activation.toFixed(), callbackPct: activation.gt(0) ? unit.div(activation).mul(100).toSignificantDigits(6).toFixed() : '0' },
    signalWeakening: true, directionConfig: { ...config }, method: 'atr-example', generatedAt: now };
  return validPlan(plan, position) ? { plan, error: null } : { plan: null, error: '当前波动示例会产生无效价格或回撤比例，请改用手动方案' };
}

function validSignal(frame: PositionMarketFrame, state: PositionRiskState, now: number): boolean {
  const signal = frame.signal, plan = state.plan;
  return !!signal && !!plan && signal.valid === true && signal.marketKey === state.position.marketKey
    && ['long', 'short', 'wait'].includes(signal.bias) && time(signal.asOf) && signal.asOf <= now && now - signal.asOf <= 30_000
    && time(signal.windowEnd) && signal.windowEnd % 60_000 === 0 && signal.windowEnd <= signal.asOf
    && signal.asOf - signal.windowEnd < 60_000 && now - signal.windowEnd <= 90_000
    && isDirectionConfig(signal.config) && configEqual(signal.config, plan.directionConfig);
}
function resetSignal(state: PositionRiskState) { state.signalBaseline = false; state.weakWindows = 0; state.lastSignalWindow = null; }

export function stepPositionRisk(previous: PositionRiskState, command: PositionRiskCommand): PositionRiskResult {
  const rejected = (error: string): PositionRiskResult => ({ state: previous, valuation: null, events: [], error });
  if (!validPositionState(previous)) return rejected('持仓状态损坏，已停止风险判断');
  if (!command || !time(command.now) || command.now < previous.position.createdAt
    || previous.plan && command.now < previous.plan.confirmedAt
    || previous.closedAt !== null && command.now < previous.closedAt
    || previous.lastMark && command.now < previous.lastMark.receivedAt) return rejected('命令时间无效或倒退');
  const state = structuredClone(previous), events: PositionRiskEvent[] = [];
  const finish = (valuation: PositionValuation | null, error: string | null = null): PositionRiskResult => ({ state, valuation, events, error });
  if (command.type === 'close') {
    if (state.phase !== 'closed') { state.phase = 'closed'; state.closedAt = command.now; }
    return finish(null);
  }
  if (command.type !== 'confirm' && command.type !== 'tick') return rejected('不支持的持仓命令');
  if (state.phase === 'closed') return finish(null, '仓位已由用户关闭，不再启用或评估规则');
  if (command.type === 'confirm') {
    if (!integer(command.expectedPlanRevision) || command.expectedPlanRevision !== (state.plan?.revision ?? 0)) return rejected('方案版本已变化，请重新查看当前方案后确认');
    if (!validPlan(command.plan, state.position) || command.plan.generatedAt > command.now) return rejected('风险方案参数或生成时间无效');
    if (state.plan && sameDraft(state.plan, command.plan)) return finish(valuePosition(state.position, command.frame, command.now));
  }
  const mark = command.frame?.mark;
  if (!freshMark(mark, state.position, command.now)) {
    if (command.type === 'confirm') return rejected('缺少新鲜同合约标记价，不能启用方案');
    state.gap = true; resetSignal(state);
    return finish(null, '标记价缺失、过期或身份不匹配，暂停判断');
  }
  const last = state.lastMark;
  if (last && (mark.sourceTime < last.sourceTime || mark.receivedAt < last.receivedAt)) return finish(null, '乱序观测已隔离');
  const equalStamp = !!last && mark.sourceTime === last.sourceTime;
  if (equalStamp && !new D(mark.markPrice).eq(last!.markPrice)) {
    state.gap = true; resetSignal(state);
    return finish(null, '同一源时间出现冲突标记价，等待更新观测');
  }
  if (equalStamp && state.gap) return finish(null, '等待缺口后的新价格观测');
  const valuation = valuePosition(state.position, command.frame, command.now)!;
  const price = new D(mark.markPrice);
  if (command.type === 'confirm') {
    const plan = planCopy(command.plan), stop = new D(plan.stopPrice), target = new D(plan.takeProfitPrice);
    if (state.position.side === 'long' ? price.lte(stop) || price.gte(target) : price.gte(stop) || price.lte(target))
      return rejected('当前标记价已到达或越过保护价/止盈价，请重新查看并修改方案');
    state.plan = { ...plan, revision: (state.plan?.revision ?? 0) + 1, confirmedAt: command.now };
    state.phase = 'armed'; state.lastMark = { ...mark }; state.gap = false;
    state.bestPrice = null; state.trailingActive = false; state.fired = []; resetSignal(state);
    if (plan.trailing && (state.position.side === 'long' ? price.gte(plan.trailing.activationPrice) : price.lte(plan.trailing.activationPrice))) {
      state.trailingActive = true; state.bestPrice = price.toFixed();
    }
    if (plan.signalWeakening && validSignal(command.frame, state, command.now)) {
      state.signalBaseline = command.frame.signal!.bias === state.position.side;
      state.lastSignalWindow = command.frame.signal!.windowEnd;
    }
    return finish(valuation);
  }
  const previousGap = state.gap || !!last && mark.sourceTime - last.sourceTime >
    (mark.source === 'binance-mark-stream' || last.source === 'binance-mark-stream' ? 15_000 : 45_000);
  state.lastMark = { ...mark }; state.gap = false;
  if (!state.plan) return finish(valuation);
  if (previousGap) resetSignal(state);
  const plan = state.plan;
  const emit = (rule: PositionRule, title: string, message: string) => {
    if (state.fired.includes(rule)) return;
    const event: PositionRiskEvent = { id: `${state.position.id}:${plan.revision}:${rule}`, positionId: state.position.id,
      planRevision: plan.revision, symbol: state.position.symbol, side: state.position.side, rule,
      timestamp: command.now, sourceTime: mark.sourceTime, markPrice: price.toFixed(), title,
      message: `${message}；仅提醒，未执行平仓${previousGap ? '；恢复监控后首次观察到满足条件，实际首次触发时间未知' : ''}`, afterGap: previousGap };
    state.fired.push(rule); state.phase = 'triggered'; events.push(event);
  };
  const isLong = state.position.side === 'long';
  if (isLong ? price.lte(plan.stopPrice) : price.gte(plan.stopPrice)) emit('stop', '保护价已触发', `标记价 ${price.toFixed()} 已到达保护价 ${plan.stopPrice}`);
  if (isLong ? price.gte(plan.takeProfitPrice) : price.lte(plan.takeProfitPrice)) emit('take-profit', '止盈价已触发', `标记价 ${price.toFixed()} 已到达止盈价 ${plan.takeProfitPrice}`);
  if (plan.trailing) {
    if (!state.trailingActive && (isLong ? price.gte(plan.trailing.activationPrice) : price.lte(plan.trailing.activationPrice))) {
      state.trailingActive = true; state.bestPrice = price.toFixed();
    }
    if (state.trailingActive) {
      const best = new D(state.bestPrice!);
      state.bestPrice = (isLong ? D.max(best, price) : D.min(best, price)).toFixed();
      const line = new D(state.bestPrice).mul(new D(1).plus(new D(plan.trailing.callbackPct).div(100).mul(isLong ? -1 : 1)));
      if (isLong ? price.lte(line) : price.gte(line)) emit('trailing', '移动保护已触发', `标记价已从观察到的最佳价 ${state.bestPrice} 回撤 ${plan.trailing.callbackPct}%`);
    }
  }
  if (plan.signalWeakening && !state.fired.includes('signal-weakening')) {
    if (!validSignal(command.frame, state, command.now)) resetSignal(state);
    else {
      const signal = command.frame.signal!;
      if (state.lastSignalWindow === null || signal.windowEnd > state.lastSignalWindow) {
        const contiguous = state.lastSignalWindow !== null && signal.windowEnd - state.lastSignalWindow === 60_000;
        if (signal.bias === state.position.side) { state.signalBaseline = true; state.weakWindows = 0; }
        else if (state.signalBaseline) {
          state.weakWindows = contiguous ? Math.min(2, state.weakWindows + 1) : 1;
          if (state.weakWindows >= 2) emit('signal-weakening', '持仓方向信号减弱', '连续两个有效闭合分钟窗口不再支持原持仓方向；不是确定反转或平仓指令');
        }
        state.lastSignalWindow = signal.windowEnd;
      }
    }
  }
  return finish(valuation);
}
