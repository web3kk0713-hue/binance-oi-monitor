import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { proposeMarketPlan, validateMarketPlan } from '../src/shared/marketPlan';
import type { MarketPlan, MarketPlanInput } from '../src/shared/marketPlanTypes';
import { marketPlanFixture as fixture } from './market-plan-fixture';

const D = Decimal.clone({ precision: 80 });
const ready = (input = fixture()) => {
  const result = proposeMarketPlan(input);
  expect(result.status, JSON.stringify(result)).toBe('ready');
  if (result.status !== 'ready') throw new Error(result.reason);
  return result.plan;
};

describe('independent structure entry proposals', () => {
  it('uses real market identity without a fictitious position and freezes an independently restorable long plan', () => {
    const input = fixture(), original = structuredClone(input), plan = ready(input);
    expect(plan).toMatchObject({ version: 'entry-structure-v1', id: 'entry-test', side: 'long', entryLow: '98.5', entryHigh: '99',
      stopPrice: '97.5', targetPrice: '105.5', support: { price: '98' }, resistance: { price: '106' }, atr15: '2', buffer: '0.5', roundTripCostBps: 12 });
    expect(plan.netRewardRisk).toBe(new D('6.5').minus('.1188').div(new D('1.5').plus('.1188')).toFixed());
    expect(plan.waitUntil).toBe(plan.generatedAt + 1_800_000);
    expect(validateMarketPlan(JSON.parse(JSON.stringify(plan)))).toBe(true);
    expect(input).toEqual(original); expect(plan).not.toHaveProperty('position');
    input.market.assetId = 'changed'; input.directionConfig.oiPct = 20;
    expect(plan.market.assetId).toBe('binance:BTC'); expect(plan.directionConfig.oiPct).toBe(5);
    expect(plan.reasons.join(' ')).toContain('未验证盈利'); expect(plan.reasons.join(' ')).toContain('未计资金费');
  });
  it('mirrors the short zone and uses its lower, worst sell price for net reward/risk', () => {
    const plan = ready(fixture('short'));
    expect(plan).toMatchObject({ entryLow: '101', entryHigh: '101.5', stopPrice: '102.5', targetPrice: '94.5',
      support: { price: '94' }, resistance: { price: '102' } });
    expect(plan.netRewardRisk).toBe(new D('6.5').minus('.1212').div(new D('1.5').plus('.1212')).toFixed());
  });
  it.each(['long', 'short'] as const)('rounds %s entry adversely and exit levels conservatively', side => {
    const input = fixture(side); input.history.tickSize = '.3'; const plan = ready(input);
    expect(plan).toMatchObject(side === 'long' ? { entryLow: '98.7', entryHigh: '99.3', stopPrice: '97.2', targetPrice: '105.3' }
      : { entryLow: '100.8', entryHigh: '101.4', stopPrice: '102.6', targetPrice: '94.8' });
    for (const key of ['entryLow', 'entryHigh', 'stopPrice', 'targetPrice'] as const) expect(new D(plan[key]).mod('.3').isZero()).toBe(true);
  });
  it.each([1_800_000, 3_600_000, 7_200_000, 14_400_000])('accepts explicit holding limit %s', holdingLimitMs => {
    expect(ready({ ...fixture(), holdingLimitMs }).holdingLimitMs).toBe(holdingLimitMs);
  });
  it('uses two ticks when recent true range is zero', () => {
    const input = fixture(); for (const bar of input.history.candles.slice(-45)) Object.assign(bar, { open: '100', high: '100', low: '100', close: '100' });
    expect(ready(input)).toMatchObject({ atr15: '0', buffer: '0.2', entryLow: '98.2', entryHigh: '98.4' });
  });
  it('does not skip the nearest obstacle even when a farther structure is attractive', () => {
    const input = fixture(); input.history.candles.at(-180)!.high = '101.5';
    expect(proposeMarketPlan(input)).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('最近结构空间不足') });
  });
  it('rejects price at target or stop rather than issuing a plan with already crossed protection', () => {
    const input = fixture(); input.reference.markPrice = '105.5';
    expect(proposeMarketPlan(input).status).toBe('unavailable');
    // Near a support, the initial quote can still be below the buy zone; a later confirmed return is required.
    input.reference.markPrice = '98.1'; expect(ready(input).entryLow).toBe('98.5');
  });
  it('rejects support breached by a subsequent fully closed 15-minute bar', () => {
    const input = fixture();
    for (let index = input.history.candles.length - 90; index < input.history.candles.length - 87; index++)
      Object.assign(input.history.candles[index], { open: '97', close: '97', low: '97', high: '101' });
    const result = proposeMarketPlan(input);
    // The original 98 support is no longer a candidate, even if the breach creates a new lower swing.
    if (result.status === 'ready') expect(result.plan.support.price).not.toBe('98');
  });
  it('requires both right-hand closed candles before using a newer swing', () => {
    const input = fixture(); input.history.candles.at(-3)!.low = '98.9';
    expect(ready(input).support.price).toBe('98');
  });
  it('selects exactly seven days and does not let older attractive barriers alter the plan', () => {
    const input = fixture(), original = ready(input), first = input.history.candles[0];
    input.history.candles.unshift({ ...first, openTime: first.openTime - 300_000, closeTime: first.closeTime - 300_000, high: '1000' });
    input.history.from -= 300_000; expect(ready(input)).toEqual(original);
  });
  it('preserves exact decimal prices smaller than normal binary precision', () => {
    const input = fixture(), factor = '1e-20';
    for (const bar of input.history.candles) for (const field of ['open', 'high', 'low', 'close'] as const) bar[field] = new D(bar[field]).mul(factor).toFixed();
    input.reference.markPrice = new D(100).mul(factor).toFixed(); input.history.tickSize = '1e-21';
    const plan = ready(input); expect(plan.entryLow).toBe(new D('98.5').mul(factor).toFixed());
    expect(plan.netRewardRisk).toBe(ready().netRewardRisk);
  });
});

