import { describe, expect, it } from 'vitest';
import { assessDirection, DIRECTION_RULES } from '../src/shared/direction';
import type { FlowMetrics, FlowSnapshot } from '../src/shared/flowTypes';

const NOW = Date.UTC(2026, 8, 25, 12, 0, 5);
const END = Math.floor(NOW / 60_000) * 60_000;
const ASSET = 'binance:BTC';
function row(changes: Partial<FlowMetrics> = {}): FlowMetrics {
  return { market: { key: 'futures:BTCUSDT', venue: 'futures', symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', assetId: ASSET },
    asOf: NOW, status: 'live', reason: '', price: 60_000, priceChange5m: 1, volume5m: 100_000,
    buyShare5m: 60, delta5m: 20_000, volumeMultiple: 2, vwap5m: 59_500, range5mPct: 2, atr14: 10, oiChange5m: 5,
    funding: { marketKey: 'futures:BTCUSDT', markPrice: 60_000, indexPrice: 60_000, fundingRate: 0.0001,
      fundingIntervalHours: 8, nextFundingTime: NOW + 3_600_000, timestamp: NOW - 2000, receivedAt: NOW - 1000 },
    depth: null, baselineWindows: 12, tradeSamples: 1000, largeTradeThreshold: 100_000,
    lastTradeAt: NOW - 1000, lastCandleAt: NOW - 2000, ...changes };
}
function spot(changes: Partial<FlowMetrics> = {}): FlowMetrics {
  return row({ market: { key: 'spot:BTCUSDT', venue: 'spot', symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', assetId: ASSET },
    buyShare5m: 55, delta5m: 10_000, funding: null, oiChange5m: null, ...changes });
}
function snapshot(rows = [row()], asOf = NOW): FlowSnapshot {
  return { schemaVersion: 1, rows, events: [], status: { mode: 'direct', startedAt: NOW - 3_600_000, asOf,
    connectedStreams: 1, totalStreams: 1, markets: rows.length, readyMarkets: rows.length, warmingMarkets: 0,
    staleMarkets: 0, backfilledMarkets: rows.length, errors: [], retentionDays: 7, scope: '' } };
}
const assess = (changes: Partial<FlowMetrics> = {}, spotRow?: FlowMetrics) =>
  assessDirection(snapshot([row(changes), ...(spotRow ? [spotRow] : [])]), ASSET, NOW);
const bearish = { priceChange5m: -1, buyShare5m: 40, delta5m: -20_000 };
const bearishSpot = () => spot({ priceChange5m: -1, buyShare5m: 45, delta5m: -10_000 });

describe('experimental fixed-5m direction contract', () => {
  it('produces symmetrical candidates, with explicit missing spot confirmation', () => {
    expect(assess()).toMatchObject({ bias: 'long', label: '偏多候选', confirmation: '待现货确认 · 不宜直接开仓',
      marketKey: 'futures:BTCUSDT', symbol: 'BTCUSDT', asOf: NOW, windowStart: END - 300_000, windowEnd: END, ruleVersion: 'direction-v1' });
    expect(assess(bearish)).toMatchObject({ bias: 'short', label: '偏空候选', confirmation: '待现货确认 · 不宜直接开仓' });
    expect(assess().evidence.join(' ')).toContain('OI +5.00%');
    expect(assess().risks.join(' ')).toContain('未回测');
    expect(assess().risks.join(' ')).toContain('盘口深度');
    expect(assess().invalidation).toContain('低于60%');
    expect(assess(bearish).invalidation).toContain('高于40%');
  });

  it('does not depend on FDV, aggregate OI, user filter windows or future event outcomes', () => {
    const data = snapshot();
    const extended = { ...data, fdvPct: -99, oiToFdvPct: 100_000, windowMinutes: 60,
      position: { oiQuantityPct: -99, pricePct: -99 },
      events: [{ outcomes: [{ minutes: 15, changePct: -99, availableAt: NOW + 900_000 }] }] } as unknown as FlowSnapshot;
    expect(assessDirection(extended, ASSET, NOW)).toEqual(assessDirection(data, ASSET, NOW));
    expect(DIRECTION_RULES.windowMinutes).toBe(5);
  });

  it.each([
    [{ oiChange5m: 4.999999 }, 'wait'], [{ oiChange5m: 5 }, 'long'],
    [{ priceChange5m: 0.5 }, 'wait'], [{ priceChange5m: 0.500001 }, 'long'],
    [{ buyShare5m: 59.999999 }, 'wait'], [{ buyShare5m: 60 }, 'long'],
    [{ ...bearish, priceChange5m: -0.5 }, 'wait'], [{ ...bearish, priceChange5m: -0.500001 }, 'short'],
    [{ ...bearish, buyShare5m: 40.000001 }, 'wait'], [{ ...bearish, buyShare5m: 40 }, 'short'],
  ] as [Partial<FlowMetrics>, string][])('uses unrounded threshold boundaries %j -> %s', (change, bias) => {
    expect(assess(change).bias).toBe(bias);
  });

  it.each([-100, -5, -0.001, 0])('waits for unwinding or absent growth %s, without squeeze attribution', oiChange5m => {
    const result = assess({ oiChange5m });
    expect(result.bias).toBe('wait');
    expect(result.reason).not.toMatch(/轧空|空头回补|多头爆仓/);
  });

  it.each([
    { priceChange5m: 0 }, { priceChange5m: -1 }, { ...bearish, priceChange5m: 1 },
    { buyShare5m: 50, delta5m: 0 }, { buyShare5m: 60, delta5m: 0 },
    { buyShare5m: 60, delta5m: -1 }, { ...bearish, delta5m: 1 },
    { buyShare5m: 50, delta5m: 1 }, { buyShare5m: 50, delta5m: -1 },
  ])('waits for no direction, insufficient pressure or internally inconsistent flow %j', change => {
    expect(assess(change).bias).toBe('wait');
  });
});

describe('spot confirmation, contradiction and matched scope', () => {
  it('requires both price and active trade direction for confirmation', () => {
    expect(assess({}, spot()).confirmation).toBe('现货同向 · 仍需入场确认');
    expect(assess(bearish, bearishSpot()).confirmation).toBe('现货同向 · 仍需入场确认');
    for (const item of [spot({ priceChange5m: 0 }), spot({ buyShare5m: 54.999, delta5m: 9998 })]) {
      expect(assess({}, item)).toMatchObject({ bias: 'long', confirmation: '待现货确认 · 不宜直接开仓' });
    }
  });

  it.each([
    [{ buyShare5m: 45, delta5m: -10_000, priceChange5m: 1 }, {}],
    [{ buyShare5m: 55, delta5m: 10_000, priceChange5m: -0.000001 }, {}],
    [{ buyShare5m: 55, delta5m: 10_000, priceChange5m: -1 }, bearish],
    [{ buyShare5m: 45, delta5m: -10_000, priceChange5m: 0.000001 }, bearish],
  ] as [Partial<FlowMetrics>, Partial<FlowMetrics>][])('vetoes strong opposite spot flow OR opposite price %j', (spotChange, change) => {
    expect(assess(change, spot(spotChange))).toMatchObject({ bias: 'wait', confirmation: '现货与合约冲突' });
  });

  it('uses a verified contrary spot metric even when a different spot metric is missing', () => {
    expect(assess({}, spot({ priceChange5m: -1, buyShare5m: null, delta5m: null })).bias).toBe('wait');
    expect(assess({}, spot({ priceChange5m: null, buyShare5m: 40, delta5m: -20_000 })).bias).toBe('wait');
    expect(assess({}, spot({ priceChange5m: 1, buyShare5m: 40, delta5m: 20_000 })))
      .toMatchObject({ bias: 'long', confirmation: '待现货确认 · 不宜直接开仓' });
  });

  it.each(['stale', 'disconnected', 'warming'] as const)('does not use copied contradictory values from %s spot', status => {
    expect(assess({}, spot({ status, priceChange5m: -10, buyShare5m: 10, delta5m: -10_000 })))
      .toMatchObject({ bias: 'long', confirmation: '待现货确认 · 不宜直接开仓' });
  });

  it('does not confirm or veto across closed-minute boundaries', () => {
    const result = assess({}, spot({ asOf: NOW - 10_000, lastCandleAt: NOW - 11_000,
      priceChange5m: -1, buyShare5m: 40, delta5m: -20_000 }));
    expect(result).toMatchObject({ bias: 'long', confirmation: '待现货确认 · 不宜直接开仓' });
    expect(result.risks.join(' ')).toContain('窗口不同');
  });

  it('never mixes quote assets, and selects a same-quote spot if one exists', () => {
    const otherQuote = spot({ market: { ...spot().market, key: 'spot:BTCUSDC', symbol: 'BTCUSDC', quoteAsset: 'USDC' },
      priceChange5m: -1, buyShare5m: 40, delta5m: -20_000 });
    expect(assess({}, otherQuote)).toMatchObject({ bias: 'long', confirmation: '待现货确认 · 不宜直接开仓' });
    const futureUsdc = row({ market: { ...row().market, key: 'futures:BTCUSDC', symbol: 'BTCUSDC', quoteAsset: 'USDC' }, funding: null });
    const matched = { ...otherQuote, priceChange5m: 1, buyShare5m: 55, delta5m: 10_000 };
    expect(assessDirection(snapshot([futureUsdc, bearishSpot(), matched]), ASSET, NOW, futureUsdc.market.key))
      .toMatchObject({ bias: 'long', confirmation: '现货同向 · 仍需入场确认', marketKey: futureUsdc.market.key });
  });

  it.each(['spot:BTCUSDC', 'spot:NOTFOUND'])('never silently substitutes an explicitly selected unmatched spot %s', preferredMarketKey => {
    const otherQuote = spot({ market: { ...spot().market, key: 'spot:BTCUSDC', symbol: 'BTCUSDC', quoteAsset: 'USDC' } });
    const result = assessDirection(snapshot([row(), spot(), otherQuote]), ASSET, NOW, preferredMarketKey);
    expect(result).toMatchObject({ bias: 'long', confirmation: '待现货确认 · 不宜直接开仓' });
    expect(result.risks.join(' ')).toContain('不替换其他现货');
    expect(result.evidence.join(' ')).not.toContain('现货 BTCUSDT');
  });
});

describe('required data guards and source integrity', () => {
  it.each([null, undefined, NaN, Infinity, -Infinity])('waits on missing or invalid required metrics %s', bad => {
    for (const key of ['oiChange5m', 'priceChange5m', 'buyShare5m', 'delta5m'])
      expect(assess({ [key]: bad }).bias, key).toBe('wait');
  });
  it.each([{ oiChange5m: -100.0001 }, { priceChange5m: -100.0001 }, { buyShare5m: -0.001 }, { buyShare5m: 100.001 }])
    ('rejects impossible values %j', change => expect(assess(change).bias).toBe('wait'));

  it.each(['stale', 'disconnected', 'warming'] as const)('waits when required futures data is %s', status => {
    const result = assess({ status });
    expect(result).toMatchObject({ bias: 'wait', windowStart: null, windowEnd: null });
  });

  it.each([0, undefined, NaN, Infinity, NOW + 1, NOW - 30_001])('rejects invalid/future/stale as-of %s', asOf => {
    expect(assess({ asOf: asOf as number }).bias).toBe('wait');
    const data = snapshot(); data.status.asOf = asOf as number;
    expect(assessDirection(data, ASSET, NOW).bias).toBe('wait');
  });
  it.each([0, undefined, NaN, Infinity, NOW + 1, NOW - 90_001])('rejects invalid/future/stale candle time %s', lastCandleAt => {
    expect(assess({ lastCandleAt: lastCandleAt as number }).bias).toBe('wait');
  });
  it('requires known-at ordering and enforces inclusive freshness boundaries', () => {
    expect(assessDirection(snapshot([row()], NOW - 1), ASSET, NOW).bias).toBe('wait');
    expect(assess({ asOf: NOW - 5000 }).bias).toBe('wait');
    expect(assess({ asOf: NOW - 30_000, lastCandleAt: NOW - 90_000, funding: null }).bias).toBe('long');
  });
  it.each([0, undefined, NaN, Infinity, NOW - 0.5])('rejects invalid caller time %s', now => {
    expect(assessDirection(snapshot(), ASSET, now as number).bias).toBe('wait');
  });

  it('keeps absent, malformed and unrelated assets/venues out of the assessment', () => {
    expect(assessDirection(null, ASSET, NOW).bias).toBe('wait');
    expect(assessDirection(snapshot(), undefined, NOW).bias).toBe('wait');
    expect(assessDirection(snapshot(), 'BTC', NOW).bias).toBe('wait');
    expect(assessDirection(snapshot([spot()]), ASSET, NOW).bias).toBe('wait');
    expect(assessDirection({ schemaVersion: 1, rows: [null, {}, { market: {} }] } as unknown as FlowSnapshot, ASSET, NOW).bias).toBe('wait');
    expect(assessDirection({ ...snapshot(), status: undefined } as unknown as FlowSnapshot, ASSET, NOW).bias).toBe('wait');
    expect(assess({ market: { ...row().market, key: 'spot:BTCUSDT' } }).bias).toBe('wait');
    expect(assess({ market: { ...row().market, quoteAsset: undefined as unknown as string } }).bias).toBe('wait');
  });

  it('does not silently replace a stale or missing explicitly selected contract', () => {
    const alternative = row({ market: { ...row().market, key: 'futures:BTCUSDC', symbol: 'BTCUSDC', quoteAsset: 'USDC' }, funding: null });
    const data = snapshot([row({ status: 'stale' }), alternative]);
    expect(assessDirection(data, ASSET, NOW).marketKey).toBe(alternative.market.key);
    expect(assessDirection(data, ASSET, NOW, 'futures:BTCUSDT').bias).toBe('wait');
    expect(assessDirection(data, ASSET, NOW, 'futures:NOTFOUND').bias).toBe('wait');
  });
});

describe('funding is disclosed risk, not another direction vote', () => {
  it.each([-0.1, 0, 0.1])('does not flip or strengthen direction from funding %s', fundingRate => {
    const funding = { ...row().funding!, fundingRate };
    expect(assess({ funding }).bias).toBe('long');
    expect(assess({ ...bearish, funding }).bias).toBe('short');
    expect(assess({ oiChange5m: 0, funding }).bias).toBe('wait');
  });
  it('does not default unknown funding cycles to eight hours or silently normalize', () => {
    const result = assess({ funding: { ...row().funding!, fundingIntervalHours: null } });
    expect(result.bias).toBe('long');
    expect(result.evidence.join(' ')).toContain('周期未核实');
    expect(result.evidence.join(' ')).not.toContain('/ 8h');
    expect(result.risks.join(' ')).toContain('不归一化');
  });
  it.each([null, { ...row().funding!, timestamp: NOW + 1 }, { ...row().funding!, timestamp: NOW - 90_001 }])
    ('discloses missing/stale/future funding without invalidating complete price and flow %j', funding => {
      const result = assess({ funding });
      expect(result.bias).toBe('long');
      expect(result.risks.join(' ')).toContain('资金费率缺失或过期');
      expect(result.evidence.join(' ')).not.toContain('资金费率 0.0100%');
    });
  it('does not mutate any source row, order, funding or event', () => {
    const data = snapshot([spot(), row()]); const before = structuredClone(data);
    assessDirection(data, ASSET, NOW);
    expect(data).toEqual(before);
  });
});
