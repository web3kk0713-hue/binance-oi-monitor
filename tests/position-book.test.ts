import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DIRECTION_CONFIG } from '../src/shared/directionConfig';
import { createPositionRisk, stepPositionRisk } from '../src/shared/positionRisk';
import type { PositionBook, PositionMarketFrame, PositionRiskEvent, PositionRiskState, RiskPlanDraft } from '../src/shared/positionTypes';

// This is a transaction/rollback contract fake, not evidence of real browser IDB locking.
// Real cross-tab acceptance is deliberately exercised separately in the browser.
const mock = vi.hoisted(() => ({
  stores: { book: new Map<string, unknown>(), outbox: new Map<string, unknown>() },
  tail: Promise.resolve(), puts: [] as string[], failPut: '' as string, failCommit: false,
}));
vi.mock('idb', () => ({ openDB: async () => ({
  get: async (name: 'book' | 'outbox', key: string) => structuredClone(mock.stores[name].get(key)),
  transaction: (names: string | string[]) => {
    const scope = (Array.isArray(names) ? names : [names]) as ('book' | 'outbox')[];
    let release!: () => void;
    const previous = mock.tail;
    mock.tail = new Promise<void>(resolve => { release = resolve; });
    let staged: typeof mock.stores;
    let aborted = false;
    let done: Promise<void> | null = null;
    const ready = previous.then(() => { staged = structuredClone(mock.stores); });
    const store = (name: 'book' | 'outbox') => ({
      get: async (key: string) => { await ready; return structuredClone(staged[name].get(key)); },
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
}) }));

import { claimPositionNotifications, emptyPositionBook, finishPositionNotification, readPositionBook, updatePositionBook, validPositionBook } from '../src/web/positionBook';

const NOW = Date.UTC(2026, 8, 25, 12);
function draft(id = 'p1'): PositionRiskState {
  return createPositionRisk({ id, marketKey: 'futures:TESTUSDT', symbol: 'TESTUSDT', assetId: 'binance:TEST', side: 'long',
    entryPrice: '100', margin: '100', leverage: '10', createdAt: NOW - 60_000 });
}
function frame(markPrice = '100', now = NOW): PositionMarketFrame {
  return { mark: { marketKey: 'futures:TESTUSDT', markPrice, sourceTime: now, receivedAt: now, source: 'binance-mark-stream' }, atr: null, signal: null };
}
function plan(): RiskPlanDraft {
  return { stopPrice: '95', takeProfitPrice: '120', trailing: null, signalWeakening: false,
    directionConfig: { ...DEFAULT_DIRECTION_CONFIG }, method: 'manual', generatedAt: NOW };
}
function triggered(id = 'p1', at = NOW + 1000) {
  const armed = stepPositionRisk(draft(id), { type: 'confirm', now: NOW, frame: frame(), plan: plan(), expectedPlanRevision: 0 });
  if (armed.error) throw new Error(armed.error);
  const result = stepPositionRisk(armed.state, { type: 'tick', frame: frame('94', at), now: at });
  if (result.error || result.events.length !== 1) throw new Error(result.error ?? 'fixture did not trigger');
  return { state: result.state, event: result.events[0] };
}
function eventBook(count = 1): PositionBook {
  const samples = Array.from({ length: count }, (_, index) => triggered(`p${index + 1}`));
  return { ...emptyPositionBook(), positions: samples.map(s => s.state), events: samples.map(s => s.event), updatedAt: NOW + 1000 };
}
function seedBook(book: PositionBook) { mock.stores.book.set('current', structuredClone(book)); }
function seedOutbox(event: PositionRiskEvent, changes: Record<string, unknown> = {}) {
  mock.stores.outbox.set(event.id, { id: event.id, event: structuredClone(event), owner: null, leaseUntil: 0, completed: false, ...changes });
}
beforeEach(() => {
  mock.stores = { book: new Map(), outbox: new Map() }; mock.tail = Promise.resolve();
  mock.puts = []; mock.failPut = ''; mock.failCommit = false;
});

describe('private position book recovery validation', () => {
  it('accepts a fresh empty book and genuine engine-generated event/state records', () => {
    expect(validPositionBook(emptyPositionBook())).toBe(true);
    expect(validPositionBook(eventBook())).toBe(true);
    expect(validPositionBook({})).toBe(false);
  });
  it.each([null, [], { schemaVersion: 2 }, { revision: NaN }, { revision: -1 }, { revision: 1.5 },
    { updatedAt: Infinity }, { updatedAt: -1 }, { positions: null }, { events: null }, { notified: null }])
    ('rejects malformed root fields %j', value => {
      expect(validPositionBook(value === null || Array.isArray(value) ? value : { ...emptyPositionBook(), ...value })).toBe(false);
    });
  it('rejects a corrupt state and duplicate position IDs', () => {
    expect(validPositionBook({ ...emptyPositionBook(), positions: [{ ...draft(), position: { ...draft().position, margin: 'NaN' } }] })).toBe(false);
    expect(validPositionBook({ ...emptyPositionBook(), positions: [draft(), draft()] })).toBe(false);
  });
  it('allows 100 positions but rejects an oversized book', () => {
    const positions = Array.from({ length: 101 }, (_, i) => draft(`p${i}`));
    expect(validPositionBook({ ...emptyPositionBook(), positions: positions.slice(0, 100) })).toBe(true);
    expect(validPositionBook({ ...emptyPositionBook(), positions })).toBe(false);
  });
  it('rejects duplicate event IDs and more than 1000 event records', () => {
    const book = eventBook();
    expect(validPositionBook({ ...book, events: [book.events[0], book.events[0]] })).toBe(false);
    expect(validPositionBook({ ...book, events: Array.from({ length: 1001 }, (_, i) => ({ ...book.events[0], id: `p1:${i + 1}:stop`, planRevision: i + 1 })) })).toBe(false);
  });
  it.each([
    { id: '' }, { id: 'other:1:stop' }, { positionId: '' }, { symbol: '' }, { title: '' }, { message: '' },
    { planRevision: undefined }, { planRevision: 0 }, { planRevision: 1.5 }, { planRevision: Number.MAX_SAFE_INTEGER + 1 },
    { sourceTime: undefined }, { sourceTime: 0 }, { sourceTime: NOW + 1001 }, { sourceTime: NaN },
    { timestamp: NOW + .5 }, { side: 'buy' }, { side: undefined }, { afterGap: undefined }, { afterGap: 'false' },
    { markPrice: '0' }, { markPrice: '-1' }, { markPrice: 'NaN' }, { markPrice: 'Infinity' }, { markPrice: '1e1000000' },
    { markPrice: '1'.repeat(129) }, { rule: 'liquidate' }, { title: 'x'.repeat(10000) }, { message: 'x'.repeat(100000) },
  ])('rejects malformed or inconsistent event fields %j', changes => {
    const book = eventBook();
    expect(validPositionBook({ ...book, events: [{ ...book.events[0], ...changes }] })).toBe(false);
  });
  it('bounds the notification ledger and rejects duplicate IDs', () => {
    expect(validPositionBook({ ...emptyPositionBook(), notified: ['p1:1:stop', 'p1:1:stop'] })).toBe(false);
    expect(validPositionBook({ ...emptyPositionBook(), notified: Array.from({ length: 1001 }, (_, i) => `p1:${i + 1}:stop`) })).toBe(false);
  });
});

describe('atomic state/outbox persistence and cross-reader CAS', () => {
  it('loads an absent record as empty without writing and skips unchanged writes', async () => {
    expect(await readPositionBook()).toEqual(emptyPositionBook());
    expect(await updatePositionBook(book => book, NOW)).toEqual(emptyPositionBook());
    expect(mock.puts).toEqual([]);
  });
  it('persists an incremented revision and one outbox item atomically', async () => {
    const next = await updatePositionBook(() => eventBook(), NOW + 1000);
    expect(next).toMatchObject({ revision: 1, updatedAt: NOW + 1000 });
    expect(await readPositionBook()).toEqual(next);
    expect(mock.stores.outbox.size).toBe(1);
    expect(mock.stores.outbox.get(next.events[0].id)).toMatchObject({ owner: null, completed: false, leaseUntil: 0 });
  });
  it('does not overwrite corrupt persisted records', async () => {
    const corrupt = { ...emptyPositionBook(), positions: [{}] };
    mock.stores.book.set('current', corrupt);
    await expect(readPositionBook()).rejects.toThrow();
    await expect(updatePositionBook(() => emptyPositionBook(), NOW)).rejects.toThrow();
    expect(mock.stores.book.get('current')).toEqual(corrupt); expect(mock.puts).toEqual([]);
  });
  it.each(['callback', 'invalid', 'book', 'outbox', 'commit'])('keeps previous state and outbox when %s fails', async failure => {
    const previous = { ...emptyPositionBook(), positions: [draft()], revision: 4, updatedAt: NOW };
    seedBook(previous);
    if (failure === 'book' || failure === 'outbox') mock.failPut = failure;
    if (failure === 'commit') mock.failCommit = true;
    await expect(updatePositionBook(book => {
      book.positions[0].position.margin = '999';
      if (failure === 'callback') throw new Error('callback rejected');
      if (failure === 'invalid') return { ...book, revision: -1 };
      return eventBook();
    }, NOW + 1000)).rejects.toThrow();
    expect(await readPositionBook()).toEqual(previous); expect(mock.stores.outbox.size).toBe(0);
    await expect(updatePositionBook(() => eventBook(), NOW + 1000)).resolves.toMatchObject({ revision: 5 });
  });
  it.each([NaN, Infinity, -1, 0, NOW + .5, NOW - 1])('rejects invalid/backward commit time %s without poisoning storage', async at => {
    const previous = { ...emptyPositionBook(), updatedAt: NOW }; seedBook(previous);
    await expect(updatePositionBook(book => ({ ...book, positions: [draft()] }), at)).rejects.toThrow();
    expect(await readPositionBook()).toEqual(previous); expect(mock.stores.outbox.size).toBe(0);
  });
  it('rejects revision overflow before saving', async () => {
    const previous = { ...emptyPositionBook(), revision: Number.MAX_SAFE_INTEGER, updatedAt: NOW }; seedBook(previous);
    await expect(updatePositionBook(book => ({ ...book, positions: [draft()] }), NOW)).rejects.toThrow();
    expect(await readPositionBook()).toEqual(previous);
  });
  it('rejects the second stale plan confirmation after rereading transaction-authoritative state', async () => {
    seedBook({ ...emptyPositionBook(), positions: [draft()], updatedAt: NOW });
    const confirm = () => updatePositionBook(book => {
      const result = stepPositionRisk(book.positions[0], { type: 'confirm', plan: plan(), frame: frame(), now: NOW, expectedPlanRevision: 0 });
      if (result.error) throw new Error(result.error);
      return { ...book, positions: [result.state] };
    }, NOW);
    const results = await Promise.allSettled([confirm(), confirm()]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((await readPositionBook()).positions[0].plan?.revision).toBe(1);
  });
  it('does not requeue a completed event when unrelated book state changes', async () => {
    const stored = await updatePositionBook(() => eventBook(), NOW + 1000);
    const event = stored.events[0];
    await claimPositionNotifications('tab-a', NOW + 1000); await finishPositionNotification(event.id, 'tab-a', true);
    await updatePositionBook(book => ({ ...book, positions: [...book.positions, draft('p2')] }), NOW + 2000);
    expect(await claimPositionNotifications('tab-b', NOW + 2000)).toEqual([]);
    expect(mock.stores.outbox.get(event.id)).toMatchObject({ completed: true });
  });
});

describe('leased notification outbox timing and ownership', () => {
  it('allows only one claimant during the lease, then permits retry exactly at expiry', async () => {
    const event = triggered().event; seedOutbox(event);
    expect(await claimPositionNotifications('tab-a', NOW + 1000)).toEqual([event]);
    expect(await claimPositionNotifications('tab-b', NOW + 30_999)).toEqual([]);
    expect(await claimPositionNotifications('tab-b', NOW + 31_000)).toEqual([event]);
  });
  it('serializes simultaneous tab claims at the transaction boundary', async () => {
    seedOutbox(triggered().event);
    const claims = await Promise.all([claimPositionNotifications('tab-a', NOW + 1000), claimPositionNotifications('tab-b', NOW + 1000)]);
    expect(claims.flat()).toHaveLength(1);
  });
  it('does not let an expired owner acknowledge a replacement owner claim', async () => {
    const event = triggered().event; seedOutbox(event);
    await claimPositionNotifications('tab-a', NOW + 1000);
    await claimPositionNotifications('tab-b', NOW + 31_000);
    await finishPositionNotification(event.id, 'tab-a', true);
    expect(mock.stores.outbox.get(event.id)).toMatchObject({ owner: 'tab-b', completed: false });
    await finishPositionNotification(event.id, 'tab-b', true);
    expect(await claimPositionNotifications('tab-c', NOW + 61_000)).toEqual([]);
  });
  it('retains a failed delivery for retry, without immediate lease bypass', async () => {
    const event = triggered().event; seedOutbox(event);
    await claimPositionNotifications('tab-a', NOW + 1000); await finishPositionNotification(event.id, 'tab-a', false);
    expect(await claimPositionNotifications('tab-a', NOW + 2000)).toEqual([]);
    expect(await claimPositionNotifications('tab-a', NOW + 31_000)).toEqual([event]);
  });
  it('does not persist a claim when its commit fails, and permits a clean retry', async () => {
    const event = triggered().event; seedOutbox(event); mock.failCommit = true;
    await expect(claimPositionNotifications('tab-a', NOW + 1000)).rejects.toThrow('commit failure');
    expect(mock.stores.outbox.get(event.id)).toMatchObject({ owner: null, leaseUntil: 0, completed: false });
    expect(await claimPositionNotifications('tab-b', NOW + 1000)).toEqual([event]);
  });
  it('does not lose an unacknowledged notification when acknowledgement commit fails', async () => {
    const event = triggered().event; seedOutbox(event);
    await claimPositionNotifications('tab-a', NOW + 1000); mock.failCommit = true;
    await expect(finishPositionNotification(event.id, 'tab-a', true)).rejects.toThrow('commit failure');
    expect(mock.stores.outbox.get(event.id)).toMatchObject({ owner: 'tab-a', completed: false });
    expect(await claimPositionNotifications('tab-b', NOW + 31_000)).toEqual([event]);
  });
  it('caps a claim batch at five without losing the remaining items', async () => {
    for (const event of eventBook(7).events) seedOutbox(event);
    expect(await claimPositionNotifications('tab-a', NOW + 1000)).toHaveLength(5);
    expect(await claimPositionNotifications('tab-b', NOW + 1000)).toHaveLength(2);
  });
  it('does not replay notifications older than five minutes, but retains recent risk history', async () => {
    const event = triggered().event; seedOutbox(event);
    expect(await claimPositionNotifications('tab-a', event.timestamp + 300_001)).toEqual([]);
    expect(mock.stores.outbox.has(event.id)).toBe(true);
  });
  it('prunes outbox items older than seven days without deleting book history', async () => {
    const book = eventBook(); seedBook(book); seedOutbox(book.events[0]);
    expect(await claimPositionNotifications('tab-a', book.events[0].timestamp + 7 * 86_400_000 + 1)).toEqual([]);
    expect(mock.stores.outbox.size).toBe(0); expect(await readPositionBook()).toEqual(book);
  });
  it('does not deliver a future-dated event', async () => {
    seedOutbox(triggered().event);
    const events = await claimPositionNotifications('tab-a', NOW).catch(() => []);
    expect(events).toEqual([]);
  });
  it.each([
    { event: null }, { event: { timestamp: NOW + 1000 } }, { completed: 'no' }, { leaseUntil: NaN },
    { id: 'wrong-id' }, { owner: 123 },
  ])('never presents corrupt outbox data %j as a valid alert', async corruption => {
    seedOutbox(triggered().event, corruption);
    const events = await claimPositionNotifications('tab-a', NOW + 1000).catch(() => []);
    expect(events).toEqual([]);
  });
});
