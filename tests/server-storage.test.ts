import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createECDH, randomBytes } from 'node:crypto';
import { SqliteDatabase } from '../server/database';
import { MonitorStore } from '../server/store';
import { MonitorScheduler } from '../server/scheduler';
import { displayedAsset } from '../src/shared/reliability';
import { loadConfig } from '../server/config';
import { hashSecret, type PushSender } from '../server/push';
import { DEFAULT_THRESHOLDS, type AlertEvent, type Snapshot } from '../src/shared/types';

// Explicitly synthetic data; these tests prove storage and alert plumbing, not market accuracy.
function sample(now: number, ratio = 95): Snapshot {
  return { schemaVersion: 1, mode: 'server', startedAt: now - 100, asOf: now, durationMs: 100, collectionIntervalMs: 30_000,
    universe: { assets: 1, contracts: 1 }, coverage: { oi: 1, marketCap: 1, fdv: 1, eligible: 1, failedContracts: 0 }, errors: [],
    assets: [{ id: 'test:1', symbol: 'TEST', name: 'Synthetic fixture', contracts: ['TESTUSDT'], priceUsd: 1, oiUsd: ratio, oiQuantity: ratio,
      marketCapUsd: 80, fdvUsd: 100, oiToFdv: ratio, oiToMarketCap: ratio / 80 * 100,
      circulatingSupply: 80, maxSupply: 100, updatedAt: now, oiUpdatedAt: now, priceUpdatedAt: now, supplyUpdatedAt: now,
      complete: true, alertEligible: true, issues: [], supplySource: 'test', mappingStatus: 'verified',
      evidence: { contracts: [{ symbol: 'TESTUSDT', baseAsset: 'TEST', quoteAsset: 'USDT', openInterest: String(ratio),
        markPrice: '1', indexPrice: '1', quoteUsd: '1', unitMultiplier: 1, oiTime: now - 1000, priceTime: now - 800, quoteTime: now - 700,
        oiObservedAt: now - 80, priceObservedAt: now - 60, quoteObservedAt: now - 50, oiUsd: ratio }],
        supply: { provider: 'CoinGecko', id: 'synthetic-fixture', circulating: 80, total: 100, max: 100, updatedAt: now, fetchedAt: now, url: 'https://example.invalid/synthetic' }, mapping: 'Synthetic test mapping' } }] };
}
function event(now: number): AlertEvent { return { id: `test:${now}`, assetId: 'test:1', symbol: 'TEST', level: 'danger', ratio: 95, oiUsd: 95, fdvUsd: 100, timestamp: now }; }
const disabledPush: PushSender = { enabled: false, publicKey: null, send: async () => {} };
const directories: string[] = [];
const stores = new Set<MonitorStore>();
const schedulers: MonitorScheduler[] = [];
function temporaryPath() { const directory = mkdtempSync(join(tmpdir(), 'binance-oi-server-')); directories.push(directory); return join(directory, 'monitor.sqlite'); }
async function open(path: string) { const store = new MonitorStore(new SqliteDatabase(path)); await store.initialize(); stores.add(store); return store; }
async function close(store: MonitorStore) { await store.close(); stores.delete(store); }
afterEach(async () => {
  for (const scheduler of schedulers.splice(0)) await scheduler.stop();
  for (const store of stores) await store.close();
  stores.clear();
  for (const directory of directories.splice(0)) {
    if (resolve(directory).startsWith(resolve(tmpdir())) && basename(directory).startsWith('binance-oi-server-')) rmSync(directory, { recursive: true, force: true });
  }
  vi.useRealTimers();
});

