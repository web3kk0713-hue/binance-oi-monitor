import { openDB, type DBSchema } from 'idb';
import Decimal from 'decimal.js';
import { freshEntryMark, validEntryBook, validEntryEvent, type EntryBook, type EntryEvent } from '../shared/entryWatch';

interface Delivery { id: string; event: EntryEvent; owner: string | null; leaseUntil: number; completed: boolean }
interface EntryDb extends DBSchema {
  book: { key: string; value: EntryBook };
  outbox: { key: string; value: Delivery };
}
export const emptyEntryBook = (): EntryBook => ({ schemaVersion: 1, revision: 0, updatedAt: 0, watches: [], events: [] });
let opening: ReturnType<typeof openEntryDb> | null = null;
function openEntryDb() {
  return openDB<EntryDb>('binance-entry-plans-v1', 1, {
    upgrade(db) { db.createObjectStore('book'); db.createObjectStore('outbox', { keyPath: 'id' }); },
    terminated() { opening = null; },
  });
}
const database = () => opening ??= openEntryDb().catch(error => { opening = null; throw error; });
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function checked(value: unknown): EntryBook {
  if (value === undefined) return emptyEntryBook();
  if (!validEntryBook(value)) throw new Error('本机进场计划无法校验，暂停观察；原记录未覆盖。');
  return value;
}
export async function readEntryBook(): Promise<EntryBook> { return checked(await (await database()).get('book', 'current')); }
/** Pure synchronous change inside the transaction; state and new reminders commit together. */
export async function updateEntryBook(change: (book: EntryBook) => EntryBook, now = Date.now()): Promise<EntryBook> {
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('进场计划更新时间无效。');
  const tx = (await database()).transaction(['book', 'outbox'], 'readwrite');
  try {
    const previous = checked(await tx.objectStore('book').get('current'));
    if (now < previous.updatedAt) throw new Error('本机时钟倒退，暂停更新进场计划。');
    const next = change(structuredClone(previous));
    const changed = JSON.stringify(previous) !== JSON.stringify(next);
    if (!object(next)) throw new Error('进场计划更新校验失败，未保存或启用。');
    // New state may legitimately have later event/evaluation times than the previous book.
    // Stamp the commit envelope before validating those cross-record time invariants.
    if (changed) {
      next.revision = previous.revision + 1; next.updatedAt = now;
    }
    if (!validEntryBook(next)) throw new Error('进场计划更新校验失败，未保存或启用。');
    if (changed) {
      const known = new Set(previous.events.map(event => event.id));
      for (const event of next.events) if (!known.has(event.id))
        await tx.objectStore('outbox').put({ id: event.id, event, owner: null, leaseUntil: 0, completed: false });
      await tx.objectStore('book').put(next, 'current');
    }
    await tx.done; return next;
  } catch (error) { try { tx.abort(); } catch { /* Already aborted. */ } await tx.done.catch(() => {}); throw error; }
}
/** A ready alert is actionable only while the latest atomically persisted evaluation still confirms it. */
function currentReady(event: EntryEvent, book: EntryBook, now: number): boolean {
  const watch = book.watches.find(item => item.plan.id === event.planId);
  const storedEvent = book.events.find(item => item.id === event.id);
  if (!watch || !storedEvent || JSON.stringify(storedEvent) !== JSON.stringify(event)
    || watch.plan.market.symbol !== event.symbol || watch.plan.market.assetId !== event.assetId
    || watch.phase !== 'ready' || watch.fillIntent !== null || watch.triggeredAt !== event.timestamp || watch.gap
    || watch.lastEvaluatedAt > now || now - watch.lastEvaluatedAt > 15_000 || now >= watch.plan.waitUntil
    || !freshEntryMark(watch.lastMark, watch.plan.market.key, now)) return false;
  const price = new Decimal(watch.lastMark.markPrice);
  return price.gte(watch.plan.entryLow) && price.lte(watch.plan.entryHigh);
}
export async function claimEntryNotifications(owner: string, now = Date.now()): Promise<EntryEvent[]> {
  if (typeof owner !== 'string' || !owner || owner.length > 100 || !Number.isSafeInteger(now) || now <= 0) return [];
  const tx = (await database()).transaction(['book', 'outbox'], 'readwrite');
  try {
    const book = checked(await tx.objectStore('book').get('current')), outbox = tx.objectStore('outbox');
    const claimed: EntryEvent[] = [];
    for (const item of await outbox.getAll()) {
      if (!object(item) || !validEntryEvent(item.event) || item.id !== item.event.id || item.event.timestamp > now || typeof item.completed !== 'boolean'
        || !Number.isSafeInteger(item.leaseUntil) || item.leaseUntil < 0 || !(item.owner === null || typeof item.owner === 'string' && item.owner.length <= 100)) continue;
      if (now - item.event.timestamp > 7 * 86_400_000) { await outbox.delete(item.id); continue; }
      if (!item.completed && item.event.kind === 'ready' && !currentReady(item.event, book, now)) {
        // Invalidate the lease as well: an old owner cannot resurrect this obsolete alert with a failed-delivery acknowledgement.
        await outbox.put({ ...item, owner: null, leaseUntil: 0, completed: true }); continue;
      }
      if (item.completed || item.leaseUntil > now || now - item.event.timestamp > 300_000) continue;
      if (claimed.length >= 5) break;
      await outbox.put({ ...item, owner, leaseUntil: now + 30_000 }); claimed.push(item.event);
    }
    await tx.done; return claimed;
  } catch (error) { try { tx.abort(); } catch { /* Already aborted. */ } await tx.done.catch(() => {}); throw error; }
}
export async function finishEntryNotification(id: string, owner: string, completed: boolean): Promise<void> {
  if (typeof id !== 'string' || typeof owner !== 'string' || !owner || owner.length > 100 || typeof completed !== 'boolean') return;
  const tx = (await database()).transaction('outbox', 'readwrite');
  try {
    const item = await tx.store.get(id);
    if (item?.owner === owner && item.id === id && validEntryEvent(item.event)) await tx.store.put({ ...item, completed });
    await tx.done;
  } catch (error) { try { tx.abort(); } catch { /* Already aborted. */ } await tx.done.catch(() => {}); throw error; }
}
