import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { buildApp } from '../server/app';
import { loadConfig } from '../server/config';
import { SqliteDatabase } from '../server/database';
import { MonitorStore } from '../server/store';
import { FlowRuntime, type BackendFlowFeed, type FlowFeedFactory } from '../server/flow-runtime';
import { FLOW_LEASE_MS, FlowStore } from '../server/flow-store';
import type { FlowEvent, FlowFeedOptions, FlowHistory, FlowMarket, FlowSnapshot, FlowUpdate } from '../src/shared/flowTypes';
import type { Snapshot } from '../src/shared/types';

const origin = 'https://example.github.io';
const at = Date.UTC(2026, 8, 23, 12);
const market: FlowMarket = { key: 'futures:BTCUSDT', venue: 'futures', symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', assetId: 'binance:BTC' };
const directories: string[] = [], apps: Awaited<ReturnType<typeof buildApp>>[] = [], runtimes: FlowRuntime[] = [];
const databases = new Set<SqliteDatabase>();
function temporaryPath() { const directory = mkdtempSync(join(tmpdir(), 'binance-flow-api-')); directories.push(directory); return join(directory, 'monitor.sqlite'); }
function event(time = at - 120_000): FlowEvent {
  return { id: `synthetic:${time}`, ruleVersion: 'flow-v1', marketKey: market.key, symbol: market.symbol, assetId: market.assetId,
    venue: 'futures', quoteAsset: 'USDT', kind: 'large_buy', severity: 'warning', title: 'Synthetic test only', timestamp: time - 1,
    detectedAt: time, referencePrice: 100, evidence: [], reason: 'Synthetic test only', invalidation: 'Not trading advice', dataStatus: 'complete', outcomes: [] };
}
function snapshot(time = at): FlowSnapshot {
  return { schemaVersion: 1, rows: [{ market, asOf: time, status: 'live', reason: 'Synthetic test only', price: 100,
    priceChange5m: null, volume5m: null, buyShare5m: null, delta5m: null, volumeMultiple: null, vwap5m: null, range5mPct: null,
    atr14: null, oiChange5m: null, funding: null, depth: null, baselineWindows: 0, tradeSamples: 0, largeTradeThreshold: null,
    lastTradeAt: time, lastCandleAt: time }], events: [], status: { mode: 'server', startedAt: time - 1000, asOf: time,
    connectedStreams: 1, totalStreams: 1, markets: 1, readyMarkets: 1, warmingMarkets: 0, staleMarkets: 0,
    backfilledMarkets: 1, errors: [], retentionDays: 7, scope: 'Synthetic public feed' } };
}
function oiSnapshot(time = at): Snapshot {
  return { schemaVersion: 1, mode: 'server', startedAt: time - 100, asOf: time, durationMs: 100, collectionIntervalMs: 30_000,
    universe: { assets: 1, contracts: 1 }, coverage: { oi: 1, marketCap: 0, fdv: 0, eligible: 0, failedContracts: 0 }, errors: [],
    assets: [{ id: market.assetId, symbol: 'BTC', name: 'Synthetic test only', contracts: ['BTCUSDT'], priceUsd: 100, oiUsd: 200,
      oiQuantity: 2, marketCapUsd: null, fdvUsd: null, oiToFdv: null, oiToMarketCap: null, circulatingSupply: null, maxSupply: null,
      updatedAt: time, oiUpdatedAt: time, priceUpdatedAt: time, supplyUpdatedAt: null, complete: true, alertEligible: false,
      issues: [], supplySource: null, mappingStatus: 'unmapped', evidence: { contracts: [], supply: null, mapping: 'Synthetic test only' } }] };
}
function fakeFactory(now: () => number, initialUpdate?: FlowUpdate) {
  const instances: Array<BackendFlowFeed & { options: FlowFeedOptions }> = [];
  const factory = vi.fn((options: FlowFeedOptions) => {
    const feed = { options, start: vi.fn(async () => { if (initialUpdate) await options.onUpdate?.(initialUpdate); }), stop: vi.fn(),
      updateSnapshot: vi.fn(), selectMarket: vi.fn(), hydrateEvents: vi.fn(), snapshot: vi.fn(() => snapshot(now())),
      history: vi.fn((key: string, from: number, to: number): FlowHistory => ({ market: key === market.key ? market : null, from, to, candles: [], events: [], depth: [], oi: [] })) };
    instances.push(feed); return feed;
  });
  return { factory, instances };
}
async function database(path = temporaryPath()) {
  const db = new SqliteDatabase(path); databases.add(db);
  const monitor = new MonitorStore(db); await monitor.initialize();
  const flowStore = new FlowStore(db); await flowStore.initialize();
  return { path, db, monitor, flowStore };
}
async function appSetup(options: { factory?: FlowFeedFactory; startJobs?: boolean; now?: () => number; flowEnabled?: boolean } = {}) {
  const resources = await database(); const clock = options.now ?? (() => at);
  const collector = { collect: vi.fn(async () => oiSnapshot(clock())) };
  const result = await buildApp({ store: resources.monitor, flowStore: resources.flowStore, collector,
    config: loadConfig({ ALLOWED_ORIGINS: origin, COLLECT_ON_START: 'false' }), startJobs: options.startJobs ?? false,
    flowFeedFactory: options.factory, flowEnabled: options.flowEnabled, now: clock,
    pushSender: { enabled: false, publicKey: null, send: async () => {} } });
  apps.push(result); databases.delete(resources.db); return { ...result, ...resources, collector };
}
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const app of apps.splice(0)) await app.app.close();
  for (const db of databases) await db.close(); databases.clear();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    if (resolve(directory).startsWith(resolve(tmpdir())) && basename(directory).startsWith('binance-flow-api-')) rmSync(directory, { recursive: true, force: true });
  }
});

