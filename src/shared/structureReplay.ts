import Decimal from 'decimal.js';
import { validateStructureHistory } from './structureAdvice';
import type { MarkObservation } from './positionTypes';
import { STRUCTURE_INTERVAL_MS, STRUCTURE_LOOKBACK_MS, type StructureAdvice, type StructureHistory,
  type StructureLevel, type StructureReplay, type StructureShadow, type StructureShadowBook, type StructureTouch } from './structureTypes';

const D = Decimal.clone({ precision: 80 });
const FRESH_MS = 15_000, DRAFT_MS = 60_000;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const time = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
function number(v: unknown, positive = false): Decimal | null {
  if (typeof v !== 'string' || v.length > 128 || !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(v)) return null;
  try { const n = new D(v); return n.isFinite() && Math.abs(n.e) <= 100 && (!positive || n.gt(0)) ? n : null; } catch { return null; }
}
export function validateStructureAdvice(v: unknown): v is StructureAdvice {
  if (!object(v) || !keys(v, ['version', 'mode', 'position', 'generatedAt', 'asOf', 'referencePrice', 'tickSize', 'historyFrom', 'historyTo',
    'atr15', 'buffer', 'quantity', 'currentPnl', 'additionalRisk', 'additionalRiskPct', 'remainingRewardRisk', 'stop', 'target1', 'target2', 'trends', 'reasons', 'warnings'])
    || v.version !== 'structure-v1' || !['live', 'replay'].includes(v.mode as string) || !object(v.position)) return false;
  const p = v.position;
  if (!keys(p, ['id', 'marketKey', 'symbol', 'assetId', 'side', 'entryPrice', 'margin', 'leverage', 'createdAt',
    ...(Object.hasOwn(p, 'openedAt') ? ['openedAt'] : []), ...(Object.hasOwn(p, 'suggestedHoldingLimitMs') ? ['suggestedHoldingLimitMs'] : [])])
    || typeof p.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(p.id)
    || typeof p.symbol !== 'string' || !/^[A-Z0-9_]{1,36}USDT$/.test(p.symbol) || p.marketKey !== `futures:${p.symbol}`
    || typeof p.assetId !== 'string' || !/^[A-Za-z0-9:_-]{1,120}$/.test(p.assetId) || !['long', 'short'].includes(p.side as string)
    || !number(p.entryPrice, true) || !number(p.margin, true) || !number(p.leverage, true)?.gte(1) || !number(p.leverage, true)?.lte(125)
    || !time(p.createdAt) || p.openedAt !== undefined && (!time(p.openedAt) || p.openedAt > p.createdAt)
    || p.suggestedHoldingLimitMs !== undefined && ![1_800_000, 3_600_000, 7_200_000, 14_400_000].includes(p.suggestedHoldingLimitMs as number)
    || !time(v.generatedAt) || !time(v.asOf) || v.asOf > v.generatedAt || p.createdAt > v.asOf
    || v.mode === 'live' && v.generatedAt - v.asOf > FRESH_MS
    || !time(v.historyFrom) || !time(v.historyTo) || v.historyFrom % STRUCTURE_INTERVAL_MS !== 0
    || v.historyTo !== v.historyFrom + STRUCTURE_LOOKBACK_MS - 1 || v.historyTo > v.asOf || v.asOf - v.historyTo >= STRUCTURE_INTERVAL_MS) return false;
  for (const k of ['referencePrice', 'tickSize', 'buffer', 'quantity', 'additionalRisk', 'additionalRiskPct', 'remainingRewardRisk']) if (!number(v[k], true)) return false;
  if (!number(v.atr15)?.gte(0) || !number(v.currentPnl)) return false;
  const level = (item: unknown): item is StructureLevel => object(item)
    && keys(item, ['price', 'structurePrice', 'confirmedAt', 'pnl', 'returnOnMarginPct'])
    && !!number(item.price, true) && !!number(item.structurePrice, true) && time(item.confirmedAt)
    && item.confirmedAt >= (v.historyFrom as number) && item.confirmedAt <= (v.historyTo as number)
    && !!number(item.pnl) && !!number(item.returnOnMarginPct) && new D(item.price as string).div(v.tickSize as string).isInteger();
  if (!level(v.stop) || !level(v.target1) || v.target2 !== null && !level(v.target2)) return false;
  const sign = p.side === 'long' ? 1 : -1, reference = new D(v.referencePrice as string);
  if (reference.minus(v.stop.price).mul(sign).lte(0) || new D(v.target1.price).minus(reference).mul(sign).lte(0)
    || v.target2 !== null && new D(v.target2.price).minus(v.target1.price).mul(sign).lte(0)) return false;
  const quantity = new D(p.margin as string).mul(p.leverage as string).div(p.entryPrice as string);
  const risk = reference.minus(v.stop.price).mul(sign), reward = new D(v.target1.price).minus(reference).mul(sign);
  const pnl = (price: string) => new D(price).minus(p.entryPrice as string).mul(quantity).mul(sign);
  const same = (actual: unknown, expected: Decimal) => new D(actual as string).eq(expected);
  const tick = new D(v.tickSize as string), buffer = new D(v.buffer as string);
  if (!same(v.quantity, quantity) || !same(v.currentPnl, pnl(v.referencePrice as string))
    || !same(v.buffer, D.max(new D(v.atr15 as string).mul('.25'), tick.mul(2)))
    || !same(v.additionalRisk, risk.mul(quantity)) || !same(v.additionalRiskPct, risk.mul(quantity).div(p.margin as string).mul(100))
    || !same(v.remainingRewardRisk, reward.div(risk)) || reward.div(risk).lt('1.2')) return false;
  for (const item of [v.stop, v.target1, v.target2]) if (item) {
    const expectedPrice = new D(item.structurePrice).minus(buffer.mul(sign)).div(tick)
      .toDecimalPlaces(0, sign === 1 ? Decimal.ROUND_FLOOR : Decimal.ROUND_CEIL).mul(tick);
    if (!same(item.price, expectedPrice) || !same(item.pnl, pnl(item.price))
      || !same(item.returnOnMarginPct, pnl(item.price).div(p.margin as string).mul(100))) return false;
  }
  const intervals = ['5m', '15m', '1h', '4h'];
  if (!Array.isArray(v.trends) || v.trends.length !== intervals.length || new Set(v.trends.map(t => object(t) ? t.interval : null)).size !== intervals.length
    || !v.trends.every(t => object(t) && keys(t, ['interval', 'direction', 'changePct', 'from', 'to']) && intervals.includes(t.interval as string)
      && ['up', 'down', 'flat', 'unavailable'].includes(t.direction as string)
      && (t.direction === 'unavailable' ? t.changePct === null && t.from === null && t.to === null
        : !!number(t.changePct) && time(t.from) && time(t.to) && t.from >= (v.historyFrom as number) && t.from <= t.to && t.to <= (v.historyTo as number)
          && (t.direction === 'flat' ? new D(t.changePct as string).isZero() : t.direction === 'up' ? new D(t.changePct as string).gt(0) : new D(t.changePct as string).lt(0))))) return false;
  const messages = (a: unknown) => Array.isArray(a) && a.length <= 30 && a.every(s => typeof s === 'string' && s.length > 0 && s.length <= 2000);
  return messages(v.reasons) && messages(v.warnings);
}
function validMark(v: unknown, marketKey: string): v is MarkObservation {
  return object(v) && keys(v, ['marketKey', 'markPrice', 'sourceTime', 'receivedAt', 'source']) && v.marketKey === marketKey
    && !!number(v.markPrice, true) && time(v.sourceTime) && time(v.receivedAt) && v.sourceTime <= v.receivedAt
    && (v.source === 'binance-mark-stream' || v.source === 'binance-premium-rest');
}
function crossed(advice: StructureAdvice, rule: StructureTouch['rule'], price: string): boolean {
  const level = advice[rule];
  if (!level) return false;
  const change = new D(price).minus(level.price).mul(advice.position.side === 'long' ? 1 : -1);
  return rule === 'stop' ? change.lte(0) : change.gte(0);
}
function validShadow(v: unknown): v is StructureShadow {
  if (!object(v) || !keys(v, ['id', 'advice', 'startedAt', 'stoppedAt', 'lastMark', 'gap', 'touches'])
    || typeof v.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(v.id) || !validateStructureAdvice(v.advice) || v.advice.mode !== 'live'
    || !time(v.startedAt) || v.startedAt < v.advice.generatedAt || v.startedAt - v.advice.generatedAt >= DRAFT_MS
    || !(v.stoppedAt === null || time(v.stoppedAt) && v.stoppedAt >= v.startedAt) || typeof v.gap !== 'boolean'
    || !validMark(v.lastMark, v.advice.position.marketKey) || v.lastMark.sourceTime < v.advice.asOf
    || v.stoppedAt !== null && v.lastMark.receivedAt > v.stoppedAt
    || !Array.isArray(v.touches) || v.touches.length > 3) return false;
  if (v.lastMark.sourceTime < v.startedAt && (v.lastMark.receivedAt > v.startedAt || v.startedAt - v.lastMark.sourceTime > FRESH_MS || v.touches.length)) return false;
  let sourceTime = 0, receivedAt = 0, previousPrice: string | null = null, previousGap = false;
  const rules = new Set<string>();
  for (const touch of v.touches) {
    if (!object(touch) || !keys(touch, ['rule', 'sourceTime', 'receivedAt', 'price', 'afterGap'])
      || !['stop', 'target1', 'target2'].includes(touch.rule as string) || rules.has(touch.rule as string)
      || !time(touch.sourceTime) || !time(touch.receivedAt) || touch.sourceTime < v.startedAt || touch.sourceTime > touch.receivedAt
      || touch.sourceTime < sourceTime || touch.receivedAt < receivedAt || touch.sourceTime > v.lastMark.sourceTime
      || touch.receivedAt > v.lastMark.receivedAt || touch.receivedAt - touch.sourceTime > FRESH_MS
      || !number(touch.price, true) || typeof touch.afterGap !== 'boolean' || touch.afterGap && !v.gap
      || previousGap && !touch.afterGap
      || touch.sourceTime === sourceTime && (touch.receivedAt !== receivedAt || !new D(touch.price as string).eq(previousPrice!))
      || touch.sourceTime === v.lastMark.sourceTime && (touch.receivedAt !== v.lastMark.receivedAt || !new D(touch.price as string).eq(v.lastMark.markPrice))
      || !crossed(v.advice, touch.rule as StructureTouch['rule'], touch.price as string)) return false;
    rules.add(touch.rule as string); sourceTime = touch.sourceTime; receivedAt = touch.receivedAt; previousPrice = touch.price as string; previousGap = touch.afterGap;
  }
  return (['stop', 'target1', 'target2'] as const).every(rule => !crossed(v.advice as StructureAdvice, rule, (v.lastMark as MarkObservation).markPrice) || rules.has(rule));
}

