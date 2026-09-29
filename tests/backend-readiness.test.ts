import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AssetRow, BackendStatus, Snapshot } from '../src/shared/types';
import { assessSample, parseOptions, readJson, runReadiness } from '../scripts/backend-readiness';

const NOW = 1_800_000_000_000;
function asset(overrides: Partial<AssetRow> = {}): AssetRow {
  return { id: 'binance:BTC', symbol: 'BTC', name: 'Bitcoin', contracts: ['BTCUSDT'], priceUsd: 10, oiUsd: 100,
    marketCapUsd: 190, fdvUsd: 210, oiToFdv: 100 / 210 * 100, oiToMarketCap: 100 / 190 * 100,
    circulatingSupply: 19, maxSupply: 21, updatedAt: NOW, oiUpdatedAt: NOW, priceUpdatedAt: NOW, supplyUpdatedAt: NOW,
    complete: true, alertEligible: true, issues: [], supplySource: 'CoinGecko', mappingStatus: 'verified',
    evidence: { contracts: [], mapping: 'Synthetic exact identity', supply: { provider: 'CoinGecko', id: 'bitcoin',
      circulating: 19, total: 20, max: 21, updatedAt: NOW, fetchedAt: NOW,
      url: 'https://api.coingecko.com/api/v3/coins/markets?ids=bitcoin', providerPriceUsd: 10 } }, ...overrides };
}
function health(overrides: Partial<BackendStatus> = {}): BackendStatus {
  return { mode: 'server', version: '0.1.0', collecting: false, lastSuccess: NOW, storage: 'sqlite',
    pushEnabled: false, retentionDays: 30, rawRetentionDays: 7, lastError: null, collectionIntervalMs: 30_000, ...overrides };
}
function snapshot(assets: AssetRow[] = [asset()], overrides: Partial<Snapshot> = {}): Snapshot {
  return { schemaVersion: 1, mode: 'server', startedAt: NOW - 100, asOf: NOW, durationMs: 100,
    collectionIntervalMs: 30_000, universe: { assets: assets.length, contracts: assets.length },
    coverage: { oi: assets.filter(a => a.oiUsd !== null).length, fdv: assets.filter(a => a.fdvUsd !== null).length,
      marketCap: assets.filter(a => a.marketCapUsd !== null).length, eligible: assets.filter(a => a.alertEligible).length, failedContracts: 0 },
    assets, errors: [], ...overrides };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const options = () => parseOptions(['https://monitor.example', '--once']);

describe('backend readiness: market data, not merely HTTP liveness', () => {
  it('blocks the exact failure of health 200 while every FDV is missing', () => {
    const report = assessSample(health(), snapshot([asset({ fdvUsd: null, maxSupply: null, supplyUpdatedAt: null,
      supplySource: null, mappingStatus: 'unmapped', evidence: { contracts: [], supply: null, mapping: '' } })]), NOW);
    expect(report.status).toBe('blocked');
    expect(report.reasons).toContain('NO_TRUSTED_FDV');
  });

  it('blocks a failed collection even when the health endpoint is 200', () => {
    const report = assessSample(health({ lastSuccess: null, lastError: 'private token=never-print-this' }), snapshot(), NOW);
    expect(report.status).toBe('blocked');
    expect(report.reasons).toContain('NO_RECENT_SUCCESS');
    expect(JSON.stringify(report)).not.toContain('never-print-this');
  });

  it('accepts an explicitly unknown/unbounded maximum without inventing FDV or requiring all coins to have it', () => {
    const eth = asset({ id: 'binance:ETH', symbol: 'ETH', maxSupply: null, fdvUsd: null, alertEligible: false });
    eth.evidence = { ...eth.evidence, supply: { ...eth.evidence.supply!, id: 'ethereum', max: null } };
    const report = assessSample(health(), snapshot([asset(), eth]), NOW);
    expect(report.status).toBe('passed');
    expect(report.coverage).toMatchObject({ trustedFdv: 1, trustedFiniteMax: 1, maxNotAvailable: 1 });
  });

  it.each([
    ['stale OI', () => asset({ oiUpdatedAt: NOW - 90_001 })],
    ['stale price', () => asset({ priceUpdatedAt: NOW - 90_001 })],
    ['stale supply', () => asset({ supplyUpdatedAt: NOW - 7_200_001 })],
    ['unmapped identity', () => asset({ mappingStatus: 'unmapped' })],
    ['incorrect formula', () => asset({ fdvUsd: 999 })],
    ['incorrect maximum', () => asset({ maxSupply: 22 })],
    ['zero OI only', () => asset({ oiUsd: 0 })],
    ['price identity mismatch', () => { const row = asset(); row.evidence.supply!.providerPriceUsd = 100; return row; }],
  ])('blocks %s despite optimistic reported coverage', (_name, fixture) => {
    expect(assessSample(health(), snapshot([fixture()]), NOW).status).toBe('blocked');
  });

  it('blocks stale/future snapshots and malformed runtime contracts', () => {
    for (const value of [snapshot([], { asOf: NOW - 90_001 }), snapshot([], { asOf: NOW + 15_001 }),
      { ...snapshot(), assets: [null] }, { ...snapshot(), coverage: null }, { ...snapshot(), mode: 'direct' }]) {
      expect(assessSample(health(), value, NOW).status).toBe('blocked');
    }
    expect(assessSample({}, snapshot(), NOW).status).toBe('blocked');
  });

  it('reports partial coverage and source errors without printing upstream messages', () => {
    const report = assessSample(health({ lastError: 'secret-on-health' }), snapshot([asset(), asset({ id: 'binance:X',
      fdvUsd: null, maxSupply: null, mappingStatus: 'unmapped', evidence: { contracts: [], supply: null, mapping: '' } })],
    { errors: ['COINGECKO_SUPPLY: secret-on-source', 'some secret bearer XYZ'] }), NOW);
    expect(report.status).toBe('partial');
    expect(report.sourceErrors).toEqual({ coinGecko: 1, coinMarketCap: 0, binance: 0, other: 1 });
    expect(JSON.stringify(report)).not.toMatch(/secret|bearer|XYZ/);
  });

  it('single-shot cannot claim continued collection has been verified', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => json(String(input).endsWith('/health') ? health() : snapshot()));
    const result = await runReadiness(options(), { fetcher, now: () => NOW });
    expect(result.status).toBe('unverified');
    expect(result.continuity).toBe('unverified');
    expect(result.samples[0].status).toBe('passed');
    expect(result.unverified).toContain('restartRecovery');
    expect(result.unverified).toContain('pushDelivery');
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(['https://monitor.example/api/v1/health', 'https://monitor.example/api/v1/snapshot']);
  });

  it('requires asOf advancement across rounds, not repeated health 200', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => json(String(input).endsWith('/health') ? health() : snapshot()));
    const sleep = vi.fn(async () => {});
    const result = await runReadiness(parseOptions(['https://monitor.example', '--rounds=3']), { fetcher, now: () => NOW, sleep });
    expect(result.status).toBe('blocked');
    expect(result.continuity).toBe('blocked');
    expect(result.reasons).toContain('SNAPSHOT_NOT_ADVANCING');
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('passes only the bounded data-readiness scope after progressing fresh rounds', async () => {
    let round = -1;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/health')) { round++; return json(health({ lastSuccess: NOW + round * 35_000 })); }
      const row = asset({ updatedAt: NOW + round * 35_000, oiUpdatedAt: NOW + round * 35_000, priceUpdatedAt: NOW + round * 35_000 });
      return json(snapshot([row], { asOf: NOW + round * 35_000 }));
    });
    const result = await runReadiness(parseOptions(['https://monitor.example', '--rounds=3']),
      { fetcher, now: () => NOW + Math.max(0, round) * 35_000, sleep: async () => {} });
    expect(result.status).toBe('passed');
    expect(result.continuity).toBe('passed');
    expect(result.scope).toBe('bounded-market-data-readiness');
    expect(result.unverified).toContain('historicalRetention');
  });

  it.each([true, false])('rejects asOf-only advancement when actual OI is frozen (success frozen: %s)', async freezeSuccess => {
    let round = -1;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/health')) { round++; return json(health({ lastSuccess: NOW + (freezeSuccess ? 0 : round * 35_000) })); }
      return json(snapshot([asset()], { asOf: NOW + round * 35_000 }));
    });
    const result = await runReadiness(parseOptions(['https://monitor.example', '--rounds=3']),
      { fetcher, now: () => NOW + Math.max(0, round) * 35_000, sleep: async () => {} });
    expect(result.status).toBe('blocked');
    expect(result.continuity).toBe('blocked');
    expect(result.reasons).toContain('OI_SAMPLES_NOT_ADVANCING');
    expect(result.sampling).toMatchObject({ comparedAssets: 1, advancingAssets: 0, stalledAssets: 1 });
    if (freezeSuccess) expect(result.reasons).toContain('COLLECTION_SUCCESS_NOT_ADVANCING');
  });

  it('does not pass with a frozen collection success time despite advancing OI', async () => {
    let round = -1;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/health')) { round++; return json(health()); }
      return json(snapshot([asset({ oiUpdatedAt: NOW + round * 35_000 })], { asOf: NOW + round * 35_000 }));
    });
    const result = await runReadiness(parseOptions(['https://monitor.example', '--rounds=3']),
      { fetcher, now: () => NOW + Math.max(0, round) * 35_000, sleep: async () => {} });
    expect(result.status).toBe('blocked');
    expect(result.reasons).toContain('COLLECTION_SUCCESS_NOT_ADVANCING');
  });

  it('reports partial when only some assets acquire newer OI samples', async () => {
    let round = -1;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/health')) { round++; return json(health({ lastSuccess: NOW + round * 35_000 })); }
      return json(snapshot([asset({ oiUpdatedAt: NOW + round * 35_000 }), asset({ id: 'binance:STALLED' })], { asOf: NOW + round * 35_000 }));
    });
    const result = await runReadiness(parseOptions(['https://monitor.example', '--rounds=3']),
      { fetcher, now: () => NOW + Math.max(0, round) * 35_000, sleep: async () => {} });
    expect(result.status).toBe('partial');
    expect(result.continuity).toBe('partial');
    expect(result.reasons).toContain('OI_SAMPLE_ADVANCEMENT_PARTIAL');
    expect(result.sampling).toMatchObject({ comparedAssets: 2, advancingAssets: 1, stalledAssets: 1, missingAssets: 0 });
  });

  it('reports an unavailable snapshot without copying its response body', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).endsWith('/health') ? json(health()) : json({ token: 'do-not-print' }, 503));
    const result = await runReadiness(options(), { fetcher, now: () => NOW });
    expect(result.status).toBe('blocked');
    expect(result.samples[0].reasons).toContain('SNAPSHOT_HTTP_503');
    expect(JSON.stringify(result)).not.toContain('do-not-print');
  });
});

