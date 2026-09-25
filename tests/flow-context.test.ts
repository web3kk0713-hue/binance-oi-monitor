import { describe, expect, it } from 'vitest';
import { selectFlowContext } from '../src/shared/flowContext';
import type { FlowMarket, FlowMetrics, FlowQuote, FlowSnapshot } from '../src/shared/flowTypes';

const NOW = Date.UTC(2026, 8, 24, 12);
const assetId = 'binance:BTC';
function market(changes: Partial<FlowMarket> = {}): FlowMarket {
  return { key: 'futures:BTCUSDT', symbol: 'BTCUSDT', venue: 'futures', baseAsset: 'BTC', quoteAsset: 'USDT', assetId, ...changes };
}
function quote(changes: Partial<FlowQuote> = {}): FlowQuote {
  return { marketKey: 'futures:BTCUSDT', markPrice: 60_000, indexPrice: 60_000, fundingRate: 0.0001,
    fundingIntervalHours: 8, nextFundingTime: NOW + 3_600_000, timestamp: NOW - 2000, receivedAt: NOW - 1000, ...changes };
}
function row(changes: Partial<FlowMetrics> = {}): FlowMetrics {
  return { market: market(), asOf: NOW, status: 'live', reason: '', price: 60_000, priceChange5m: 1.2,
    volume5m: 100_000, buyShare5m: 60, delta5m: 20_000, volumeMultiple: 2, vwap5m: 60_000,
    range5mPct: 1.5, atr14: 100, oiChange5m: 2, funding: quote(), depth: null,
    baselineWindows: 12, tradeSamples: 1000, largeTradeThreshold: 100_000,
    lastTradeAt: NOW - 1000, lastCandleAt: NOW - 2000, ...changes };
}
function snapshot(rows: FlowMetrics[], asOf = NOW): FlowSnapshot {
  return { schemaVersion: 1, rows, events: [], status: { mode: 'direct', startedAt: NOW - 3_600_000, asOf,
    connectedStreams: 1, totalStreams: 1, markets: rows.length, readyMarkets: rows.length,
    warmingMarkets: 0, staleMarkets: 0, backfilledMarkets: rows.length, errors: [], retentionDays: 7, scope: '' } };
}
function select(changes: Partial<FlowMetrics> = {}) {
  return selectFlowContext(snapshot([row(changes)]), assetId, NOW).futures!;
}
const unavailable = { buyShare5m: null, delta5m: null, priceChange5m: null, oiChange5m: null,
  windowStart: null, windowEnd: null, fundingRate: null, fundingIntervalHours: null, nextFundingTime: null };

