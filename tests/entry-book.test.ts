import { beforeEach, describe, expect, it, vi } from 'vitest';
import { adoptEntryPlan, entryPositionId, stepEntryWatch, validEntryBook, type EntryBook, type EntryEvent, type EntryWatch } from '../src/shared/entryWatch';
import { entryFlow, entryPlan, ENTRY_NOW as NOW } from './entry-fixture';

// Contract fake: transactions stage private copies and serialize commits. Real browser IDB locking is verified separately.
const mock = vi.hoisted(() => ({
  stores: { book: new Map<string, unknown>(), outbox: new Map<string, unknown>() }, tail: Promise.resolve(),
  puts: [] as string[], scopes: [] as string[][], failPut: '', failCommit: false, failOpen: false, failRead: false, failTxRead: false,
  opened: 0, terminated: null as null | (() => void),
}));
vi.mock('idb', () => ({ openDB: async (_name: string, _version: number, options: { terminated(): void }) => {
  mock.opened++; mock.terminated = options.terminated;
  if (mock.failOpen) { mock.failOpen = false; throw new Error('simulated open failure'); }
  return {
    get: async (name: 'book' | 'outbox', key: string) => {
      if (mock.failRead) { mock.failRead = false; throw new Error('simulated read failure'); }
      return structuredClone(mock.stores[name].get(key));
    },
    transaction: (names: string | string[]) => {
      const scope = (Array.isArray(names) ? names : [names]) as ('book' | 'outbox')[]; mock.scopes.push(scope);
      let release!: () => void;
      const previous = mock.tail; mock.tail = new Promise<void>(resolve => { release = resolve; });
      let staged: typeof mock.stores, aborted = false, done: Promise<void> | null = null;
      const ready = previous.then(() => { staged = structuredClone(mock.stores); });
      const store = (name: 'book' | 'outbox') => ({
        get: async (key: string) => {
          await ready; if (mock.failTxRead) { mock.failTxRead = false; throw new Error('simulated transaction read failure'); }
          return structuredClone(staged[name].get(key));
        },
        getAll: async () => { await ready; return structuredClone([...staged[name].values()]); },
        delete: async (key: string) => { await ready; staged[name].delete(key); },
        put: async (value: unknown, key?: string) => {
          await ready; mock.puts.push(name);
          if (mock.failPut === name) { mock.failPut = ''; aborted = true; throw new Error(`simulated ${name} write failure`); }
          staged[name].set(key ?? (value as { id: string }).id, structuredClone(value));
        },
      });
      return { objectStore: store, store: store(scope[0]), abort: () => { aborted = true; },
        get done() {
          done ??= ready.then(() => {
            if (aborted) throw new Error('simulated aborted transaction');
            if (mock.failCommit) { mock.failCommit = false; throw new Error('simulated commit failure'); }
            for (const name of scope) mock.stores[name] = staged[name];
          }).finally(release);
          return done;
        },
      };
    },
  };
} }));

let api: typeof import('../src/web/entryBook');
const AT = NOW + 60_000;
function initial(id = 'entry-one'): EntryWatch {
  return adoptEntryPlan(entryPlan('long', id), entryFlow(NOW).marks![0], NOW);
}
function ready(id = 'entry-one') {
  const result = stepEntryWatch(initial(id), entryFlow(AT, '98.7'), AT);
  if (result.watch.phase !== 'ready' || result.events.length !== 1) throw new Error('ready fixture failed');
  return result;
}
function readyBook(count = 1): EntryBook {
  const samples = Array.from({ length: count }, (_, index) => ready(`entry-${index}`));
  return { schemaVersion: 1, revision: 1, updatedAt: AT, watches: samples.map(sample => sample.watch), events: samples.flatMap(sample => sample.events) };
}
function seed(book = readyBook()) {
  mock.stores.book.set('current', structuredClone(book));
  for (const event of book.events) mock.stores.outbox.set(event.id, { id: event.id, event: structuredClone(event), owner: null, leaseUntil: 0, completed: false });
  return book;
}
function refresh(book: EntryBook, now: number) {
  book.watches = book.watches.map(watch => stepEntryWatch(watch, entryFlow(now, '98.7'), now).watch); book.updatedAt = now;
  mock.stores.book.set('current', structuredClone(book));
}
beforeEach(async () => {
  mock.stores = { book: new Map(), outbox: new Map() }; mock.tail = Promise.resolve(); mock.puts = []; mock.scopes = [];
  mock.failPut = ''; mock.failCommit = false; mock.failOpen = false; mock.failRead = false; mock.failTxRead = false; mock.opened = 0; mock.terminated = null;
  vi.resetModules(); api = await import('../src/web/entryBook');
});

