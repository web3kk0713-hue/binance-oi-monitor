// Synthetic recovery fixtures only. No real exchange or provider requests are made.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCollector } from '../src/data/collector';

interface Token { symbol: string; geckoId: string; cmcId?: number; }
function fixture(initial: Token[]) {
  const state = {
    tokens: initial,
    unmapped: new Set<string>(),
    omitGecko: new Set<string>(),
    omitCmc: new Set<number>(),
    maxSupply: 1_000_000 as number | null,
    oi: undefined as ((symbol: string, signal?: AbortSignal | null) => Promise<Response>) | undefined,
    markets: undefined as ((ids: string[], signal?: AbortSignal | null) => Promise<Response | undefined>) | undefined,
    mapping: undefined as (() => Promise<Response>) | undefined,
  };
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.href);
    const now = Date.now();
    if (url.pathname.endsWith('/exchangeInfo')) return Response.json({ symbols: state.tokens.map(token => ({
      symbol: `${token.symbol}USDT`, baseAsset: token.symbol, quoteAsset: 'USDT', marginAsset: 'USDT',
      status: 'TRADING', contractType: 'PERPETUAL', underlyingType: 'COIN',
    })), rateLimits: [{ rateLimitType: 'REQUEST_WEIGHT', interval: 'MINUTE', intervalNum: 1, limit: 2400 }] });
    if (url.pathname.endsWith('/premiumIndex')) return Response.json(state.tokens.map(token => ({ symbol: `${token.symbol}USDT`, markPrice: '10', indexPrice: '10', time: now })));
    if (url.pathname.endsWith('/assetIndex')) return Response.json([{ symbol: 'USDTUSD', index: '1', time: now }]);
    if (url.pathname.endsWith('/openInterest')) {
      const symbol = url.searchParams.get('symbol')!;
      return state.oi ? state.oi(symbol, init?.signal) : Response.json({ symbol, openInterest: '100', time: now });
    }
    if (url.pathname.includes('/derivatives/exchanges/')) return state.mapping ? state.mapping() : Response.json({ tickers: state.tokens.filter(token => !state.unmapped.has(token.symbol)).map(token => ({
      symbol: `${token.symbol}USDT`, base: token.symbol, target: 'USDT', coin_id: token.geckoId, contract_type: 'perpetual',
    })) });
    if (url.pathname.endsWith('/coins/markets')) {
      const ids = url.searchParams.get('ids')!.split(',');
      const response = await state.markets?.(ids, init?.signal);
      if (response) return response;
      return Response.json(state.tokens.filter(token => ids.includes(token.geckoId) && !state.omitGecko.has(token.geckoId)).map(token => ({
        id: token.geckoId, symbol: token.symbol.toLowerCase(), name: `Synthetic ${token.symbol}`, current_price: 10,
        circulating_supply: 100_000, total_supply: 200_000, max_supply: state.maxSupply, last_updated: new Date(now).toISOString(),
      })));
    }
    if (url.hostname === 'pro-api.coinmarketcap.com' && url.pathname.endsWith('/quotes/latest')) {
      const ids = url.searchParams.get('id')!.split(',').map(Number);
      return Response.json({ status: { error_code: 0 }, data: state.tokens.filter(token => token.cmcId && ids.includes(token.cmcId) && !state.omitCmc.has(token.cmcId)).map(token => ({
        id: token.cmcId, symbol: token.symbol, name: `Synthetic ${token.symbol}`, circulating_supply: 100_000, total_supply: 200_000,
        max_supply: state.maxSupply, quote: [{ symbol: 'USD', price: 10 }], last_updated: new Date(now).toISOString(),
      })) });
    }
    throw new Error(`Unexpected fixture URL: ${url.href}`);
  };
  return { state, calls, fetcher, count: (path: string) => calls.filter(url => new URL(url).pathname.endsWith(path)).length };
}

afterEach(() => { vi.useRealTimers(); });

