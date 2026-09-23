import { afterEach, expect, it, vi } from 'vitest';
import { SqliteDatabase } from '../server/database';
import { MonitorStore } from '../server/store';
import { MonitorScheduler } from '../server/scheduler';
import { loadConfig } from '../server/config';
import type { Snapshot } from '../src/shared/types';

const stores: MonitorStore[] = [], schedulers: MonitorScheduler[] = [];
afterEach(async () => { for (const scheduler of schedulers.splice(0)) await scheduler.stop(); for (const store of stores.splice(0)) await store.close(); });
async function setup(collector: { collect: () => Promise<Snapshot> }, now: () => number) {
  const store = new MonitorStore(new SqliteDatabase(':memory:')); await store.initialize(); stores.push(store);
  const scheduler = make(store, collector, now); await scheduler.initialize(); return { store, scheduler };
}
function make(store: MonitorStore, collector: { collect: () => Promise<Snapshot> }, now: () => number) {
  const scheduler = new MonitorScheduler(store, collector, { enabled: false, publicKey: null, send: async () => {} }, loadConfig({}), now);
  schedulers.push(scheduler); return scheduler;
}
function failed(at: number, retryAt = 0): Snapshot {
  return { schemaVersion: 1, mode: 'server', startedAt: at, asOf: at, durationMs: 0,
    universe: { assets: 0, contracts: 0 }, coverage: { oi: 0, fdv: 0, marketCap: 0, eligible: 0, failedContracts: 0 },
    assets: [], errors: ['Synthetic source failure'], retryAt };
}
it('shares a failed attempt slot across schedulers without relabeling failure as success', async () => {
  let clock = 1_800_000_000_000;
  const collector = { collect: vi.fn(async () => failed(clock)) };
  const { store, scheduler } = await setup(collector, () => clock);
  const rival = make(store, collector, () => clock);
  await scheduler.runOnce(); await rival.runOnce(); await scheduler.runOnce();
  expect(collector.collect).toHaveBeenCalledTimes(1);
  expect(scheduler.status().lastSuccess).toBeNull();
  clock += 30_000; await rival.runOnce(); expect(collector.collect).toHaveBeenCalledTimes(2);
});
it('restores a failed first-attempt cooldown when a scheduler is recreated', async () => {
  let clock = 1_800_000_000_000;
  const deadline = clock + 180_000;
  const collector = { collect: vi.fn(async () => failed(clock, deadline)) };
  const { store, scheduler } = await setup(collector, () => clock);
  await scheduler.runOnce(); await scheduler.stop();
  const restarted = make(store, collector, () => clock); await restarted.initialize();
  expect(restarted.status().retryAt).toBe(deadline);
  clock += 60_000; await restarted.runOnce(); expect(collector.collect).toHaveBeenCalledTimes(1);
  expect(restarted.status().lastSuccess).toBeNull();
  clock = deadline; await restarted.runOnce(); expect(collector.collect).toHaveBeenCalledTimes(2);
});