describe('bounded read-only transport and CLI', () => {
  it('reads an actual HTTP backend and refuses health-200/FDV-zero readiness', async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(request.url?.endsWith('/health') ? health() : snapshot([asset({ fdvUsd: null })])));
    });
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable');
      const result = await runReadiness(parseOptions([`http://127.0.0.1:${address.port}`, '--once']), { now: () => NOW });
      expect(result.status).toBe('blocked');
      expect(result.samples[0].reasons).toContain('NO_TRUSTED_FDV');
      expect(requests.sort()).toEqual(['GET /api/v1/health', 'GET /api/v1/snapshot']);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('defaults to explicit multi-round monitoring and validates all argument boundaries', () => {
    expect(parseOptions(['https://monitor.example/'])).toMatchObject({ rounds: 3, intervalMs: 35_000, timeoutMs: 10_000 });
    expect(parseOptions(['http://127.0.0.1:3000/proxy', '--once']).rounds).toBe(1);
    for (const args of [[], ['https://user:password@example.com'], ['https://example.com/?key=secret'], ['https://example.com/#secret'],
      ['file:///tmp/a'], ['https://example.com', '--rounds=99'], ['https://example.com', '--rounds=1'],
      ['https://example.com', '--once', '--rounds=2'], ['https://example.com', '--interval-ms=1'],
      ['https://example.com', '--timeout-ms=0'], ['https://example.com', '--unknown'], ['https://example.com', '--once', '--once']]) {
      expect(() => parseOptions(args)).toThrow();
    }
  });

  it('rejects redirects, non-JSON bodies, excess advertised/streamed bytes and corrupt JSON', async () => {
    const fixtures = [new Response('secret', { status: 302, headers: { location: 'https://secret.example' } }),
      new Response('secret', { headers: { 'content-type': 'text/html' } }),
      new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '1000' } }),
      json({ padding: 'x'.repeat(100) }), new Response('{broken', { headers: { 'content-type': 'application/json' } })];
    for (const response of fixtures) {
      const result = await readJson('https://example.com/api', { timeoutMs: 1000, maxBytes: 32, fetcher: vi.fn(async () => response) });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain('secret');
    }
  });

  it('uses GET with no credentials or redirects', async () => {
    const fetcher = vi.fn(async () => json({ ok: true }));
    expect(await readJson('https://example.com/api', { timeoutMs: 1000, maxBytes: 100, fetcher })).toEqual({ ok: true, value: { ok: true } });
    expect(fetcher).toHaveBeenCalledWith('https://example.com/api', expect.objectContaining({ method: 'GET', redirect: 'error', credentials: 'omit' }));
  });

  it('bounds a stalled response body even when fetch already returned 200', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(async () => new Response(new ReadableStream(), { headers: { 'content-type': 'application/json' } }));
      const promise = readJson('https://example.com/api', { timeoutMs: 1000, maxBytes: 100, fetcher });
      await vi.advanceTimersByTimeAsync(1001);
      expect(await promise).toEqual({ ok: false, code: 'TIMEOUT' });
    } finally { vi.useRealTimers(); }
  });
});