describe('collector recovery and bounded retry scheduling', () => {
  it.each(['network', '503'] as const)('rotates past a persistent first supply batch failure (%s) without inventing missing FDV', async failure => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_800_000_000_000);
    const f = fixture(Array.from({ length: 525 }, (_, i) => ({ symbol: `TEST${i}`, geckoId: `test-${i}` })));
    let blocked = true;
    f.state.markets = async ids => {
      if (!blocked || !ids.includes('test-0')) return undefined;
      if (failure === 'network') throw new TypeError('Failed to fetch');
      return new Response('unavailable', { status: 503 });
    };
    const collector = createCollector({ fetcher: f.fetcher });
    const first = await collector.collect();
    expect(first.coverage.oi).toBe(525);
    expect(first.coverage.fdv).toBe(0);
    expect(f.count('/coins/markets')).toBe(1);
    vi.setSystemTime(Date.now() + 30_000);
    await collector.collect();
    expect(f.count('/coins/markets')).toBe(1);
    vi.setSystemTime(Date.now() + 30_000);
    const second = await collector.collect();
    expect(second.coverage.fdv).toBe(425);
    expect(second.assets.find(row => row.symbol === 'TEST0')!.fdvUsd).toBeNull();
    const retained = second.assets.find(row => row.symbol === 'TEST100')!.evidence.supply;
    const marketCalls = f.calls.filter(url => new URL(url).pathname.endsWith('/coins/markets'));
    expect(new URL(marketCalls[1]!).searchParams.get('ids')!.split(',')[0]).toBe('test-100');
    blocked = false;
    vi.setSystemTime(Date.now() + 60_000);
    const recovered = await collector.collect();
    expect(recovered.coverage.fdv).toBe(525);
    expect(recovered.assets.find(row => row.symbol === 'TEST100')!.evidence.supply).toEqual(retained);
  });

  it('limits a whole-source network outage to one failed batch per attempt and backs off 1/2/4/5 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const startedAt = 1_800_000_000_000;
    vi.setSystemTime(startedAt);
    const f = fixture(Array.from({ length: 525 }, (_, i) => ({ symbol: `TEST${i}`, geckoId: `test-${i}` })));
    f.state.markets = async () => { throw new TypeError('Failed to fetch'); };
    const collector = createCollector({ fetcher: f.fetcher });
    for (const [offset, expectedCalls] of [[0, 1], [60_000, 2], [120_000, 2], [180_000, 3], [300_000, 3], [420_000, 4], [600_000, 4], [720_000, 5]]) {
      vi.setSystemTime(startedAt + offset!);
      const snapshot = await collector.collect();
      expect(snapshot.coverage.fdv).toBe(0);
      expect(f.count('/coins/markets')).toBe(expectedCalls);
      expect(snapshot.errors.some(error => error.startsWith('COINGECKO_RETRY:'))).toBe(true);
    }
  });

  it.each([401, 403, 451])('stops explicit HTTP %s refusals without rotating or bypassing the source', async status => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const startedAt = 1_800_000_000_000;
    vi.setSystemTime(startedAt);
    const f = fixture(Array.from({ length: 205 }, (_, i) => ({ symbol: `TEST${i}`, geckoId: `test-${i}` })));
    f.state.markets = async () => new Response('denied', { status });
    const collector = createCollector({ fetcher: f.fetcher });
    const first = await collector.collect();
    expect(f.count('/coins/markets')).toBe(1);
    expect(first.errors.some(error => error.includes(`HTTP_${status}`))).toBe(true);
    vi.setSystemTime(startedAt + 60_000);
    await collector.collect();
    expect(f.count('/coins/markets')).toBe(1);
    vi.setSystemTime(startedAt + 5 * 60_000);
    await collector.collect();
    const marketCalls = f.calls.filter(url => new URL(url).pathname.endsWith('/coins/markets'));
    expect(marketCalls).toHaveLength(2);
    expect(marketCalls[1]).toBe(marketCalls[0]);
    expect(f.calls.every(url => ['fapi.binance.com', 'api.coingecko.com'].includes(new URL(url).hostname))).toBe(true);
  });

  it('stops CoinGecko markets as well when its mapping endpoint explicitly refuses access', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_800_000_000_000);
    const f = fixture([{ symbol: 'BTC', geckoId: 'bitcoin' }, { symbol: 'TEST', geckoId: 'test' }]);
    f.state.mapping = async () => new Response('denied', { status: 403 });
    const snapshot = await createCollector({ fetcher: f.fetcher }).collect();
    expect(f.count('/binance_futures')).toBe(1);
    expect(f.count('/coins/markets')).toBe(0);
    expect(snapshot.coverage.fdv).toBe(0);
    expect(snapshot.errors.some(error => error.includes('COINGECKO_IDENTITY: HTTP_403'))).toBe(true);
  });

  it.each([{ status: 429, seconds: 180 }, { status: 418, seconds: 1_200 }])('respects CoinGecko HTTP $status Retry-After without blocking Binance OI', async ({ status, seconds }) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const startedAt = 1_800_000_000_000;
    vi.setSystemTime(startedAt);
    const f = fixture(Array.from({ length: 205 }, (_, i) => ({ symbol: `TEST${i}`, geckoId: `test-${i}` })));
    f.state.markets = async () => new Response('limited', { status, headers: { 'retry-after': String(seconds) } });
    const collector = createCollector({ fetcher: f.fetcher });
    const first = await collector.collect();
    expect(first.coverage.oi).toBe(205);
    expect(f.count('/coins/markets')).toBe(1);
    expect(first.errors.some(error => error.includes(new Date(startedAt + seconds * 1_000).toISOString()))).toBe(true);
    vi.setSystemTime(startedAt + seconds * 1_000 - 1);
    const paused = await collector.collect();
    expect(paused.coverage.oi).toBe(205);
    expect(f.count('/coins/markets')).toBe(1);
    f.state.markets = undefined;
    vi.setSystemTime(startedAt + seconds * 1_000);
    expect((await collector.collect()).coverage.fdv).toBe(205);
  });

  it('does not let a refreshed listing directory reset an active supply refusal backoff', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const startedAt = 1_800_000_000_000;
    vi.setSystemTime(startedAt);
    const f = fixture([{ symbol: 'TEST', geckoId: 'test' }]);
    const collector = createCollector({ fetcher: f.fetcher });
    await collector.collect();
    // Make a new listing trigger the first refusal shortly before the next directory refresh.
    vi.setSystemTime(startedAt + 15 * 60_000);
    f.state.tokens.push({ symbol: 'NEW', geckoId: 'new' });
    f.state.markets = async () => new Response('limited', { status: 429, headers: { 'retry-after': '1800' } });
    await collector.collect();
    const supplyCalls = f.count('/coins/markets');
    vi.setSystemTime(startedAt + 30 * 60_000);
    f.state.tokens.push({ symbol: 'LATER', geckoId: 'later' });
    expect((await collector.collect()).universe.assets).toBe(3);
    expect(f.count('/coins/markets')).toBe(supplyCalls);
  });

  it('keeps supply batches serial and within the existing 27-second round deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const f = fixture(Array.from({ length: 525 }, (_, i) => ({ symbol: `TEST${i}`, geckoId: `test-${i}` })));
    let active = 0; let maxActive = 0;
    f.state.markets = (_ids, signal) => new Promise((resolve, reject) => {
      active++; maxActive = Math.max(maxActive, active);
      const abort = () => { clearTimeout(timer); active--; reject(new DOMException('aborted', 'AbortError')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); active--; resolve(undefined); }, 7_000);
      signal?.addEventListener('abort', abort, { once: true });
    });
    const collector = createCollector({ fetcher: f.fetcher });
    const work = collector.collect();
    await vi.advanceTimersByTimeAsync(27_000);
    const first = await work;
    expect(first.durationMs).toBe(27_000);
    expect(first.coverage.fdv).toBe(300);
    expect(first.errors.some(error => error.startsWith('ROUND_BUDGET:'))).toBe(true);
    expect(maxActive).toBe(1);
    expect(active).toBe(0);
    await vi.advanceTimersByTimeAsync(33_000);
    f.state.markets = undefined;
    expect((await collector.collect()).coverage.fdv).toBe(525);
  });

  it('services a previously unattempted tail first after a budget-truncated round', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const f = fixture(Array.from({ length: 5 }, (_, i) => ({ symbol: `TEST${i}`, geckoId: `test-${i}` })));
    f.state.oi = (symbol, signal) => new Promise<Response>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve(Response.json({ symbol, openInterest: '100', time: Date.now() }));
      }, 7_000);
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
    const collector = createCollector({ fetcher: f.fetcher, concurrency: 1 });
    const firstWork = collector.collect();
    await vi.advanceTimersByTimeAsync(27_000);
    const first = await firstWork;
    expect(first.assets.find(row => row.symbol === 'TEST4')!.oiUsd).toBeNull();
    expect(first.errors.some(error => error.includes('ROUND_BUDGET'))).toBe(true);
    const priorCalls = f.calls.length;
    await vi.advanceTimersByTimeAsync(3_000);
    const secondWork = collector.collect();
    await vi.advanceTimersByTimeAsync(27_000);
    const second = await secondWork;
    const secondOi = f.calls.slice(priorCalls).filter(url => new URL(url).pathname.endsWith('/openInterest'));
    expect(new URL(secondOi[0]!).searchParams.get('symbol')).toBe('TEST4USDT');
    expect(second.assets.find(row => row.symbol === 'TEST4')!.oiUsd).toBe(1_000);
  });

  it('revalidates unresolved identities after five minutes, without requesting mappings every round', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_800_000_000_000);
    const f = fixture([{ symbol: 'TEST', geckoId: 'test' }]);
    f.state.unmapped.add('TEST');
    const collector = createCollector({ fetcher: f.fetcher });
    expect((await collector.collect()).assets[0]!.fdvUsd).toBeNull();
    f.state.unmapped.clear();
    vi.setSystemTime(Date.now() + 30_000);
    expect((await collector.collect()).assets[0]!.fdvUsd).toBeNull();
    expect(f.count('/binance_futures')).toBe(1);
    vi.setSystemTime(Date.now() + 4 * 60_000 + 30_000);
    const recovered = await collector.collect();
    expect(f.count('/binance_futures')).toBe(2);
    expect(recovered.assets[0]!.mappingStatus).toBe('verified');
    expect(recovered.assets[0]!.fdvUsd).toBe(10_000_000);
  });

  it('does not let a permanent failure starve healthy contracts across later truncated rounds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const f = fixture(Array.from({ length: 5 }, (_, i) => ({ symbol: `TEST${i}`, geckoId: `test-${i}` })));
    f.state.oi = (symbol, signal) => new Promise<Response>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve(symbol === 'TEST0USDT' ? new Response('persistent outage', { status: 503 }) : Response.json({ symbol, openInterest: '100', time: Date.now() }));
      }, 7_000);
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
    const collector = createCollector({ fetcher: f.fetcher, concurrency: 1 });
    const recentSuccesses = new Set<string>();
    for (let round = 0; round < 4; round++) {
      const work = collector.collect();
      await vi.advanceTimersByTimeAsync(27_000);
      const snapshot = await work;
      expect(snapshot.assets.find(row => row.symbol === 'TEST0')!.oiUsd).toBeNull();
      if (round >= 2) for (const row of snapshot.assets) if (row.oiUsd !== null) recentSuccesses.add(row.symbol);
      await vi.advanceTimersByTimeAsync(3_000);
    }
    expect([...recentSuccesses].sort()).toEqual(['TEST1', 'TEST2', 'TEST3', 'TEST4']);
  });

  it('retries a CMC-omitted ID next minute while preserving fresh fallback evidence', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_800_000_000_000);
    const f = fixture([{ symbol: 'BTC', geckoId: 'bitcoin', cmcId: 1 }]);
    f.state.omitCmc.add(1);
    const collector = createCollector({ fetcher: f.fetcher, mode: 'server' });
    const first = await collector.collect();
    expect(first.assets[0]!.supplySource).toBe('CoinGecko');
    expect(first.errors.some(error => error.includes('CMC_SUPPLY_PARTIAL'))).toBe(true);
    f.state.omitCmc.clear();
    vi.setSystemTime(Date.now() + 30_000);
    await collector.collect();
    expect(f.count('/quotes/latest')).toBe(1);
    vi.setSystemTime(Date.now() + 30_000);
    const second = await collector.collect();
    expect(f.count('/quotes/latest')).toBe(2);
    expect(f.count('/coins/markets')).toBe(1);
    expect(second.assets[0]!.supplySource).toBe('CoinMarketCap');
  });

  it('exposes the first rate-limit deadline and rehydrates it without making upstream requests', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_800_000_000_000);
    const f = fixture([{ symbol: 'BTC', geckoId: 'bitcoin', cmcId: 1 }]);
    f.state.oi = async () => new Response('rate limited', { status: 429, headers: { 'retry-after': '120' } });
    const collector = createCollector({ fetcher: f.fetcher });
    const limited = await collector.collect();
    expect(limited.retryAt).toBe(Date.now() + 120_000);
    expect(collector.retryAt?.()).toBe(limited.retryAt);
    expect(limited.coverage.oi).toBe(0);
    const restarted = fixture([{ symbol: 'BTC', geckoId: 'bitcoin', cmcId: 1 }]);
    const restored = createCollector({ fetcher: restarted.fetcher, initialSnapshot: limited });
    expect(restored.retryAt?.()).toBe(limited.retryAt);
    expect(restarted.calls).toEqual([]);
    vi.setSystemTime(limited.retryAt!);
    expect(restored.retryAt?.()).toBe(0);
    expect((await restored.collect()).coverage.oi).toBe(1);
  });

  it('does not treat a legitimate unknown max supply as a missing provider row or invent FDV', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_800_000_000_000);
    const f = fixture([{ symbol: 'TEST', geckoId: 'test' }]);
    f.state.maxSupply = null;
    const collector = createCollector({ fetcher: f.fetcher });
    const first = await collector.collect();
    expect(first.assets[0]!.mappingStatus).toBe('verified');
    expect(first.assets[0]!.fdvUsd).toBeNull();
    expect(first.assets[0]!.marketCapUsd).toBe(1_000_000);
    expect(first.errors.some(error => error.includes('SUPPLY_PARTIAL'))).toBe(false);
    vi.setSystemTime(Date.now() + 5 * 60_000);
    const second = await collector.collect();
    expect(second.assets[0]!.fdvUsd).toBeNull();
    expect(f.count('/coins/markets')).toBe(1);
    expect(f.count('/binance_futures')).toBe(1);
  });

  it('does not postpone older successful supply refreshes when a missing ID recovers later', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const startedAt = 1_800_000_000_000;
    vi.setSystemTime(startedAt);
    const f = fixture([{ symbol: 'TEST', geckoId: 'test' }, { symbol: 'LATE', geckoId: 'late' }]);
    f.state.omitGecko.add('late');
    const collector = createCollector({ fetcher: f.fetcher });
    await collector.collect();
    f.state.omitGecko.clear();
    vi.setSystemTime(startedAt + 5 * 60_000);
    const recovered = await collector.collect();
    expect(recovered.coverage.fdv).toBe(2);
    const lateEvidence = recovered.assets.find(row => row.symbol === 'LATE')!.evidence.supply;
    vi.setSystemTime(startedAt + 60 * 60_000);
    const refreshed = await collector.collect();
    expect(f.count('/coins/markets')).toBe(3);
    expect(refreshed.assets.find(row => row.symbol === 'TEST')!.evidence.supply!.fetchedAt).toBe(Date.now());
    expect(refreshed.assets.find(row => row.symbol === 'LATE')!.evidence.supply).toEqual(lateEvidence);
  });

  it('uses the cached universe normally but admits new listings and fetches their supply on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_800_000_000_000);
    const f = fixture([{ symbol: 'TEST', geckoId: 'test' }]);
    const collector = createCollector({ fetcher: f.fetcher });
    const first = await collector.collect();
    const initialEvidence = first.assets[0]!.evidence.supply;
    f.state.tokens.push({ symbol: 'NEW', geckoId: 'new' });
    vi.setSystemTime(Date.now() + 30_000);
    expect((await collector.collect()).universe.contracts).toBe(1);
    expect(f.count('/exchangeInfo')).toBe(1);
    vi.setSystemTime(Date.now() + 14 * 60_000 + 30_000);
    const refreshed = await collector.collect();
    expect(f.count('/exchangeInfo')).toBe(2);
    expect(refreshed.universe.contracts).toBe(2);
    expect(refreshed.assets.find(row => row.symbol === 'NEW')!.fdvUsd).toBe(10_000_000);
    expect(refreshed.assets.find(row => row.symbol === 'TEST')!.evidence.supply).toEqual(initialEvidence);
  });
});