/** Mechanical first-touch diagnosis, not execution simulation or a profitability backtest. */
export function replayStructureAdvice(advice: StructureAdvice, history: StructureHistory, horizonMs = 4 * 3_600_000): StructureReplay {
  const result = (outcome: StructureReplay['outcome'], observedTo: number, bars: number, reason: string, touchedAt: number | null = null): StructureReplay =>
    ({ outcome, touchedAt, observedTo, bars, reason });
  if (!validateStructureAdvice(advice)) return result('incomplete', 0, 0, '方案无效，未进行回放');
  if (!Number.isSafeInteger(horizonMs) || horizonMs < STRUCTURE_INTERVAL_MS || horizonMs > STRUCTURE_LOOKBACK_MS || horizonMs % STRUCTURE_INTERVAL_MS !== 0)
    return result('incomplete', advice.asOf, 0, '回放时长无效');
  if (!validateStructureHistory(history) || history.marketKey !== advice.position.marketKey || history.symbol !== advice.position.symbol
    || !new D(history.tickSize).eq(advice.tickSize)) return result('incomplete', advice.asOf, 0, '缺少可校验的同合约标记价历史');
  const from = Math.ceil(advice.asOf / STRUCTURE_INTERVAL_MS) * STRUCTURE_INTERVAL_MS, end = advice.asOf + horizonMs;
  if (!Number.isSafeInteger(end)) return result('incomplete', advice.asOf, 0, '回放时间超出有效范围');
  const candles = new Map(history.candles.map(c => [c.openTime, c]));
  let bars = 0, observedTo = advice.asOf;
  for (let at = from; at + STRUCTURE_INTERVAL_MS - 1 <= end; at += STRUCTURE_INTERVAL_MS) {
    const c = candles.get(at);
    if (!c || at < history.from || c.closeTime >= history.to || c.closeTime >= history.fetchedAt)
      return result('incomplete', observedTo, bars, '后续闭合5分钟标记价历史缺失或尚未形成；不推断触线');
    bars++; observedTo = c.closeTime + 1;
    const stop = crossed(advice, 'stop', advice.position.side === 'long' ? c.low : c.high);
    const target = crossed(advice, 'target1', advice.position.side === 'long' ? c.high : c.low);
    if (stop && target) return result('ambiguous', observedTo, bars, '同一5分钟区间同时触及保护价与第一目标，先后未知；时间为区间起点，不是成交时刻', c.openTime);
    if (stop || target) return result(stop ? 'stop' : 'target1', observedTo, bars, '仅诊断首次触及的价位；时间为5分钟区间起点，具体时刻、成交及费用未知', c.openTime);
  }
  return result('unresolved', observedTo, bars, '完整回放窗口内未触及保护价或第一目标；未决不等于亏损，未强制平仓');
}

