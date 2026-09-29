import Decimal from 'decimal.js';
import { assessDirection } from './direction';
import type { FlowMarket, FlowSnapshot } from './flowTypes';
import type { MarkObservation } from './positionTypes';
import { validateMarketPlan } from './marketPlan';
import type { MarketPlan } from './marketPlanTypes';

export interface EntryFillInput { entryPrice: string; margin: string; leverage: string; openedAt: number }
export interface EntryWatch {
  plan: MarketPlan; adoptedAt: number;
  phase: 'watching' | 'ready' | 'invalidated' | 'expired' | 'filled' | 'stopped';
  lastMark: MarkObservation | null; lastEvaluatedAt: number; gap: boolean;
  triggeredAt: number | null; filledPositionId: string | null; reason: string;
  fillIntent: EntryFillInput | null;
}
export interface EntryEvent {
  id: string; planId: string; symbol: string; assetId: string;
  kind: 'ready' | 'expired' | 'invalidated'; timestamp: number;
  markPrice: string | null; sourceTime: number | null; afterGap: boolean; message: string;
}
export interface EntryBook { schemaVersion: 1; revision: number; updatedAt: number; watches: EntryWatch[]; events: EntryEvent[] }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const time = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const positive = (v: unknown): v is string => {
  if (typeof v !== 'string' || v.length > 128 || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(v)) return false;
  try { const d = new Decimal(v); return d.isFinite() && d.gt(0) && Math.abs(d.e) <= 100; } catch { return false; }
};
export function validEntryMark(mark: unknown, marketKey: string): mark is MarkObservation {
  return object(mark) && mark.marketKey === marketKey && positive(mark.markPrice) && time(mark.sourceTime)
    && time(mark.receivedAt) && mark.sourceTime <= mark.receivedAt
    && ['binance-mark-stream', 'binance-premium-rest'].includes(mark.source as string);
}
export function freshEntryMark(mark: unknown, marketKey: string, now: number): mark is MarkObservation {
  return time(now) && validEntryMark(mark, marketKey) && mark.receivedAt <= now && now - mark.sourceTime <= 15_000;
}
/** Exact market only. No fake position and no stale-price substitution. */
export function entryMarketMark(flow: FlowSnapshot | null, marketKey: string, now: number): MarkObservation | null {
  if (!flow || flow.schemaVersion !== 1 || !time(flow.status?.asOf) || flow.status.asOf > now || now - flow.status.asOf > 30_000) return null;
  const rows = flow.rows.filter(row => row.market?.key === marketKey && row.market.venue === 'futures'
    && row.market.quoteAsset === 'USDT' && row.market.key === `futures:${row.market.symbol}`);
  if (rows.length !== 1) return null;
  const marks = (flow.marks ?? []).filter(mark => freshEntryMark(mark, marketKey, now) && mark.receivedAt <= flow.status.asOf)
    .sort((a, b) => b.sourceTime - a.sourceTime || a.receivedAt - b.receivedAt);
  if (!marks.length || marks.some(mark => mark.sourceTime === marks[0].sourceTime && !new Decimal(mark.markPrice).eq(marks[0].markPrice))) return null;
  return { ...marks[0] };
}
export function validEntryFill(value: unknown, now: number): value is EntryFillInput {
  return object(value) && Object.keys(value).length === 4 && positive(value.entryPrice) && positive(value.margin) && positive(value.leverage)
    && new Decimal(value.leverage).gte(1) && new Decimal(value.leverage).lte(125) && time(value.openedAt) && value.openedAt <= now;
}
export const entryPositionId = (id: string) => `entry_${id}`;
export function validEntryWatch(value: unknown): value is EntryWatch {
  if (!object(value) || !validateMarketPlan(value.plan) || !time(value.adoptedAt) || value.adoptedAt < value.plan.generatedAt
    || value.adoptedAt - value.plan.generatedAt > 60_000 || value.adoptedAt >= value.plan.waitUntil
    || !time(value.lastEvaluatedAt) || value.lastEvaluatedAt < value.adoptedAt || typeof value.gap !== 'boolean'
    || !['watching', 'ready', 'invalidated', 'expired', 'filled', 'stopped'].includes(value.phase as string)
    || typeof value.reason !== 'string' || value.reason.length > 2000) return false;
  if (value.lastMark !== null && (!validEntryMark(value.lastMark, value.plan.market.key) || value.lastMark.receivedAt > value.lastEvaluatedAt)) return false;
  if (value.triggeredAt !== null && (!time(value.triggeredAt) || value.triggeredAt < value.adoptedAt || value.triggeredAt > value.lastEvaluatedAt)) return false;
  if (value.phase === 'ready' && value.triggeredAt === null) return false;
  if (value.fillIntent !== null && (!validEntryFill(value.fillIntent, value.lastEvaluatedAt) || value.fillIntent.openedAt < value.adoptedAt)) return false;
  return value.phase === 'filled' ? value.filledPositionId === entryPositionId(value.plan.id) && value.fillIntent !== null : value.filledPositionId === null;
}
export function validEntryEvent(v: unknown): v is EntryEvent {
  return object(v) && typeof v.planId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v.planId)
    && ['ready', 'expired', 'invalidated'].includes(v.kind as string) && v.id === `${v.planId}:${v.kind}`
    && typeof v.symbol === 'string' && /^[A-Z0-9_]{1,36}USDT$/.test(v.symbol)
    && typeof v.assetId === 'string' && /^[A-Za-z0-9:_-]{1,120}$/.test(v.assetId) && time(v.timestamp)
    && (v.markPrice === null ? v.sourceTime === null : positive(v.markPrice) && time(v.sourceTime) && v.sourceTime <= v.timestamp)
    && typeof v.afterGap === 'boolean' && typeof v.message === 'string' && v.message.length > 0 && v.message.length <= 2000;
}
export function validEntryBook(v: unknown): v is EntryBook {
  return object(v) && v.schemaVersion === 1 && Number.isSafeInteger(v.revision) && (v.revision as number) >= 0
    && Number.isSafeInteger(v.updatedAt) && (v.updatedAt as number) >= 0
    && Array.isArray(v.watches) && v.watches.length <= 100 && Array.from(v.watches).every(validEntryWatch)
    && v.watches.every(watch => watch.lastEvaluatedAt <= (v.updatedAt as number))
    && new Set(v.watches.map(w => w.plan.id)).size === v.watches.length
    && Array.isArray(v.events) && v.events.length <= 500 && Array.from(v.events).every(validEntryEvent)
    && v.events.every(event => event.timestamp <= (v.updatedAt as number))
    && new Set(v.events.map(e => e.id)).size === v.events.length;
}
export function adoptEntryPlan(plan: MarketPlan, mark: MarkObservation | null, now: number): EntryWatch {
  if (!validateMarketPlan(plan) || !time(now) || now < plan.generatedAt || now - plan.generatedAt > 60_000 || now >= plan.waitUntil)
    throw new Error('候选已过期或无法校验，请重新分析；既有观察不受影响。');
  if (!freshEntryMark(mark, plan.market.key, now)) throw new Error('需要同合约 15 秒内标记价才能采纳。');
  const p = new Decimal(mark.markPrice), low = Decimal.min(plan.stopPrice, plan.targetPrice), high = Decimal.max(plan.stopPrice, plan.targetPrice);
  if (p.lte(low) || p.gte(high)) throw new Error('价格已越过止损或目标边界，请重新分析。');
  return { plan: structuredClone(plan), adoptedAt: now, phase: 'watching', lastMark: { ...mark }, lastEvaluatedAt: now,
    gap: false, triggeredAt: null, filledPositionId: null, fillIntent: null, reason: '等待采纳后的新 5m 窗口确认，并进入冻结区间。' };
}
export const activeEntry = (watch: EntryWatch) => watch.phase === 'watching' || watch.phase === 'ready';
export function sameEntryMarket(a: FlowMarket, b: FlowMarket): boolean {
  return ['key', 'symbol', 'assetId', 'venue', 'quoteAsset', 'baseAsset'].every(key => a[key as keyof FlowMarket] === b[key as keyof FlowMarket]);
}
export function stepEntryWatch(previous: EntryWatch, flow: FlowSnapshot | null, now: number): { watch: EntryWatch; events: EntryEvent[] } {
  if (!validEntryWatch(previous) || !time(now) || now < previous.lastEvaluatedAt) throw new Error('观察状态或时钟无效，未推进。');
  if (!activeEntry(previous) || previous.fillIntent) return { watch: previous, events: [] };
  const watch = { ...previous }, plan = previous.plan;
  watch.lastEvaluatedAt = now;
  const mark = entryMarketMark(flow, plan.market.key, now);
  const gap = previous.gap || now - previous.lastEvaluatedAt > 15_000;
  const event = (kind: EntryEvent['kind'], message: string): EntryEvent => ({ id: `${plan.id}:${kind}`, planId: plan.id,
    symbol: plan.market.symbol, assetId: plan.market.assetId, kind, timestamp: now, markPrice: mark?.markPrice ?? null,
    sourceTime: mark?.sourceTime ?? null, afterGap: gap || !mark, message });
  if (now >= plan.waitUntil) {
    watch.phase = 'expired'; watch.reason = '30 分钟入场等待已截止，未自动开仓；需要重新分析。';
    return { watch, events: [event('expired', watch.reason)] };
  }
  const exactRows = flow?.rows.filter(row => row.market.key === plan.market.key) ?? [];
  const identity = exactRows.length === 1 && sameEntryMarket(exactRows[0].market, plan.market);
  if (!mark || !identity || previous.lastMark && (mark.sourceTime < previous.lastMark.sourceTime
    || mark.sourceTime === previous.lastMark.sourceTime && !new Decimal(mark.markPrice).eq(previous.lastMark.markPrice))) {
    watch.gap = true; watch.phase = 'watching'; watch.reason = '行情缺失、过期或身份冲突，进场条件暂停确认。';
    return { watch, events: [] };
  }
  watch.lastMark = mark; watch.gap = false;
  const p = new Decimal(mark.markPrice);
  if (p.lte(Decimal.min(plan.stopPrice, plan.targetPrice)) || p.gte(Decimal.max(plan.stopPrice, plan.targetPrice))) {
    watch.phase = 'invalidated'; watch.reason = '当前价已越过冻结止损／目标边界，入场方案失效；未自动开仓。';
    return { watch, events: [event('invalidated', watch.reason)] };
  }
  const direction = assessDirection(flow, plan.market.assetId, now, plan.market.key, plan.directionConfig);
  const inZone = p.gte(plan.entryLow) && p.lte(plan.entryHigh);
  const confirmed = direction.quality === 'valid' && direction.marketKey === plan.market.key && direction.bias === plan.side
    && direction.windowEnd !== null && direction.windowEnd > watch.adoptedAt && direction.windowEnd <= now;
  watch.phase = inZone && confirmed ? 'ready' : 'watching';
  watch.reason = !inZone ? '等待标记价回到进场区间，不追价。' : !confirmed ? `已到区间，仍等新的 5m 方向确认：${direction.reason}`
    : '当前价在区间，新的 5m 方向条件已齐；核对交易所报价与风险后再决定，未自动成交。';
  if (watch.phase !== 'ready' || watch.triggeredAt !== null) return { watch, events: [] };
  watch.triggeredAt = now;
  return { watch, events: [event('ready', `${watch.reason}${gap ? ' 监控曾中断，仅确认恢复后的当前状态，不补推测中断期间。' : ''}`)] };
}
