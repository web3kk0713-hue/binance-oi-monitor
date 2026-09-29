import Decimal from 'decimal.js';
import type { ManualPosition } from './positionTypes';
import { STRUCTURE_INTERVAL_MS, STRUCTURE_LOOKBACK_MS, type StructureAdvice, type StructureCandle,
  type StructureHistory, type StructureInput, type StructureLevel, type StructureResult, type StructureTrend } from './structureTypes';

const D = Decimal.clone({ precision: 80 });
const DAY = 86_400_000;
const FIFTEEN_MINUTES = 900_000;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const time = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
function positive(value: unknown): Decimal | null {
  if (typeof value !== 'string' || value.length > 128 || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return null;
  try { const number = new D(value); return number.isFinite() && number.gt(0) && Math.abs(number.e) <= 100 ? number : null; }
  catch { return null; }
}
/** Same bounded decimal wire domain used by the independent persisted-advice validator. */
function boundedDecimal(value: string): boolean {
  if (value.length > 128) return false;
  const parsed = new D(value);
  return parsed.isFinite() && Math.abs(parsed.e) <= 100;
}
function validPosition(value: unknown): value is ManualPosition {
  if (!record(value)) return false;
  const leverage = positive(value.leverage);
  return typeof value.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value.id)
    && typeof value.symbol === 'string' && /^[A-Z0-9_]{1,36}USDT$/.test(value.symbol)
    && value.marketKey === `futures:${value.symbol}` && typeof value.assetId === 'string'
    && /^[A-Za-z0-9:_-]{1,120}$/.test(value.assetId) && (value.side === 'long' || value.side === 'short')
    && positive(value.entryPrice) !== null && positive(value.margin) !== null
    && leverage !== null && leverage.gte(1) && leverage.lte(125) && time(value.createdAt)
    && (value.openedAt === undefined || time(value.openedAt) && value.openedAt <= value.createdAt)
    && (value.suggestedHoldingLimitMs === undefined || [1_800_000, 3_600_000, 7_200_000, 14_400_000].includes(value.suggestedHoldingLimitMs as number));
}
function validCandle(value: unknown): value is StructureCandle {
  if (!record(value) || !time(value.openTime) || value.openTime % STRUCTURE_INTERVAL_MS !== 0
    || !time(value.closeTime) || value.closeTime !== value.openTime + STRUCTURE_INTERVAL_MS - 1) return false;
  const open = positive(value.open), high = positive(value.high), low = positive(value.low), close = positive(value.close);
  return !!open && !!high && !!low && !!close && high.gte(low) && high.gte(open) && high.gte(close) && low.lte(open) && low.lte(close);
}
function validCandles(value: unknown): value is StructureCandle[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 31 * DAY / STRUCTURE_INTERVAL_MS) return false;
  for (let index = 0; index < value.length; index++) {
    const bar = value[index];
    if (!validCandle(bar) || index > 0 && bar.openTime !== value[index - 1].openTime + STRUCTURE_INTERVAL_MS) return false;
  }
  return true;
}

/** The envelope uses [from, to); gaps, duplicates and conflicting OHLC are never repaired silently. */
export function validateStructureHistory(history: unknown): history is StructureHistory {
  return record(history) && history.schemaVersion === 1 && history.intervalMs === STRUCTURE_INTERVAL_MS
    && typeof history.symbol === 'string' && /^[A-Z0-9_]{1,36}USDT$/.test(history.symbol)
    && history.marketKey === `futures:${history.symbol}` && positive(history.tickSize) !== null
    && time(history.from) && time(history.to) && time(history.fetchedAt) && history.to <= history.fetchedAt
    && history.from % STRUCTURE_INTERVAL_MS === 0 && history.to % STRUCTURE_INTERVAL_MS === 0
    && validCandles(history.candles) && history.from === history.candles[0].openTime
    && history.to === history.candles.at(-1)!.closeTime + 1;
}

