import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { aggregateStructureCandles, proposeStructureAdvice, validateStructureHistory } from '../src/shared/structureAdvice';
import { STRUCTURE_INTERVAL_MS as STEP, STRUCTURE_LOOKBACK_MS as LOOKBACK, type StructureCandle, type StructureInput } from '../src/shared/structureTypes';
import { structureFixture as fixture, STRUCTURE_TEST_NOW as NOW } from './structure-fixture';

const D = Decimal.clone({ precision: 80 });
function ready(input = fixture()) {
  const result = proposeStructureAdvice(input);
  expect(result.status, JSON.stringify(result)).toBe('ready');
  if (result.status !== 'ready') throw new Error(result.reason);
  return result.advice;
}

describe('strict structure history and closed UTC aggregation', () => {
  it('validates an exact history envelope without mutating it', () => {
    const input = fixture(), original = structuredClone(input.history);
    expect(validateStructureHistory(input.history)).toBe(true);
    const bars = aggregateStructureCandles(input.history.candles, 900_000);
    expect(bars).toHaveLength(672);
    expect(bars[0]).toEqual({ openTime: NOW - LOOKBACK, closeTime: NOW - LOOKBACK + 899_999, open: '100', high: '101', low: '99', close: '100' });
    expect(input.history).toEqual(original);
  });
  it('drops incomplete leading and trailing aggregation buckets, never fills them', () => {
    const bars = fixture().history.candles.slice(1, -1);
    const result = aggregateStructureCandles(bars, 900_000);
    expect(result).toHaveLength(670);
    expect(result[0].openTime % 900_000).toBe(0);
    expect(result.at(-1)!.closeTime).toBe(NOW - 900_000 - 1);
  });
  it.each([null, { intervalMs: 60_000 }, { schemaVersion: 2 }, { marketKey: 'spot:BTCUSDT' }, { symbol: 'BTCUSDC' },
    { tickSize: '0' }, { tickSize: 'NaN' }, { tickSize: '1e99999' }, { tickSize: 0.1 }, { from: NOW - LOOKBACK + 1 },
    { to: NOW + STEP }, { fetchedAt: NOW - 1 }, { candles: [] }])('rejects malformed envelope %j', changes => {
    const input = fixture().history;
    expect(validateStructureHistory(changes === null ? null : { ...input, ...changes })).toBe(false);
  });
  it.each([{ high: '99' }, { low: '101' }, { low: '-1' }, { close: 'Infinity' }, { open: '0x10' }, { high: '1e101' },
    { closeTime: NOW }, { openTime: NOW + .5 }])('rejects malformed candle %j', changes => {
    const input = fixture().history;
    input.candles[30] = { ...input.candles[30], ...changes };
    expect(validateStructureHistory(input)).toBe(false);
    expect(aggregateStructureCandles(input.candles, 900_000)).toEqual([]);
  });
  it.each(['missing', 'duplicate', 'reverse'])('rejects %s bars rather than repairing history', type => {
    const input = fixture().history;
    if (type === 'missing') input.candles.splice(30, 1);
    else if (type === 'duplicate') input.candles[30] = input.candles[29];
    else input.candles.reverse();
    expect(validateStructureHistory(input)).toBe(false);
  });
  it('rejects sparse arrays without throwing or skipping missing rows', () => {
    const input = fixture().history; delete input.candles[0];
    expect(() => validateStructureHistory(input)).not.toThrow();
    expect(validateStructureHistory(input)).toBe(false);
    expect(aggregateStructureCandles(input.candles, 900_000)).toEqual([]);
  });
  it.each([0, NaN, Infinity, -1, 60_000, 450_000, 172_800_000])('rejects aggregation interval %s', interval => {
    expect(aggregateStructureCandles(fixture().history.candles, interval)).toEqual([]);
  });
});

