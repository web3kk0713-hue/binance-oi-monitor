import { openDB, type DBSchema } from 'idb';
import type { StructureShadowBook } from '../shared/structureTypes';
import { validStructureShadowBook } from '../shared/structureReplay';

interface ResearchDb extends DBSchema {
  book: { key: string; value: StructureShadowBook };
}
export const emptyStructureBook = (): StructureShadowBook => ({ schemaVersion: 1, revision: 0, updatedAt: 0, records: [] });
let opening: ReturnType<typeof openResearchDb> | null = null;
function openResearchDb() {
  return openDB<ResearchDb>('binance-structure-research-v1', 1, { upgrade(db) { db.createObjectStore('book'); } });
}
const database = () => opening ??= openResearchDb().catch(error => { opening = null; throw error; });
function checked(value: unknown): StructureShadowBook {
  if (value === undefined) return emptyStructureBook();
  if (!validStructureShadowBook(value)) throw new Error('本机验证记录无法校验，已暂停观察；原记录未覆盖。');
  return value;
}
export async function readStructureBook(): Promise<StructureShadowBook> {
  return checked(await (await database()).get('book', 'current'));
}
/** A separate transaction boundary: this module never opens the official position/outbox database. */
export async function updateStructureBook(change: (book: StructureShadowBook) => StructureShadowBook, now = Date.now()) {
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('验证记录时间无效。');
  const db = await database(), tx = db.transaction('book', 'readwrite');
  try {
    const previous = checked(await tx.store.get('current'));
    if (now < previous.updatedAt) throw new Error('本机时钟倒退，验证记录未更新。');
    const next = change(structuredClone(previous));
    // Version/time are transaction-owned; callers cannot reset them.
    next.revision = previous.revision; next.updatedAt = now;
    if (!validStructureShadowBook(next)) throw new Error('验证方案未通过校验，未保存。');
    if (JSON.stringify(previous.records) !== JSON.stringify(next.records)) {
      next.revision++;
      if (!validStructureShadowBook(next)) throw new Error('验证记录版本无效，未保存。');
      await tx.store.put(next, 'current');
    } else { next.updatedAt = previous.updatedAt; }
    await tx.done; return structuredClone(next);
  } catch (error) {
    try { tx.abort(); } catch { /* Already aborted. */ }
    await tx.done.catch(() => {}); throw error;
  }
}
