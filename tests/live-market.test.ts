import { describe, expect, it } from 'vitest';
import { createMarketTracker, LIVE_MAX_TRADES, LIVE_WINDOW_MS, observeMarket, parseMarketBook, parseMarketTrade,
  selectFuturesMarket, verifySpotMarket, type MarketTarget } from '../src/shared/liveMarket';
import { marketStreamUrls } from '../src/web/useLiveMarket';
import type { AssetRow, ContractEvidence } from '../src/shared/types';

const now = Date.UTC(2026, 8, 23, 10);
const future: MarketTarget = { venue: 'futures', symbol: '1000PEPEUSDT', baseAsset: 'PEPE', quoteAsset: 'USDT', multiplier: 1000 };
const spot: MarketTarget = { venue: 'spot', symbol: 'PEPEUSDT', baseAsset: 'PEPE', quoteAsset: 'USDT', multiplier: 1 };
const trade = (time = now, id = 1, maker = false, price = '0.1') => ({ e: 'aggTrade', s: future.symbol, a: id, T: time, E: time, p: price, q: '20', m: maker, st: 1 });
const book = (time = now, id = 1) => ({ e: 'bookTicker', s: future.symbol, u: id, T: time, E: time, b: '0.099', a: '0.101', B: '10', A: '10', st: 1 });
function asset(contracts: { symbol: string; baseAsset: string; quoteAsset: string }[], symbol = 'PEPE'): AssetRow {
  return { symbol, contracts: contracts.map(row => row.symbol), evidence: { contracts: contracts as ContractEvidence[] } } as AssetRow;
}

describe('official market identity and transport routes', () => {
  it('chooses one USDT future and normalizes only reviewed units', () => {
    expect(selectFuturesMarket(asset([
      { symbol: '1000PEPEUSDC', baseAsset: '1000PEPE', quoteAsset: 'USDC' },
      { symbol: '1000PEPEUSDT', baseAsset: '1000PEPE', quoteAsset: 'USDT' },
    ]))).toEqual(future);
    expect(selectFuturesMarket(asset([{ symbol: '1000NEWUSDT', baseAsset: '1000NEW', quoteAsset: 'USDT' }], 'NEW'))).toBeNull();
    expect(selectFuturesMarket(undefined)).toBeNull();
  });
  it('does not invent a spot listing from the future symbol', () => {
    const row = { symbol: 'PEPEUSDT', baseAsset: 'PEPE', quoteAsset: 'USDT', status: 'TRADING', isSpotTradingAllowed: true };
    expect(verifySpotMarket({ symbols: [row] }, 'PEPE')).toEqual(spot);
    for (const change of [{ baseAsset: 'OTHER' }, { status: 'BREAK' }, { isSpotTradingAllowed: false }, { quoteAsset: 'USDC' }]) {
      expect(verifySpotMarket({ symbols: [{ ...row, ...change }] }, 'PEPE')).toBeNull();
    }
    expect(verifySpotMarket({ symbols: [] }, 'PEPE')).toBeNull();
  });
  it('keeps UM market and public routes separate, spot streams combined', () => {
    expect(marketStreamUrls(future)).toEqual(['wss://fstream.binance.com/market/ws/1000pepeusdt@aggTrade', 'wss://fstream.binance.com/public/ws/1000pepeusdt@bookTicker']);
    expect(marketStreamUrls(spot)).toEqual(['wss://stream.binance.com:9443/stream?streams=pepeusdt@aggTrade/pepeusdt@bookTicker']);
  });
});

