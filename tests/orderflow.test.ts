import { describe, expect, it } from 'vitest';
import { createFlowEngine, FLOW_RULES } from '../src/shared/orderflow';
import type { FlowCandle, FlowDepth, FlowEvent, FlowMarket, FlowTrade } from '../src/shared/flowTypes';

const MIN = 60_000;
const START = Date.UTC(2026, 8, 23, 0);
const market: FlowMarket = { key: 'futures:BTCUSDT', venue: 'futures', symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', assetId: 'binance:BTC' };
const spot: FlowMarket = { ...market, key: 'spot:BTCUSDT', venue: 'spot' };
const end = (index: number) => START + (index + 1) * MIN - 1;
function candle(index: number, changes: Partial<FlowCandle> = {}): FlowCandle {
  return { marketKey: market.key, openTime: START + index * MIN, closeTime: end(index), open: 10, high: 11, low: 9, close: 10,
    volume: 100, quoteVolume: 1000, takerBuyQuote: 500, trades: 100, closed: true,
    sourceTime: end(index) + 1, receivedAt: end(index) + 100, source: 'stream', ...changes };
}
function trade(id: string | number, at: number, amount = 100, side: 'buy' | 'sell' = 'buy', changes: Partial<FlowTrade> = {}): FlowTrade {
  return { marketKey: market.key, id: String(id), price: '10', quantity: String(amount / 10), quoteQuantity: String(amount), timestamp: at, receivedAt: at + 10, side, ...changes };
}
function depth(at: number, changes: Partial<FlowDepth> = {}): FlowDepth {
  return { marketKey: market.key, timestamp: at, receivedAt: at + 10, bid: 9.99, ask: 10.01, bidDepthQuote: 500_000,
    askDepthQuote: 500_000, bandBps: 10, spreadBps: 20, buySlippageBps: 1, sellSlippageBps: 1,
    orderSizeQuote: 10_000, complete: true, reason: null, ...changes };
}
function engine() { const value = createFlowEngine(); value.setMarkets([market]); value.setConnected([market.key], true, START); return value; }
function seed(value: ReturnType<typeof engine>, count = 60, receivedAt = end(count - 1) + 100) {
  for (let index = 0; index < count; index++) value.ingestCandle(candle(index, { source: 'rest', sourceTime: end(index), receivedAt }));
}
function active(value: ReturnType<typeof engine>, direction: 'buy' | 'sell' = 'buy', close = 10) {
  for (let index = 60; index < 65; index++) value.ingestCandle(candle(index, { quoteVolume: 3000, volume: 300,
    takerBuyQuote: direction === 'buy' ? 2400 : 600, close, high: Math.max(11, close), low: Math.min(9, close) }));
}
function sampled(value: ReturnType<typeof engine>, amount = 100, count = 1000, first = START) {
  for (let index = 0; index < count; index++) value.ingestTrade(trade(index, first + index * 300, amount));
}
function simpleEvent(id = 'restored'): FlowEvent {
  return { id, ruleVersion: 'flow-v1', marketKey: market.key, symbol: market.symbol, assetId: market.assetId, venue: 'futures', quoteAsset: 'USDT',
    kind: 'large_buy', severity: 'warning', title: '实验事件', timestamp: START, detectedAt: START + 10, referencePrice: 10,
    evidence: [], reason: '实验', invalidation: '不归因', dataStatus: 'complete', outcomes: [] };
}

describe('closed windows, exact units, baseline and no look-ahead', () => {
  it('uses only five closed minutes, quote turnover, exact Delta and VWAP, and 14 one-minute true ranges', () => {
    const e = engine(); seed(e, 60); active(e);
    const result = e.metrics(end(64) + 100)[0];
    expect(result).toMatchObject({ status: 'live', volume5m: 15000, delta5m: 9000, buyShare5m: 80, vwap5m: 10,
      priceChange5m: 0, range5mPct: 20, atr14: 2, baselineWindows: 12, volumeMultiple: 3 });
    e.ingestCandle(candle(65, { closed: false, sourceTime: end(64) + 200, receivedAt: end(64) + 201, quoteVolume: 999_999, volume: 10000 }));
    expect(e.metrics(end(64) + 201)[0].volume5m).toBe(15000);
  });
  it('requires twelve completed prior five-minute windows and limits the baseline to sixty', () => {
    const e = engine(); seed(e, 59); e.ingestCandle(candle(59));
    expect(e.metrics(end(59) + 100)[0]).toMatchObject({ baselineWindows: 11, volumeMultiple: null });
    seed(e, 360, end(359) + 100); e.ingestCandle(candle(360));
    expect(e.metrics(end(360) + 100)[0].baselineWindows).toBe(60);
    expect(e.history(market.key, START, end(361)).candles).toHaveLength(FLOW_RULES.candleLimit);
  });
  it('does not use the candidate window in its own volume baseline', () => {
    const e = engine(); seed(e); active(e);
    expect(e.metrics(end(64) + 100)[0].volumeMultiple).toBe(3);
  });
  it('rejects malformed OHLC, impossible zero volume, future source and misaligned minutes', () => {
    const e = engine();
    for (const change of [{ high: 8 }, { low: 12 }, { close: NaN }, { volume: 0 }, { takerBuyQuote: 1001 },
      { sourceTime: end(0) + 101 }, { openTime: START + 1 }, { quoteVolume: -1 }]) expect(e.ingestCandle(candle(0, change))).toBe(false);
    expect(e.history(market.key, START, end(1)).candles).toHaveLength(0);
  });
  it('keeps legitimate zero turnover different from unavailable data', () => {
    const e = engine();
    for (let i = 0; i < 5; i++) e.ingestCandle(candle(i, { volume: 0, quoteVolume: 0, takerBuyQuote: 0, trades: 0 }));
    expect(e.metrics(end(4) + 100)[0]).toMatchObject({ status: 'live', volume5m: 0, delta5m: 0, vwap5m: null, buyShare5m: null });
  });
  it('suppresses derived overflow even when individual source numbers are finite', () => {
    const e = engine();
    for (let i = 0; i < 5; i++) e.ingestCandle(candle(i, { open: 1e-300, low: 1e-300, high: 1e300, close: 1e300 }));
    expect(e.metrics(end(4) + 100)[0].priceChange5m).toBeNull();
    expect(e.ingestDepth(depth(START, { bidDepthQuote: 1e308, askDepthQuote: 1e308 }))).toBe(false);
  });
  it('never includes a later receipt in an earlier as-of projection', () => {
    const e = engine(); seed(e, 5, end(4) + 5000);
    e.ingestCandle(candle(5, { closed: false, sourceTime: end(4) + 1, receivedAt: end(4) + 5000 }));
    expect(e.metrics(end(4) + 100)[0].volume5m).toBeNull();
    expect(e.history(market.key, START, end(4) + 100).candles).toHaveLength(0);
    expect(e.metrics(end(4) + 5000)[0].volume5m).toBe(5000);
  });
  it('does not turn late REST backfill into historical alerts', () => {
    const e = engine(); seed(e, 60, end(64) + 100);
    for (let i = 60; i < 65; i++) e.ingestCandle(candle(i, { source: 'rest', sourceTime: end(i), receivedAt: end(64) + 100,
      quoteVolume: 3000, volume: 300, takerBuyQuote: 2400 }));
    expect(e.events()).toHaveLength(0);
    expect(e.metrics(end(64) + 100)[0].status).toBe('warming');
    // A genuinely fresh final stream frame can confirm the same values now.
    e.ingestCandle(candle(64, { quoteVolume: 3000, volume: 300, takerBuyQuote: 2400, receivedAt: end(64) + 200 }));
    expect(e.events().find(row => row.kind === 'buy_pressure')?.detectedAt).toBe(end(64) + 200);
  });
  it('marks missing, stale and disconnected inputs instead of retaining executable-looking numbers', () => {
    const e = engine(); for (const i of [0, 1, 3, 4]) e.ingestCandle(candle(i));
    expect(e.metrics(end(4) + 100)[0]).toMatchObject({ status: 'warming', volume5m: null });
    expect(e.metrics(end(4) + 100 + FLOW_RULES.candleStaleMs)[0].status).toBe('stale');
    e.setConnected([market.key], false, end(5));
    expect(e.metrics(end(5))[0]).toMatchObject({ status: 'disconnected', price: null, volume5m: null });
  });
  it('does not allow an unfinished or old candle to overwrite a closed candle', () => {
    const e = engine(); e.ingestCandle(candle(0));
    expect(e.ingestCandle(candle(0, { closed: false, receivedAt: end(0) + 200 }))).toBe(false);
    expect(e.ingestCandle(candle(0, { close: 9, sourceTime: end(0), receivedAt: end(0) + 50 }))).toBe(false);
    expect(e.history(market.key, START, end(1)).candles[0].close).toBe(10);
  });
});

describe('directional experimental rules', () => {
  it('detects persistent buy or sell pressure only once per cooldown', () => {
    for (const direction of ['buy', 'sell'] as const) {
      const e = engine(); seed(e); active(e, direction);
      expect(e.events().filter(row => row.kind === `${direction}_pressure`)).toHaveLength(1);
      e.ingestCandle(candle(65, { quoteVolume: 3000, volume: 300, takerBuyQuote: direction === 'buy' ? 2400 : 600 }));
      expect(e.events().filter(row => row.kind === `${direction}_pressure`)).toHaveLength(1);
      expect(e.events()[0].reason).toContain('实验');
    }
  });
  it('does not confuse a single intense minute with four persistent minutes', () => {
    const e = engine(); seed(e);
    for (let i = 60; i < 65; i++) e.ingestCandle(candle(i, { quoteVolume: 3000, volume: 300, takerBuyQuote: i === 64 ? 2900 : 1500 }));
    expect(e.events().some(row => row.kind.includes('pressure'))).toBe(false);
  });
  it('uses the closed five-minute close, not a transient wick, for breakouts and breakdowns', () => {
    const up = engine(); seed(up); active(up, 'buy', 12); expect(up.events().some(row => row.kind === 'breakout_up')).toBe(true);
    const down = engine(); seed(down); active(down, 'sell', 8); expect(down.events().some(row => row.kind === 'breakout_down')).toBe(true);
    const wick = engine(); seed(wick);
    for (let i = 60; i < 65; i++) wick.ingestCandle(candle(i, { high: 15, quoteVolume: 3000, volume: 300, takerBuyQuote: 1500 }));
    expect(wick.events().some(row => row.kind.startsWith('breakout'))).toBe(false);
  });
  it('does not use twelve scattered older windows when a breakout lookback window is missing', () => {
    const e = engine(); seed(e, 75);
    // A gap at minute 79 lies inside the immediately preceding hour, although enough older baselines exist.
    for (let i = 75; i < 90; i++) if (i !== 79) e.ingestCandle(candle(i, { source: 'rest', receivedAt: end(89) + 100 }));
    for (let i = 90; i < 95; i++) e.ingestCandle(candle(i, { close: 12, high: 13, quoteVolume: 3000, volume: 300, takerBuyQuote: 1500 }));
    expect(e.metrics(end(94) + 100)[0].baselineWindows).toBeGreaterThanOrEqual(12);
    expect(e.events().some(row => row.kind === 'breakout_up')).toBe(false);
  });
  it('requires continuous raw OI for divergence, not dollar OI or funding', () => {
    const e = engine(); seed(e);
    for (let i = 0; i <= 10; i++) { const at = START + 60 * MIN + i * 30_000;
      e.ingestOi({ marketKey: market.key, quantity: 1000 - i, timestamp: at, receivedAt: at + 10 }); }
    active(e, 'sell', 10.1);
    expect(e.metrics(end(64) + 100)[0].oiChange5m).toBe(-1);
    expect(e.events().some(row => row.kind === 'flow_divergence')).toBe(true);
    const gap = engine(); seed(gap);
    for (let i = 0; i <= 10; i++) if (i !== 5) { const at = START + 60 * MIN + i * 30_000;
      gap.ingestOi({ marketKey: market.key, quantity: 1000 - i, timestamp: at, receivedAt: at + 10 }); }
    active(gap, 'sell', 10.1);
    expect(gap.metrics(end(64) + 100)[0].oiChange5m).toBeNull();
    expect(gap.events().some(row => row.kind === 'flow_divergence')).toBe(false);
  });
  it('ignores future, duplicate and stale OI and never fabricates spot OI', () => {
    const e = engine();
    expect(e.ingestOi({ marketKey: market.key, quantity: 10, timestamp: START + 1, receivedAt: START })).toBe(false);
    expect(e.ingestOi({ marketKey: market.key, quantity: 10, timestamp: START, receivedAt: START })).toBe(true);
    expect(e.ingestOi({ marketKey: market.key, quantity: 20, timestamp: START, receivedAt: START + 1 })).toBe(false);
    e.setMarkets([market, spot]); expect(e.ingestOi({ marketKey: spot.key, quantity: 10, timestamp: START, receivedAt: START })).toBe(false);
  });
  it('retains unknown funding intervals as null and expires a passed settlement quote', () => {
    const e = engine(); const row = { marketKey: market.key, markPrice: 10, indexPrice: 9.9, fundingRate: 0.0001,
      nextFundingTime: START + 30_000, fundingIntervalHours: null, timestamp: START, receivedAt: START + 10 };
    e.ingestQuote(row);
    expect(e.metrics(START + 20)[0].funding?.fundingIntervalHours).toBeNull();
    expect(e.metrics(START + 30_000)[0].funding).toBeNull();
    expect(e.ingestQuote({ ...row, timestamp: START + 100, receivedAt: START + 99 })).toBe(false);
  });
});

describe('large aggregate trades, sampling, ordering and bounded memory', () => {
  it('needs previous mature samples and never uses the candidate in its own threshold', () => {
    const e = engine(); sampled(e);
    const at = START + 5 * MIN + 20;
    expect(e.ingestTrade(trade('large', at, 200_000, 'sell'))).toBe(true);
    const event = e.events()[0];
    expect(event.kind).toBe('large_sell'); expect(event.rawTrade?.id).toBe('large');
    expect(event.evidence.find(row => row.label === '此前实际样本')?.value).toBe(1000);
    expect(event.evidence[0].baseline).toBe(100_000); expect(event.quoteAsset).toBe('USDT');
    expect(e.ingestTrade(trade('large', at, 200_000, 'sell'))).toBe(false);
    e.ingestTrade(trade('next', at + 1, 300_000, 'sell')); expect(e.events()).toHaveLength(1);
    e.ingestTrade(trade('buy', at + 2, 300_000, 'buy')); expect(e.events()).toHaveLength(2);
  });
  it('does not qualify 999 samples or less than five continuously connected minutes', () => {
    const e = engine(); sampled(e, 100, 999);
    expect(e.metrics(START + 5 * MIN + 1)[0].largeTradeThreshold).toBeNull();
    const fresh = engine(); for (let i = 0; i < 1000; i++) fresh.ingestTrade(trade(i, START + i));
    fresh.ingestTrade(trade('early', START + 1001, 200_000)); expect(fresh.events()).toHaveLength(0);
  });
  it('lets a hot market mature despite ten thousand trades spanning much less than five minutes', () => {
    const e = engine(); const at = START + 5 * MIN;
    for (let i = 0; i < 10_050; i++) e.ingestTrade(trade(i, at + i, 100));
    e.ingestTrade(trade('hot', at + 10_051, 200_000));
    expect(e.metrics(at + 10_061)[0].tradeSamples).toBe(10_000);
    expect(e.events().some(row => row.rawTrade?.id === 'hot')).toBe(true);
    expect(e.ingestTrade(trade(0, at, 100, 'buy', { receivedAt: at + 10_062 }))).toBe(false);
  });
  it('keeps a five-second quantile cache during ring eviction, then updates it deterministically', () => {
    const e = engine(); const at = START + 5 * MIN;
    for (let i = 0; i < 10_000; i++) e.ingestTrade(trade(i, at + i, 100));
    const checked = at + 10_100;
    expect(e.metrics(checked)[0].largeTradeThreshold).toBe(100_000);
    for (let i = 0; i < 100; i++) e.ingestTrade(trade(`higher${i}`, checked + i + 1, 200_000));
    expect(e.metrics(checked + 1000)[0].largeTradeThreshold).toBe(100_000);
    expect(e.metrics(checked + 5001)[0].largeTradeThreshold).toBe(200_000);
  });
  it('accepts out-of-order trades once, without regressing price or producing late large alerts', () => {
    const e = engine(); sampled(e); const at = START + 5 * MIN + 10;
    e.ingestTrade(trade('new', at + 100, 100, 'buy', { price: '20', quantity: '5' }));
    e.ingestTrade(trade('old', at + 50, 200_000, 'sell', { receivedAt: at + 110 }));
    expect(e.events()).toHaveLength(0); expect(e.metrics(at + 120)[0].price).toBe(20);
  });
  it('rejects future times, stale trades, nonfinite values and inconsistent quote amounts', () => {
    const e = engine();
    for (const change of [{ timestamp: START + 11 }, { receivedAt: START + 15_001 }, { price: 'Infinity' },
      { quantity: '-1' }, { quoteQuantity: '999' }]) expect(e.ingestTrade(trade(1, START, 100, 'buy', change))).toBe(false);
    expect(e.metrics(START + 20_000)[0].tradeSamples).toBe(0);
  });
  it('resets sample maturity and OI continuity after disconnect', () => {
    const e = engine(); sampled(e); expect(e.metrics(START + 5 * MIN + 20)[0].largeTradeThreshold).not.toBeNull();
    const at = START + 6 * MIN; e.setConnected([market.key], false, at); e.setConnected([market.key], true, at + 1);
    e.ingestTrade(trade('after', at + 10, 500_000));
    expect(e.events()).toHaveLength(0); expect(e.metrics(at + 20)[0].tradeSamples).toBe(1);
    expect(e.metrics(at + 20)[0].largeTradeThreshold).toBeNull();
  });
  it('expires actual samples older than the declared one-hour lookback', () => {
    const e = engine(); sampled(e);
    expect(e.metrics(START + FLOW_RULES.sampleLookbackMs + 6 * MIN)[0].tradeSamples).toBe(0);
    expect(e.metrics(START + FLOW_RULES.sampleLookbackMs + 6 * MIN)[0].largeTradeThreshold).toBeNull();
  });
  it('enforces the global 500k cap and explicitly rewarms markets evicted by hotter markets', () => {
    const e = engine(); const markets = Array.from({ length: 51 }, (_, index) => ({ ...market, key: `futures:T${index}USDT`, symbol: `T${index}USDT` }));
    e.setMarkets(markets); e.setConnected(markets.map(row => row.key), true, START);
    const at = START + 5 * MIN;
    for (const current of markets) for (let i = 0; i < 10_000; i++) e.ingestTrade(trade(i, at + i, 100, 'buy', { marketKey: current.key }));
    const rows = e.metrics(at + 10_100);
    expect(rows.reduce((total, row) => total + row.tradeSamples, 0)).toBe(FLOW_RULES.globalSampleLimit);
    expect(rows[0].tradeSamples).toBe(0); expect(rows[0].reason).toContain('重新预热');
    expect(rows.at(-1)?.tradeSamples).toBe(10_000);
  }, 20_000);
});

describe('selected visible-depth anomalies', () => {
  it('invalidates depth immediately without deleting pending evidence and rebuilds the baseline after recovery', () => {
    const e = engine();
    for (let i = 0; i < 300; i++) e.ingestDepth(depth(START + i * 1000));
    for (let i = 300; i < 305; i++) e.ingestDepth(depth(START + i * 1000, { bidDepthQuote: 100_000, askDepthQuote: 100_000, spreadBps: 50 }));
    expect(e.metrics(START + 304_010)[0].depth).not.toBeNull();
    e.invalidateDepth(market.key);
    expect(e.metrics(START + 304_011)[0].depth).toBeNull();
    const pending = e.drainUpdates().depth;
    expect(pending).toHaveLength(305);
    expect(pending.at(-1)).toMatchObject({ timestamp: START + 304_000, receivedAt: START + 304_010 });
    for (let i = 305; i <= 315; i++) e.ingestDepth(depth(START + i * 1000, { bidDepthQuote: 100_000, askDepthQuote: 100_000, spreadBps: 50 }));
    expect(e.events()).toHaveLength(0);
    expect(e.metrics(START + 315_010)[0].depth?.timestamp).toBe(START + 315_000);
    for (let i = 316; i < 616; i++) e.ingestDepth(depth(START + i * 1000));
    for (let i = 616; i <= 626; i++) e.ingestDepth(depth(START + i * 1000, { bidDepthQuote: 100_000, askDepthQuote: 100_000, spreadBps: 50 }));
    expect(e.events().filter(row => row.kind === 'liquidity_drop')).toHaveLength(1);
    expect(() => e.invalidateDepth('futures:UNKNOWN')).not.toThrow();
  });
  it('requires five minutes of complete sampled depth plus a persistent ten-second change', () => {
    const e = engine(); for (let i = 0; i < 300; i++) e.ingestDepth(depth(START + i * 1000));
    for (let i = 300; i < 310; i++) e.ingestDepth(depth(START + i * 1000, { bidDepthQuote: 100_000, askDepthQuote: 100_000, spreadBps: 50 }));
    expect(e.events()).toHaveLength(0);
    e.ingestDepth(depth(START + 310_000, { bidDepthQuote: 100_000, askDepthQuote: 100_000, spreadBps: 50 }));
    expect(e.events().filter(row => row.kind === 'liquidity_drop')).toHaveLength(1);
    expect(e.metrics(START + 326_001)[0].depth).toBeNull();
  });
  it('suppresses partial depth, changed band and interrupted baselines', () => {
    for (const variant of ['partial', 'band', 'gap'] as const) {
      const e = engine();
      for (let i = 0; i < 300; i++) if (!(variant === 'gap' && i >= 240 && i <= 250)) e.ingestDepth(depth(START + i * 1000));
      for (let i = 300; i <= 312; i++) e.ingestDepth(depth(START + i * 1000, { bidDepthQuote: 100_000, askDepthQuote: 100_000, spreadBps: 50,
        complete: variant !== 'partial', bandBps: variant === 'band' ? 20 : 10 }));
      expect(e.events()).toHaveLength(0);
    }
  });
});

describe('event outcomes, persistence and immutable as-of history', () => {
  it('uses the first complete post-detection price and then contiguous 1/5/15-minute closes', () => {
    const e = engine(); seed(e); active(e);
    const original = e.events().find(row => row.kind === 'buy_pressure')!; expect(original.referencePrice).toBe(10);
    e.drainUpdates();
    for (let i = 65; i <= 80; i++) e.ingestCandle(candle(i, { close: 20 + i - 65, open: 20, high: 40, low: 19 }));
    const updated = e.events().find(row => row.id === original.id)!;
    expect(updated.outcomes.map(row => row.minutes)).toEqual([1, 5, 15]);
    expect(updated.outcomes[0]).toMatchObject({ entryAt: end(65), entryPrice: 20, price: 21, changePct: 5, availableAt: end(66) + 100 });
    expect(updated.referencePrice).toBe(10);
    expect(e.history(market.key, original.detectedAt, end(66) + 50).events.find(row => row.id === original.id)?.outcomes).toHaveLength(0);
    expect(e.drainUpdates().events.find(row => row.id === original.id)?.outcomes).toHaveLength(3);
    expect(e.drainUpdates()).toEqual({ candles: [], events: [], depth: [], oi: [] });
  });
  it('does not backfill a missing outcome path from later REST history', () => {
    const e = engine(); seed(e); active(e); const id = e.events()[0].id;
    e.ingestCandle(candle(65)); e.ingestCandle(candle(66));
    e.ingestCandle(candle(68)); // Missing minute 67 invalidates the remaining path.
    e.ingestCandle(candle(67, { source: 'rest', sourceTime: end(67), receivedAt: end(68) + 1000 }));
    for (let i = 69; i <= 80; i++) e.ingestCandle(candle(i));
    expect(e.events().find(row => row.id === id)?.outcomes.map(row => row.minutes)).toEqual([1]);
  });
  it('stops later outcomes on a disconnection or excessively delayed first price', () => {
    const e = engine(); seed(e); active(e); const id = e.events()[0].id;
    e.setConnected([market.key], false, end(64) + 200); e.setConnected([market.key], true, end(64) + 300);
    for (let i = 65; i <= 81; i++) e.ingestCandle(candle(i));
    expect(e.events().find(row => row.id === id)?.outcomes).toHaveLength(0);
    const delayed = engine(); seed(delayed); active(delayed); const delayedId = delayed.events()[0].id;
    delayed.ingestCandle(candle(65, { receivedAt: end(65) + 20_000 })); delayed.ingestCandle(candle(66));
    expect(delayed.events().find(row => row.id === delayedId)?.outcomes).toHaveLength(0);
  });
  it('hydrates saved outcomes without re-persisting imports or inventing a missing entry', () => {
    const e = engine(); const prior = simpleEvent(); e.hydrateEvents([prior]);
    expect(e.drainUpdates().events).toHaveLength(0);
    for (let i = 0; i < 20; i++) e.ingestCandle(candle(i));
    expect(e.events().find(row => row.id === prior.id)?.outcomes).toHaveLength(0);
  });
  it('resumes a known entry only along the immediately following complete path', () => {
    const e = engine(); const prior = simpleEvent();
    prior.outcomes = [{ minutes: 1, entryAt: end(0), entryPrice: 10, price: 10, changePct: 0, availableAt: end(1) + 100 }];
    e.hydrateEvents([prior]); for (let i = 2; i <= 15; i++) e.ingestCandle(candle(i));
    expect(e.events().find(row => row.id === prior.id)?.outcomes.map(row => row.minutes)).toEqual([1, 5, 15]);
  });
  it('drains changed candles, new OI/depth and changed events; returned data cannot mutate the engine', () => {
    const e = engine(); e.ingestCandle(candle(0)); e.ingestCandle(candle(0));
    e.ingestCandle(candle(1, { closed: false, sourceTime: end(0) + 100, receivedAt: end(0) + 101 }));
    e.ingestOi({ marketKey: market.key, quantity: 10, timestamp: START, receivedAt: START }); e.ingestDepth(depth(START));
    const update = e.drainUpdates(); expect(update.candles).toHaveLength(2); expect(update.oi).toHaveLength(1); expect(update.depth).toHaveLength(1);
    update.candles[0].close = 999; expect(e.history(market.key, START, end(2)).candles[0].close).toBe(10);
    expect(e.drainUpdates()).toEqual({ candles: [], events: [], depth: [], oi: [] });
  });
  it('coalesces forming updates, replaces them with a final close, and freezes closed availability against reloads', () => {
    const e = engine();
    for (let i = 1; i <= 1000; i++) e.ingestCandle(candle(0, { closed: false, sourceTime: START + i * 50, receivedAt: START + i * 50 + 1 }));
    const forming = e.drainUpdates().candles;
    expect(forming).toHaveLength(1); expect(forming[0]).toMatchObject({ closed: false, receivedAt: START + 50_001 });
    e.ingestCandle(candle(0, { closed: false, sourceTime: START + 55_000, receivedAt: START + 55_001 }));
    e.ingestCandle(candle(0));
    const closed = e.drainUpdates().candles;
    expect(closed).toHaveLength(1); expect(closed[0]).toMatchObject({ closed: true, receivedAt: end(0) + 100 });
    expect(e.ingestCandle(candle(0, { source: 'rest', sourceTime: end(0), receivedAt: end(1) + 100 }))).toBe(false);
    expect(e.ingestCandle(candle(0, { close: 10.5, sourceTime: end(0) + 500, receivedAt: end(0) + 501 }))).toBe(false);
    expect(e.drainUpdates().candles).toHaveLength(0);
    expect(e.history(market.key, START, end(0) + 100).candles[0]).toMatchObject({ close: 10, receivedAt: end(0) + 100 });
  });
  it('retains undrained minute evidence independently of the 360-candle working buffer', () => {
    const e = engine(); seed(e, FLOW_RULES.candleLimit + 10);
    expect(e.history(market.key, START, end(380)).candles).toHaveLength(FLOW_RULES.candleLimit);
    expect(e.drainUpdates().candles).toHaveLength(FLOW_RULES.candleLimit + 10);
  });
  it('never mixes currencies/venues or keeps removed markets subscribed in memory', () => {
    const e = engine(); e.setMarkets([market, spot]); e.setConnected([spot.key], true, START);
    e.ingestCandle(candle(0, { marketKey: spot.key })); expect(e.history(market.key, START, end(1)).candles).toHaveLength(0);
    e.setMarkets([spot]); expect(e.metrics(START + MIN)).toHaveLength(1);
    expect(e.ingestTrade(trade(1, START))).toBe(false);
  });
  it('accepts Unicode market names, single-character assets and U quotes while rejecting unsafe tokens', () => {
    const e = engine();
    const make = (symbol: string, baseAsset = '币', quoteAsset = 'U'): FlowMarket =>
      ({ ...market, key: `futures:${symbol}`, symbol, baseAsset, quoteAsset });
    const valid = [make('币安人生USDT', '币安人生', 'USDT'), make('BU', 'B'), make('一', '一'), make('币_1U', '币_1')];
    const invalid = [make('BAD/USDT'), make('BAD USDT'), make('BAD\nUSDT'), make(''), make('A'.repeat(41)),
      make('BASEU', 'BAD/BASE'), make('QUOTEU', 'BASE', 'U?')];
    e.setMarkets([...valid, ...invalid]);
    expect(e.metrics(START).map(row => row.market)).toEqual(valid);
  });
  it('preserves undrained events after display eviction and visibly suppresses new events at the pending bound', () => {
    const e = engine(); const markets = Array.from({ length: 126 }, (_, index) => ({ ...market, key: `futures:Q${index}USDT`, symbol: `Q${index}USDT` }));
    e.setMarkets(markets); e.setConnected(markets.map(row => row.key), true, START);
    const at = START + 5 * MIN;
    for (const current of markets) {
      for (let i = 0; i < 1000; i++) e.ingestTrade(trade(i, at + i, 100, 'buy', { marketKey: current.key }));
      for (let i = 0; i < 40; i++) e.ingestTrade(trade(`event${i}`, at + 1100 + i * (MIN + 1), 200_000, 'buy', { marketKey: current.key }));
    }
    expect(e.events()).toHaveLength(FLOW_RULES.eventLimit);
    expect(e.metrics(at + 42 * MIN).at(-1)?.reason).toContain('队列已满');
    expect(e.drainUpdates().events).toHaveLength(FLOW_RULES.pendingEventLimit);
    expect(e.metrics(at + 42 * MIN).at(-1)?.reason).not.toContain('队列已满');
  }, 20_000);
});