describe('entry book transaction recovery and timestamps', () => {
  it('reads an absent record without writing and skips unchanged commits', async () => {
    expect(await api.readEntryBook()).toEqual(api.emptyEntryBook());
    expect(await api.updateEntryBook(book => book, NOW)).toEqual(api.emptyEntryBook()); expect(mock.puts).toEqual([]);
  });
  it('stamps new state time before strict cross-record validation', async () => {
    const next = await api.updateEntryBook(book => ({ ...book, watches: [initial()] }), NOW);
    expect(next).toMatchObject({ revision: 1, updatedAt: NOW }); expect(validEntryBook(next)).toBe(true);
    const triggered = ready();
    const updated = await api.updateEntryBook(book => ({ ...book, watches: [triggered.watch], events: triggered.events }), AT);
    expect(updated).toMatchObject({ revision: 2, updatedAt: AT }); expect(validEntryBook(updated)).toBe(true);
    expect(mock.stores.outbox.size).toBe(1); expect(await api.readEntryBook()).toEqual(updated);
  });
  it('preserves corrupt records and prevents notification claims from using them', async () => {
    const corrupt = { ...readyBook(), watches: [{}] }; mock.stores.book.set('current', corrupt);
    await expect(api.readEntryBook()).rejects.toThrow('无法校验');
    await expect(api.updateEntryBook(() => api.emptyEntryBook(), AT)).rejects.toThrow('无法校验');
    await expect(api.claimEntryNotifications('tab-a', AT)).rejects.toThrow('无法校验');
    expect(mock.stores.book.get('current')).toEqual(corrupt); expect(mock.puts).toEqual([]);
  });
  it.each(['callback', 'invalid', 'book', 'outbox', 'commit', 'read'])('rolls back state and outbox after %s failure, then permits retry', async failure => {
    const previous = { ...api.emptyEntryBook(), revision: 4, updatedAt: NOW, watches: [initial()] }; mock.stores.book.set('current', structuredClone(previous));
    if (failure === 'book' || failure === 'outbox') mock.failPut = failure;
    if (failure === 'commit') mock.failCommit = true;
    if (failure === 'read') mock.failTxRead = true;
    await expect(api.updateEntryBook(book => {
      book.watches[0].reason = 'local mutation';
      if (failure === 'callback') throw new Error('callback failure');
      if (failure === 'invalid') return { ...book, watches: [{} as EntryWatch] };
      return readyBook();
    }, AT)).rejects.toThrow();
    expect(await api.readEntryBook()).toEqual(previous); expect(mock.stores.outbox.size).toBe(0);
    await expect(api.updateEntryBook(() => readyBook(), AT)).resolves.toMatchObject({ revision: 5, updatedAt: AT });
  });
  it.each([NaN, Infinity, 0, -1, AT - .5, NOW - 1])('rejects invalid/backward commit time %s', at => {
    mock.stores.book.set('current', { ...api.emptyEntryBook(), updatedAt: NOW });
    return expect(api.updateEntryBook(book => ({ ...book, watches: [initial()] }), at)).rejects.toThrow();
  });
  it('rejects revision overflow and state later than commit time', async () => {
    const previous = { ...api.emptyEntryBook(), revision: Number.MAX_SAFE_INTEGER, updatedAt: NOW }; mock.stores.book.set('current', previous);
    await expect(api.updateEntryBook(book => ({ ...book, watches: [initial()] }), NOW)).rejects.toThrow();
    expect(mock.stores.book.get('current')).toEqual(previous);
    mock.stores.book.set('current', api.emptyEntryBook());
    await expect(api.updateEntryBook(() => readyBook(), NOW)).rejects.toThrow(); expect(mock.stores.outbox.size).toBe(0);
  });
  it('retries transient reads, failed opens and terminated connections without clearing persisted data', async () => {
    const book = seed(); mock.failOpen = true;
    await expect(api.readEntryBook()).rejects.toThrow('open failure'); expect(await api.readEntryBook()).toEqual(book); expect(mock.opened).toBe(2);
    mock.failRead = true; await expect(api.readEntryBook()).rejects.toThrow('read failure'); expect(await api.readEntryBook()).toEqual(book);
    mock.terminated!(); expect(await api.readEntryBook()).toEqual(book); expect(mock.opened).toBe(3);
  });
});

