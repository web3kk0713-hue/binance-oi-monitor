import { openDB, type DBSchema } from 'idb';
import Decimal from 'decimal.js';
import { validPositionState } from '../shared/positionRisk';
import type { PositionBook, PositionRiskEvent } from '../shared/positionTypes';

interface OutboxItem { id: string; event: PositionRiskEvent; owner: string | null; leaseUntil: number; completed: boolean; }
interface PositionDb extends DBSchema {
  book: { key: string; value: PositionBook };
  outbox: { key: string; value: OutboxItem };
}
export const emptyPositionBook = (): PositionBook => ({ schemaVersion: 1, revision: 0, positions: [], events: [], notified: [], updatedAt: 0 });
function validRiskEvent(value: unknown): value is PositionRiskEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const e = value as PositionRiskEvent;
  const text = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max;
  if (!text(e.id, 180) || !text(e.positionId, 100) || !text(e.symbol, 40) || !text(e.title, 200) || !text(e.message, 2000)
    || !Number.isSafeInteger(e.planRevision) || e.planRevision < 1 || !Number.isSafeInteger(e.timestamp) || e.timestamp <= 0
    || !Number.isSafeInteger(e.sourceTime) || e.sourceTime <= 0 || e.sourceTime > e.timestamp
    || !['stop', 'take-profit', 'trailing', 'signal-weakening'].includes(e.rule) || !['long', 'short'].includes(e.side)
    || typeof e.afterGap !== 'boolean' || e.id !== `${e.positionId}:${e.planRevision}:${e.rule}`
    || typeof e.markPrice !== 'string' || e.markPrice.length > 128 || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(e.markPrice)) return false;
  try { const price = new Decimal(e.markPrice); return price.isFinite() && price.gt(0) && Math.abs(price.e) <= 100; } catch { return false; }
}
export function validPositionBook(value: unknown): value is PositionBook {
  if (!value || typeof value !== 'object') return false;
  const b = value as PositionBook;
  return b.schemaVersion === 1 && Number.isSafeInteger(b.revision) && b.revision >= 0
    && Number.isSafeInteger(b.updatedAt) && b.updatedAt >= 0
    && Array.isArray(b.positions) && b.positions.length <= 100 && b.positions.every(validPositionState)
    && new Set(b.positions.map(p => p.position.id)).size === b.positions.length
    && Array.isArray(b.events) && b.events.length <= 1000 && b.events.every(validRiskEvent)
    && new Set(b.events.map(e => e.id)).size === b.events.length
    && Array.isArray(b.notified) && b.notified.length <= 1000 && b.notified.every(id => typeof id === 'string' && id.length > 0 && id.length <= 180)
    && new Set(b.notified).size === b.notified.length;
}
let opening: ReturnType<typeof openPositionDb> | null = null;
function openPositionDb() {
  return openDB<PositionDb>('binance-private-positions-v1', 1, { upgrade(db) {
    db.createObjectStore('book'); db.createObjectStore('outbox', { keyPath: 'id' });
  } });
}
const database = () => opening ??= openPositionDb().catch(error => { opening = null; throw error; });
function checked(value: unknown): PositionBook {
  if (value === undefined) return emptyPositionBook();
  if (!validPositionBook(value)) throw new Error('本机持仓记录无法校验，已暂停监控；原记录未覆盖。');
  return value;
}
export async function readPositionBook(): Promise<PositionBook> { return checked(await (await database()).get('book', 'current')); }

/** IDB serializes read-write transactions across tabs: read, evaluate, state and outbox commit atomically. */
export async function updatePositionBook(change: (book: PositionBook) => PositionBook, now = Date.now()): Promise<PositionBook> {
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('持仓更新时间无效，未写入。');
  const db = await database(), tx = db.transaction(['book', 'outbox'], 'readwrite');
  try {
    const previous = checked(await tx.objectStore('book').get('current'));
    if (now < previous.updatedAt) throw new Error('本机时钟倒退，暂停更新持仓。');
    const next = change(structuredClone(previous));
    if (!validPositionBook(next)) throw new Error('持仓更新未通过校验，未保存或启用。');
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      next.revision = previous.revision + 1; next.updatedAt = now;
      if (!validPositionBook(next)) throw new Error('持仓版本或更新时间无效，未写入。');
      const known = new Set(previous.events.map(e => e.id));
      for (const event of next.events) if (!known.has(event.id)) await tx.objectStore('outbox').put({ id: event.id, event, owner: null, leaseUntil: 0, completed: false });
      await tx.objectStore('book').put(next, 'current');
    }
    await tx.done;
    return next;
  } catch (error) { try { tx.abort(); } catch { /* transaction may already be aborted */ } await tx.done.catch(() => {}); throw error; }
}

export async function claimPositionNotifications(owner: string, now = Date.now()): Promise<PositionRiskEvent[]> {
  if (typeof owner !== 'string' || !owner || owner.length > 100 || !Number.isSafeInteger(now) || now <= 0) return [];
  const db = await database(), tx = db.transaction('outbox', 'readwrite');
  const items = await tx.store.getAll(), claimed: PositionRiskEvent[] = [];
  for (const item of items) {
    if (!validRiskEvent(item.event) || item.id !== item.event.id || item.event.timestamp > now || typeof item.completed !== 'boolean'
      || !Number.isSafeInteger(item.leaseUntil) || item.leaseUntil < 0 || !(item.owner === null || typeof item.owner === 'string' && item.owner.length <= 100)) continue;
    if (now - item.event.timestamp > 7 * 86_400_000) { await tx.store.delete(item.id); continue; }
    // Old events remain in the risk center, but are not replayed as fresh popups after a long absence.
    if (item.completed || item.leaseUntil > now || now - item.event.timestamp > 300_000) continue;
    if (claimed.length === 5) break;
    await tx.store.put({ ...item, owner, leaseUntil: now + 30_000 }); claimed.push(item.event);
  }
  await tx.done; return claimed;
}
export async function finishPositionNotification(id: string, owner: string, completed: boolean): Promise<void> {
  const db = await database(), tx = db.transaction('outbox', 'readwrite'), item = await tx.store.get(id);
  if (item?.owner === owner) await tx.store.put({ ...item, completed });
  await tx.done;
}