/** UTC-aligned complete buckets only. Invalid input returns no bars, never a synthetic bridge over a gap. */
export function aggregateStructureCandles(candles: StructureCandle[], intervalMs: number): StructureCandle[] {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < STRUCTURE_INTERVAL_MS || intervalMs > DAY
    || intervalMs % STRUCTURE_INTERVAL_MS !== 0 || !validCandles(candles)) return [];
  const count = intervalMs / STRUCTURE_INTERVAL_MS, result: StructureCandle[] = [];
  for (let index = 0; index + count <= candles.length; index++) {
    if (candles[index].openTime % intervalMs !== 0) continue;
    const group = candles.slice(index, index + count);
    result.push({ openTime: group[0].openTime, closeTime: group.at(-1)!.closeTime, open: group[0].open,
      high: D.max(...group.map(bar => new D(bar.high))).toFixed(), low: D.min(...group.map(bar => new D(bar.low))).toFixed(), close: group.at(-1)!.close });
    index += count - 1;
  }
  return result;
}

interface Pivot { price: Decimal; confirmedAt: number }
function pivots(candles: StructureCandle[]): { lows: Pivot[]; highs: Pivot[] } {
  const lows = candles.map(bar => new D(bar.low)), highs = candles.map(bar => new D(bar.high));
  const minClose: Decimal[] = [], maxClose: Decimal[] = [];
  // Suffix extrema include only bars already closed at the proposal's asOf, never subsequent replay bars.
  for (let index = candles.length - 1; index >= 0; index--) {
    const close = new D(candles[index].close);
    minClose[index] = minClose[index + 1] ? D.min(close, minClose[index + 1]) : close;
    maxClose[index] = maxClose[index + 1] ? D.max(close, maxClose[index + 1]) : close;
  }
  const result: { lows: Pivot[]; highs: Pivot[] } = { lows: [], highs: [] };
  for (let index = 2; index + 2 < candles.length; index++) {
    const neighbors = [index - 2, index - 1, index + 1, index + 2], afterConfirmation = index + 3;
    const confirmedAt = candles[index + 2].closeTime;
    if (neighbors.every(other => lows[index].lt(lows[other])) && (!minClose[afterConfirmation] || minClose[afterConfirmation].gte(lows[index])))
      result.lows.push({ price: lows[index], confirmedAt });
    if (neighbors.every(other => highs[index].gt(highs[other])) && (!maxClose[afterConfirmation] || maxClose[afterConfirmation].lte(highs[index])))
      result.highs.push({ price: highs[index], confirmedAt });
  }
  return result;
}
function orderedUnique(values: Pivot[], ascending: boolean): Pivot[] {
  const sorted = values.sort((a, b) => (ascending ? a.price.cmp(b.price) : b.price.cmp(a.price)) || b.confirmedAt - a.confirmedAt);
  return sorted.filter((item, index) => index === 0 || !item.price.eq(sorted[index - 1].price));
}
function trend(candles: StructureCandle[], interval: StructureTrend['interval'], intervalMs: number): StructureTrend {
  const bars = aggregateStructureCandles(candles, intervalMs).slice(-6);
  if (bars.length !== 6) return { interval, direction: 'unavailable', changePct: null, from: null, to: null };
  const change = new D(bars.at(-1)!.close).minus(bars[0].open).div(bars[0].open).mul(100);
  return { interval, direction: change.gt(0) ? 'up' : change.lt(0) ? 'down' : 'flat', changePct: change.toFixed(), from: bars[0].openTime, to: bars.at(-1)!.closeTime };
}
const unavailable = (code: Extract<StructureResult, { status: 'unavailable' }>['code'], reason: string): StructureResult => ({ status: 'unavailable', code, reason });

