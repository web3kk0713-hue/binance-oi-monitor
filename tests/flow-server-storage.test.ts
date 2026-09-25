// Synthetic public observations; these tests prove persistence and as-of rules, not trading efficacy.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { SqliteDatabase } from '../server/database';
import { FLOW_LEASE_MS, FLOW_RETENTION_MS, FlowStore } from '../server/flow-store';
import type { FlowCandle, FlowDepth, FlowEvent, FlowMarket, FlowSnapshot, FlowUpdate } from '../src/shared/flowTypes';

const clock = Date.UTC(2026, 8, 23, 12);
const market: FlowMarket = { key: 'futures:TESTUSDT', venue: 'futures', symbol: 'TESTUSDT', baseAsset: 'TEST', quoteAsset: 'USDT', assetId: 'binance:TEST' };
const directories: string[] = [];
const databases = new Set<SqliteDatabase>();
function temporaryPath() { const directory = mkdtempSync(join(tmpdir(), 'binance-flow-store-')); directories.push(directory); return join(directory, 'monitor.sqlite'); }
async function open(path: string) { const db = new SqliteDatabase(path); databases.add(db); const store = new FlowStore(db); await store.initialize(); return { db, store }; }
async function close(db: SqliteDatabase) { await db.close(); databases.delete(db); }
function update(values: Partial<FlowUpdate> = {}): FlowUpdate { return { candles: [], events: [], depth: [], oi: [], ...values }; }
function candle(openTime: number, extra: Partial<FlowCandle> = {}): FlowCandle {
  return { marketKey: market.key, openTime, closeTime: openTime + 59_999, open: 100, high: 102, low: 99, close: 101,
    volume: 20, quoteVolume: 2000, takerBuyQuote: 1200, trades: 4, closed: true,
    sourceTime: openTime + 59_999, receivedAt: openTime + 60_000, source: 'stream', ...extra };
}
function event(at = clock - 120_000): FlowEvent {
  return { id: `synthetic:${at}`, ruleVersion: 'flow-v1', marketKey: market.key, symbol: market.symbol, assetId: market.assetId,
    venue: 'futures', quoteAsset: 'USDT', kind: 'large_buy', severity: 'warning', title: 'Synthetic event', timestamp: at - 10,
    detectedAt: at, referencePrice: 100, evidence: [{ label: 'Amount', value: 1000, unit: 'USDT', baseline: 500 }],
    reason: 'Synthetic fixture only', invalidation: 'No trading instruction', dataStatus: 'complete', outcomes: [],
    rawTrade: { marketKey: market.key, id: '1', price: '100.00000000001', quantity: '10.00000000001', quoteQuantity: '1000.0000000011',
      timestamp: at - 10, receivedAt: at, side: 'buy' } };
}
function depth(at = clock - 1000): FlowDepth {
  return { marketKey: market.key, timestamp: at, receivedAt: at + 1, bid: 99, ask: 101, bidDepthQuote: 1000, askDepthQuote: 1200,
    bandBps: 20, spreadBps: 200, buySlippageBps: null, sellSlippageBps: null, orderSizeQuote: 100,
    complete: false, reason: 'Only visible bounded public depth' };
}
function snapshot(at = clock): FlowSnapshot {
  return { schemaVersion: 1, rows: [{ market, asOf: at, status: 'warming', reason: 'Synthetic fixture', price: null,
    priceChange5m: null, volume5m: null, buyShare5m: null, delta5m: null, volumeMultiple: null, vwap5m: null, range5mPct: null,
    atr14: null, oiChange5m: null, funding: null, depth: null, baselineWindows: 0, tradeSamples: 0, largeTradeThreshold: null,
    lastTradeAt: null, lastCandleAt: null }], events: [], status: { mode: 'server', startedAt: at - 1000, asOf: at,
    connectedStreams: 0, totalStreams: 1, markets: 1, readyMarkets: 0, warmingMarkets: 1, staleMarkets: 0,
    backfilledMarkets: 0, errors: [], retentionDays: 7, scope: 'Synthetic fixture only' } };
}
afterEach(async () => {
  for (const db of databases) await db.close(); databases.clear();
  for (const directory of directories.splice(0)) {
    if (resolve(directory).startsWith(resolve(tmpdir())) && basename(directory).startsWith('binance-flow-store-')) rmSync(directory, { recursive: true, force: true });
  }
});