describe('single-asset, single-market confirmation context', () => {
  it('requires an exact asset identity and keeps a missing venue empty', () => {
    const data = snapshot([row()]);
    expect(selectFlowContext(null, assetId, NOW)).toEqual({ futures: null, spot: null });
    expect(selectFlowContext(data, undefined, NOW)).toEqual({ futures: null, spot: null });
    expect(selectFlowContext(data, 'BTC', NOW)).toEqual({ futures: null, spot: null });
    expect(selectFlowContext(data, 'binance:ETH', NOW, 'futures:BTCUSDT')).toEqual({ futures: null, spot: null });
    expect(selectFlowContext(data, assetId, NOW).spot).toBeNull();
  });

  it('preserves valid positive, zero and negative values without currency conversion or summing', () => {
    expect(select()).toMatchObject({ marketKey: 'futures:BTCUSDT', symbol: 'BTCUSDT', quoteAsset: 'USDT',
      asOf: NOW, buyShare5m: 60, delta5m: 20_000, priceChange5m: 1.2, fundingRate: 0.0001,
      fundingIntervalHours: 8, nextFundingTime: NOW + 3_600_000 });
    expect(select({ buyShare5m: 0, delta5m: 0, priceChange5m: 0, funding: quote({ fundingRate: 0 }) }))
      .toMatchObject({ buyShare5m: 0, delta5m: 0, priceChange5m: 0, fundingRate: 0 });
    expect(select({ buyShare5m: 100, delta5m: -20_000, priceChange5m: -1, funding: quote({ fundingRate: -0.0001 }) }))
      .toMatchObject({ buyShare5m: 100, delta5m: -20_000, priceChange5m: -1, fundingRate: -0.0001 });
  });

  it('uses deterministic USDT > USDC > remaining quote order, independently by venue', () => {
    const pair = (quoteAsset: string, venue: 'spot' | 'futures') => row({
      market: market({ key: `${venue}:BTC${quoteAsset}`, symbol: `BTC${quoteAsset}`, quoteAsset, venue }), funding: null,
      delta5m: quoteAsset === 'USDT' ? 100 : 200,
    });
    const rows = [pair('USD1', 'futures'), pair('USDC', 'futures'), pair('USDT', 'futures'), pair('USDC', 'spot'), pair('USDT', 'spot')];
    expect(selectFlowContext(snapshot(rows), assetId, NOW)).toMatchObject({
      futures: { marketKey: 'futures:BTCUSDT', quoteAsset: 'USDT', delta5m: 100 },
      spot: { marketKey: 'spot:BTCUSDT', quoteAsset: 'USDT', delta5m: 100 },
    });
    expect(selectFlowContext(snapshot([...rows].reverse()), assetId, NOW)).toEqual(selectFlowContext(snapshot(rows), assetId, NOW));
    expect(selectFlowContext(snapshot(rows.filter(item => item.market.quoteAsset !== 'USDT')), assetId, NOW).futures?.quoteAsset).toBe('USDC');
    expect(selectFlowContext(snapshot([pair('USD1', 'futures'), pair('BTC', 'futures')]), assetId, NOW).futures?.quoteAsset).toBe('BTC');
  });

  it('respects an explicit preferred pair only in its own asset and venue', () => {
    const usdc = row({ market: market({ key: 'futures:BTCUSDC', symbol: 'BTCUSDC', quoteAsset: 'USDC' }), funding: null });
    const eth = row({ market: market({ key: 'futures:ETHUSDT', symbol: 'ETHUSDT', assetId: 'binance:ETH', baseAsset: 'ETH' }) });
    const spot = row({ market: market({ key: 'spot:BTCUSDT', venue: 'spot' }), funding: null });
    const data = snapshot([row(), usdc, eth, spot]);
    expect(selectFlowContext(data, assetId, NOW, usdc.market.key)).toMatchObject({
      futures: { marketKey: usdc.market.key }, spot: { marketKey: spot.market.key },
    });
    expect(selectFlowContext(data, assetId, NOW, eth.market.key).futures?.marketKey).toBe('futures:BTCUSDT');
  });

  it('prioritizes fresh live alternatives when no selected pair is given, but never hides a stale explicit selection', () => {
    const stale = row({ status: 'stale' });
    const warm = row({ market: market({ key: 'futures:BTCUSDC', symbol: 'BTCUSDC', quoteAsset: 'USDC' }), status: 'warming', funding: null });
    const live = row({ market: market({ key: 'futures:BTCUSD1', symbol: 'BTCUSD1', quoteAsset: 'USD1' }), funding: null });
    const data = snapshot([stale, warm, live]);
    expect(selectFlowContext(data, assetId, NOW).futures?.marketKey).toBe(live.market.key);
    expect(selectFlowContext(data, assetId, NOW, stale.market.key).futures).toMatchObject({ marketKey: stale.market.key, ...unavailable });
    expect(selectFlowContext(snapshot([stale, warm]), assetId, NOW).futures?.marketKey).toBe(warm.market.key);
  });

  it('never leaks futures funding into a spot row', () => {
    const result = selectFlowContext(snapshot([row({ market: market({ key: 'spot:BTCUSDT', venue: 'spot' }) })]), assetId, NOW).spot;
    expect(result).toMatchObject({ buyShare5m: 60, oiChange5m: null, fundingRate: null, fundingIntervalHours: null, nextFundingTime: null });
  });

  it('projects same-contract OI and the engine closed-candle bounds, not the latest candle source stamp', () => {
    expect(select()).toMatchObject({ oiChange5m: 2, windowStart: NOW - 300_000, windowEnd: NOW });
    expect(select({ lastCandleAt: NOW - 59_999 })).toMatchObject({ windowStart: NOW - 300_000, windowEnd: NOW });
    expect(select({ status: 'warming' })).toMatchObject({ oiChange5m: null, windowStart: null, windowEnd: null });
  });
});

describe('freshness and time ordering', () => {
  it.each([0, NaN, Infinity, NOW - 0.5, NOW + 1, NOW - 30_001, undefined])('rejects invalid or stale snapshot timestamp %s', asOf => {
    const data = snapshot([row()]); data.status.asOf = asOf as number;
    const result = selectFlowContext(data, assetId, NOW).futures;
    expect(result).toMatchObject(unavailable);
    expect(result?.reason).toContain('快照时间');
  });

  it.each([0, NaN, Infinity, NOW - 0.5, NOW + 1, NOW - 30_001, undefined])('rejects invalid or stale row timestamp %s', asOf => {
    const result = select({ asOf: asOf as number });
    expect(result).toMatchObject(unavailable);
    expect(Number.isFinite(result.asOf)).toBe(true);
  });

  it.each([0, NaN, Infinity, NOW - 0.5, undefined])('rejects invalid caller time %s', now => {
    expect(selectFlowContext(snapshot([row()]), assetId, now as number).futures).toMatchObject(unavailable);
  });

  it('rejects observations newer than the snapshot and checks exact inclusive time boundaries', () => {
    expect(selectFlowContext(snapshot([row()], NOW - 1), assetId, NOW).futures).toMatchObject(unavailable);
    expect(selectFlowContext(snapshot([row({ asOf: NOW - 30_000, lastCandleAt: NOW - 90_000, funding: null })], NOW - 30_000), assetId, NOW)
      .futures).toMatchObject({ buyShare5m: 60, delta5m: 20_000 });
  });

  it.each(['stale', 'disconnected'] as const)('suppresses copied values for %s rows', status => {
    const result = select({ status });
    expect(result).toMatchObject(unavailable);
    expect(result.reason).not.toBe('');
  });

  it.each([0, NaN, Infinity, NOW + 1, NOW - 90_001, null, undefined])('blocks trade metrics on invalid candle time %s', lastCandleAt => {
    const result = select({ lastCandleAt: lastCandleAt as number | null });
    expect(result).toMatchObject({ buyShare5m: null, delta5m: null, priceChange5m: null, fundingRate: 0.0001 });
    expect(result.reason).toContain('K线时间');
  });

  it('does not use candle or funding observations received after row as-of', () => {
    const result = select({ asOf: NOW - 5000 });
    expect(result).toMatchObject(unavailable);
    expect(result.reason).toContain('K线时间');
    expect(result.reason).toContain('资金费率时间');
  });

  it('shows a separately fresh funding observation while trade windows warm', () => {
    const result = select({ status: 'warming' });
    expect(result).toMatchObject({ buyShare5m: null, delta5m: null, priceChange5m: null, fundingRate: 0.0001 });
    expect(result.reason).toContain('预热');
  });
});

