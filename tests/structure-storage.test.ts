import { beforeEach, describe, expect, it, vi } from 'vitest';
import { proposeStructureAdvice } from '../src/shared/structureAdvice';
import { startStructureShadow, stepStructureShadow } from '../src/shared/structureReplay';
import { structureFixture, STRUCTURE_TEST_NOW as NOW } from './structure-fixture';

// Transaction fake only; does not claim real browser IndexedDB acceptance.
const mock = vi.hoisted(() => ({ value: undefined as unknown, tail: Promise.resolve(), failure: false, writes: 0, names: [] as string[] }));
vi.mock('idb', () => ({ openDB: async (name: string) => {
  mock.names.push(name);
  return { get: async () => structuredClone(mock.value), transaction: () => {
    const previous = mock.tail; let release!: () => void, staged: unknown, aborted = false, written = false;
    mock.tail = new Promise<void>(resolve => { release = resolve; });
    const ready = previous.then(() => { staged = structuredClone(mock.value); });
    let done: Promise<void> | null = null;
    return { store: { get: async () => { await ready; return structuredClone(staged); }, put: async (value: unknown) => {
      await ready; if (mock.failure) { aborted = true; throw new Error('write failed'); }
      staged = structuredClone(value); written = true;
    } }, abort: () => { aborted = true; }, get done() {
      done ??= ready.then(() => { if (aborted) throw new Error('aborted'); if (written) { mock.value = staged; mock.writes++; } }).finally(release);
      return done;
    } };
  } };
} }));
import { emptyStructureBook, readStructureBook, updateStructureBook } from '../src/web/structureStorage';
function shadow(id = 'shadow-1') {
  const input = structureFixture(); const result = proposeStructureAdvice(input);
  if (result.status !== 'ready') throw new Error(result.reason);
  return startStructureShadow(id, result.advice, input.reference, NOW);
}
beforeEach(() => { mock.value = undefined; mock.tail = Promise.resolve(); mock.failure = false; mock.writes = 0; });
describe('independent local research book', () => {
  it('starts empty without writing official position state or outbox', async () => {
    expect(await readStructureBook()).toEqual(emptyStructureBook());
    expect(mock.writes).toBe(0);
    expect(mock.names.every(n => n === 'binance-structure-research-v1')).toBe(true);
  });
  it('saves a frozen engine proposal and restores it unchanged', async () => {
    const record = shadow();
    const saved = await updateStructureBook(book => ({ ...book, records: [record] }), NOW);
    expect(saved.revision).toBe(1); expect(saved.updatedAt).toBe(NOW);
    record.advice.stop.price = '1';
    const restored = await readStructureBook();
    expect(restored.records[0].advice.stop.price).toBe('97.5');
    expect(restored).toEqual(saved);
  });
  it('serializes concurrent records without dropping one', async () => {
    await Promise.all(['one', 'two'].map(id => updateStructureBook(book => ({ ...book, records: [...book.records, shadow(id)] }), NOW)));
    const book = await readStructureBook(); expect(book.records).toHaveLength(2); expect(book.revision).toBe(2);
  });
  it('does not rewrite unchanged observations or let caller reset revision', async () => {
    await updateStructureBook(book => ({ ...book, records: [shadow()] }), NOW);
    const same = await updateStructureBook(book => ({ ...book, revision: 0 }), NOW + 5000);
    expect(same.revision).toBe(1); expect(same.updatedAt).toBe(NOW); expect(mock.writes).toBe(1);
  });
  it('preserves invalid stored data and refuses to replace it with an empty book', async () => {
    mock.value = { schemaVersion: 99, records: [] };
    await expect(readStructureBook()).rejects.toThrow('无法校验');
    await expect(updateStructureBook(() => emptyStructureBook(), NOW)).rejects.toThrow('原记录未覆盖');
    expect(mock.value).toEqual({ schemaVersion: 99, records: [] }); expect(mock.writes).toBe(0);
  });
  it('retains the prior record when a write fails, and a later retry succeeds', async () => {
    await updateStructureBook(book => ({ ...book, records: [shadow()] }), NOW);
    const previous = structuredClone(mock.value); mock.failure = true;
    await expect(updateStructureBook(book => ({ ...book, records: book.records.map(r => ({ ...r, gap: true })) }), NOW + 5000)).rejects.toThrow('write failed');
    expect(mock.value).toEqual(previous); mock.failure = false;
    const next = await updateStructureBook(book => ({ ...book, records: book.records.map(r => ({ ...r, gap: true })) }), NOW + 6000);
    expect(next.records[0].gap).toBe(true);
  });
  it('persists observed touches without changing the candidate or auto-closing', async () => {
    await updateStructureBook(book => ({ ...book, records: [shadow()] }), NOW);
    const input = structureFixture();
    const book = await updateStructureBook(book => ({ ...book, records: book.records.map(r => stepStructureShadow(r,
      { ...input.reference, markPrice: '97', sourceTime: NOW + 5000, receivedAt: NOW + 5000 }, NOW + 5000)) }), NOW + 5000);
    expect(book.records[0].touches).toHaveLength(1); expect(book.records[0].stoppedAt).toBeNull();
    expect(book.records[0].advice.stop.price).toBe('97.5');
  });
  it('never silently deletes seven-day records', async () => {
    await updateStructureBook(book => ({ ...book, records: [shadow()] }), NOW);
    const later = NOW + 8 * 86_400_000;
    const book = await updateStructureBook(book => ({ ...book, records: book.records.map(r => ({ ...r, gap: true })) }), later);
    expect(book.records).toHaveLength(1); expect(book.records[0].startedAt).toBe(NOW);
  });
  it('refuses clock rollback and invalid new state', async () => {
    await updateStructureBook(book => ({ ...book, records: [shadow()] }), NOW);
    await expect(updateStructureBook(b => b, NOW - 1)).rejects.toThrow('时钟倒退');
    await expect(updateStructureBook(b => ({ ...b, records: [{ ...b.records[0], touches: [{ rule: 'execute' }] as never }] }), NOW)).rejects.toThrow('未通过校验');
  });
});