describe('durable flow evidence and replay boundaries', () => {
  it('preserves independent raw mark strings and source times in snapshots after database restart', async () => {
    const path = temporaryPath(), first = await open(path);
    const sample = snapshot();
    sample.marks = [{ marketKey: market.key, markPrice: '100.123456789012345678901234',
      sourceTime: clock - 1000, receivedAt: clock - 500, source: 'binance-mark-stream' }];
    expect(sample.rows[0].funding).toBeNull(); expect(sample.rows[0].price).toBeNull();
    await first.store.saveSnapshot(sample); await close(first.db);
    const second = await open(path), restored = await second.store.latest();
    expect(restored?.marks).toEqual(sample.marks);
    expect(restored?.rows[0].funding).toBeNull(); expect(restored?.rows[0].price).toBeNull();
  });
  it('persists quotes in their native currency and restores candles, exact event evidence, depth and OI after restart', async () => {
    const path = temporaryPath(); const first = await open(path);
    const value = event(); const book = depth();
    await first.store.saveSnapshot(snapshot());
    const batch = update({ candles: [candle(clock - 60_000)], events: [value], depth: [book],
      oi: [{ marketKey: market.key, timestamp: clock - 1000, receivedAt: clock - 500, quantity: 2 }] });
    await first.store.writeUpdate(batch); await first.store.writeUpdate(batch);
    await close(first.db);
    const second = await open(path); await second.store.initialize();
    const history = await second.store.history(market.key, 168, clock);
    expect(history.market).toEqual(market);
    expect(history.candles).toHaveLength(1);
    expect(history.events).toEqual([value]);
    expect(history.depth).toEqual([book]); expect(history.depth[0].buySlippageBps).toBeNull();
    expect(history.oi).toHaveLength(1);
    expect((await second.store.latest())?.rows[0].price).toBeNull();
  });

  it('never rewrites event evidence and only appends each outcome once with original entry metadata', async () => {
    const { store } = await open(temporaryPath()); const original = event();
    await store.writeUpdate(update({ events: [original] }));
    const outcome = { minutes: 1 as const, price: 102, changePct: 1, availableAt: clock - 59_000, entryPrice: 101, entryAt: original.detectedAt + 1000 };
    await store.writeUpdate(update({ events: [{ ...original, title: 'Must not replace title', evidence: [], outcomes: [outcome] }] }));
    await store.writeUpdate(update({ events: [{ ...original, outcomes: [{ ...outcome, price: 999 }] }] }));
    expect(await store.events(market.key, 100, clock + 1)).toEqual([{ ...original, outcomes: [outcome] }]);
    expect((await store.history(market.key, 1, clock - 60_000)).events[0].outcomes).toEqual([]);
    expect((await store.history(market.key, 1, clock)).events[0].outcomes[0]).toEqual(outcome);
  });

  it('updates a forming candle but does not regress a closed minute or revise its captured evidence', async () => {
    const { store } = await open(temporaryPath()); const start = clock - 60_000;
    await store.writeUpdate(update({ candles: [candle(start, { closed: false, close: 100, sourceTime: start + 1000, receivedAt: start + 1001 })] }));
    await store.writeUpdate(update({ candles: [candle(start)] }));
    await store.writeUpdate(update({ candles: [candle(start, { closed: false, close: 999, receivedAt: clock + 1 }), candle(start, { close: 998, receivedAt: clock + 2 })] }));
    const history = await store.history(market.key, 1, clock + 3);
    expect(history.candles).toHaveLength(1); expect(history.candles[0].close).toBe(101); expect(history.candles[0].closed).toBe(true);
  });

  it('does not backdate late REST, delayed depth or OI, undetected events or not-yet-available outcomes', async () => {
    const { store } = await open(temporaryPath());
    const delayedEvent = { ...event(clock + 1), timestamp: clock - 10_000 };
    await store.writeUpdate(update({ candles: [candle(clock - 60_000, { source: 'rest', receivedAt: clock + 1 })],
      depth: [{ ...depth(clock - 1000), receivedAt: clock + 1 }],
      oi: [{ marketKey: market.key, timestamp: clock - 1000, receivedAt: clock + 1, quantity: 3 }], events: [delayedEvent] }));
    expect(await store.history(market.key, 1, clock)).toMatchObject({ candles: [], depth: [], oi: [], events: [] });
    expect(await store.events(market.key, 100, clock + 1)).toEqual([]);
    expect((await store.history(market.key, 1, clock + 1)).events).toHaveLength(1);
    const empty = await store.history('futures:UNKNOWNUSDT', 1, clock);
    expect(empty).toMatchObject({ market: null, candles: [], depth: [], oi: [], events: [] });
  });

  it('returns a complete seven-day minute range up to 10081 actual rows, not a short clipped chart', async () => {
    const { store } = await open(temporaryPath());
    const start = clock - FLOW_RETENTION_MS;
    const candles = Array.from({ length: 10081 }, (_, i) => {
      const at = start + i * 60_000;
      return candle(at, { closed: false, sourceTime: at, receivedAt: at });
    });
    await store.writeUpdate(update({ candles }));
    const history = await store.history(market.key, 168, clock);
    expect(history.candles).toHaveLength(10081);
    expect(history.candles[0].openTime).toBe(start); expect(history.candles.at(-1)?.openTime).toBe(clock);
  });

  it('retains the exact seven-day boundary and cleans older evidence plus dependent outcomes', async () => {
    const { store, db } = await open(temporaryPath()); const boundary = clock - FLOW_RETENTION_MS;
    const old = event(boundary - 1), kept = event(boundary);
    await store.writeUpdate(update({ candles: [candle(boundary - 60_000), candle(boundary)], events: [old, kept],
      depth: [depth(boundary - 1), depth(boundary)], oi: [boundary - 1, boundary].map(at => ({ marketKey: market.key, timestamp: at, receivedAt: at, quantity: 3 })) }));
    await store.writeUpdate(update({ events: [{ ...old, outcomes: [{ minutes: 1, price: 101, changePct: 1, availableAt: boundary + 60_000 }] }] }));
    await store.cleanup(clock);
    const history = await store.history(market.key, 168, clock);
    expect(history.events.map(event => event.id)).toEqual([kept.id]); expect(history.candles).toHaveLength(1);
    expect(history.depth).toHaveLength(1); expect(history.oi).toHaveLength(1);
    expect((await db.query('SELECT COUNT(*) AS count FROM flow_outcomes')).rows[0].count).toBe(0);
  });

  it('rolls back the entire update if an observation is invalid', async () => {
    const { store } = await open(temporaryPath());
    await expect(store.writeUpdate(update({ events: [event()], oi: [{ marketKey: market.key, timestamp: NaN, receivedAt: clock, quantity: 1 }] }))).rejects.toThrow();
    expect(await store.events()).toEqual([]);
  });

  it('leases one network owner across database connections and fences stale writers without changing original OI tables', async () => {
    const path = temporaryPath(); const one = await open(path); const two = await open(path);
    await one.db.query('CREATE TABLE old_monitor_sentinel (value TEXT NOT NULL)');
    await one.db.query("INSERT INTO old_monitor_sentinel VALUES('untouched')");
    expect(await one.store.acquireLease('one', clock)).toBe(true);
    expect(await two.store.acquireLease('two', clock)).toBe(false);
    expect(await two.store.writeUpdate(update({ events: [event()] }), 'two', clock)).toBe(false);
    expect(await two.store.acquireLease('two', clock + FLOW_LEASE_MS)).toBe(true);
    expect(await one.store.renewLease('one', clock + FLOW_LEASE_MS)).toBe(false);
    expect(await one.store.writeUpdate(update({ events: [event()] }), 'one', clock + FLOW_LEASE_MS)).toBe(false);
    await one.store.releaseLease('one');
    expect(await two.store.renewLease('two', clock + FLOW_LEASE_MS + 1)).toBe(true);
    expect(await two.store.writeUpdate(update({ events: [event()] }), 'two', clock + FLOW_LEASE_MS + 1)).toBe(true);
    expect((await one.db.query('SELECT value FROM old_monitor_sentinel')).rows).toEqual([{ value: 'untouched' }]);
  });
});