/** Starting a local shadow record never adopts a formal risk plan or sends a notification. */
export function startStructureShadow(id: string, advice: StructureAdvice, reference: MarkObservation, now: number): StructureShadow {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id) || !validateStructureAdvice(advice) || advice.mode !== 'live'
    || !time(now) || now < advice.generatedAt || now - advice.generatedAt >= DRAFT_MS
    || !validMark(reference, advice.position.marketKey) || reference.receivedAt > now || now - reference.sourceTime > FRESH_MS
    || reference.sourceTime < advice.asOf || crossed(advice, 'stop', reference.markPrice) || crossed(advice, 'target1', reference.markPrice))
    throw new Error('验证方案或标记价无效、过期或已触线；请重新分析。历史回放不能启用实时观察。');
  return { id, advice: structuredClone(advice), startedAt: now, stoppedAt: null, lastMark: { ...reference }, gap: false, touches: [] };
}

/** Gap status is sticky: subsequent recovery does not make an incomplete observation record complete. */
export function stepStructureShadow(record: StructureShadow, mark: MarkObservation | null, now: number): StructureShadow {
  if (!validShadow(record) || !time(now) || now < record.startedAt || now < record.lastMark!.receivedAt
    || record.stoppedAt !== null && now < record.stoppedAt)
    throw new Error('本机验证记录或时间无效，已暂停观察。');
  const next = structuredClone(record);
  if (next.stoppedAt !== null) return next;
  const last = next.lastMark!;
  if (!validMark(mark, next.advice.position.marketKey) || mark.receivedAt > now
    || now - mark.sourceTime > FRESH_MS || mark.sourceTime < last.sourceTime || mark.receivedAt < last.receivedAt) {
    next.gap = true; return next;
  }
  if (mark.sourceTime === last.sourceTime) {
    if (!new D(mark.markPrice).eq(last.markPrice) || now - last.receivedAt > FRESH_MS) next.gap = true;
    return next; // A repeated source timestamp never refreshes its original receipt or adds a touch.
  }
  if (mark.sourceTime < next.startedAt) { next.gap = true; return next; }
  next.gap ||= mark.sourceTime - last.sourceTime > FRESH_MS || mark.receivedAt - last.receivedAt > FRESH_MS;
  next.lastMark = { ...mark };
  for (const rule of ['stop', 'target1', 'target2'] as const) {
    if (!next.touches.some(t => t.rule === rule) && crossed(next.advice, rule, mark.markPrice)) {
      next.touches.push({ rule, sourceTime: mark.sourceTime, receivedAt: mark.receivedAt, price: mark.markPrice, afterGap: next.gap });
    }
  }
  return next;
}

export function validStructureShadowBook(value: unknown): value is StructureShadowBook {
  if (!object(value) || !keys(value, ['schemaVersion', 'revision', 'updatedAt', 'records']) || value.schemaVersion !== 1
    || !count(value.revision) || !count(value.updatedAt) || !Array.isArray(value.records) || value.records.length > 100
    || !value.records.every(validShadow) || new Set(value.records.map(r => r.id)).size !== value.records.length) return false;
  const updatedAt = value.updatedAt;
  return value.records.every(r => r.startedAt <= updatedAt && r.lastMark!.receivedAt <= updatedAt
    && (r.stoppedAt === null || r.stoppedAt <= updatedAt));
}