describe('input and persisted-plan fail-closed boundaries', () => {
  it.each([null, { id: '' }, { side: 'buy' }, { now: 0 }, { now: NaN }, { holdingLimitMs: 60_000 }, { directionConfig: {} }, { reference: null }])('rejects invalid input %#', patch => {
    expect(proposeMarketPlan((patch === null ? null : { ...fixture(), ...patch }) as unknown as MarketPlanInput).status).toBe('unavailable');
  });
  it.each([{ venue: 'spot' }, { key: 'futures:ETHUSDT' }, { baseAsset: 'ETH' }, { quoteAsset: 'USDC' }, { symbol: 'BTCUSDC' }, { assetId: '' }])('rejects inconsistent market %j', patch => {
    const input = fixture(); Object.assign(input.market, patch); expect(proposeMarketPlan(input).status).toBe('unavailable');
  });
  it.each([{ markPrice: 'NaN' }, { markPrice: '0x64' }, { markPrice: '1e101' }, { sourceTime: 0 }, { source: 'unknown' }, { marketKey: 'spot:BTCUSDT' }])('rejects invalid quote %j', patch => {
    const input = fixture(); Object.assign(input.reference, patch); expect(proposeMarketPlan(input).status).toBe('unavailable');
  });
  it('accepts exactly 15s freshness and rejects one millisecond older, future or contradictory times', () => {
    const input = fixture(); input.now += 15_000; expect(ready(input).asOf).toBe(input.reference.sourceTime);
    input.now++; expect(proposeMarketPlan(input).status).toBe('unavailable');
    input.now = input.reference.sourceTime - 1; expect(proposeMarketPlan(input).status).toBe('unavailable');
    input.now = input.reference.sourceTime; input.reference.receivedAt--; expect(proposeMarketPlan(input).status).toBe('unavailable');
  });
  it.each(['gap', 'duplicate', 'short', 'future', 'wrong-market'] as const)('rejects %s history', type => {
    const input = fixture();
    if (type === 'gap') input.history.candles.splice(20, 1);
    if (type === 'duplicate') input.history.candles[20] = input.history.candles[19];
    if (type === 'short') { input.history.candles.shift(); input.history.from += 300_000; }
    if (type === 'future') input.history.fetchedAt++;
    if (type === 'wrong-market') input.history.marketKey = 'futures:ETHUSDT';
    expect(proposeMarketPlan(input).status).toBe('unavailable');
  });
  const original = ready();
  it.each([null, { version: 'other' }, { id: '' }, { id: 'a'.repeat(81) }, { side: 'buy' }, { referencePrice: '0' }, { tickSize: '1e999' },
    { atr15: '-2' }, { buffer: '1' }, { entryLow: '98.4' }, { entryHigh: '98.9' }, { stopPrice: '97.4' }, { targetPrice: '109.5' },
    { netRewardRisk: '100' }, { roundTripCostBps: 0 }, { holdingLimitMs: 60_000 }, { waitUntil: original.waitUntil + 1 },
    { asOf: original.asOf + 1 }, { generatedAt: original.generatedAt + 16_000 }, { historyFrom: original.historyFrom + 1 },
    { historyTo: original.historyTo + 1 }, { reasons: [] }, { reasons: new Array(1) }, { reasons: ['x'.repeat(2001)] },
  ])('rejects malformed or inconsistent persisted plan %#', patch => {
    expect(validateMarketPlan(patch === null ? null : { ...original, ...patch })).toBe(false);
  });
  it.each(['support', 'resistance'] as const)('rejects invalid %s timestamps and levels', field => {
    for (const patch of [{ price: 'NaN' }, { price: '100' }, { confirmedAt: original.historyTo + 900_000 }, { confirmedAt: original.historyFrom - 1 }, { confirmedAt: original[field].confirmedAt + 1 }]) {
      const plan = structuredClone(original); Object.assign(plan[field], patch); expect(validateMarketPlan(plan)).toBe(false);
    }
  });
  it('rejects tampered direction parameters and inconsistent catalog identity', () => {
    const plan: MarketPlan = structuredClone(original); plan.directionConfig.requireSpot = 'no' as unknown as boolean;
    expect(validateMarketPlan(plan)).toBe(false); plan.directionConfig = { ...original.directionConfig }; plan.market.key = 'futures:ETHUSDT';
    expect(validateMarketPlan(plan)).toBe(false);
  });
});
