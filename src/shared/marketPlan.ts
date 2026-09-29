import Decimal from 'decimal.js';
import { isDirectionConfig } from './directionConfig';
import type { FlowMarket } from './flowTypes';
import type { MarketPlan, MarketPlanInput, MarketPlanResult } from './marketPlanTypes';
import { aggregateStructureCandles, validateStructureHistory } from './structureAdvice';
import { STRUCTURE_INTERVAL_MS as STEP, STRUCTURE_LOOKBACK_MS as LOOKBACK, type StructureCandle } from './structureTypes';

const D = Decimal.clone({ precision: 80 });
const QUARTER = 900_000, WAIT_MS = 1_800_000;
const HOLDING_LIMITS = [1_800_000, 3_600_000, 7_200_000, 14_400_000];
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const time = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
function decimal(value: unknown, allowZero = false): Decimal | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return null;
  try {
    const parsed = new D(value);
    return parsed.isFinite() && (allowZero ? parsed.gte(0) : parsed.gt(0)) && Math.abs(parsed.e) <= 100 ? parsed : null;
  } catch { return null; }
}
function validMarket(value: unknown): value is FlowMarket {
  return object(value) && value.venue === 'futures' && value.quoteAsset === 'USDT'
    && typeof value.symbol === 'string' && /^[A-Z0-9_]{1,36}USDT$/.test(value.symbol)
    && value.key === `futures:${value.symbol}` && typeof value.baseAsset === 'string'
    && /^[A-Z0-9_]{1,36}$/.test(value.baseAsset) && `${value.baseAsset}USDT` === value.symbol
    && typeof value.assetId === 'string' && /^[A-Za-z0-9:_-]{1,120}$/.test(value.assetId);
}
interface Pivot { price: Decimal; confirmedAt: number }
/** Confirm each swing after two closed right bars; reject later close-throughs, not mere wick touches. */
function structures(bars: StructureCandle[]) {
  const lows = bars.map(bar => new D(bar.low)), highs = bars.map(bar => new D(bar.high));
  const minClose: Decimal[] = [], maxClose: Decimal[] = [];
  for (let index = bars.length - 1; index >= 0; index--) {
    const close = new D(bars[index].close);
    minClose[index] = minClose[index + 1] ? D.min(close, minClose[index + 1]) : close;
    maxClose[index] = maxClose[index + 1] ? D.max(close, maxClose[index + 1]) : close;
  }
  const support: Pivot[] = [], resistance: Pivot[] = [];
  for (let index = 2; index + 2 < bars.length; index++) {
    const neighbors = [index - 2, index - 1, index + 1, index + 2], later = index + 3;
    const confirmedAt = bars[index + 2].closeTime;
    if (neighbors.every(other => lows[index].lt(lows[other])) && (!minClose[later] || minClose[later].gte(lows[index])))
      support.push({ price: lows[index], confirmedAt });
    if (neighbors.every(other => highs[index].gt(highs[other])) && (!maxClose[later] || maxClose[later].lte(highs[index])))
      resistance.push({ price: highs[index], confirmedAt });
  }
  return { support, resistance };
}
/** Conservative executable rounding: buys round up, sells down; stops widen and targets tighten. */
function levels(side: 'long' | 'short', support: Decimal, resistance: Decimal, buffer: Decimal, tick: Decimal) {
  const floor = (value: Decimal) => value.div(tick).toDecimalPlaces(0, Decimal.ROUND_FLOOR).mul(tick);
  const ceil = (value: Decimal) => value.div(tick).toDecimalPlaces(0, Decimal.ROUND_CEIL).mul(tick);
  const long = side === 'long';
  const entryLow = long ? ceil(support.plus(buffer)) : floor(resistance.minus(buffer.mul(2)));
  const entryHigh = long ? ceil(support.plus(buffer.mul(2))) : floor(resistance.minus(buffer));
  const stopPrice = long ? floor(support.minus(buffer)) : ceil(resistance.plus(buffer));
  const targetPrice = long ? floor(resistance.minus(buffer)) : ceil(support.plus(buffer));
  const worst = long ? entryHigh : entryLow, sign = long ? 1 : -1;
  // Fixed illustrative round-trip cost: 12 bps of entry notional. Funding is not included.
  const cost = worst.mul('.0012'), risk = worst.minus(stopPrice).mul(sign).plus(cost);
  const reward = targetPrice.minus(worst).mul(sign).minus(cost);
  return { entryLow, entryHigh, stopPrice, targetPrice, netRewardRisk: risk.gt(0) ? reward.div(risk) : new D(-1) };
}
function validLevels(side: 'long' | 'short', value: ReturnType<typeof levels>, support: Decimal, resistance: Decimal, reference: Decimal) {
  const { entryLow, entryHigh, stopPrice, targetPrice, netRewardRisk } = value;
  return entryLow.gt(support) && entryHigh.lt(resistance) && entryLow.lte(entryHigh) && stopPrice.gt(0) && targetPrice.gt(0)
    && (side === 'long' ? stopPrice.lt(support) && targetPrice.gt(entryHigh) && reference.gt(stopPrice) && reference.lt(targetPrice)
      : stopPrice.gt(resistance) && targetPrice.lt(entryLow) && reference.lt(stopPrice) && reference.gt(targetPrice))
    && netRewardRisk.gte('1.5');
}
const unavailable = (reason: string): MarketPlanResult => ({ status: 'unavailable', reason });