describe('real SQLite persistence and scheduling', () => {
  it('persists a failed observation separately from last-good display values and restores cooldown across a real restart', async () => {
    const path = temporaryPath();
    let clock = 1_800_000_000_000;
    let fail = false;
    const initialTime = clock, deadline = clock + 180_000;
    const collector = { collect: vi.fn(async () => {
      const snapshot = sample(clock, fail ? 120 : 95);
      snapshot.assets[0].evidence.supply!.providerPriceUsd = 1;
      if (fail) {
        Object.assign(snapshot.assets[0], { oiUsd: null, oiQuantity: null, oiToFdv: null, oiToMarketCap: null,
          complete: false, alertEligible: false, oiUpdatedAt: null });
        Object.assign(snapshot.assets[0].evidence.contracts[0], { openInterest: null, oiTime: null, oiUsd: null });
        snapshot.coverage.oi = 0; snapshot.coverage.eligible = 0; snapshot.coverage.failedContracts = 1;
        snapshot.errors = ['Synthetic HTTP_429']; snapshot.retryAt = deadline;
      }
      return snapshot;
    }) };
    const first = await open(path);
    const scheduler = new MonitorScheduler(first, collector, disabledPush, loadConfig({}), () => clock);
    schedulers.push(scheduler); await scheduler.initialize();
    expect(await scheduler.runOnce()).toBe(true);
    expect(await first.alerts()).toHaveLength(1);
    fail = true; clock += 30_000;
    expect(await scheduler.runOnce()).toBe(false);
    const latest = (await first.latest())!;
    expect(latest).toMatchObject({ asOf: clock, coverage: { oi: 0 }, retryAt: deadline });
    expect(latest.assets[0]).toMatchObject({ oiUsd: null, complete: false });
    expect(displayedAsset(latest.assets[0], latest)).toMatchObject({ values: { oiUsd: 95, fdvUsd: 100 }, retainedAt: initialTime });
    expect((await first.history('test:1', 1, clock)).map(point => point.oiUsd)).toEqual([95, null]);
    expect((await first.contractHistory('TESTUSDT', 1, clock)).map(point => point.openInterest)).toEqual(['95', null]);
    expect(await first.alerts()).toHaveLength(1);
    expect(scheduler.status().lastSuccess).toBe(initialTime);
    await scheduler.stop(); await close(first);

    const reopened = await open(path);
    const restored = new MonitorScheduler(reopened, collector, disabledPush, loadConfig({}), () => clock);
    schedulers.push(restored); await restored.initialize();
    expect(restored.status()).toMatchObject({ lastSuccess: initialTime, retryAt: deadline });
    clock += 60_000; expect(await restored.runOnce()).toBe(false);
    expect(collector.collect).toHaveBeenCalledTimes(2);
    const cached = (await reopened.latest())!;
    expect(displayedAsset(cached.assets[0], cached).retainedAt).toBe(initialTime);
    expect(await reopened.history('test:1', 1, clock)).toHaveLength(2);

    fail = false; clock = deadline;
    expect(await restored.runOnce()).toBe(true);
    const recovered = (await reopened.latest())!;
    expect(displayedAsset(recovered.assets[0], recovered).retainedAt).toBeNull();
    expect(recovered.lastGood?.['test:1'].timestamp).toBe(deadline);
    expect((await reopened.history('test:1', 1, clock)).map(point => point.oiUsd)).toEqual([95, null, 95]);
    expect(restored.status()).toMatchObject({ lastSuccess: deadline, retryAt: 0 });
    expect(await reopened.alerts()).toHaveLength(1);
  });

  it('retains three/seven-day values across restart without recalculating old FDV', async () => {
    const path = temporaryPath();
    const clock = Math.floor(Date.now() / 60_000) * 60_000 + 1_000;
    const first = await open(path);
    for (const offset of [168, 72, 0]) {
      const snapshot = sample(clock - offset * 3_600_000);
      snapshot.assets[0].fdvUsd = 100 + offset;
      await first.commitCollection(snapshot, {}, []);
    }
    await close(first);
    const second = await open(path);
    expect((await second.history('test:1', 72, clock)).map(point => point.fdvUsd)).toEqual([172, 100]);
    expect((await second.history('test:1', 168, clock)).map(point => point.fdvUsd)).toEqual([268, 172, 100]);
  });

  it('uses actual availability times across duration jitter instead of backdating points to a start slot', async () => {
    const store = await open(temporaryPath());
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    const first = sample(minute + 70_000); first.startedAt = minute + 50_000;
    const second = sample(minute + 115_000); second.startedAt = minute + 110_000;
    await store.commitCollection(first, {}, []);
    await store.commitCollection(second, {}, []);
    expect((await store.history('test:1', 1, minute + 120_000)).map(point => point.timestamp)).toEqual([minute + 70_000, minute + 115_000]);
    expect(await store.history('test:1', 1, minute + 60_000)).toEqual([]);
  });

  it('keeps two real samples in one minute and exact contract decimals across a database restart', async () => {
    const path = temporaryPath();
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    const store = await open(path);
    const first = sample(minute + 1000);
    first.assets[0].evidence.contracts[0].openInterest = '12345678901234567890.123456789';
    await store.commitCollection(first, {}, []);
    await store.commitCollection(first, {}, []); // retry is not another observation
    await store.commitCollection(sample(minute + 31_000), {}, []);
    await close(store);
    const reopened = await open(path);
    const history = await reopened.history('test:1', 1, minute + 40_000);
    expect(history.map(point => point.timestamp)).toEqual([minute + 1000, minute + 31_000]);
    expect(history[0]).toMatchObject({ availableAt: minute + 1000, oiQuantity: 95, priceUsd: 1,
      samplingIntervalMs: 30_000, contractSetKey: 'TESTUSDT:1', sourceSkewMs: 300 });
    const raw = await reopened.contractHistory('TESTUSDT', 1, minute + 40_000);
    expect(raw).toHaveLength(2);
    expect(raw[0]).toMatchObject({ openInterest: '12345678901234567890.123456789', availableAt: minute + 1000,
      oiTime: minute, oiObservedAt: minute + 920, priceObservedAt: minute + 940 });
  });

  it('migrates legacy rows without destroying raw data or certifying unverified valuations', async () => {
    const database = new SqliteDatabase(temporaryPath());
    await database.query(`CREATE TABLE monitor_history (asset_id TEXT NOT NULL, timestamp BIGINT NOT NULL, oi_usd DOUBLE PRECISION,
      market_cap_usd DOUBLE PRECISION, fdv_usd DOUBLE PRECISION, oi_to_fdv DOUBLE PRECISION, oi_to_market_cap DOUBLE PRECISION, complete INTEGER NOT NULL,
      PRIMARY KEY(asset_id,timestamp))`);
    const clock = Date.now();
    await database.query('INSERT INTO monitor_history VALUES($1,$2,50,80,100,50,62.5,1)', ['test:1', clock]);
    const store = new MonitorStore(database); stores.add(store);
    await store.initialize(); await store.initialize();
    const history = await store.history('test:1', 1, clock);
    expect(history).toMatchObject([{ oiUsd: 50, fdvUsd: null, marketCapUsd: null }]);
    expect(history[0].availableAt).toBeUndefined();
    expect(history[0].oiQuantity).toBeUndefined();
    expect((await database.query('SELECT fdv_usd FROM monitor_history')).rows[0].fdv_usd).toBe(100);
  });

  it('restores 30s collection slots and alert cooldown after closing and reopening the database', async () => {
    const path = temporaryPath();
    let clock = Date.now();
    const first = await open(path);
    const collector = { collect: vi.fn(async () => sample(clock)) };
    const config = loadConfig({});
    const scheduler = new MonitorScheduler(first, collector, disabledPush, config, () => clock);
    schedulers.push(scheduler);
    await scheduler.initialize();
    expect(await scheduler.runOnce()).toBe(true);
    expect(await first.alerts()).toHaveLength(1);
    await scheduler.stop();
    await close(first);

    const second = await open(path);
    const restarted = new MonitorScheduler(second, collector, disabledPush, config, () => clock);
    schedulers.push(restarted);
    await restarted.initialize();
    expect(restarted.status().lastSuccess).toBe(clock);
    expect(await restarted.runOnce()).toBe(false); // persistent lease remembers this completed 30s interval
    clock += 30_000;
    expect(await restarted.runOnce()).toBe(true);
    expect(await second.history('test:1', 1, clock)).toHaveLength(2);
    expect(await second.alerts()).toHaveLength(1); // restart does not reset alert cooldown
    expect((await second.states())['test:1'].lastLevel).toBe(2);
  });

  it('migrates an old minute lease without blocking the next half-minute or breaking rollback counters', async () => {
    const database = new SqliteDatabase(temporaryPath());
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    await database.query('CREATE TABLE monitor_lease (id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at BIGINT NOT NULL, last_completed_slot BIGINT NOT NULL)');
    await database.query("INSERT INTO monitor_lease VALUES('collector','',0,$1)", [minute / 60_000]);
    const store = new MonitorStore(database); stores.add(store);
    await store.initialize(); await store.initialize();
    expect(await store.acquireLease('new', minute + 1000)).toBe(false);
    expect(await store.acquireLease('new', minute + 31_000)).toBe(true);
    await store.releaseLease('new', minute + 30_000);
    expect((await database.query("SELECT last_completed_at,last_completed_slot FROM monitor_lease WHERE id='collector'")).rows[0])
      .toEqual({ last_completed_at: minute + 30_000, last_completed_slot: minute / 60_000 });
  });

  it('actually schedules two rounds a minute and exposes the target interval in health', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const store = await open(temporaryPath());
    let clock = Math.floor(Date.now() / 60_000) * 60_000;
    const collector = { collect: vi.fn(async () => sample(clock)) };
    const scheduler = new MonitorScheduler(store, collector, disabledPush, loadConfig({ COLLECT_ON_START: 'false' }), () => clock);
    schedulers.push(scheduler);
    await scheduler.initialize(); scheduler.start();
    expect(collector.collect).toHaveBeenCalledTimes(0);
    clock += 30_000; await vi.advanceTimersByTimeAsync(30_000);
    expect(collector.collect).toHaveBeenCalledTimes(1);
    clock += 30_000; await vi.advanceTimersByTimeAsync(30_000);
    expect(collector.collect).toHaveBeenCalledTimes(2);
    expect(scheduler.status()).toMatchObject({ collectionIntervalMs: 30_000, rawRetentionDays: 7, lastSuccess: clock });
    expect(await store.history('test:1', 1, clock)).toHaveLength(2);
  });

  it('prevents concurrent collectors and preserves the prior snapshot on a total source failure', async () => {
    const path = temporaryPath();
    const store = await open(path);
    const rivalStore = await open(path);
    let clock = Date.now();
    let finish!: (value: Snapshot) => void;
    const collector = { collect: vi.fn(() => new Promise<Snapshot>(resolveCollection => { finish = resolveCollection; })) };
    const scheduler = new MonitorScheduler(store, collector, disabledPush, loadConfig({}), () => clock);
    const rival = new MonitorScheduler(rivalStore, { collect: vi.fn(async () => sample(clock)) }, disabledPush, loadConfig({}), () => clock);
    schedulers.push(scheduler, rival);
    const pending = scheduler.runOnce();
    await vi.waitFor(() => expect(collector.collect).toHaveBeenCalledTimes(1));
    expect(await scheduler.runOnce()).toBe(false);
    expect(await rival.runOnce()).toBe(false);
    finish(sample(clock));
    expect(await pending).toBe(true);
    const previousTime = clock;
    clock += 60_000;
    const failedRound = scheduler.runOnce();
    await vi.waitFor(() => expect(collector.collect).toHaveBeenCalledTimes(2));
    const empty = sample(clock); empty.coverage.oi = 0;
    finish(empty);
    expect(await failedRound).toBe(false);
    expect((await store.latest())?.asOf).toBe(previousTime);
    expect(await store.alerts()).toHaveLength(1);
  });

  it('upserts the same observation atomically and rolls back a failed history write', async () => {
    const store = await open(temporaryPath());
    const clock = Math.floor(Date.now() / 60_000) * 60_000 + 1000;
    await store.commitCollection(sample(clock), {}, []);
    await store.commitCollection(sample(clock, 99), {}, []);
    expect(await store.history('test:1', 1, clock + 100)).toMatchObject([{ oiUsd: 99 }]);
    const invalid = sample(clock + 60_000);
    invalid.assets[0].id = null as unknown as string;
    await expect(store.commitCollection(invalid, {}, [])).rejects.toThrow();
    expect((await store.latest())?.asOf).toBe(clock);
    expect(await store.history('test:1', 1, clock + 60_000)).toHaveLength(1);
  });

  it('removes only expired history and alerts at the 30-day boundary', async () => {
    const store = await open(temporaryPath());
    const clock = Date.now();
    const old = clock - 31 * 86_400_000;
    await store.commitCollection(sample(old), {}, [event(old)]);
    await store.commitCollection(sample(clock), {}, [event(clock)]);
    expect(await store.history('test:1', 1, old)).toHaveLength(1);
    await store.cleanup(clock);
    expect(await store.history('test:1', 1, old)).toHaveLength(0);
    expect(await store.history('test:1', 720, clock)).toHaveLength(1);
    expect(await store.alerts()).toMatchObject([{ timestamp: clock }]);
  });

  it('retains the full raw seven-day boundary and removes only older contract observations', async () => {
    const store = await open(temporaryPath());
    const clock = Date.now();
    const boundary = clock - 7 * 86_400_000;
    await store.commitCollection(sample(boundary - 30_000), {}, []);
    await store.commitCollection(sample(boundary), {}, []);
    await store.commitCollection(sample(clock), {}, []);
    await store.cleanup(clock);
    expect(await store.contractHistory('TESTUSDT', 1, boundary - 1)).toEqual([]);
    expect((await store.contractHistory('TESTUSDT', 168, clock)).map(point => point.availableAt)).toEqual([boundary, clock]);
    expect(await store.history('test:1', 720, clock)).toHaveLength(3); // aggregate retention is still 30 days
  });

  it('retains per-subscription thresholds and a failed push across a database restart', async () => {
    const path = temporaryPath();
    let clock = Date.now();
    const store = await open(path);
    const key = createECDH('prime256v1'); key.generateKeys();
    const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-fixture', expirationTime: null,
      keys: { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
    await store.saveSubscription({ id: 'test-sub', endpointHash: hashSecret(subscription.endpoint), tokenHash: hashSecret('synthetic-token'),
      subscription, thresholds: DEFAULT_THRESHOLDS, createdAt: clock });
    await store.commitCollection(sample(clock), {}, [], [{ id: 'test-sub', thresholds: DEFAULT_THRESHOLDS,
      states: { 'test:1': { assetId: 'test:1', lastLevel: 2, lastSentAt: clock } }, events: [event(clock)] }]);
    // Reopening a page may register the same endpoint again; that must not reset alert cooldowns.
    await store.saveSubscription({ id: 'test-sub', endpointHash: hashSecret(subscription.endpoint), tokenHash: hashSecret('synthetic-token'),
      subscription, thresholds: DEFAULT_THRESHOLDS, createdAt: clock });
    expect((await store.states('test-sub'))['test:1'].lastSentAt).toBe(clock);
    const failingSend = vi.fn(async () => { throw { statusCode: 503 }; });
    const scheduler = new MonitorScheduler(store, { collect: async () => sample(clock) }, { enabled: true, publicKey: 'synthetic', send: failingSend }, loadConfig({}), () => clock);
    schedulers.push(scheduler);
    await scheduler.flushPush();
    expect(failingSend).toHaveBeenCalledTimes(1);
    expect(await store.pendingPush(clock)).toHaveLength(0);
    await scheduler.stop(); await close(store);
    clock += 60_000;
    const reopened = await open(path);
    expect((await reopened.subscription('test-sub'))?.thresholds).toEqual(DEFAULT_THRESHOLDS);
    expect((await reopened.states('test-sub'))['test:1'].lastLevel).toBe(2);
    expect(await reopened.pendingPush(clock)).toMatchObject([{ attempts: 1 }]);
    const successfulSend = vi.fn(async () => {});
    const restarted = new MonitorScheduler(reopened, { collect: async () => sample(clock) }, { enabled: true, publicKey: 'synthetic', send: successfulSend }, loadConfig({}), () => clock);
    schedulers.push(restarted);
    await restarted.flushPush();
    expect(successfulSend).toHaveBeenCalledTimes(1);
    expect(await reopened.pendingPush(clock)).toHaveLength(0);
  });
});
