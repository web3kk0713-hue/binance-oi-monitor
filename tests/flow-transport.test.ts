import { describe, expect, it, vi } from 'vitest';
import { createFlowBook } from '../src/data/flowDepth';
import { discoverFlowMarkets, parseFlowCandle, parseFlowQuote, parseFlowTrade, parseRestCandles } from '../src/data/flowParsing';
import { binanceRequestWeight, createSourceClient } from '../src/data/http';
import type { FlowMarket } from '../src/shared/flowTypes';

const at = 1_800_000_000_000, minute = Math.floor(at / 60_000) * 60_000;
const market: FlowMarket = { key: 'futures:1000PEPEUSDT', venue: 'futures', symbol: '1000PEPEUSDT', baseAsset: '1000PEPE', quoteAsset: 'USDT', assetId: 'binance:PEPE' };
describe('orderflow source parsing', () => {
  it('restricts scope and maps reviewed units, without stripping digits', () => {
    const coin = { status: 'TRADING', contractType: 'PERPETUAL', underlyingType: 'COIN', marginAsset: 'USDT', quoteAsset: 'USDT' };
    const markets = discoverFlowMarkets({ symbols: [{ ...coin, symbol: '1000PEPEUSDT', baseAsset: '1000PEPE' }, { ...coin, symbol: '1000UNKNOWNUSDT', baseAsset: '1000UNKNOWN' }, { ...coin, symbol: 'STOCKUSDT', baseAsset: 'STOCK', underlyingType: 'EQUITY' }, { ...coin, symbol: 'BADUSDT', baseAsset: 'BAD', status: 'SETTLING' }] });
    expect(markets).toHaveLength(2); expect(markets.find(x => x.symbol === '1000PEPEUSDT')?.assetId).toBe('binance:PEPE');
    expect(markets.find(x => x.symbol === '1000UNKNOWNUSDT')?.assetId).toBe('binance:1000UNKNOWN');
  });
  it('preserves exact native aggregate trade notional and taker side', () => {
    const raw = { e: 'aggTrade', s: market.symbol, a: 1, p: '0.0123456789', q: '100000.1234', T: at - 1, E: at, m: true, st: 1 };
    const parsed = parseFlowTrade(raw, market, at);
    expect(parsed?.quoteQuantity).toBe('1234.56941345677626'); expect(parsed?.price).toBe(raw.p); expect(parsed?.side).toBe('sell');
    expect(parseFlowTrade({ ...raw, st: 2 }, market, at)).toBeNull();
    expect(parseFlowTrade({ ...raw, T: at + 1 }, market, at)).toBeNull();
    expect(parseFlowTrade({ ...raw, T: at - 16_000 }, market, at)).toBeNull();
    expect(parseFlowTrade({ ...raw, q: '-1' }, market, at)).toBeNull();
  });
  it('admits only structurally valid minute candles and closed REST history', () => {
    const row = [minute - 60_000, '10', '12', '9', '11', '100', minute - 1, '1100', 20, '40', '440'];
    expect(parseRestCandles([row], market, at)).toHaveLength(1);
    expect(parseRestCandles([[...row.slice(0, 6), minute, ...row.slice(7)]], market, at)).toHaveLength(0);
    expect(parseRestCandles([[minute, ...row.slice(1, 6), minute + 59_999, ...row.slice(7)]], market, at)).toHaveLength(0);
    expect(parseRestCandles([[...row.slice(0, 10), '2200']], market, at)).toHaveLength(0);
    const raw = { e: 'kline', s: market.symbol, E: at, k: { t: minute, T: minute + 59_999, i: '1m', s: market.symbol, o: '10', h: '12', l: '9', c: '11', v: '100', q: '1100', n: 20, V: '40', Q: '440', x: false } };
    expect(parseFlowCandle(raw, market, at)?.closed).toBe(false);
    expect(parseFlowCandle({ ...raw, k: { ...raw.k, x: true } }, market, at)).toBeNull();
  });
  it('does not fabricate an eight-hour funding interval', () => {
    const q = parseFlowQuote({ e: 'markPriceUpdate', s: market.symbol, E: at, p: '10', i: '10', r: '-0.001', T: at + 3600000 }, market, at, null);
    expect(q?.fundingRate).toBe(-0.001); expect(q?.fundingIntervalHours).toBeNull();
  });
  it('includes one-character assets, U quote and official Unicode names without accepting URL delimiters', () => {
    const common = { status: 'TRADING', contractType: 'PERPETUAL', underlyingType: 'COIN', marginAsset: 'USDT', quoteAsset: 'USDT' };
    const list = discoverFlowMarkets({ symbols: [{ ...common, symbol: 'BUSDT', baseAsset: 'B' }, { ...common, symbol: 'BTCU', baseAsset: 'BTC', quoteAsset: 'U' },
      { ...common, symbol: '币安人生USDT', baseAsset: '币安人生' }, { ...common, symbol: 'X?key=bad', baseAsset: 'X' }] });
    expect(list.map(m => m.symbol).sort()).toEqual(['BTCU', 'BUSDT', '币安人生USDT'].sort());
  });
});
describe('sequence-checked order book', () => {
  const seed = { lastUpdateId: 100, bids: [['99.99', '100'], ['99', '100']], asks: [['100.01', '100'], ['101', '100']] };
  it('requires bridging and matching previous ID, ignores old duplicates', () => {
    const book = createFlowBook(market.key); expect(book.seed(seed)).toBe(true); expect(book.snapshot(at, at)).toBeNull();
    expect(book.update({ U: 99, u: 102, pu: 98, b: [], a: [] })).toBe('ok');
    const depth = book.snapshot(at, at); expect(depth?.complete).toBe(true); expect(depth?.bidDepthQuote).toBe(9999);
    expect(depth?.spreadBps).toBeCloseTo(2); expect(depth?.buySlippageBps).toBeCloseTo(0);
    expect(book.update({ U: 99, u: 102, pu: 98, b: [], a: [] })).toBe('old');
    expect(book.update({ U: 104, u: 105, pu: 103, b: [], a: [] })).toBe('gap'); expect(book.snapshot(at, at)).toBeNull();
  });
  it('does not label shallow coverage or an unfillable order as full liquidity', () => {
    const book = createFlowBook(market.key); book.seed({ ...seed, bids: [['99.99', '1']], asks: [['100.01', '1']] });
    book.update({ U: 100, u: 101, pu: 99, b: [], a: [] });
    expect(book.snapshot(at, at)?.complete).toBe(false); expect(book.snapshot(at, at)?.buySlippageBps).toBeNull();
    book.seed(seed); book.update({ U: 100, u: 101, pu: 99, b: [], a: [] });
    expect(book.snapshot(at, at, 1_000_000)?.buySlippageBps).toBeNull();
    expect(book.snapshot(at, at + 6000)?.complete).toBe(false);
  });
  it('absolute zero deletes a price and malformed prices fail closed', () => {
    const book = createFlowBook(market.key); book.seed(seed);
    book.update({ U: 100, u: 101, pu: 99, b: [['99.99', '0']], a: [] });
    expect(book.snapshot(at, at)?.bid).toBe(99);
    expect(book.update({ U: 102, u: 103, pu: 101, b: [['NaN', '1']], a: [] })).toBe('gap');
  });
});
describe('shared public REST governor', () => {
  it('reserves actual kline/depth weights across collector and feed', async () => {
    expect(binanceRequestWeight(new URL('https://fapi.binance.com/fapi/v1/klines?limit=360'))).toBe(2);
    expect(binanceRequestWeight(new URL('https://fapi.binance.com/fapi/v1/depth?limit=1000'))).toBe(20);
    const fetcher = vi.fn(async () => Response.json({})) as unknown as typeof fetch;
    const collector = createSourceClient(fetcher, 1), feed = createSourceClient(fetcher, 1); collector.setBinanceWeightLimit(5);
    const signal = new AbortController().signal;
    await feed('https://fapi.binance.com/fapi/v1/klines?limit=360', signal);
    await collector('https://fapi.binance.com/fapi/v1/openInterest?symbol=X', signal);
    await expect(feed('https://fapi.binance.com/fapi/v1/klines?limit=360', signal)).rejects.toMatchObject({ code: 'RATE_LIMIT_BUDGET' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