describe('flow API and lifecycle', () => {
  it('does not construct a feed or open any source connection when startJobs is false', async () => {
    const factory = vi.fn(() => { throw new Error('Must not create network feed'); });
    const { app, collector } = await appSetup({ factory });
    const sourceFetch = vi.spyOn(globalThis, 'fetch');
    const response = await app.inject('/api/v1/flow/snapshot');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ schemaVersion: 1, rows: [], events: [], status: { mode: 'server', connectedStreams: 0, retentionDays: 7 } });
    expect(response.json().status.scope).toContain('系统 Web Push 尚未接入');
    expect(factory).not.toHaveBeenCalled(); expect(collector.collect).not.toHaveBeenCalled(); expect(sourceFetch).not.toHaveBeenCalled();
  });

  it('serves persisted events and complete typed history through a real HTTP listener without changing subscriptions', async () => {
    const fake = fakeFactory(() => at); const { app, flowStore } = await appSetup({ factory: fake.factory });
    const value = event();
    await flowStore.saveSnapshot(snapshot());
    await flowStore.writeUpdate({ candles: [], depth: [], oi: [], events: [value] });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('Expected HTTP listener');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/flow/history?marketKey=futures%3ABTCUSDT&hours=168`, { headers: { origin } });
    expect(response.status).toBe(200); expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(await response.json()).toMatchObject({ market, candles: [], events: [value], depth: [], oi: [], to: at });
    expect(fake.factory).not.toHaveBeenCalled();
    expect((await app.inject('/api/v1/flow/history?marketKey=spot%3AUNKNOWNUSDT&hours=1')).json().market).toBeNull();
  });

  it('validates every query boundary and rejects future cursors, windows, unknown keys and SQL-like market input', async () => {
    const { app } = await appSetup();
    for (const url of ['/api/v1/flow/history', '/api/v1/flow/history?marketKey=futures:BTCUSDT&hours=169',
      '/api/v1/flow/history?marketKey=futures:BTCUSDT&hours=0', '/api/v1/flow/history?marketKey=futures:BTCUSDT&hours=NaN',
      `/api/v1/flow/history?marketKey=futures:BTCUSDT&to=${at + 1}`, '/api/v1/flow/history?marketKey=futures:%27%3BDROP',
      '/api/v1/flow/history?marketKey=futures:BTCUSDT&unknown=1']) {
      expect((await app.inject(url)).statusCode).toBe(400);
    }
    for (const url of ['/api/v1/flow/events?limit=501', '/api/v1/flow/events?limit=0', '/api/v1/flow/events?before=-1',
      `/api/v1/flow/events?before=${at + 2}`, '/api/v1/flow/events?marketKey=bad%2Fkey', '/api/v1/flow/events?extra=1']) {
      expect((await app.inject(url)).statusCode).toBe(400);
    }
    const foreign = await app.inject({ url: '/api/v1/flow/snapshot', headers: { origin: 'https://evil.example' } });
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
    const replay = await app.inject('/api/v1/flow/history?marketKey=futures:BTCUSDT&hours=0.5');
    expect(replay.statusCode).toBe(200); expect(replay.json()).toMatchObject({ from: at - 30 * 60_000, to: at });
  });

  it('pages by detectedAt while preserving outcomes known now, and separates historical as-of playback', async () => {
    const { app, flowStore } = await appSetup(); const original = event();
    const outcome = { minutes: 1 as const, price: 101, changePct: 1, availableAt: at - 60_000 };
    await flowStore.writeUpdate({ candles: [], oi: [], depth: [], events: [{ ...original, outcomes: [outcome] }, event(at - 10_000)] });
    const page = await app.inject(`/api/v1/flow/events?marketKey=futures:BTCUSDT&limit=1&before=${at - 100_000}`);
    expect(page.json()).toEqual([{ ...original, outcomes: [outcome] }]);
    const historical = await app.inject(`/api/v1/flow/history?marketKey=futures:BTCUSDT&hours=1&to=${at - 100_000}`);
    expect(historical.json().events).toEqual([original]);
  });

  it('accepts one-character and Unicode market identities without admitting path or query delimiters', async () => {
    const { app, flowStore } = await appSetup();
    const keys = ['futures:B', 'futures:HUSDT', 'futures:4USDT', 'spot:U', 'futures:币安人生USDT',
      'futures:我踏马来了USDT', 'futures:龙虾USDT', 'futures:牛来USDT', 'futures:哈基米USDT'];
    const sample = snapshot();
    const markets: FlowMarket[] = keys.map(key => ({ ...market, key, symbol: key.split(':')[1],
      venue: key.startsWith('spot:') ? 'spot' : 'futures' }));
    await flowStore.saveSnapshot({ ...sample, rows: markets.map(value => ({ ...sample.rows[0], market: value })) });
    const events = markets.map((value, index) => ({ ...event(at - 120_000 - index), marketKey: value.key,
      symbol: value.symbol, venue: value.venue }));
    await flowStore.writeUpdate({ candles: [], oi: [], depth: [], events });
    for (let index = 0; index < keys.length; index++) {
      const encoded = encodeURIComponent(keys[index]);
      const history = await app.inject(`/api/v1/flow/history?marketKey=${encoded}&hours=0.5`);
      expect(history.statusCode).toBe(200); expect(history.json().market).toEqual(markets[index]);
      expect((await app.inject(`/api/v1/flow/events?marketKey=${encoded}`)).json()).toEqual([events[index]]);
    }
    for (const key of ['futures:币/USDT', 'futures:币?USDT', 'spot:U:BTC', 'spot:U-BTC']) {
      expect((await app.inject(`/api/v1/flow/history?marketKey=${encodeURIComponent(key)}`)).statusCode).toBe(400);
    }
  });

  it('allows thirty history reads per minute for polling and selection, then returns a bounded rate error', async () => {
    const { app } = await appSetup();
    const url = '/api/v1/flow/history?marketKey=futures:BTCUSDT&hours=0.5';
    for (let request = 0; request < 30; request++) expect((await app.inject(url)).statusCode).toBe(200);
    const limited = await app.inject(url);
    expect(limited.statusCode).toBe(429); expect(limited.json()).toMatchObject({ error: 'rate_limited' });
  });

  it('starts one injectable feed, selects the default depth market, persists updates and delivers new OI snapshots', async () => {
    let time = at;
    const batch = { candles: [], oi: [], depth: [], events: [event()] };
    const fake = fakeFactory(() => time, batch);
    const { app, scheduler, flow } = await appSetup({ factory: fake.factory, startJobs: true, now: () => time });
    await app.ready();
    await vi.waitFor(() => expect(fake.instances[0]?.start).toHaveBeenCalledTimes(1));
    expect(fake.instances[0].selectMarket).toHaveBeenCalledWith('futures:BTCUSDT');
    await vi.waitFor(async () => expect((await flow.snapshot()).events).toHaveLength(1));
    time += 1000;
    expect(await scheduler.runOnce()).toBe(true);
    expect(fake.instances[0].updateSnapshot).toHaveBeenCalledWith(expect.objectContaining({ asOf: time }));
    await app.close(); apps.splice(apps.findIndex(item => item.app === app), 1);
    expect(fake.instances[0].stop).toHaveBeenCalledTimes(1);
  });

  it('prevents duplicate network feeds across processes, hands off after lease loss and marks old snapshots stale', async () => {
    const path = temporaryPath(); const one = await database(path); const two = await database(path); let time = at;
    const first = fakeFactory(() => time), second = fakeFactory(() => time);
    const leader = new FlowRuntime(one.flowStore, one.monitor, first.factory, () => time);
    const rival = new FlowRuntime(two.flowStore, two.monitor, second.factory, () => time); runtimes.push(leader, rival);
    leader.start();
    await vi.waitFor(async () => expect(await one.flowStore.latest()).not.toBeNull());
    rival.start(); await rival.tick();
    expect(second.factory).not.toHaveBeenCalled();
    time += 16_000;
    expect((await rival.snapshot()).rows[0].status).toBe('disconnected');
    expect((await rival.snapshot()).status.connectedStreams).toBe(0);
    time = at + FLOW_LEASE_MS + 1;
    await rival.tick();
    await vi.waitFor(() => expect(second.instances[0]?.start).toHaveBeenCalledTimes(1));
    await leader.tick();
    expect(first.instances[0].stop).toHaveBeenCalledTimes(1);
    expect((await one.flowStore.latest())?.status.asOf).toBe(time);
  });

  it('rehydrates existing incomplete outcomes without fabricating missing horizons', async () => {
    const resources = await database(); const original = event();
    const firstOutcome = { minutes: 1 as const, price: 101, changePct: 1, availableAt: at - 60_000, entryPrice: 100, entryAt: original.detectedAt + 1 };
    await resources.flowStore.writeUpdate({ candles: [], oi: [], depth: [], events: [{ ...original, outcomes: [firstOutcome] }] });
    const fake = fakeFactory(() => at); const runtime = new FlowRuntime(resources.flowStore, resources.monitor, fake.factory, () => at); runtimes.push(runtime);
    runtime.start(); await vi.waitFor(() => expect(fake.instances[0]?.hydrateEvents).toHaveBeenCalled());
    expect(fake.instances[0].hydrateEvents).toHaveBeenCalledWith([{ ...original, outcomes: [firstOutcome] }]);
    expect((await runtime.snapshot()).events[0].outcomes).toEqual([firstOutcome]);
  });

  it('waits for the closing feed batch before closing SQLite and persists a disconnected snapshot', async () => {
    const fake = fakeFactory(() => at);
    let releaseStop!: () => void;
    const stopWaiting = new Promise<void>(resolveStop => { releaseStop = resolveStop; });
    const factory: FlowFeedFactory = options => {
      const feed = fake.factory(options);
      feed.stop = vi.fn(async () => { await stopWaiting; await options.onUpdate?.({ candles: [], depth: [], oi: [], events: [event()] }); });
      return feed;
    };
    const result = await appSetup({ factory, startJobs: true });
    await result.app.ready();
    await vi.waitFor(async () => expect(await result.flowStore.latest()).not.toBeNull());
    let release!: () => void;
    const waiting = new Promise<void>(resolveWrite => { release = resolveWrite; });
    const original = result.flowStore.writeUpdate.bind(result.flowStore);
    const write = vi.spyOn(result.flowStore, 'writeUpdate').mockImplementation(async (...args) => { await waiting; return original(...args); });
    let closed = false;
    const closing = result.app.close().then(() => { closed = true; });
    await vi.waitFor(() => expect(fake.instances[0].stop).toHaveBeenCalledTimes(1));
    expect(closed).toBe(false); expect(write).not.toHaveBeenCalled(); releaseStop();
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(closed).toBe(false); release(); await closing;
    apps.splice(apps.findIndex(item => item.app === result.app), 1);
    const reopened = await database(result.path);
    expect((await reopened.flowStore.events(undefined, 100, at + 1))).toHaveLength(1);
    expect((await reopened.flowStore.latest())?.rows[0].status).toBe('disconnected');
  });

  it('releases its lease and closes safely even when the feed reports a shutdown failure', async () => {
    const resources = await database(); const fake = fakeFactory(() => at);
    const runtime = new FlowRuntime(resources.flowStore, resources.monitor, fake.factory, () => at); runtimes.push(runtime);
    runtime.start(); await vi.waitFor(async () => expect(await resources.flowStore.latest()).not.toBeNull());
    fake.instances[0].stop = vi.fn(async () => { throw new Error('Synthetic shutdown failure'); });
    await expect(runtime.stop()).resolves.toBeUndefined();
    expect((await resources.flowStore.latest())?.rows[0].status).toBe('disconnected');
    expect(await resources.flowStore.acquireLease('replacement', at)).toBe(true);
  });
});
