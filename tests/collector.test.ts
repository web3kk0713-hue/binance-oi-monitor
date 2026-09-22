// Mock contract fixtures only. These values are deliberately fictional and never imported by production code.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCollector } from '../src/data/collector';

interface TestContract { symbol: string; baseAsset: string; quoteAsset: string; marginAsset?: string; underlyingType?: string; status?: string; contractType?: string; }
interface FixtureOptions {
  contracts?: TestContract[];
  oi?: Record<string, string | number>;
  oiFailure?: string;
  mark?: Record<string, string>;
  mappingId?: string;
  max?: number | null;
  circulation?: number | null;
  cmc429?: boolean;
  cg429?: boolean;
  unknownMapping?: boolean;
  supplyAge?: number;
  oiAge?: number;
  supplyFailure?: () => boolean;
  cmcSuccessCode?: number | string;
  providerPrice?: number | null;
  providerSymbol?: string;
}
function fixture(options: FixtureOptions = {}) {
  const calls: string[] = [];
  const contracts = options.contracts ?? [{ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' }];
  const firstBase = contracts[0]!.baseAsset;
  const isBonk = firstBase === '1000BONK';
  const symbol = isBonk ? 'BONK' : firstBase;
  const geckoId = options.mappingId ?? (isBonk ? 'bonk' : symbol === 'BTC' ? 'bitcoin' : symbol.toLowerCase());
  const cmcId = isBonk ? 23095 : 1;
  const sourcePrice = options.providerPrice === undefined ? Number(options.mark?.[contracts[0]!.symbol] ?? '20000') / (isBonk ? 1000 : 1) : options.providerPrice;
  const fetcher = vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    calls.push(url.href);
    const now = Date.now();
    const data = (value: unknown) => Response.json(value);
    if (url.pathname.endsWith('/exchangeInfo')) return data({ symbols: contracts.map(c => ({ status: 'TRADING', contractType: 'PERPETUAL', underlyingType: 'COIN', marginAsset: c.quoteAsset, ...c })) });
    if (url.pathname.endsWith('/premiumIndex')) return data(contracts.map(c => ({ symbol: c.symbol, markPrice: options.mark?.[c.symbol] ?? '20000', indexPrice: options.mark?.[c.symbol] ?? '20000', time: now })));
    if (url.pathname.endsWith('/assetIndex')) return data([{ symbol: 'USDTUSD', index: '1', time: now }, { symbol: 'USDCUSD', index: '1.01', time: now }]);
    if (url.pathname.endsWith('/openInterest')) {
      const requested = url.searchParams.get('symbol')!;
      if (options.oiFailure === requested) return new Response('unavailable', { status: 503 });
      return data({ symbol: requested, openInterest: String(options.oi?.[requested] ?? '10'), time: now - (options.oiAge ?? 0) });
    }
    if (url.pathname.includes('/derivatives/exchanges/')) {
      if (options.cg429) return new Response('rate limited', { status: 429, headers: { 'retry-after': '120' } });
      return data({ tickers: options.unknownMapping ? [] : contracts.map(c => ({ symbol: c.symbol, base: c.baseAsset, target: c.quoteAsset, coin_id: isBonk ? '1000bonk' : geckoId, contract_type: 'perpetual' })) });
    }
    if (url.hostname === 'pro-api.coinmarketcap.com') {
      if (options.cmc429) return new Response('rate limited', { status: 429, headers: { 'retry-after': '180' } });
      if (options.supplyFailure?.()) return new Response('unavailable', { status: 503 });
      if (url.pathname.endsWith('/cryptocurrency/map')) return data({ status: { error_code: options.cmcSuccessCode ?? 0 }, data: [{ id: cmcId, symbol, name: `Test ${symbol}`, slug: geckoId }] });
      if (url.pathname.endsWith('/quotes/latest')) return data({ status: { error_code: options.cmcSuccessCode ?? 0 }, data: [{ id: cmcId, symbol: options.providerSymbol ?? symbol, name: `Test ${symbol}`, circulating_supply: options.circulation === undefined ? 20000000 : options.circulation, max_supply: options.max === undefined ? 21000000 : options.max, total_supply: 20000000, quote: [{ id: 2781, symbol: 'USD', price: sourcePrice }], last_updated: new Date(now - (options.supplyAge ?? 0)).toISOString() }] });
    }
    if (url.pathname.endsWith('/coins/markets')) {
      if (options.cg429) return new Response('rate limited', { status: 429, headers: { 'retry-after': '120' } });
      if (options.supplyFailure?.()) return new Response('unavailable', { status: 503 });
      return data([{ id: geckoId, symbol: options.providerSymbol ?? symbol.toLowerCase(), name: `Test ${symbol}`, circulating_supply: options.circulation === undefined ? 20000000 : options.circulation, max_supply: options.max === undefined ? 21000000 : options.max, total_supply: 20000000, current_price: sourcePrice, fully_diluted_valuation: 1, last_updated: new Date(now - (options.supplyAge ?? 0)).toISOString() }]);
    }
    throw new Error(`Unexpected fixture URL ${url.href}`);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('official-source collector contract (fictional test fixtures)', () => {
  it('accepts the CMC public gateway string success code observed in live responses', async () => {
    const row = (await createCollector({ mode: 'server', fetcher: fixture({ cmcSuccessCode: '0' }).fetcher }).collect()).assets[0]!;
    expect(row.supplySource).toBe('CoinMarketCap');
    expect(row.alertEligible).toBe(true);
  });
  it('never requests CMC from direct mode, including reviewed IDs and an accidentally supplied key', async () => {
    const f = fixture();
    const row = (await createCollector({ mode: 'direct', cmcApiKey: 'fictional-test-key', fetcher: f.fetcher }).collect()).assets[0]!;
    expect(row.supplySource).toBe('CoinGecko');
    expect(row.evidence.supply?.id).toBe('bitcoin');
    expect(f.calls.some(url => url.includes('coinmarketcap'))).toBe(false);
    expect(f.calls.some(url => url.includes('/derivatives/'))).toBe(false);
  });

  it('cannot opt into CMC requests by passing server mode inside a browser', async () => {
    vi.stubGlobal('window', {});
    const f = fixture();
    const row = (await createCollector({ mode: 'server', cmcApiKey: 'fictional-test-key', fetcher: f.fetcher }).collect()).assets[0]!;
    expect(row.supplySource).toBe('CoinGecko');
    expect(f.calls.some(url => url.includes('coinmarketcap'))).toBe(false);
  });

  it.each([false, true])('replaces a server CMC snapshot with independently fetched CG evidence, without relabeling it (failure=%s)', async failure => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const initial = await createCollector({ mode: 'server', fetcher: fixture().fetcher }).collect();
    expect(initial.assets[0]!.supplySource).toBe('CoinMarketCap');
    const originalTime = initial.assets[0]!.supplyUpdatedAt;
    vi.setSystemTime(Date.now() + 61_000);
    const f = fixture({ cg429: failure, supplyAge: 20_000 });
    const row = (await createCollector({ mode: 'direct', initialSnapshot: initial, fetcher: f.fetcher }).collect()).assets[0]!;
    expect(f.calls.some(url => url.includes('coinmarketcap'))).toBe(false);
    if (failure) {
      expect(row.evidence.supply).toBeNull();
      expect(row.supplySource).toBeNull();
      expect(row.alertEligible).toBe(false);
    } else {
      expect(row.evidence.supply?.provider).toBe('CoinGecko');
      expect(row.supplyUpdatedAt).toBe(Date.now() - 20_000);
      expect(row.supplyUpdatedAt).not.toBe(originalTime);
      expect(row.alertEligible).toBe(true);
    }
  });
  it('aggregates two quote contracts with actual FX and never doubles OI for long/short sides', async () => {
    const f = fixture({ contracts: [{ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' }, { symbol: 'BTCUSDC', baseAsset: 'BTC', quoteAsset: 'USDC' }], oi: { BTCUSDT: '10', BTCUSDC: '5' } });
    const snapshot = await createCollector({ fetcher: f.fetcher }).collect();
    expect(snapshot.universe).toEqual({ contracts: 2, assets: 1 });
    expect(snapshot.assets[0]!.oiUsd).toBe(301000);
    expect(snapshot.assets[0]!.fdvUsd).toBe(420000000000);
    expect(snapshot.assets[0]!.alertEligible).toBe(true);
    expect(snapshot.assets[0]!.evidence.contracts[1]!.quoteUsd).toBe('1.01');
    expect(snapshot.assets[0]!.evidence.contracts[0]!.sources?.some(s => s.url.includes('/openInterest'))).toBe(true);
  });

  it('normalizes an explicitly verified 1000-token alias only for per-token price and supply valuation', async () => {
    const f = fixture({ contracts: [{ symbol: '1000BONKUSDT', baseAsset: '1000BONK', quoteAsset: 'USDT' }], oi: { '1000BONKUSDT': '720000' }, mark: { '1000BONKUSDT': '250' }, max: 1000000000, circulation: 100000000 });
    const row = (await createCollector({ fetcher: f.fetcher }).collect()).assets[0]!;
    expect(row.symbol).toBe('BONK');
    expect(row.priceUsd).toBe(0.25);
    expect(row.oiUsd).toBe(180000000);
    expect(row.marketCapUsd).toBe(25000000);
    expect(row.fdvUsd).toBe(250000000);
    expect(row.oiToFdv).toBe(72);
    expect(row.evidence.mapping).toContain('单位倍率 1000');
  });

  it('leaves FDV null when max supply is unknown, even if another provider publishes a native FDV', async () => {
    const f = fixture({ max: null, cmc429: true });
    const row = (await createCollector({ fetcher: f.fetcher }).collect()).assets[0]!;
    expect(row.marketCapUsd).toBeGreaterThan(0);
    expect(row.fdvUsd).toBeNull();
    expect(row.oiToFdv).toBeNull();
    expect(row.alertEligible).toBe(false);
    expect(row.complete).toBe(true);
  });

  it('allows FDV alerts without circulating supply when max supply and all required source data are verified', async () => {
    const row = (await createCollector({ fetcher: fixture({ circulation: null }).fetcher }).collect()).assets[0]!;
    expect(row.marketCapUsd).toBeNull();
    expect(row.fdvUsd).toBeGreaterThan(0);
    expect(row.complete).toBe(true);
    expect(row.alertEligible).toBe(true);
  });

  it('nulls the aggregate OI if any constituent contract is missing', async () => {
    const f = fixture({ contracts: [{ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' }, { symbol: 'BTCUSDC', baseAsset: 'BTC', quoteAsset: 'USDC' }], oiFailure: 'BTCUSDC' });
    const snapshot = await createCollector({ fetcher: f.fetcher }).collect();
    expect(snapshot.assets[0]!.oiUsd).toBeNull();
    expect(snapshot.assets[0]!.oiToFdv).toBeNull();
    expect(snapshot.assets[0]!.alertEligible).toBe(false);
    expect(snapshot.coverage.failedContracts).toBe(1);
  });

  it('falls back on CMC 429 while honoring its Retry-After and retaining source provenance', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = fixture({ cmc429: true });
    const collector = createCollector({ mode: 'server', fetcher: f.fetcher });
    const first = await collector.collect();
    expect(first.assets[0]!.supplySource).toBe('CoinGecko');
    expect(first.assets[0]!.alertEligible).toBe(true);
    expect(first.errors.some(e => e.includes('HTTP_429'))).toBe(true);
    vi.setSystemTime(Date.now() + 61000);
    await collector.collect();
    expect(f.calls.filter(url => url.includes('coinmarketcap'))).toHaveLength(1);
  });

  it('retains last source values but disables alerts after supply expires and refresh fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let fail = false;
    const f = fixture({ supplyFailure: () => fail });
    const collector = createCollector({ fetcher: f.fetcher });
    const first = await collector.collect();
    const original = first.assets[0]!.supplyUpdatedAt;
    fail = true;
    vi.setSystemTime(Date.now() + 2 * 60 * 60_000 + 1);
    const row = (await collector.collect()).assets[0]!;
    expect(row.supplyUpdatedAt).toBe(original);
    expect(row.fdvUsd).toBeGreaterThan(0);
    expect(row.alertEligible).toBe(false);
    expect(row.issues.some(issue => issue.includes('供应量超过 2 小时'))).toBe(true);
  });

  it('does not fabricate identity when no exact derivative mapping exists', async () => {
    const f = fixture({ contracts: [{ symbol: 'UNKNOWNUSDT', baseAsset: 'UNKNOWN', quoteAsset: 'USDT' }], unknownMapping: true });
    const row = (await createCollector({ fetcher: f.fetcher }).collect()).assets[0]!;
    expect(row.oiUsd).toBeGreaterThan(0);
    expect(row.marketCapUsd).toBeNull();
    expect(row.mappingStatus).toBe('unmapped');
    expect(row.alertEligible).toBe(false);
  });

  it('excludes coin-margin, index, dated, and non-trading contracts', async () => {
    const f = fixture({ contracts: [{ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' }, { symbol: 'ETHBTC', baseAsset: 'ETH', quoteAsset: 'BTC', marginAsset: 'BTC' }, { symbol: 'BTCDOMUSDT', baseAsset: 'BTCDOM', quoteAsset: 'USDT', underlyingType: 'INDEX' }, { symbol: 'BTCUSDT_261225', baseAsset: 'BTC', quoteAsset: 'USDT', contractType: 'CURRENT_QUARTER' }, { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'SETTLING' }] });
    const snapshot = await createCollector({ fetcher: f.fetcher }).collect();
    expect(snapshot.universe.contracts).toBe(1);
    expect(f.calls.filter(url => url.includes('/openInterest'))).toHaveLength(1);
  });

  it('prevents a stale OI value from becoming alert eligible', async () => {
    const row = (await createCollector({ fetcher: fixture({ oiAge: 121000 }).fetcher }).collect()).assets[0]!;
    expect(row.oiUsd).toBeGreaterThan(0);
    expect(row.alertEligible).toBe(false);
    expect(row.issues.some(issue => issue.includes('OI 源时间过期'))).toBe(true);
  });

  it('rehydrates fresh supply without altering source timestamps or immediately re-requesting metadata', async () => {
    const f = fixture();
    const first = await createCollector({ fetcher: f.fetcher }).collect();
    const secondFixture = fixture({ cg429: true, cmc429: true });
    const second = await createCollector({ fetcher: secondFixture.fetcher, initialSnapshot: first }).collect();
    expect(second.assets[0]!.supplyUpdatedAt).toBe(first.assets[0]!.supplyUpdatedAt);
    expect(second.assets[0]!.alertEligible).toBe(true);
    expect(secondFixture.calls.some(url => !url.includes('binance.com'))).toBe(false);
  });

  it('bounds CG request URLs and batch sizes, and retries only missing batches without touching successful evidence', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const contracts = Array.from({ length: 205 }, (_, index) => ({ symbol: `TEST${index}USDT`, baseAsset: `TEST${index}`, quoteAsset: 'USDT' }));
    const tokens = contracts.map((contract, index) => ({ ...contract, id: `test-token-with-a-deliberately-long-slug-${index}` }));
    const f = fixture({ contracts });
    const marketCalls: string[] = [];
    let failSecondBatch = true;
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/derivatives/exchanges/')) return Response.json({ tickers: tokens.map(token => ({ symbol: token.symbol, base: token.baseAsset, target: token.quoteAsset, coin_id: token.id, contract_type: 'perpetual' })) });
      if (url.pathname.endsWith('/coins/markets')) {
        marketCalls.push(url.href);
        if (failSecondBatch && marketCalls.length === 2) return new Response('temporary unavailable', { status: 503 });
        const ids = url.searchParams.get('ids')!.split(',');
        return Response.json(tokens.filter(token => ids.includes(token.id)).map(token => ({ id: token.id, symbol: token.baseAsset.toLowerCase(), name: token.baseAsset, current_price: 20000, circulating_supply: 20000000, max_supply: 21000000, total_supply: 20000000, last_updated: new Date().toISOString() })));
      }
      return f.fetcher(input, init);
    };
    const collector = createCollector({ mode: 'direct', fetcher });
    const first = await collector.collect();
    expect(marketCalls).toHaveLength(2);
    const firstSuccess = new Set(new URL(marketCalls[0]!).searchParams.get('ids')!.split(','));
    expect(first.coverage.marketCap).toBe(firstSuccess.size);
    const firstEvidence = first.assets.filter(row => row.evidence.supply).map(row => ({ id: row.id, evidence: row.evidence.supply }));
    failSecondBatch = false;
    vi.setSystemTime(Date.now() + 61_000);
    const second = await collector.collect();
    expect(second.coverage.marketCap).toBe(205);
    expect(second.coverage.eligible).toBe(205);
    for (const call of marketCalls) {
      const parsed = new URL(call);
      const ids = parsed.searchParams.get('ids')!.split(',');
      expect(ids.length).toBeLessThanOrEqual(100);
      expect(call.length).toBeLessThanOrEqual(1800);
      expect(Number(parsed.searchParams.get('per_page'))).toBe(ids.length);
    }
    const retriedIds = marketCalls.slice(2).flatMap(call => new URL(call).searchParams.get('ids')!.split(','));
    expect(retriedIds.some(id => firstSuccess.has(id))).toBe(false);
    for (const cached of firstEvidence) expect(second.assets.find(row => row.id === cached.id)!.evidence.supply).toEqual(cached.evidence);
  });

  it('retries a provider-omitted ID next minute instead of treating a partial response as an hourly success', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = fixture();
    let omit = true;
    const fetcher: typeof fetch = async (input, init) => new URL(String(input)).pathname.endsWith('/coins/markets') && omit ? Response.json([]) : f.fetcher(input, init);
    const collector = createCollector({ mode: 'direct', fetcher });
    const first = await collector.collect();
    expect(first.coverage.marketCap).toBe(0);
    expect(first.errors.some(error => error.includes('COINGECKO_SUPPLY_PARTIAL'))).toBe(true);
    omit = false;
    vi.setSystemTime(Date.now() + 61_000);
    const second = await collector.collect();
    expect(second.coverage.marketCap).toBe(1);
    expect(second.assets[0]!.alertEligible).toBe(true);
  });

  it('rejects a same-symbol but wrong underlying asset reported by the derivative identity source', async () => {
    const f = fixture({ contracts: [{ symbol: 'FAKEUSDT', baseAsset: 'FAKE', quoteAsset: 'USDT' }], mappingId: 'another-fake-token', mark: { FAKEUSDT: '0.0045' }, providerPrice: 0.25, cmc429: true });
    const row = (await createCollector({ fetcher: f.fetcher }).collect()).assets[0]!;
    expect(row.evidence.supply?.providerPriceUsd).toBe(0.25);
    expect(row.oiUsd).toBeGreaterThan(0);
    expect(row.marketCapUsd).toBeNull();
    expect(row.fdvUsd).toBeNull();
    expect(row.mappingStatus).toBe('unmapped');
    expect(row.alertEligible).toBe(false);
    expect(row.issues.some(issue => issue.includes('价格不一致'))).toBe(true);
  });

  it('does not use a matching price as proof of token identity', async () => {
    const row = (await createCollector({ fetcher: fixture({ providerSymbol: 'NOTBTC' }).fetcher }).collect()).assets[0]!;
    expect(row.mappingStatus).toBe('unmapped');
    expect(row.fdvUsd).toBeNull();
    expect(row.alertEligible).toBe(false);
  });

  it('never bridges identical provider slugs and symbols without address evidence (APE / APEcoin.dev collision)', async () => {
    const f = fixture({ contracts: [{ symbol: 'APEUSDT', baseAsset: 'APE', quoteAsset: 'USDT' }], mappingId: 'apecoin', mark: { APEUSDT: '0.1475' }, providerPrice: 0.1475, max: 1000000000, circulation: 1000000000 });
    const originalFetch = f.fetcher;
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname.includes('coinmarketcap')) {
        // Old implementation would accept this identical slug/symbol, despite being a different contract.
        return Response.json({ status: { error_code: 0 }, data: url.pathname.endsWith('/map') ? [{ id: 7257, symbol: 'APE', name: 'APEcoin.dev', slug: 'apecoin' }] : [{ id: 7257, symbol: 'APE', name: 'APEcoin.dev', max_supply: 10000000, quote: [{ symbol: 'USD', price: 0.1475 }], last_updated: new Date().toISOString() }] });
      }
      return originalFetch(input, init);
    };
    const row = (await createCollector({ fetcher }).collect()).assets[0]!;
    expect(row.supplySource).toBe('CoinGecko');
    expect(row.maxSupply).toBe(1000000000);
    expect(row.fdvUsd).toBe(147500000);
    expect(row.evidence.mapping).not.toContain('CMC');
  });

  it('rejects a cached CMC ID originally derived from a slug collision even with a matching source price', async () => {
    const options = { contracts: [{ symbol: 'APEUSDT', baseAsset: 'APE', quoteAsset: 'USDT' }], mappingId: 'apecoin', mark: { APEUSDT: '0.1475' }, providerPrice: 0.1475, max: 1000000000, circulation: 1000000000 };
    const old = await createCollector({ fetcher: fixture(options).fetcher }).collect();
    const evidence = old.assets[0]!.evidence.supply!;
    evidence.provider = 'CoinMarketCap';
    evidence.id = '7257';
    evidence.max = 10000000;
    old.assets[0]!.evidence.mapping = 'CoinGecko Binance 合约 APEUSDT → apecoin; CMC slug=apecoin, symbol=APE, id=7257';
    const row = (await createCollector({ fetcher: fixture({ ...options, supplyFailure: () => true }).fetcher, initialSnapshot: old }).collect()).assets[0]!;
    expect(row.evidence.supply).toBeNull();
    expect(row.fdvUsd).toBeNull();
    expect(row.alertEligible).toBe(false);
  });

  it('rejects old persisted supply that lacks independent price validation evidence', async () => {
    const first = await createCollector({ fetcher: fixture().fetcher }).collect();
    delete first.assets[0]!.evidence.supply!.providerPriceUsd;
    const f = fixture({ cmc429: true, cg429: true });
    const row = (await createCollector({ fetcher: f.fetcher, initialSnapshot: first }).collect()).assets[0]!;
    expect(row.mappingStatus).toBe('unmapped');
    expect(row.fdvUsd).toBeNull();
    expect(row.alertEligible).toBe(false);
  });

  it('normalizes 1000-token units before the source-price consistency check', async () => {
    const f = fixture({ contracts: [{ symbol: '1000BONKUSDT', baseAsset: '1000BONK', quoteAsset: 'USDT' }], mark: { '1000BONKUSDT': '250' }, providerPrice: 0.25 });
    const row = (await createCollector({ fetcher: f.fetcher }).collect()).assets[0]!;
    expect(row.mappingStatus).toBe('verified');
    expect(row.alertEligible).toBe(true);
  });

  it.each([
    { base: 'NEIRO', incorrect: 'neiro', correct: 'neiro-3', price: 0.0001, max: 420690000000 },
    { base: 'PUMP', incorrect: 'pumpbtc-2', correct: 'pump-fun', price: 0.0045, max: 1000000000000 },
  ])('overrides the observed wrong $base exchange identity using reviewed chain-address evidence', async ({ base, incorrect, correct, price, max }) => {
    const f = fixture({ contracts: [{ symbol: `${base}USDT`, baseAsset: base, quoteAsset: 'USDT' }], mappingId: incorrect, mark: { [`${base}USDT`]: String(price) }, cmc429: true });
    const baseFetcher = f.fetcher;
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/coins/markets')) {
        expect(url.searchParams.get('ids')).toContain(correct);
        expect(url.searchParams.get('ids')).not.toContain(incorrect === 'neiro' ? 'neiro,' : incorrect);
        return Response.json([{ id: correct, symbol: base.toLowerCase(), name: base, current_price: price, circulating_supply: max, total_supply: max, max_supply: max, last_updated: new Date().toISOString() }]);
      }
      return baseFetcher(input, init);
    };
    const row = (await createCollector({ fetcher }).collect()).assets[0]!;
    expect(row.evidence.supply?.id).toBe(correct);
    expect(row.evidence.mapping).toContain('官方合约地址核验');
    expect(row.fdvUsd).toBe(price * max);
    expect(row.alertEligible).toBe(true);
  });
});
