// Synthetic fixtures only. The documented endpoint is exercised without network requests.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCollector } from '../src/data/collector';
import { hasFreshMarketCapEvidence } from '../src/shared/valuation';

const NOW = 1_800_000_000_000, MINUTE = 60_000;
interface Contract { symbol: string; baseAsset: string; quoteAsset: string; }
const btc: Contract = { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' };
function fixture(contracts: Contract[] = [btc]) {
  const calls: URL[] = [];
  const state = {
    cg: false, max: 21_000_000 as number | null, circulation: 20_000_000 as number | null,
    nativeSupply: '20000000', mark: '20000', sourceAge: 0, weightLimit: 2400,
    stats: undefined as ((symbol: string, signal?: AbortSignal | null) => Promise<Response>) | undefined,
    oi: undefined as ((symbol: string, signal?: AbortSignal | null) => Promise<Response>) | undefined,
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push(url); const now = Date.now();
    if (url.pathname.endsWith('/exchangeInfo')) return Response.json({ symbols: contracts.map(contract => ({ ...contract,
      status: 'TRADING', contractType: 'PERPETUAL', underlyingType: 'COIN', marginAsset: contract.quoteAsset })),
      rateLimits: [{ rateLimitType: 'REQUEST_WEIGHT', interval: 'MINUTE', intervalNum: 1, limit: state.weightLimit }] });
    if (url.pathname.endsWith('/premiumIndex')) return Response.json(contracts.map(contract => ({ symbol: contract.symbol, markPrice: state.mark, indexPrice: state.mark, time: now })));
    if (url.pathname.endsWith('/assetIndex')) return Response.json([{ symbol: 'USDTUSD', index: '1', time: now }, { symbol: 'USDCUSD', index: '1', time: now }]);
    const symbol = url.searchParams.get('symbol')!;
    if (url.pathname.endsWith('/openInterest')) return state.oi ? state.oi(symbol, init?.signal) : Response.json({ symbol, openInterest: '10', time: now });
    if (url.pathname.endsWith('/openInterestHist')) return state.stats ? state.stats(symbol, init?.signal) : Response.json([{ symbol,
      CMCCirculatingSupply: state.nativeSupply, timestamp: Math.floor((now - state.sourceAge) / (5 * MINUTE)) * 5 * MINUTE }]);
    if (url.hostname === 'api.coingecko.com') {
      if (!state.cg) return new Response('offline', { status: 503 });
      if (url.pathname.includes('/derivatives/')) return Response.json({ tickers: [] });
      return Response.json([{ id: 'bitcoin', symbol: 'btc', name: 'Synthetic BTC', circulating_supply: state.circulation,
        total_supply: 20_000_000, max_supply: state.max, current_price: Number(state.mark), last_updated: new Date(now).toISOString() }]);
    }
    throw new Error(`Unexpected fixture URL ${url.href}`);
  };
  return { state, calls, fetcher, statsCalls: () => calls.filter(url => url.pathname.endsWith('/openInterestHist')) };
}
afterEach(() => vi.useRealTimers());

describe('independent contract-bound Binance circulating-market-cap source', () => {
  it('works despite CG failure without inventing FDV or marking the FDV identity verified', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    const f = fixture(); const result = await createCollector({ fetcher: f.fetcher }).collect(); const row = result.assets[0]!;
    expect(row).toMatchObject({ marketCapUsd: 400_000_000_000, circulatingSupply: 20_000_000, fdvUsd: null,
      maxSupply: null, oiToFdv: null, mappingStatus: 'unmapped', alertEligible: true, complete: true });
    expect(row.oiToMarketCap).toBeCloseTo(0.00005);
    expect(row.evidence.supply).toBeNull(); expect(row.supplySource).toBeNull();
    expect(row.evidence.marketCap).toEqual({ provider: 'Binance', upstream: 'CoinMarketCap', contractSymbol: 'BTCUSDT',
      circulatingSupply: 20_000_000, unitMultiplier: 1, sourceTime: NOW, fetchedAt: NOW,
      url: 'https://fapi.binance.com/futures/data/openInterestHist?symbol=BTCUSDT&period=5m&limit=1' });
    expect(hasFreshMarketCapEvidence(row, NOW)).toBe(true);
    expect(f.calls.some(url => url.hostname.includes('coinmarketcap'))).toBe(false);
  });

  it.each(['ETH', 'UNMAPPED'])('binds %s to its exact exchange contract without any CG identity', async baseAsset => {
    const f = fixture([{ symbol: `${baseAsset}USDT`, baseAsset, quoteAsset: 'USDT' }]);
    f.state.nativeSupply = '122000000'; f.state.mark = '2700';
    const row = (await createCollector({ fetcher: f.fetcher }).collect()).assets[0]!;
    expect(row.marketCapUsd).toBe(329_400_000_000); expect(row.mappingStatus).toBe('unmapped');
    expect(row.alertEligible).toBe(true); expect(row.evidence.marketCap?.contractSymbol).toBe(`${baseAsset}USDT`);
  });

  it('normalizes 1000PEPE circulating supply exactly once using the reviewed multiplier', async () => {
    const f = fixture([{ symbol: '1000PEPEUSDT', baseAsset: '1000PEPE', quoteAsset: 'USDT' }]);
    f.state.nativeSupply = '413772355107.944'; f.state.mark = '0.0043';
    const row = (await createCollector({ fetcher: f.fetcher }).collect()).assets[0]!;
    expect(row.symbol).toBe('PEPE'); expect(row.priceUsd).toBe(0.0000043);
    expect(row.circulatingSupply).toBe(413_772_355_107_944);
    expect(row.marketCapUsd).toBeCloseTo(1_779_221_126.9641592, 5);
    expect(row.evidence.marketCap?.unitMultiplier).toBe(1000); expect(row.fdvUsd).toBeNull();
  });

  it('requests one reference per asset while preserving aggregate multi-quote OI', async () => {
    const f = fixture([btc, { symbol: 'BTCUSDC', baseAsset: 'BTC', quoteAsset: 'USDC' }]);
    const row = (await createCollector({ fetcher: f.fetcher }).collect()).assets[0]!;
    expect(f.statsCalls()).toHaveLength(1); expect(f.statsCalls()[0]!.searchParams.get('symbol')).toBe('BTCUSDT');
    expect(row.oiUsd).toBe(400_000); expect(row.marketCapUsd).toBe(400_000_000_000);
  });

  it('prefers valid existing circulation and allows MC alerts when only max supply is unavailable', async () => {
    const f = fixture(); f.state.cg = true; f.state.max = null;
    const row = (await createCollector({ fetcher: f.fetcher }).collect()).assets[0]!;
    expect(f.statsCalls()).toHaveLength(0); expect(row.evidence.marketCap).toBeUndefined();
    expect(row.fdvUsd).toBeNull(); expect(row.marketCapUsd).toBe(400_000_000_000); expect(row.alertEligible).toBe(true);
  });

  it.each(['zero', 'negative', 'nan', 'stale', 'future', 'wrong-symbol', 'empty', 'non-grid'])('rejects %s metadata without fabricating a usable value', async variant => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    const f = fixture(); f.state.stats = async symbol => Response.json(variant === 'empty' ? [] : [{
      symbol: variant === 'wrong-symbol' ? 'OTHERUSDT' : symbol,
      CMCCirculatingSupply: variant === 'zero' ? '0' : variant === 'negative' ? '-1' : variant === 'nan' ? 'NaN' : '20000000',
      timestamp: variant === 'stale' ? NOW - 15 * MINUTE : variant === 'future' ? NOW + 5 * MINUTE : variant === 'non-grid' ? NOW - 1 : NOW,
    }]);
    const row = (await createCollector({ fetcher: f.fetcher }).collect()).assets[0]!;
    expect(row.marketCapUsd).toBeNull(); expect(row.evidence.marketCap).toBeUndefined(); expect(row.alertEligible).toBe(false);
  });

  it('retains real metadata timestamps, refreshes at five minutes and expires failed refreshes after ten', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    const f = fixture(), collector = createCollector({ fetcher: f.fetcher });
    const first = (await collector.collect()).assets[0]!.evidence.marketCap;
    vi.setSystemTime(NOW + 4 * MINUTE); expect((await collector.collect()).assets[0]!.evidence.marketCap).toEqual(first);
    expect(f.statsCalls()).toHaveLength(1);
    vi.setSystemTime(NOW + 5 * MINUTE); f.state.stats = async () => new Response('unavailable', { status: 503 });
    expect((await collector.collect()).assets[0]!.evidence.marketCap).toEqual(first); expect(f.statsCalls()).toHaveLength(2);
    vi.setSystemTime(NOW + 10 * MINUTE + 1);
    const expired = (await collector.collect()).assets[0]!;
    expect(expired.marketCapUsd).toBeNull(); expect(expired.alertEligible).toBe(false);
  });

  it('rehydrates fresh independent MC without provider timestamp rewriting', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    const first = await createCollector({ fetcher: fixture().fetcher }).collect();
    vi.setSystemTime(NOW + MINUTE);
    const f = fixture(); const second = await createCollector({ fetcher: f.fetcher, initialSnapshot: first }).collect();
    expect(f.statsCalls()).toHaveLength(0); expect(second.assets[0]!.evidence.marketCap).toEqual(first.assets[0]!.evidence.marketCap);
    expect(second.assets[0]!.alertEligible).toBe(true);
  });

  it('rejects a cached contract, multiplier or URL that is not the live asset binding', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    const first = await createCollector({ fetcher: fixture().fetcher }).collect();
    for (const change of [{ contractSymbol: 'OTHERUSDT' }, { unitMultiplier: 1000 }, { url: 'https://example.test/futures/data/openInterestHist?symbol=BTCUSDT&period=5m' }]) {
      const initial = structuredClone(first); Object.assign(initial.assets[0]!.evidence.marketCap!, change);
      const f = fixture(); f.state.stats = async () => Response.json([]);
      const row = (await createCollector({ fetcher: f.fetcher, initialSnapshot: initial }).collect()).assets[0]!;
      expect(row.marketCapUsd).toBeNull(); expect(row.alertEligible).toBe(false); expect(f.statsCalls()).toHaveLength(1);
    }
  });

  it('clears a stale FDV denominator only when new independent MC monitoring actually takes over', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    const f = fixture(); f.state.cg = true; const collector = createCollector({ fetcher: f.fetcher });
    const first = (await collector.collect()).assets[0]!; expect(first.fdvUsd).toBe(420_000_000_000);
    f.state.cg = false; vi.setSystemTime(NOW + 2 * 60 * MINUTE + 1);
    const fallback = (await collector.collect()).assets[0]!;
    expect(fallback.marketCapUsd).toBe(400_000_000_000); expect(fallback.alertEligible).toBe(true);
    expect(fallback.fdvUsd).toBeNull(); expect(fallback.oiToFdv).toBeNull();
    expect(fallback.evidence.supply).toEqual(first.evidence.supply);
    expect(fallback.issues.some(issue => issue.includes('供应量超过 2 小时'))).toBe(true);
  });

  it('does not let metadata make a missing live OI eligible', async () => {
    const f = fixture(); f.state.oi = async () => new Response('failed', { status: 503 });
    const row = (await createCollector({ fetcher: f.fetcher }).collect()).assets[0]!;
    expect(row.marketCapUsd).toBe(400_000_000_000); expect(row.oiUsd).toBeNull(); expect(row.alertEligible).toBe(false);
  });

  it('starts bounded metadata only after every live OI request and rotates the unattempted tail', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    const f = fixture(Array.from({ length: 65 }, (_, i) => ({ symbol: `TEST${i}USDT`, baseAsset: `TEST${i}`, quoteAsset: 'USDT' })));
    const collector = createCollector({ fetcher: f.fetcher }); const first = await collector.collect();
    expect(f.statsCalls()).toHaveLength(60); expect(first.coverage.marketCap).toBe(60);
    const beforeMetadata = f.calls.slice(0, f.calls.findIndex(url => url.pathname.endsWith('/openInterestHist')));
    expect(beforeMetadata.filter(url => url.pathname.endsWith('/openInterest'))).toHaveLength(65);
    vi.setSystemTime(NOW + 30_000); const second = await collector.collect();
    expect(f.statsCalls()).toHaveLength(65); expect(second.coverage.marketCap).toBe(65);
  });

  // This exercises >7,000 mock requests; allow CPU contention in the full parallel suite.
  it('caps metadata at 600 requests in a rolling five-minute window without blocking live OI', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    const f = fixture(Array.from({ length: 610 }, (_, i) => ({ symbol: `TEST${i}USDT`, baseAsset: `TEST${i}`, quoteAsset: 'USDT' })));
    f.state.weightLimit = 100_000;
    const collector = createCollector({ fetcher: f.fetcher });
    for (let round = 0; round < 10; round++) { vi.setSystemTime(NOW + round * 30_000); await collector.collect(); }
    expect(f.statsCalls()).toHaveLength(600);
    const blocked = await collector.collect();
    expect(f.statsCalls()).toHaveLength(600); expect(blocked.coverage.oi).toBe(610); expect(blocked.coverage.marketCap).toBe(600);
    expect(blocked.errors.some(error => error.includes('每 5 分钟 600 次上限'))).toBe(true);
    vi.setSystemTime(NOW + 5 * MINUTE); const resumed = await collector.collect();
    expect(f.statsCalls()).toHaveLength(660); expect(resumed.coverage.marketCap).toBe(610);
  }, 15_000);

  it('honors Retry-After from metadata without discarding OI already collected this round', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    const f = fixture(); f.state.stats = async () => new Response('limited', { status: 429, headers: { 'Retry-After': '120' } });
    const collector = createCollector({ fetcher: f.fetcher }); const first = await collector.collect();
    expect(first.coverage.oi).toBe(1); expect(first.retryAt).toBe(NOW + 2 * MINUTE);
    vi.setSystemTime(NOW + MINUTE); await collector.collect(); expect(f.statsCalls()).toHaveLength(1);
    vi.setSystemTime(NOW + 2 * MINUTE); f.state.stats = undefined;
    expect((await collector.collect()).assets[0]!.alertEligible).toBe(true); expect(f.statsCalls()).toHaveLength(2);
  });

  it('bounds a stalled metadata batch to four seconds while retaining current OI', async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const f = fixture(); f.state.stats = async (_symbol, signal) => new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    const promise = createCollector({ fetcher: f.fetcher }).collect(); await vi.advanceTimersByTimeAsync(4_001);
    const result = await promise; expect(result.durationMs).toBe(4_000); expect(result.assets[0]!.oiUsd).toBe(200_000);
    expect(result.errors.some(error => error.includes('4 秒预算'))).toBe(true); expect(result.assets[0]!.marketCapUsd).toBeNull();
  });

  it('does not cache a late metadata response after user cancellation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    const f = fixture(); let release: ((response: Response) => void) | undefined;
    f.state.stats = async () => new Promise<Response>(resolve => { release = resolve; });
    const collector = createCollector({ fetcher: f.fetcher }), controller = new AbortController();
    const work = collector.collect({ signal: controller.signal });
    for (let i = 0; i < 50 && !release; i++) await Promise.resolve();
    expect(release).toBeDefined(); controller.abort();
    release!(Response.json([{ symbol: 'BTCUSDT', CMCCirculatingSupply: '999999999', timestamp: NOW }]));
    await expect(work).rejects.toMatchObject({ name: 'AbortError' });
    f.state.stats = async () => Response.json([]); vi.setSystemTime(NOW + MINUTE);
    expect((await collector.collect()).assets[0]!.marketCapUsd).toBeNull();
  });
});
