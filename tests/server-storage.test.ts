import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createECDH, randomBytes } from 'node:crypto';
import { SqliteDatabase } from '../server/database';
import { MonitorStore } from '../server/store';
import { MonitorScheduler } from '../server/scheduler';
import { loadConfig } from '../server/config';
import { hashSecret, type PushSender } from '../server/push';
import { DEFAULT_THRESHOLDS, type AlertEvent, type Snapshot } from '../src/shared/types';

// Explicitly synthetic data; these tests prove storage and alert plumbing, not market accuracy.
function sample(now: number, ratio = 95): Snapshot {
  return { schemaVersion: 1, mode: 'server', startedAt: now - 100, asOf: now, durationMs: 100,
    universe: { assets: 1, contracts: 1 }, coverage: { oi: 1, marketCap: 1, fdv: 1, eligible: 1, failedContracts: 0 }, errors: [],
    assets: [{ id: 'test:1', symbol: 'TEST', name: 'Synthetic fixture', contracts: ['TESTUSDT'], priceUsd: 1, oiUsd: ratio,
      marketCapUsd: 80, fdvUsd: 100, oiToFdv: ratio, oiToMarketCap: ratio / 80 * 100,
      circulatingSupply: 80, maxSupply: 100, updatedAt: now, oiUpdatedAt: now, priceUpdatedAt: now, supplyUpdatedAt: now,
      complete: true, alertEligible: true, issues: [], supplySource: 'test', mappingStatus: 'verified',
      evidence: { contracts: [], supply: null, mapping: 'Synthetic test mapping' } }] };
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
});

describe('real SQLite persistence and scheduling', () => {
  it('restores the snapshot, minute history, and alert cooldown after closing and reopening the database', async () => {
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
    expect(await restarted.runOnce()).toBe(false); // persistent lease remembers this completed minute
    clock += 60_000;
    expect(await restarted.runOnce()).toBe(true);
    expect(await second.history('test:1', 1, clock)).toHaveLength(2);
    expect(await second.alerts()).toHaveLength(1); // restart does not reset alert cooldown
    expect((await second.states())['test:1'].lastLevel).toBe(2);
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

  it('upserts a minute atomically and rolls back a failed history write', async () => {
    const store = await open(temporaryPath());
    const clock = Math.floor(Date.now() / 60_000) * 60_000 + 1000;
    await store.commitCollection(sample(clock), {}, []);
    await store.commitCollection(sample(clock + 100, 99), {}, []);
    expect(await store.history('test:1', 1, clock + 100)).toMatchObject([{ oiUsd: 99 }]);
    const invalid = sample(clock + 60_000);
    invalid.assets[0].id = null as unknown as string;
    await expect(store.commitCollection(invalid, {}, [])).rejects.toThrow();
    expect((await store.latest())?.asOf).toBe(clock + 100);
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