describe('pure stream parsing and as-of projection', () => {
  it('maps buyer-maker to aggressive selling, without double-applying unit multipliers', () => {
    const sell = parseMarketTrade(trade(now, 1, true), future, now + 10)!;
    expect(sell.side).toBe('sell'); expect(sell.price).toBe(0.0001); expect(sell.quoteValue.toNumber()).toBe(2);
    expect(sell.sourceTime).toBe(now); expect(sell.receivedAt).toBe(now + 10);
    expect(parseMarketTrade({ stream: '1000pepeusdt@aggTrade', data: trade() }, future, now)?.side).toBe('buy');
    const quote = parseMarketBook(book(), future, now)!;
    expect(quote.bid).toBe(0.000099); expect(quote.ask).toBe(0.000101); expect(quote.spreadBps).toBe(200);
  });
  it('does not fabricate source time for spot bookTicker', () => {
    const quote = parseMarketBook({ s: 'PEPEUSDT', u: 1, b: '1', a: '2', B: '1', A: '1' }, spot, now)!;
    expect(quote.sourceTime).toBeNull(); expect(quote.receivedAt).toBe(now);
  });
  it('rejects malformed, delayed, future, wrong-symbol and COIN-M frames', () => {
    for (const change of [{ T: now + 1 }, { T: now - 15_001 }, { q: 'NaN' }, { q: '0' }, { m: 'false' }, { p: 'Infinity' }, { s: 'BTCUSDT' }, { st: 2 }, { a: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect(parseMarketTrade({ ...trade(), ...change }, future, now)).toBeNull();
    }
    expect(parseMarketBook({ ...book(), b: '2', a: '1' }, future, now)).toBeNull();
    expect(parseMarketBook({ ...book(), T: now + 1 }, future, now)).toBeNull();
  });
  it('deduplicates IDs, excludes observations unavailable at as-of, and preserves the rolling boundary', () => {
    const first = parseMarketTrade(trade(now, 1), future, now)!;
    const second = parseMarketTrade(trade(now + 1, 2, true), future, now + 2)!;
    const projected = observeMarket({ target: future, trades: [first, first, second], latestTrade: first,
      book: parseMarketBook(book(), future, now), continuousSince: now, now, connected: true });
    expect(projected.buyQuote).toBe(2); expect(projected.sellQuote).toBe(0); expect(projected.buyShare).toBe(100);
    expect(projected.status).toBe('warming'); expect(projected.coveredMs).toBe(0);
    const expired = observeMarket({ target: future, trades: [first], latestTrade: first, book: null,
      continuousSince: now, now: now + LIVE_WINDOW_MS, connected: true });
    expect(expired.buyQuote).toBeNull(); expect(expired.price).toBeNull(); expect(expired.status).toBe('stale');
  });
  it('nulls stale quotes independently instead of presenting the old spread', () => {
    const projected = observeMarket({ target: future, trades: [], latestTrade: parseMarketTrade(trade(now + 20_000), future, now + 20_000),
      book: parseMarketBook(book(), future, now), continuousSince: now, now: now + 20_000, connected: true });
    expect(projected.price).not.toBeNull(); expect(projected.bid).toBeNull(); expect(projected.ask).toBeNull(); expect(projected.spreadBps).toBeNull();
    expect(projected.status).toBe('stale');
  });
});

describe('bounded continuous-window lifecycle', () => {
  it('starts as missing, accepts out-of-order trades once, and never regresses the latest price', () => {
    const tracker = createMarketTracker(future); tracker.connect(now);
    expect(tracker.observe(now).buyQuote).toBeNull();
    tracker.ingest(book(now + 20), now + 20);
    tracker.ingest(trade(now + 20, 2, false, '0.2'), now + 20);
    tracker.ingest(trade(now + 10, 1, true, '0.1'), now + 30);
    tracker.ingest(trade(now + 20, 2, false, '0.2'), now + 40);
    const result = tracker.observe(now + 40);
    expect(tracker.size).toBe(2); expect(result.buyQuote).toBe(4); expect(result.sellQuote).toBe(2);
    expect(result.price).toBe(0.0002); expect(result.buyShare).toBeCloseTo(66.6666667);
    expect(result.status).toBe('warming');
  });
  it('becomes live only after five continuously observed minutes', () => {
    const tracker = createMarketTracker(future); tracker.connect(now);
    for (let i = 0; i <= 300; i++) {
      const time = now + i * 1000;
      tracker.ingest(trade(time, i), time); tracker.ingest(book(time, i), time);
      const result = tracker.observe(time);
      expect(result.status).toBe(i < 300 ? 'warming' : 'live');
    }
    expect(tracker.observe(now + LIVE_WINDOW_MS).buyQuote).toBe(600); // 300 retained trades, not the excluded left endpoint.
    tracker.disconnect(now + LIVE_WINDOW_MS + 1);
    expect(tracker.observe(now + LIVE_WINDOW_MS + 1)).toMatchObject({ status: 'stale', coveredMs: 0, buyQuote: null, price: null });
    tracker.connect(now + LIVE_WINDOW_MS + 2);
    tracker.ingest(trade(now + LIVE_WINDOW_MS + 3, 301), now + LIVE_WINDOW_MS + 3);
    tracker.ingest(book(now + LIVE_WINDOW_MS + 3, 301), now + LIVE_WINDOW_MS + 3);
    expect(tracker.observe(now + LIVE_WINDOW_MS + 3).status).toBe('warming');
  });
  it('ignores delayed duplicates and old book IDs without regressing valid observations', () => {
    const tracker = createMarketTracker(future); tracker.connect(now);
    tracker.ingest(trade(now, 1), now);
    for (let i = 1; i <= 20; i++) {
      const time = now + i * 1000;
      tracker.ingest(trade(time, i + 1), time); tracker.ingest(book(time, i + 1), time);
    }
    expect(tracker.ingest(trade(now, 1), now + 20_001)).toBe(false);
    expect(tracker.ingest({ ...book(now + 20_001, 1), b: '0.2', a: '0.3' }, now + 20_001)).toBe(false);
    expect(tracker.size).toBe(21);
    expect(tracker.observe(now + 20_001)).toMatchObject({ buyQuote: 42, bid: 0.000099, ask: 0.000101, coveredMs: 20_001 });
  });
  it('resets continuity on a sleep-sized observation gap or invalid trade', () => {
    const tracker = createMarketTracker(future); tracker.connect(now); tracker.ingest(trade(), now); tracker.ingest(book(), now);
    expect(tracker.observe(now + 11_000).coveredMs).toBe(0); expect(tracker.size).toBe(0);
    tracker.ingest(trade(now + 11_001, 2), now + 11_001);
    tracker.ingest(trade(now + 50_000, 3), now + 11_002);
    expect(tracker.observe(now + 11_002).buyQuote).toBeNull(); expect(tracker.size).toBe(0);
  });
  it('resets a silent trade stream even while fresh books arrive', () => {
    const tracker = createMarketTracker(future); tracker.connect(now); tracker.ingest(trade(), now);
    for (let i = 0; i <= 31; i++) { tracker.ingest(book(now + i * 1000, i), now + i * 1000); tracker.observe(now + i * 1000); }
    expect(tracker.size).toBe(0); expect(tracker.observe(now + 31_000).coveredMs).toBe(0);
  });
  it('bounds memory and resets completeness on overflow instead of silently truncating', () => {
    const tracker = createMarketTracker(future, 2); tracker.connect(now);
    for (let i = 1; i <= 3; i++) tracker.ingest(trade(now + i, i), now + i);
    expect(tracker.size).toBe(1); expect(tracker.observe(now + 3).coveredMs).toBe(0);
    expect(tracker.observe(now + 3).message).toContain('上限'); expect(LIVE_MAX_TRADES).toBe(50_000);
  });
});