describe('current-state-gated entry notification leases', () => {
  it('atomically claims current ready alerts with book and outbox under the same lock', async () => {
    const book = seed(); expect(await api.claimEntryNotifications('tab-a', AT)).toEqual(book.events);
    expect(mock.scopes.at(-1)).toEqual(['book', 'outbox']); expect(mock.stores.outbox.get(book.events[0].id)).toMatchObject({ owner: 'tab-a', leaseUntil: AT + 30_000 });
  });
  it('serializes simultaneous tab claims and retries only after lease expiry with a fresh evaluation', async () => {
    const book = seed(), claims = await Promise.all([api.claimEntryNotifications('tab-a', AT), api.claimEntryNotifications('tab-b', AT)]);
    expect(claims.flat()).toHaveLength(1); refresh(book, AT + 29_999);
    expect(await api.claimEntryNotifications('tab-c', AT + 29_999)).toEqual([]);
    refresh(book, AT + 30_000); expect(await api.claimEntryNotifications('tab-c', AT + 30_000)).toEqual(book.events);
  });
  it('keeps a failed delivery pending within its lease and rejects acknowledgement from an old owner', async () => {
    const book = seed(), event = book.events[0]; await api.claimEntryNotifications('tab-a', AT); await api.finishEntryNotification(event.id, 'tab-a', false);
    expect(await api.claimEntryNotifications('tab-a', AT + 1)).toEqual([]);
    refresh(book, AT + 30_000); await api.claimEntryNotifications('tab-b', AT + 30_000);
    await api.finishEntryNotification(event.id, 'tab-a', true); expect(mock.stores.outbox.get(event.id)).toMatchObject({ owner: 'tab-b', completed: false });
    await api.finishEntryNotification(event.id, 'tab-b', true); expect(await api.claimEntryNotifications('tab-c', AT + 30_000)).toEqual([]);
  });
  it.each(['claim-commit', 'claim-write', 'ack-commit', 'ack-write'])('recovers after %s failure without losing the pending alert', async failure => {
    const book = seed(), event = book.events[0];
    if (failure.startsWith('ack')) await api.claimEntryNotifications('tab-a', AT);
    if (failure.endsWith('commit')) mock.failCommit = true; else mock.failPut = 'outbox';
    await expect(failure.startsWith('ack') ? api.finishEntryNotification(event.id, 'tab-a', true) : api.claimEntryNotifications('tab-a', AT)).rejects.toThrow();
    expect(mock.stores.outbox.get(event.id)).toMatchObject({ completed: false });
    const at = failure.startsWith('ack') ? AT + 30_000 : AT; refresh(book, at);
    expect(await api.claimEntryNotifications('tab-b', at)).toEqual(book.events);
  });
  it.each(['watching', 'invalidated', 'expired', 'stopped', 'filled'] as const)('permanently cancels old ready alerts when state is %s while retaining history', async phase => {
    const book = readyBook(), watch = book.watches[0]; watch.phase = phase;
    if (phase === 'filled') { watch.fillIntent = { entryPrice: '98.7', margin: '100', leverage: '2', openedAt: AT }; watch.filledPositionId = entryPositionId(watch.plan.id); }
    seed(book); const event = book.events[0];
    expect(await api.claimEntryNotifications('tab-a', AT)).toEqual([]);
    expect(mock.stores.outbox.get(event.id)).toMatchObject({ completed: true, owner: null, leaseUntil: 0 }); expect(await api.readEntryBook()).toEqual(book);
  });
  it.each(['gap', 'fill-intent', 'trigger-time', 'stale-evaluation', 'stale-mark', 'out-of-zone', 'expired-deadline', 'missing-watch', 'missing-event', 'altered-event'] as const)
    ('never presents a ready alert with %s as a current entry opportunity', async failure => {
      const book = readyBook(), watch = book.watches[0]; let at = AT;
      if (failure === 'gap') watch.gap = true;
      if (failure === 'fill-intent') watch.fillIntent = { entryPrice: '98.7', margin: '100', leverage: '2', openedAt: AT };
      if (failure === 'trigger-time') watch.triggeredAt = AT - 1;
      if (failure === 'stale-evaluation') at += 15_001;
      if (failure === 'stale-mark') { watch.lastMark!.sourceTime -= 15_001; watch.lastMark!.receivedAt -= 15_001; }
      if (failure === 'out-of-zone') watch.lastMark!.markPrice = '100';
      if (failure === 'expired-deadline') { at = watch.plan.waitUntil; watch.lastEvaluatedAt = at; watch.lastMark!.sourceTime = at; watch.lastMark!.receivedAt = at; book.updatedAt = at; }
      const event = structuredClone(book.events[0]); seed(book);
      if (failure === 'missing-watch') book.watches = [];
      if (failure === 'missing-event') book.events = [];
      if (failure === 'altered-event') book.events[0].message = 'changed';
      mock.stores.book.set('current', structuredClone(book));
      expect(await api.claimEntryNotifications('tab-a', at)).toEqual([]);
      expect(mock.stores.outbox.get(event.id)).toMatchObject({ completed: true }); expect(await api.readEntryBook()).toEqual(book);
    });
  it('cannot resurrect an invalidated alert when the former lease owner reports failure late', async () => {
    const book = seed(), event = book.events[0]; await api.claimEntryNotifications('tab-a', AT);
    book.watches[0].phase = 'invalidated'; mock.stores.book.set('current', structuredClone(book));
    expect(await api.claimEntryNotifications('tab-b', AT + 1)).toEqual([]); await api.finishEntryNotification(event.id, 'tab-a', false);
    expect(mock.stores.outbox.get(event.id)).toMatchObject({ completed: true, owner: null });
    book.watches[0].phase = 'ready'; refresh(book, AT + 30_000); expect(await api.claimEntryNotifications('tab-c', AT + 30_000)).toEqual([]);
  });
  it('accepts exact 15-second freshness but never replays alerts older than five minutes', async () => {
    const book = seed(); expect(await api.claimEntryNotifications('tab-a', AT + 15_000)).toEqual(book.events);
    refresh(book, AT + 300_001); expect(await api.claimEntryNotifications('tab-b', AT + 300_001)).toEqual([]);
  });
  it('retains invalidation/expiry risk messages even though their watches are terminal', async () => {
    const watch = initial(), next = stepEntryWatch(watch, entryFlow(NOW + 1, '97'), NOW + 1);
    const book: EntryBook = { ...api.emptyEntryBook(), updatedAt: NOW + 1, watches: [next.watch], events: next.events }; seed(book);
    expect(await api.claimEntryNotifications('tab-a', NOW + 1)).toEqual(next.events);
  });
  it('caps claims at five and prunes seven-day outbox history without deleting the book', async () => {
    const book = seed(readyBook(7)); expect(await api.claimEntryNotifications('tab-a', AT)).toHaveLength(5);
    expect(await api.claimEntryNotifications('tab-b', AT)).toHaveLength(2);
    expect(await api.claimEntryNotifications('tab-c', AT + 7 * 86_400_000 + 1)).toEqual([]);
    expect(mock.stores.outbox.size).toBe(0); expect(await api.readEntryBook()).toEqual(book);
  });
  it.each([null, { event: null }, { completed: 'false' }, { leaseUntil: NaN }, { owner: 2 }, { id: 'wrong' }])('ignores corrupt outbox entries %# without presenting them', async corrupt => {
    const book = seed(), event = book.events[0], existing = mock.stores.outbox.get(event.id);
    mock.stores.outbox.set(event.id, corrupt === null ? null : { ...(existing as object), ...corrupt });
    expect(await api.claimEntryNotifications('tab-a', AT)).toEqual([]);
  });
  it('never requeues a completed event after an unrelated state write', async () => {
    const book = seed(), event = book.events[0]; await api.claimEntryNotifications('tab-a', AT); await api.finishEntryNotification(event.id, 'tab-a', true);
    await api.updateEntryBook(value => ({ ...value, watches: value.watches.map(watch => ({ ...watch, reason: 'another reason' })) }), AT);
    expect(mock.stores.outbox.get(event.id)).toMatchObject({ completed: true }); expect(await api.claimEntryNotifications('tab-b', AT)).toEqual([]);
  });
});