describe('metric and funding validation', () => {
  it.each([NaN, Infinity, -Infinity, null, undefined])('suppresses non-finite or missing trade values %s', value => {
    expect(select({ buyShare5m: value as number, delta5m: value as number, priceChange5m: value as number }))
      .toMatchObject({ buyShare5m: null, delta5m: null, priceChange5m: null });
  });

  it.each([-0.001, 100.001])('rejects impossible buy share %s without suppressing other valid metrics', buyShare5m => {
    expect(select({ buyShare5m })).toMatchObject({ buyShare5m: null, delta5m: 20_000, priceChange5m: 1.2 });
  });

  it.each([NaN, Infinity, -Infinity, undefined, null, -100.00001])('rejects invalid OI and impossible percent changes %s', value => {
    expect(select({ oiChange5m: value as number, priceChange5m: value as number }))
      .toMatchObject({ oiChange5m: null, priceChange5m: null });
  });

  it('preserves mathematically valid minus-100 percent endpoints as descriptive context', () => {
    expect(select({ oiChange5m: -100, priceChange5m: -100 })).toMatchObject({ oiChange5m: -100, priceChange5m: -100 });
  });

  it('requires the exact same funding market key', () => {
    const result = select({ funding: quote({ marketKey: 'futures:BTCUSDC' }) });
    expect(result).toMatchObject({ buyShare5m: 60, fundingRate: null, fundingIntervalHours: null, nextFundingTime: null });
    expect(result.reason).toContain('不匹配');
  });

  it.each([
    { timestamp: 0 }, { timestamp: NaN }, { timestamp: undefined }, { timestamp: NOW - 0.5 }, { timestamp: NOW + 1 }, { timestamp: NOW - 90_001 },
    { receivedAt: 0 }, { receivedAt: NaN }, { receivedAt: undefined }, { receivedAt: NOW - 0.5 }, { receivedAt: NOW + 1 }, { receivedAt: NOW - 90_001 },
    { timestamp: NOW - 500, receivedAt: NOW - 1000 },
  ])('rejects stale, future or reversed funding time %j', changes => {
    expect(select({ funding: quote(changes) })).toMatchObject({ buyShare5m: 60, fundingRate: null, fundingIntervalHours: null, nextFundingTime: null });
  });

  it('accepts the funding source age boundary and nulls invalid funding fields independently', () => {
    expect(select({ funding: quote({ timestamp: NOW - 90_000, receivedAt: NOW - 90_000 }) }).fundingRate).toBe(0.0001);
    expect(select({ funding: quote({ fundingRate: NaN }) })).toMatchObject({ fundingRate: null, fundingIntervalHours: 8 });
    expect(select({ funding: quote({ fundingIntervalHours: 0 }) })).toMatchObject({ fundingRate: 0.0001, fundingIntervalHours: null });
    expect(select({ funding: quote({ nextFundingTime: NOW }) })).toMatchObject({ fundingRate: 0.0001, nextFundingTime: null });
    expect(select({ funding: quote({ fundingRate: null, fundingIntervalHours: null, nextFundingTime: null }) }))
      .toMatchObject({ fundingRate: null, fundingIntervalHours: null, nextFundingTime: null });
  });

  it.each([NaN, Infinity, -1, 0, undefined])('does not invent a settlement cycle or time for invalid values %s', value => {
    expect(select({ funding: quote({ fundingIntervalHours: value as number, nextFundingTime: value as number }) }))
      .toMatchObject({ fundingIntervalHours: null, nextFundingTime: null });
  });

  it('does not mutate source snapshots or their row order', () => {
    const data = snapshot([row({ market: market({ key: 'futures:BTCUSDC', quoteAsset: 'USDC' }) }), row()]);
    const original = structuredClone(data);
    selectFlowContext(data, assetId, NOW);
    expect(data).toEqual(original);
  });
});