describe('research-only structural proposals', () => {
  it('proposes a long from confirmed support with ATR buffer and sequential resistance targets', () => {
    const input = fixture(), original = structuredClone(input), advice = ready(input);
    expect(advice).toMatchObject({ version: 'structure-v1', mode: 'live', asOf: NOW, generatedAt: NOW,
      atr15: '2', buffer: '0.5', quantity: '10', currentPnl: '0', additionalRisk: '25', additionalRiskPct: '25', remainingRewardRisk: '2.2',
      stop: { price: '97.5', structurePrice: '98', pnl: '-25' }, target1: { price: '105.5', structurePrice: '106', pnl: '55' },
      target2: { price: '109.5', structurePrice: '110', pnl: '95' } });
    expect(advice.historyTo).toBeLessThanOrEqual(advice.asOf);
    expect(advice.stop.confirmedAt).toBeLessThanOrEqual(advice.asOf);
    expect(advice.trends.map(value => value.interval)).toEqual(['5m', '15m', '1h', '4h']);
    expect(advice.trends.every(value => value.to! <= advice.asOf && value.direction === 'flat')).toBe(true);
    expect(advice).not.toHaveProperty('stopPrice'); expect(advice).not.toHaveProperty('method');
    input.position.margin = '999'; expect(advice.position.margin).toBe(original.position.margin);
  });
  it('mirrors risk, targets and signed PnL for short positions', () => {
    expect(ready(fixture('short'))).toMatchObject({ remainingRewardRisk: '2.2', additionalRisk: '25',
      stop: { price: '102.5', structurePrice: '102', pnl: '-25' }, target1: { price: '94.5', structurePrice: '94', pnl: '55' },
      target2: { price: '90.5', structurePrice: '90', pnl: '95' } });
  });
  it.each(['long', 'short'] as const)('retains precise non-binary decimal values for %s', side => {
    const input = fixture(side), shift = '0.0000000000000000001';
    for (const bar of input.history.candles) for (const key of ['open', 'high', 'low', 'close'] as const) bar[key] = new D(bar[key]).plus(shift).div(1000).toFixed();
    input.history.tickSize = '0.0000000000000000000001';
    input.reference.markPrice = new D(100).plus(shift).div(1000).toFixed();
    input.position.entryPrice = input.reference.markPrice; input.position.margin = '.3'; input.position.leverage = '7';
    const advice = ready(input), expectedStop = new D(side === 'long' ? '97.5' : '102.5').plus(shift).div(1000);
    expect(advice.stop.price).toBe(expectedStop.toFixed());
    expect(new D(advice.quantity).mul(input.position.entryPrice).minus('2.1').abs().lt('1e-75')).toBe(true);
    expect(advice.remainingRewardRisk).toBe('2.2');
  });
  it.each(['long', 'short'] as const)('rounds %s stop and targets conservatively to tick before computing RR', side => {
    const input = fixture(side); input.history.tickSize = '.3';
    const advice = ready(input);
    for (const value of [advice.stop.price, advice.target1.price, advice.target2!.price]) expect(new D(value).mod('.3').isZero()).toBe(true);
    if (side === 'long') {
      expect(advice.stop.price).toBe('97.2'); expect(advice.target1.price).toBe('105.3');
    } else {
      expect(advice.stop.price).toBe('102.6'); expect(advice.target1.price).toBe('94.8');
    }
    expect(new D(advice.remainingRewardRisk).gte('1.2')).toBe(true);
  });
  it.each(['long', 'short'] as const)('identifies a %s target that remains below break-even', side => {
    const input = fixture(side); input.position.entryPrice = side === 'long' ? '110' : '90';
    const advice = ready(input);
    expect(new D(advice.target1.pnl).lt(0)).toBe(true);
    expect(advice.warnings.join(' ')).toContain('减亏');
    const expected = new D(advice.target1.price).minus(input.position.entryPrice).mul(advice.quantity).mul(side === 'long' ? 1 : -1);
    expect(advice.target1.pnl).toBe(expected.toFixed());
  });
  it('omits TP2 when there is no second distinct opposing barrier', () => {
    const input = fixture(); input.history.candles.at(-210)!.high = '101';
    expect(ready(input).target2).toBeNull();
  });
  it('uses the 2-tick floor when recent ATR is zero but older confirmed structures remain valid', () => {
    const input = fixture();
    for (const bar of input.history.candles.slice(-45)) Object.assign(bar, { open: '100', high: '100', low: '100', close: '100' });
    expect(ready(input)).toMatchObject({ atr15: '0', buffer: '0.2', stop: { price: '97.8' }, target1: { price: '105.8' } });
  });
  it.each([
    { margin: '1e100', entryPrice: '1e-100' },
    { margin: '1e-100', entryPrice: '1e100' },
    { margin: '1e100', entryPrice: '.1' },
  ])('rejects otherwise valid inputs whose derived decimals exceed the persisted domain %j', change => {
    const input = fixture(); Object.assign(input.position, change);
    expect(proposeStructureAdvice(input)).toMatchObject({ status: 'unavailable', code: 'invalid', reason: expect.stringContaining('安全保存范围') });
  });
  it('rejects nearest barrier inside the buffer rather than skipping to a farther target', () => {
    const input = fixture(); input.history.candles.at(-120)!.high = '100.4'; input.history.candles.at(-120)!.low = '99';
    // Neighbor highs must be smaller for a strict pivot, while preserving valid bodies.
    for (let index = input.history.candles.length - 126; index < input.history.candles.length - 111; index++) input.history.candles[index].high = '100.1';
    input.history.candles.at(-120)!.high = '100.4';
    expect(proposeStructureAdvice(input)).toMatchObject({ status: 'unavailable', code: 'space' });
  });
  it('rejects insufficient nearest-target RR even when a farther target could pass', () => {
    const input = fixture(); input.history.candles.at(-180)!.high = '102';
    expect(proposeStructureAdvice(input)).toMatchObject({ status: 'unavailable', code: 'space' });
  });
  it('accepts the exact 1.2 RR boundary but rejects a tick below it', () => {
    const input = fixture(); input.history.candles.at(-180)!.high = '103.5';
    expect(ready(input).remainingRewardRisk).toBe('1.2');
    input.history.candles.at(-180)!.high = '103.499999999999999999';
    expect(proposeStructureAdvice(input)).toMatchObject({ status: 'unavailable', code: 'space' });
  });
  it('rechecks RR after adverse tick rounding, never only before it', () => {
    const input = fixture(); input.history.tickSize = '.3'; input.history.candles.at(-180)!.high = '104';
    // Before rounding: risk=2.6, reward=3.4. After: risk=2.8, reward=3.2, below 1.2.
    expect(proposeStructureAdvice(input)).toMatchObject({ status: 'unavailable', code: 'space' });
  });
  it('rejects a support breached after confirmation rather than reusing its attractive price', () => {
    const input = fixture();
    for (let offset = 90; offset >= 88; offset--) Object.assign(input.history.candles.at(-offset)!, { low: '96', close: '97' });
    expect(ready(input).stop.structurePrice).toBe('96');
  });
  it('does not count equal-height plateaus as strict confirmed pivots', () => {
    const input = fixture(); input.history.candles.at(-147)!.low = '98';
    expect(proposeStructureAdvice(input)).toMatchObject({ status: 'unavailable', code: 'structure' });
  });
  it('does not fabricate a fixed-percent fallback when there are no structures', () => {
    const input = fixture(); for (const bar of input.history.candles) { bar.high = '101'; bar.low = '99'; }
    expect(proposeStructureAdvice(input)).toMatchObject({ status: 'unavailable', code: 'structure' });
  });
});