/** Pure selected-market computation. Heavy historical scans belong in marketPlan.worker, never render paths. */
export function proposeMarketPlan(input: MarketPlanInput): MarketPlanResult {
  if (!object(input) || !id(input.id) || !validMarket(input.market) || !['long', 'short'].includes(input.side)
    || !time(input.now) || !HOLDING_LIMITS.includes(input.holdingLimitMs) || !isDirectionConfig(input.directionConfig)
    || !object(input.reference)) return unavailable('市场身份、方向、持有上限或方向参数无效，未生成进场计划。');
  const { market, reference, history, now, side } = input;
  if (reference.marketKey !== market.key || object(history) && (history.marketKey !== market.key || history.symbol !== market.symbol))
    return unavailable('历史、标记价和所选 USDT 合约身份不一致。');
  const referencePrice = decimal(reference.markPrice);
  if (!referencePrice || !time(reference.sourceTime) || !time(reference.receivedAt) || reference.sourceTime > reference.receivedAt
    || reference.receivedAt > now || !['binance-mark-stream', 'binance-premium-rest'].includes(reference.source))
    return unavailable('标记价格、来源或时间顺序无效。');
  if (now - reference.sourceTime > 15_000 || now - reference.receivedAt > 15_000)
    return unavailable('标记价超过 15 秒，等待新行情后重新生成计划。');
  if (!validateStructureHistory(history) || history.fetchedAt > now)
    return unavailable('历史数据存在缺口、冲突或非法价格，未生成计划。');
  const asOf = reference.sourceTime, end = Math.floor((asOf + 1) / STEP) * STEP, start = end - LOOKBACK;
  const candles = history.candles.filter(bar => bar.openTime >= start && bar.closeTime <= asOf);
  if (candles.length !== LOOKBACK / STEP || candles[0].openTime !== start || candles.at(-1)!.closeTime !== end - 1)
    return unavailable('需要截至参考时点连续完整的 7 天已收盘 5 分钟标记价；不能补造缺失历史。');
  const bars = aggregateStructureCandles(candles, QUARTER), last = bars.slice(-15);
  if (last.length !== 15) return unavailable('完整 15 分钟历史不足，不能计算已确认结构和 ATR。');
  let ranges = new D(0);
  for (let index = 1; index < last.length; index++) {
    const bar = last[index], previous = new D(last[index - 1].close);
    ranges = ranges.plus(D.max(new D(bar.high).minus(bar.low), new D(bar.high).minus(previous).abs(), new D(bar.low).minus(previous).abs()));
  }
  const atr = ranges.div(14), tick = new D(history.tickSize), buffer = D.max(atr.mul('.25'), tick.mul(2));
  const found = structures(bars);
  const support = found.support.filter(item => item.price.lt(referencePrice)).sort((a, b) => b.price.cmp(a.price) || b.confirmedAt - a.confirmedAt)[0];
  const resistance = found.resistance.filter(item => item.price.gt(referencePrice)).sort((a, b) => a.price.cmp(b.price) || b.confirmedAt - a.confirmedAt)[0];
  if (!support || !resistance) return unavailable('当前价格两侧没有完整的已确认有效支撑／压力，暂不建议进场。');
  const derived = levels(side, support.price, resistance.price, buffer, tick);
  if (!validLevels(side, derived, support.price, resistance.price, referencePrice))
    return unavailable('最近结构空间不足：按最差入场价扣除 12bps 往返成本后，净收益／风险需至少 1.5；不跳过近处障碍。');
  const plan: MarketPlan = {
    version: 'entry-structure-v1', id: input.id,
    market: { key: market.key, venue: market.venue, symbol: market.symbol, baseAsset: market.baseAsset, quoteAsset: market.quoteAsset, assetId: market.assetId },
    side, generatedAt: now, asOf, referencePrice: referencePrice.toFixed(), tickSize: tick.toFixed(),
    entryLow: derived.entryLow.toFixed(), entryHigh: derived.entryHigh.toFixed(), stopPrice: derived.stopPrice.toFixed(), targetPrice: derived.targetPrice.toFixed(),
    netRewardRisk: derived.netRewardRisk.toFixed(), roundTripCostBps: 12, waitUntil: now + WAIT_MS, holdingLimitMs: input.holdingLimitMs,
    directionConfig: { oiPct: input.directionConfig.oiPct, pricePct: input.directionConfig.pricePct, flowSharePct: input.directionConfig.flowSharePct, requireSpot: input.directionConfig.requireSpot },
    historyFrom: start, historyTo: end - 1,
    support: { price: support.price.toFixed(), confirmedAt: support.confirmedAt }, resistance: { price: resistance.price.toFixed(), confirmedAt: resistance.confirmedAt },
    atr15: atr.toFixed(), buffer: buffer.toFixed(), reasons: [
      '未验证盈利能力的条件计划：不是立即进场指令、成交记录或自动交易。',
      '仅用参考时点前 7 天已收盘标记价；15 分钟摆动点需左右各 2 根确认，至少延迟 30 分钟。',
      '最近有效支撑／压力确定回踩区间、止损和第一目标；缓冲取 0.25×15m ATR14 简单均值与 2 个最小价位的较大者。',
      '净收益／风险使用区间内最差入场价，往返手续费及滑点合计按入场金额 12bps 假设，未计资金费；实际成本可能更高。',
      '等待区间触及，以及采纳后更新的最近 5 根已闭合 1m 组成的 5 分钟窗口在冻结参数下满足 OI／成交方向条件；不是额外 K 线形态确认，30 分钟未完成则失效。',
      '最大持有时间是成交后的风险截止，不是最低持有承诺；止损和止盈始终优先，关页后不能持续监测。',
    ],
  };
  return validateMarketPlan(plan) ? { status: 'ready', plan } : unavailable('计算结果超过安全保存范围，未生成计划。');
}