/** Experimental structure proposal. A separate validated, opt-in adapter creates a reminder plan. */
export function proposeStructureAdvice(input: StructureInput): StructureResult {
  if (!record(input) || !validPosition(input.position) || !time(input.now) || !['live', 'replay'].includes(input.mode)
    || input.position.createdAt > input.now || !record(input.reference)) return unavailable('invalid', '持仓、参考价格或分析时间无效，未生成候选方案');
  const { position, reference, history, now, mode } = input;
  if (reference.marketKey !== position.marketKey || record(history) && (history.marketKey !== position.marketKey || history.symbol !== position.symbol))
    return unavailable('identity', '历史、标记价与持仓必须属于同一 USDT 合约');
  if (!positive(reference.markPrice) || !time(reference.sourceTime) || !time(reference.receivedAt)
    || reference.sourceTime > reference.receivedAt || reference.receivedAt > now || position.createdAt > reference.sourceTime
    || !['binance-mark-stream', 'binance-premium-rest'].includes(reference.source)) return unavailable('invalid', '参考标记价的数值、来源或时间顺序无效');
  if (mode === 'live' && (now - reference.sourceTime > 15_000 || now - reference.receivedAt > 15_000))
    return unavailable('stale', '标记价已超过 15 秒，请等待新行情后重新分析');
  if (!validateStructureHistory(history) || history.fetchedAt > now) return unavailable('history', '历史数据缺失、时间冲突或格式无效，不能生成结构价位');
  const asOf = reference.sourceTime;
  const end = Math.floor((asOf + 1) / STRUCTURE_INTERVAL_MS) * STRUCTURE_INTERVAL_MS;
  const start = end - STRUCTURE_LOOKBACK_MS;
  const candles = history.candles.filter(bar => bar.openTime >= start && bar.closeTime <= asOf);
  if (candles.length !== STRUCTURE_LOOKBACK_MS / STRUCTURE_INTERVAL_MS || candles[0].openTime !== start || candles.at(-1)!.closeTime !== end - 1)
    return unavailable('history', '需要截至参考时点连续完整的 7 天已收盘 5 分钟标记价，缺口不能补造');
  const bars15 = aggregateStructureCandles(candles, FIFTEEN_MINUTES);
  if (bars15.length < 15) return unavailable('history', '完整 15 分钟历史不足，不能计算结构及 ATR');
  const atrBars = bars15.slice(-15);
  let totalRange = new D(0);
  for (let index = 1; index < atrBars.length; index++) {
    const bar = atrBars[index], previousClose = new D(atrBars[index - 1].close);
    totalRange = totalRange.plus(D.max(new D(bar.high).minus(bar.low), new D(bar.high).minus(previousClose).abs(), new D(bar.low).minus(previousClose).abs()));
  }
  const atr = totalRange.div(14), tick = new D(history.tickSize), buffer = D.max(atr.mul('.25'), tick.mul(2));
  const price = new D(reference.markPrice), structures = pivots(bars15);
  const lows = orderedUnique(structures.lows.filter(level => level.price.lt(price)), false);
  const highs = orderedUnique(structures.highs.filter(level => level.price.gt(price)), true);
  const isLong = position.side === 'long', side = isLong ? 1 : -1;
  const protective = (isLong ? lows : highs)[0], opposing = isLong ? highs : lows;
  if (!protective || !opposing[0]) return unavailable('structure', '当前价格两侧没有足够的已确认有效支撑／压力，不以固定百分比替代');
  const rounding = isLong ? Decimal.ROUND_FLOOR : Decimal.ROUND_CEIL;
  const round = (value: Decimal) => value.div(tick).toDecimalPlaces(0, rounding).mul(tick);
  const stopPrice = round(protective.price.minus(buffer.mul(side)));
  const targetPrice = (level: Pivot) => round(level.price.minus(buffer.mul(side)));
  const firstPrice = targetPrice(opposing[0]);
  const risk = price.minus(stopPrice).mul(side), reward = firstPrice.minus(price).mul(side);
  if (stopPrice.lte(0) || firstPrice.lte(0) || risk.lte(0) || reward.lte(0) || reward.div(risk).lt('1.2'))
    return unavailable('space', '最近对侧结构的剩余空间不足 1.2 倍风险；不跳过近处阻力来制造盈亏比');
  const quantity = new D(position.margin).mul(position.leverage).div(position.entryPrice);
  const pnl = (value: Decimal) => value.minus(position.entryPrice).mul(quantity).mul(side);
  const level = (pivot: Pivot, value: Decimal): StructureLevel => ({ price: value.toFixed(), structurePrice: pivot.price.toFixed(), confirmedAt: pivot.confirmedAt,
    pnl: pnl(value).toFixed(), returnOnMarginPct: pnl(value).div(position.margin).mul(100).toFixed() });
  const secondPrice = opposing[1] ? targetPrice(opposing[1]) : null;
  const target2 = secondPrice && secondPrice.gt(0) && secondPrice.minus(firstPrice).mul(side).gt(0) ? level(opposing[1], secondPrice) : null;
  const warnings = ['试验规则，未经充分盈利验证；重新分析不替换已采纳计划，须明确采纳后才启用新的提醒，不自动交易。',
    '未确认个人风险预算；盈亏按手动录入仓位估算，未计手续费、滑点和资金费，不是账户权益或强平价。',
    '摆动点需左右各 2 根 15 分钟 K 线确认，至少有 30 分钟确认延迟；支撑压力可能失效。',
    '5m／15m／1h／4h 仅显示已收盘价格背景，彼此相关，不是独立方向投票。',
    '未提供同一历史时点的 OI、成交和资金费，不将当前指标填入过去。'];
  if (pnl(firstPrice).lt(0)) warnings.push('按实际开仓价计算，第一目标仍是亏损，属于反弹减亏／回落减亏目标，不是盈利止盈。');
  if (risk.mul(quantity).gte(position.margin)) warnings.push('从参考价到止损的额外估算损失已达到或超过录入保证金；本模型不能判断途中是否强平。');
  const advice: StructureAdvice = { version: 'structure-v1', mode,
    position: { id: position.id, marketKey: position.marketKey, symbol: position.symbol, assetId: position.assetId, side: position.side,
      entryPrice: position.entryPrice, margin: position.margin, leverage: position.leverage, createdAt: position.createdAt,
      ...(position.openedAt === undefined ? {} : { openedAt: position.openedAt }),
      ...(position.suggestedHoldingLimitMs === undefined ? {} : { suggestedHoldingLimitMs: position.suggestedHoldingLimitMs }) },
    generatedAt: now, asOf, referencePrice: price.toFixed(), tickSize: tick.toFixed(), historyFrom: candles[0].openTime, historyTo: candles.at(-1)!.closeTime,
    atr15: atr.toFixed(), buffer: buffer.toFixed(), quantity: quantity.toFixed(), currentPnl: pnl(price).toFixed(),
    additionalRisk: risk.mul(quantity).toFixed(), additionalRiskPct: risk.mul(quantity).div(position.margin).mul(100).toFixed(),
    remainingRewardRisk: reward.div(risk).toFixed(), stop: level(protective, stopPrice), target1: level(opposing[0], firstPrice), target2,
    trends: [trend(candles, '5m', STRUCTURE_INTERVAL_MS), trend(candles, '15m', FIFTEEN_MINUTES), trend(candles, '1h', 3_600_000), trend(candles, '4h', 14_400_000)],
    reasons: ['仅使用参考时点前连续 7 天已收盘标记价，15 分钟已确认结构决定候选价位。',
      '已剔除确认后被收盘价穿越的结构；最近支撑／压力决定止损与第一目标，不跳过近处障碍。',
      '缓冲取 15 分钟 ATR14 简单平均的 0.25 倍与 2 个最小价格单位中的较大者；保守取整后复核至少 1.2 倍剩余空间。'], warnings };
  // Valid individual inputs can still overflow our storage/display domain when multiplied or divided.
  // Fail closed instead of returning a candidate which cannot be persisted or safely inspected.
  const values = [advice.referencePrice, advice.tickSize, advice.atr15, advice.buffer, advice.quantity, advice.currentPnl,
    advice.additionalRisk, advice.additionalRiskPct, advice.remainingRewardRisk,
    ...[advice.stop, advice.target1, advice.target2].flatMap(item => item ? [item.price, item.structurePrice, item.pnl, item.returnOnMarginPct] : []),
    ...advice.trends.flatMap(item => item.changePct === null ? [] : [item.changePct])];
  if (!values.every(boundedDecimal)) return unavailable('invalid', '计算结果的数值量级或精度超出安全保存范围，未生成候选方案');
  return { status: 'ready', advice };
}
