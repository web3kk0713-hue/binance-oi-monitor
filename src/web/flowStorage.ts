import { openDB, type DBSchema } from 'idb';
import type { FlowCandle, FlowDepth, FlowEvent, FlowHistory, FlowMarket, FlowOi, FlowUpdate } from '../shared/flowTypes';

const HOUR = 3_600_000, RETENTION = 7 * 24 * HOUR;
interface Bucket { id: string; marketKey: string; hour: number; candles: FlowCandle[]; depth: FlowDepth[]; oi: FlowOi[]; }
interface FlowDb extends DBSchema {
  buckets: { key: string; value: Bucket; indexes: { 'by-hour': number; 'by-market-hour': [string, number] } };
  events: { key: string; value: FlowEvent; indexes: { 'by-detected': number; 'by-market-detected': [string, number] } };
  markets: { key: string; value: FlowMarket };
}
let opening: ReturnType<typeof openFlowDb> | null = null;
function openFlowDb() {
  return openDB<FlowDb>('binance-orderflow-v1', 1, { upgrade(db) {
    const buckets = db.createObjectStore('buckets', { keyPath: 'id' });
    buckets.createIndex('by-hour', 'hour'); buckets.createIndex('by-market-hour', ['marketKey', 'hour']);
    const events = db.createObjectStore('events', { keyPath: 'id' });
    events.createIndex('by-detected', 'detectedAt'); events.createIndex('by-market-detected', ['marketKey', 'detectedAt']);
    db.createObjectStore('markets', { keyPath: 'key' });
  } });
}
const database = () => opening ??= openFlowDb().catch(error => { opening = null; throw error; });
function mergeBy<T>(old: T[], added: T[], key: (v: T) => number): T[] { return [...new Map([...old, ...added].map(v => [key(v), v])).values()].sort((a, b) => key(a) - key(b)); }
/** A REST reconnect must not erase when a closed minute originally became observable. */
export function mergeObservedCandles(old: FlowCandle[], added: FlowCandle[]): FlowCandle[] {
  const rows = new Map(old.map(c => [c.openTime, c]));
  for (const c of added) {
    const previous = rows.get(c.openTime);
    if (!previous || (!previous.closed && (c.closed || c.receivedAt >= previous.receivedAt))) rows.set(c.openTime, c);
  }
  return [...rows.values()].sort((a, b) => a.openTime - b.openTime);
}
export function mergeObservedOi(old: FlowOi[], added: FlowOi[]): FlowOi[] {
  const rows = new Map(old.map(o => [o.timestamp, o]));
  for (const o of added) { const previous = rows.get(o.timestamp); if (!previous || o.receivedAt < previous.receivedAt) rows.set(o.timestamp, o); }
  return [...rows.values()].sort((a, b) => a.timestamp - b.timestamp);
}
let lastPrune = 0;
/** Hour-packed records avoid millions of tiny IndexedDB objects. Raw trades are not retained, only alert evidence. */
export async function saveFlowUpdate(update: FlowUpdate, markets: FlowMarket[], now = Date.now()) {
  const db = await database();
  const tx = db.transaction(['buckets', 'events', 'markets'], 'readwrite');
  const pending = new Map<string, Bucket>();
  function bucket(key: string, time: number) {
    const hour = Math.floor(time / HOUR) * HOUR, id = `${key}:${hour}`;
    let entry = pending.get(id); if (!entry) { entry = { id, marketKey: key, hour, candles: [], depth: [], oi: [] }; pending.set(id, entry); } return entry;
  }
  for (const c of update.candles) if (c.closed && c.closeTime >= now - RETENTION) bucket(c.marketKey, c.openTime).candles.push(c);
  // Persist one measured depth point per five seconds. The live engine still evaluates every received sample.
  for (const d of update.depth) if (d.timestamp >= now - RETENTION) bucket(d.marketKey, d.timestamp).depth.push(d);
  for (const o of update.oi) if (o.timestamp >= now - RETENTION) bucket(o.marketKey, o.timestamp).oi.push(o);
  for (const added of pending.values()) {
    const old = await tx.objectStore('buckets').get(added.id);
    const c = mergeObservedCandles(old?.candles ?? [], added.candles);
    const d = mergeBy(old?.depth ?? [], added.depth, v => Math.floor(v.timestamp / 5000));
    const o = mergeObservedOi(old?.oi ?? [], added.oi);
    await tx.objectStore('buckets').put({ ...added, candles: c, depth: d, oi: o });
  }
  for (const e of update.events) if (e.detectedAt >= now - RETENTION) {
    const old = await tx.objectStore('events').get(e.id);
    const outcomes = old ? [...new Map([...e.outcomes, ...old.outcomes].map(o => [o.minutes, o])).values()].sort((a, b) => a.minutes - b.minutes) : e.outcomes;
    await tx.objectStore('events').put(old ? { ...old, outcomes } : e);
  }
  for (const m of markets) await tx.objectStore('markets').put(m);
  await tx.done;
  if (now - lastPrune > HOUR) { await pruneFlowStorage(now); lastPrune = now; }
}
export async function pruneFlowStorage(now = Date.now()) {
  const db = await database(); const tx = db.transaction(['buckets', 'events'], 'readwrite');
  let b = await tx.objectStore('buckets').index('by-hour').openCursor(IDBKeyRange.upperBound(Math.floor((now - RETENTION) / HOUR) * HOUR, true));
  while (b) { await b.delete(); b = await b.continue(); }
  let e = await tx.objectStore('events').index('by-detected').openCursor(IDBKeyRange.upperBound(now - RETENTION, true));
  while (e) { await e.delete(); e = await e.continue(); }
  await tx.done;
}
export async function loadFlowEvents(limit = 500): Promise<FlowEvent[]> {
  const db = await database(); const out: FlowEvent[] = [];
  let c = await db.transaction('events').store.index('by-detected').openCursor(IDBKeyRange.lowerBound(Date.now() - RETENTION), 'prev');
  while (c && out.length < limit) { out.push(c.value); c = await c.continue(); } return out;
}
export async function loadFlowHistory(key: string, from: number, to: number): Promise<FlowHistory> {
  const db = await database(); const tx = db.transaction(['buckets', 'events', 'markets']);
  const buckets = await tx.objectStore('buckets').index('by-market-hour').getAll(IDBKeyRange.bound([key, Math.floor(from / HOUR) * HOUR], [key, Math.floor(to / HOUR) * HOUR]));
  const events = await tx.objectStore('events').index('by-market-detected').getAll(IDBKeyRange.bound([key, from], [key, to]));
  const market = await tx.objectStore('markets').get(key) ?? null;
  const eligible = <T extends { timestamp: number; receivedAt: number }>(v: T) => v.timestamp >= from && v.timestamp <= to && v.receivedAt <= to;
  return { market, from, to, candles: buckets.flatMap(b => b.candles).filter(c => c.openTime >= from && c.sourceTime <= to && c.receivedAt <= to).sort((a, b) => a.openTime - b.openTime),
    events: events.map(e => ({ ...e, outcomes: e.outcomes.filter(o => o.availableAt <= to) })),
    depth: buckets.flatMap(b => b.depth).filter(eligible).sort((a, b) => a.timestamp - b.timestamp),
    oi: buckets.flatMap(b => b.oi).filter(eligible).sort((a, b) => a.timestamp - b.timestamp) };
}
export function mergeFlowHistory(stored: FlowHistory, live: FlowHistory): FlowHistory {
  return { ...stored, market: live.market ?? stored.market,
    candles: mergeObservedCandles(stored.candles, live.candles), depth: mergeBy(stored.depth, live.depth, d => Math.floor(d.timestamp / 5000)), oi: mergeObservedOi(stored.oi, live.oi),
    events: [...new Map([...stored.events, ...live.events].map(e => [e.id, e])).values()].sort((a, b) => b.detectedAt - a.detectedAt) };
}
