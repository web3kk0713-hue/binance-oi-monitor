import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createECDH, randomBytes } from 'node:crypto';
import { buildApp } from '../server/app';
import { loadConfig } from '../server/config';
import { SqliteDatabase } from '../server/database';
import { publicPushAddress, validPushEndpoint, validPushSubscription } from '../server/push';
import { MonitorStore } from '../server/store';
import { DEFAULT_THRESHOLDS, type Snapshot } from '../src/shared/types';

const origin = 'https://example.github.io';
const directories: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
function subscription(endpoint = 'https://fcm.googleapis.com/fcm/send/synthetic-fixture') {
  const key = createECDH('prime256v1'); key.generateKeys();
  return { endpoint, expirationTime: null, keys: { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}
async function setup(pushEnabled = false) {
  const directory = mkdtempSync(join(tmpdir(), 'binance-oi-api-')); directories.push(directory);
  const store = new MonitorStore(new SqliteDatabase(join(directory, 'monitor.sqlite')));
  await store.initialize();
  const collector = { collect: vi.fn(async (): Promise<Snapshot> => { throw new Error('Synthetic tests never collect live data'); }) };
  const result = await buildApp({ store, collector, config: loadConfig({ ALLOWED_ORIGINS: origin, NOTIFICATION_URL: `${origin}/binance-oi-monitor/` }),
    pushSender: { enabled: pushEnabled, publicKey: pushEnabled ? 'synthetic-key' : null, send: async () => {} }, startJobs: false });
  apps.push(result);
  return { ...result, store };
}
afterEach(async () => {
  for (const item of apps.splice(0)) await item.app.close();
  for (const directory of directories.splice(0)) {
    if (resolve(directory).startsWith(resolve(tmpdir())) && basename(directory).startsWith('binance-oi-api-')) rmSync(directory, { recursive: true, force: true });
  }
});

describe('backend API boundaries on real disk storage', () => {
  it('serves health over an actual listening HTTP socket and reports unconfigured push honestly', async () => {
    const { app } = await setup();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: 'server', storage: 'sqlite', pushEnabled: false, lastSuccess: null, retentionDays: 30 });
    expect((await app.inject('/api/v1/snapshot')).statusCode).toBe(503);
    expect((await app.inject('/api/v1/push/key')).json()).toEqual({ publicKey: null });
    const registration = await app.inject({ method: 'POST', url: '/api/v1/push/subscriptions', headers: { origin }, payload: { subscription: subscription(), thresholds: DEFAULT_THRESHOLDS } });
    expect(registration.statusCode).toBe(503);
  });

  it('validates history windows, limits, and exact configured CORS origins', async () => {
    const { app } = await setup();
    const valid = await app.inject({ url: '/api/v1/history?assetId=cmc:1&hours=24', headers: { origin } });
    expect(valid.statusCode).toBe(200);
    expect(valid.headers['access-control-allow-origin']).toBe(origin);
    expect(valid.json()).toEqual([]);
    expect((await app.inject(`/api/v1/history?assetId=${encodeURIComponent('binance:我踏马来了')}&hours=24`)).statusCode).toBe(200);
    const rejected = await app.inject({ url: '/api/v1/health', headers: { origin: 'https://evil.example' } });
    expect(rejected.headers['access-control-allow-origin']).toBeUndefined();
    for (const url of ['/api/v1/history?assetId=cmc:1&hours=721', '/api/v1/history?assetId=cmc:1&hours=-1',
      '/api/v1/history?assetId=cmc:1&unknown=1', '/api/v1/history?assetId=%27%3BDROP', '/api/v1/alerts?limit=10000']) {
      expect((await app.inject(url)).statusCode).toBe(400);
    }
  });

  it('requires allowed origin, validates push targets, and protects persisted subscription updates/deletes', async () => {
    const { app, store } = await setup(true);
    const body = { subscription: subscription(), thresholds: DEFAULT_THRESHOLDS };
    const foreign = await app.inject({ method: 'POST', url: '/api/v1/push/subscriptions', headers: { origin: 'https://evil.example' }, payload: body });
    expect(foreign.statusCode).toBe(403);
    const ssrf = await app.inject({ method: 'POST', url: '/api/v1/push/subscriptions', headers: { origin }, payload: { ...body, subscription: subscription('https://127.0.0.1/internal') } });
    expect(ssrf.statusCode).toBe(400);
    const create = await app.inject({ method: 'POST', url: '/api/v1/push/subscriptions', headers: { origin }, payload: body });
    expect(create.statusCode).toBe(201);
    const { id, deleteToken } = create.json<{ id: string; deleteToken: string }>();
    const saved = await store.subscription(id);
    expect(saved?.tokenHash).not.toBe(deleteToken);
    expect(saved?.thresholds).toEqual(DEFAULT_THRESHOLDS);
    expect((await app.inject({ method: 'POST', url: '/api/v1/push/subscriptions', headers: { origin }, payload: body })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/v1/push/subscriptions', headers: { origin, authorization: `Bearer ${deleteToken}` },
      payload: { ...body, thresholds: { ...DEFAULT_THRESHOLDS, warning: 60 } } })).statusCode).toBe(200);
    expect((await store.subscription(id))?.thresholds.warning).toBe(60);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/push/subscriptions/${id}` })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/push/subscriptions/${id}`, headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/push/subscriptions/${id}`, headers: { authorization: `Bearer ${deleteToken}` } })).statusCode).toBe(204);
    expect(await store.subscription(id)).toBeNull();
  });

  it('blocks oversize bodies before processing or persisting subscriptions', async () => {
    const { app, store } = await setup(true);
    const result = await app.inject({ method: 'POST', url: '/api/v1/push/subscriptions', headers: { origin, 'content-type': 'application/json' }, payload: JSON.stringify({ padding: 'x'.repeat(9000) }) });
    expect(result.statusCode).toBe(413);
    expect(await store.subscriptions()).toEqual([]);
  });
});

describe('push destination restrictions', () => {
  it('rejects private and deceptive URLs and malformed encryption keys', () => {
    expect(validPushSubscription(subscription())).toBe(true);
    for (const endpoint of ['http://fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://fcm.googleapis.com.evil.example/x',
      'https://fcm.googleapis.com@evil.example/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://2130706433/x',
      'https://localhost/x', 'https://evil.notify.windows.com.evil.example/x', 'https://fcm.googleapis.com/x#fragment']) expect(validPushEndpoint(endpoint)).toBe(false);
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '100.64.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) expect(publicPushAddress(address)).toBe(false);
    expect(publicPushAddress('8.8.8.8')).toBe(true);
    expect(publicPushAddress('2606:4700:4700::1111')).toBe(true);
    expect(validPushSubscription({ ...subscription(), keys: { p256dh: 'bad', auth: 'bad' } })).toBe(false);
  });
});