/** Restore gate checks bounded wire data and recalculates formulas; it is not a cryptographic proof of source history. */
export function validateMarketPlan(value: unknown): value is MarketPlan {
  if (!object(value) || value.version !== 'entry-structure-v1' || !id(value.id) || !validMarket(value.market)
    || value.side !== 'long' && value.side !== 'short' || !time(value.generatedAt) || !time(value.asOf)
    || value.asOf > value.generatedAt || value.generatedAt - value.asOf > 15_000
    || !time(value.waitUntil) || value.waitUntil !== value.generatedAt + WAIT_MS
    || !HOLDING_LIMITS.includes(value.holdingLimitMs as number) || value.roundTripCostBps !== 12 || !isDirectionConfig(value.directionConfig)
    || !time(value.historyFrom) || !time(value.historyTo) || value.historyFrom % STEP !== 0
    || (value.historyTo + 1) % STEP !== 0 || value.historyTo - value.historyFrom + 1 !== LOOKBACK
    || value.historyTo !== Math.floor((value.asOf + 1) / STEP) * STEP - 1
    || !object(value.support) || !object(value.resistance)) return false;
  const reference = decimal(value.referencePrice), tick = decimal(value.tickSize), atr = decimal(value.atr15, true), buffer = decimal(value.buffer);
  const support = decimal(value.support.price), resistance = decimal(value.resistance.price);
  if (!reference || !tick || !atr || !buffer || !support || !resistance || !support.lt(reference) || !resistance.gt(reference)
    || !buffer.eq(D.max(atr.mul('.25'), tick.mul(2)))) return false;
  for (const level of [value.support, value.resistance]) {
    if (!time(level.confirmedAt) || (level.confirmedAt + 1) % QUARTER !== 0 || level.confirmedAt < value.historyFrom + QUARTER * 5 - 1
      || level.confirmedAt > value.historyTo) return false;
  }
  const derived = levels(value.side, support, resistance, buffer, tick);
  if (!validLevels(value.side, derived, support, resistance, reference)) return false;
  for (const key of ['entryLow', 'entryHigh', 'stopPrice', 'targetPrice', 'netRewardRisk'] as const) {
    const parsed = decimal(value[key]);
    if (!parsed || !parsed.eq(derived[key])) return false;
  }
  return Array.isArray(value.reasons) && value.reasons.length > 0 && value.reasons.length <= 12
    && Array.from(value.reasons).every(reason => typeof reason === 'string' && reason.length > 0 && reason.length <= 2000);
}
