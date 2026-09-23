import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { buildApp } from '../server/app';
import { loadConfig } from '../server/config';
import { SqliteDatabase } from '../server/database';
import { MonitorStore } from '../server/store';
import type { HistoryPoint, Snapshot } from '../src/shared/types';
import { appendSample, type SampleHour } from '../src/web/historyCodec';
import { HOUR, readChangeBaselines } from '../src/web/storage';

const indexedDb = vi.hoisted(() => ({ getAllFromIndex: vi.fn() }));
vi.mock('idb', () => ({ openDB: vi.fn(async () => indexedDb) }));

// Synthetic fixtures prove storage/as-of behavior; they are not market evidence.
const at = Date.UTC(2026, 8, 23, 12, 0, 20);
const origin = 'https://example.github.io';
const directories: string[] = [];
const stores = new Set<MonitorStore>();
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
function point(timestamp: number, changes: Partial<HistoryPoint> = {}): HistoryPoint {
  return { assetId: 'test:A', timestamp, availableAt: timestamp, oiUsd: 50, marketCapUsd: 80, fdvUsd: 100,
    oiToFdv: 50, oiToMarketCap: 62.5, complete: true, oiQuantity: 5, priceUsd: 10,
    oiSourceTime: timestamp - 1000, priceSourceTime: timestamp - 1000, sourceSkewMs: 0,
    samplingIntervalMs: 30_000, contractSetKey: 'TESTUSDT:1', ...changes };
}
function packed(points: HistoryPoint[]): SampleHour[] {
  const records = new Map<string, SampleHour>();
  for (const value of points) {
    const key = `${value.assetId}:${Math.floor(value.timestamp / HOUR)}`;
    records.set(key, appendSample(records.get(key), value));
  }
  return [...records.values()];
}
function temporaryPath() {
  const directory = mkdtempSync(join(tmpdir(), 'binance-change-baselines-'));
  directories.push(directory); return join(directory, 'monitor.sqlite');
}
async function open(path = temporaryPath()) {
  const db = new SqliteDatabase(path), store = new MonitorStore(db);
  await store.initialize(); stores.add(store); return { path, db, store };
}
async function close(store: MonitorStore) { await store.close(); stores.delete(store); }
async function insert(db: SqliteDatabase, value: HistoryPoint, validated = true) {
  await db.query(`INSERT INTO monitor_history(asset_id,timestamp,oi_usd,market_cap_usd,fdv_usd,oi_to_fdv,oi_to_market_cap,
    complete,validated,available_at,oi_quantity,price_usd,oi_source_time,price_source_time,sampling_interval_ms,contract_set_key,source_skew_ms)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
  [value.assetId, value.timestamp, value.oiUsd, value.marketCapUsd, value.fdvUsd, value.oiToFdv, value.oiToMarketCap,
    Number(value.complete), Number(validated), value.availableAt ?? null, value.oiQuantity ?? null, value.priceUsd ?? null,
    value.oiSourceTime ?? null, value.priceSourceTime ?? null, value.samplingIntervalMs ?? null, value.contractSetKey ?? null, value.sourceSkewMs ?? null]);
}
async function setup() {
  const resources = await open();
  const collector = { collect: vi.fn(async (): Promise<Snapshot> => { throw new Error('Tests must not collect upstream data'); }) };
  const feedFactory = vi.fn(() => { throw new Error('Tests must not create a live feed'); });
  const result = await buildApp({ store: resources.store, collector, config: loadConfig({ ALLOWED_ORIGINS: origin, COLLECT_ON_START: 'false' }),
    now: () => at, startJobs: false, flowFeedFactory: feedFactory,
    pushSender: { enabled: false, publicKey: null, send: async () => {} } });
  apps.push(result); stores.delete(resources.store);
  return { ...resources, ...result, collector, feedFactory };
}
beforeEach(() => {
  indexedDb.getAllFromIndex.mockReset();
  vi.stubGlobal('IDBKeyRange', { bound: (lower: number, upper: number) => ({ lower, upper }) });
});
afterEach(async () => {
  for (const item of apps.splice(0)) await item.app.close();
  for (const store of stores) await store.close(); stores.clear();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) {
    const resolved = resolve(directory), temporaryRoot = resolve(tmpdir());
    if (resolved.startsWith(`${temporaryRoot}${sep}`) && basename(resolved).startsWith('binance-change-baselines-')) {
      rmSync(resolved, { recursive: true, force: true });
    }
  }
});

describe('bounded browser comparison baselines', () => {
  it('reads only the two relevant raw-sample hours across an hour boundary, never the legacy store', async () => {
    const exact = point(at - 45_000, { assetId: 'test:boundary' });
    const newest = point(at - 1, { assetId: 'binance:币安人生' });
    indexedDb.getAllFromIndex.mockResolvedValue(packed([
      exact, newest, point(at - 45_001, { assetId: 'test:too-old' }), point(at + 1, { assetId: 'test:future' }),
    ]));
    expect(new Map((await readChangeBaselines(at)).map(value => [value.assetId, value]))).toEqual(new Map([
      [exact.assetId, exact], [newest.assetId, newest],
    ]));
    expect(indexedDb.getAllFromIndex).toHaveBeenCalledExactlyOnceWith('samples', 'by-hour', {
      lower: Math.floor((at - 45_000) / HOUR) * HOUR, upper: Math.floor(at / HOUR) * HOUR,
    });
  });

  it('keeps the nearest invalid metric without falling back to an older good sample and preserves real zeros', async () => {
    const time = at + 120_000;
    indexedDb.getAllFromIndex.mockResolvedValue(packed([
      point(time - 30_000), point(time - 1000, { oiUsd: null, fdvUsd: null, oiToFdv: null, oiToMarketCap: null }),
      point(time, { assetId: 'test:zero', oiUsd: 0, oiQuantity: 0, fdvUsd: 0, oiToFdv: null, oiToMarketCap: 0 }),
    ]));
    const values = new Map((await readChangeBaselines(time)).map(value => [value.assetId, value]));
    expect(values.get('test:A')).toMatchObject({ timestamp: time - 1000, oiUsd: null, fdvUsd: null });
    expect(values.get('test:zero')).toMatchObject({ timestamp: time, oiUsd: 0, oiQuantity: 0, fdvUsd: 0, oiToFdv: null });
    expect(indexedDb.getAllFromIndex).toHaveBeenCalledExactlyOnceWith('samples', 'by-hour', {
      lower: Math.floor(time / HOUR) * HOUR, upper: Math.floor(time / HOUR) * HOUR,
    });
  });

  it('does not open an IndexedDB query for an invalid target', async () => {
    for (const value of [NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(await readChangeBaselines(value)).toEqual([]);
    expect(indexedDb.getAllFromIndex).not.toHaveBeenCalled();
  });
});

describe('real SQLite comparison baselines', () => {
  it('uses an inclusive 45-second timestamp range and only values known by the target time', async () => {
    const { db, store } = await open();
    const exact = point(at - 45_000, { assetId: 'test:boundary' });
    const latest = point(at, { assetId: 'binance:币安人生' });
    for (const value of [exact, latest,
      point(at - 45_001, { assetId: 'test:too-old' }), point(at + 1, { assetId: 'test:future' }),
      point(at - 1000, { assetId: 'test:not-yet-known', availableAt: at + 1 }),
      point(at - 1000, { assetId: 'test:legacy', availableAt: undefined }),
    ]) await insert(db, value);
    const query = vi.spyOn(db, 'query');
    expect(new Map((await store.changeBaselines(at)).map(value => [value.assetId, value]))).toEqual(new Map([
      [exact.assetId, exact], [latest.assetId, latest],
    ]));
    expect(query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('WHERE timestamp>=$1 AND timestamp<=$2'), [at - 45_000, at]);
  });

  it('preserves nulls, zeros, validation flags and the latest bad row rather than cherry-picking a good metric', async () => {
    const { db, store } = await open();
    await insert(db, point(at - 30_000));
    await insert(db, point(at - 1000, { complete: false }));
    await insert(db, point(at, { assetId: 'test:unvalidated' }), false);
    await insert(db, point(at, { assetId: 'test:zero', oiUsd: 0, oiQuantity: 0, fdvUsd: 0, oiToFdv: null, oiToMarketCap: 0 }));
    await insert(db, point(at, { assetId: 'test:missing', oiUsd: null, oiQuantity: null, fdvUsd: null, oiToFdv: null, oiToMarketCap: null }));
    const values = new Map((await store.changeBaselines(at)).map(value => [value.assetId, value]));
    expect(values.get('test:A')).toMatchObject({ timestamp: at - 1000, oiUsd: null, fdvUsd: null, complete: false });
    expect(values.get('test:unvalidated')).toMatchObject({ oiUsd: 50, fdvUsd: null, marketCapUsd: null, oiToFdv: null });
    expect(values.get('test:zero')).toMatchObject({ oiUsd: 0, oiQuantity: 0, fdvUsd: 0, oiToFdv: null });
    expect(values.get('test:missing')).toMatchObject({ oiUsd: null, oiQuantity: null, fdvUsd: null, oiToFdv: null });
    expect(values.get('test:A')).toEqual((await store.history('test:A', 1, at)).at(-1));
  });

  it('returns the same original values and source metadata after a disk database restart', async () => {
    const first = await open();
    const value = point(at - 15_000, { assetId: 'binance:我踏马来了', oiUsd: 1_250_000, fdvUsd: 20_000_000,
      oiToFdv: 6.25, oiToMarketCap: 1_562_500, contractSetKey: '我踏马来了USDT:1' });
    await insert(first.db, value);
    const before = await first.store.changeBaselines(at);
    await close(first.store);
    const reopened = await open(first.path);
    expect(await reopened.store.changeBaselines(at)).toEqual(before);
    expect(before).toEqual([value]);
    expect(await reopened.store.changeBaselines(at - 16_000)).toEqual([]);
  });
});

describe('comparison baseline API', () => {
  it('returns a plain typed array over a real HTTP listener without starting collector or source feeds', async () => {
    const { app, db, collector, feedFactory } = await setup();
    const value = point(at - 500, { assetId: 'binance:哈基米' });
    await insert(db, value);
    const sourceFetch = vi.spyOn(globalThis, 'fetch');
    const injected = await app.inject(`/api/v1/change-baselines?at=${at}`);
    expect(injected.statusCode).toBe(200); expect(injected.json()).toEqual([value]);
    expect(sourceFetch).not.toHaveBeenCalled();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('Expected HTTP listener');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/change-baselines?at=${at}`, { headers: { origin } });
    expect(response.status).toBe(200); expect(await response.json()).toEqual([value]);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(sourceFetch).toHaveBeenCalledTimes(1);
    expect(collector.collect).not.toHaveBeenCalled(); expect(feedFactory).not.toHaveBeenCalled();
  });

  it('requires a positive integer target, excludes future/over-retention targets, and rejects extra parameters', async () => {
    const { app } = await setup();
    const earliest = at - 7 * 86_400_000 - 120_000;
    for (const target of [at, earliest]) {
      const response = await app.inject(`/api/v1/change-baselines?at=${target}`);
      expect(response.statusCode).toBe(200); expect(response.json()).toEqual([]);
    }
    for (const suffix of ['', '?at=', '?at=0', '?at=-1', '?at=NaN', '?at=Infinity', '?at=1.5',
      '?at=9007199254740992', `?at=${at + 1}`, `?at=${earliest - 1}`, `?at=${at}&unknown=1`, `?at=${at}&at=${at}`]) {
      const response = await app.inject(`/api/v1/change-baselines${suffix}`);
      expect(response.statusCode, suffix).toBe(400);
      expect(response.json()).toMatchObject({ error: 'invalid_request' });
    }
  });

  it('allows thirty baseline reads per minute and then responds with 429, not an internal error', async () => {
    const { app } = await setup();
    for (let count = 0; count < 30; count++) expect((await app.inject(`/api/v1/change-baselines?at=${at}`)).statusCode).toBe(200);
    const limited = await app.inject(`/api/v1/change-baselines?at=${at}`);
    expect(limited.statusCode).toBe(429); expect(limited.json()).toMatchObject({ error: 'rate_limited' });
  });
});