describe('causal timing and input isolation', () => {
  it('ignores future bars in a replay history, including bars which later invalidate a support', () => {
    const base = fixture(); base.mode = 'replay'; base.now += 86_400_000;
    const future = structuredClone(base), added: StructureCandle[] = Array.from({ length: 288 }, (_, index) => ({ openTime: NOW + index * STEP,
      closeTime: NOW + (index + 1) * STEP - 1, open: '50', high: '60', low: '40', close: '50' }));
    future.history.candles.push(...added); future.history.to += 86_400_000; future.history.fetchedAt = base.now;
    expect(ready(future)).toEqual(ready(base));
  });
  it('waits for both right-side 15m bars before accepting a pivot', () => {
    const input = fixture(); input.history.candles.at(-150)!.low = '99'; input.history.candles.at(-6)!.low = '98';
    expect(proposeStructureAdvice(input)).toMatchObject({ status: 'unavailable', code: 'structure' });
    // The same trailing low becomes confirmed only when a second right-hand closed bar is present.
    input.history.candles.at(-6)!.low = '99'; input.history.candles.at(-9)!.low = '98';
    expect(ready(input).stop.confirmedAt).toBe(NOW - 1);
  });
  it('requires the latest closed 5m candle and full trailing seven days', () => {
    const input = fixture(); input.history.candles.shift(); input.history.from += STEP;
    expect(validateStructureHistory(input.history)).toBe(true);
    expect(proposeStructureAdvice(input)).toMatchObject({ status: 'unavailable', code: 'history' });
    const stale = fixture(); stale.now += STEP; stale.reference.sourceTime += STEP; stale.reference.receivedAt += STEP;
    expect(proposeStructureAdvice(stale)).toMatchObject({ status: 'unavailable', code: 'history' });
  });
  it.each(['binance-mark-stream', 'binance-premium-rest'] as const)('requires <=15s live reference freshness for %s', source => {
    const input = fixture(); input.reference.source = source; input.now += 15_000;
    expect(proposeStructureAdvice(input).status).toBe('ready');
    input.now++;
    expect(proposeStructureAdvice(input)).toMatchObject({ status: 'unavailable', code: 'stale' });
    input.mode = 'replay'; expect(proposeStructureAdvice(input).status).toBe('ready');
  });
  it.each([{ marketKey: 'spot:BTCUSDT' }, { markPrice: '0' }, { markPrice: 'Infinity' }, { sourceTime: NOW + 1 },
    { receivedAt: NOW + 1 }, { sourceTime: NOW, receivedAt: NOW - 1 }, { source: 'last-trade' }])('rejects invalid mark %j', change => {
    const input = fixture(); Object.assign(input.reference, change);
    expect(proposeStructureAdvice(input).status).toBe('unavailable');
  });
  it.each([{ symbol: 'BTCUSDC' }, { side: 'buy' }, { entryPrice: '-1' }, { margin: '1e9999' }, { leverage: '126' },
    { leverage: '.9' }, { id: '../unsafe' }, { assetId: '<BTC>' }, { createdAt: NOW + 1 }])('rejects invalid position %j', change => {
    const input = fixture(); Object.assign(input.position, change);
    expect(proposeStructureAdvice(input)).toMatchObject({ status: 'unavailable', code: 'invalid' });
  });
  it('rejects foreign history, future fetch time and position creation after replay asOf', () => {
    const foreign = fixture(); foreign.history.marketKey = 'futures:ETHUSDT'; foreign.history.symbol = 'ETHUSDT';
    expect(proposeStructureAdvice(foreign)).toMatchObject({ status: 'unavailable', code: 'identity' });
    const fetched = fixture(); fetched.history.fetchedAt++;
    expect(proposeStructureAdvice(fetched)).toMatchObject({ status: 'unavailable', code: 'history' });
    const later = fixture(); later.mode = 'replay'; later.now += 1000; later.position.createdAt = NOW + 1;
    expect(proposeStructureAdvice(later)).toMatchObject({ status: 'unavailable', code: 'invalid' });
  });
  it('returns unavailable rather than throwing for malformed external payloads', () => {
    for (const input of [null, {}, { ...fixture(), history: null }, { ...fixture(), reference: null }, { ...fixture(), mode: 'unknown' },
      { ...fixture(), now: NaN }, { ...fixture(), history: { candles: [null] } }]) {
      expect(() => proposeStructureAdvice(input as StructureInput)).not.toThrow();
      expect(proposeStructureAdvice(input as StructureInput).status).toBe('unavailable');
    }
  });
});
