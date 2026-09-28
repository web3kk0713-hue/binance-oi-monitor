import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DIRECTION_CONFIG, DIRECTION_PRESETS, type DirectionConfig } from '../src/shared/directionConfig';
import { proposePositionAdvice } from '../src/shared/positionAdvice';
import { createPositionRisk, stepPositionRisk } from '../src/shared/positionRisk';
import type { ManualPosition, PositionMarketFrame } from '../src/shared/positionTypes';

const NOW = Date.UTC(2026, 8, 28, 12);
function position(changes: Partial<ManualPosition> = {}): ManualPosition {
  return { id: 'advice-p1', marketKey: 'futures:TESTUSDT', symbol: 'TESTUSDT', assetId: 'binance:TEST',
    side: 'long', entryPrice: '100', margin: '200', leverage: '5', createdAt: NOW - 60_000, ...changes };
}
function frame(price = '100', changes: Partial<PositionMarketFrame> = {}): PositionMarketFrame {
  return { mark: { marketKey: 'futures:TESTUSDT', markPrice: price, sourceTime: NOW, receivedAt: NOW, source: 'binance-mark-stream' },
    atr: { marketKey: 'futures:TESTUSDT', value: '2', asOf: NOW, lastCandleAt: NOW - 1000 },
    signal: { marketKey: 'futures:TESTUSDT', windowEnd: NOW, asOf: NOW, valid: true, bias: 'long', config: { ...DEFAULT_DIRECTION_CONFIG } },
    ...changes };
}
function advice(p = position(), f = frame(), config: DirectionConfig = DEFAULT_DIRECTION_CONFIG) {
  const result = proposePositionAdvice(p, f, NOW, config);
  expect(result.error).toBeNull(); expect(result.advice).not.toBeNull();
  return result.advice!;
}

describe('position advice numeric basis and loss-aware wording inputs', () => {
  it.each([
    ['long', '110', '106', '118', '114'],
    ['short', '90', '94', '82', '86'],
  ] as const)('uses current-price 2 ATR protection and 2 R target for %s, but PnL from entry', (side, price, stop, target, activation) => {
    const result = advice(position({ side }), frame(price));
    expect(result).toMatchObject({ referencePrice: price, markSourceTime: NOW, atr: '2', currentPnl: '100',
      stopPnl: '60', targetPnl: '180', stopReturnPct: '30', targetReturnPct: '90',
      additionalRisk: '40', additionalRiskPct: '20', targetStillLoss: false,
      plan: { stopPrice: stop, takeProfitPrice: target, trailing: { activationPrice: activation }, method: 'atr-example', generatedAt: NOW } });
    expect(new Decimal(result.referencePrice).minus(result.plan.stopPrice).abs().toString()).toBe('4');
    expect(new Decimal(result.plan.takeProfitPrice).minus(result.referencePrice).abs().toString()).toBe('8');
    const expectedCallback = new Decimal(2).div(activation).mul(100);
    expect(new Decimal(result.plan.trailing!.callbackPct).minus(expectedCallback).abs().lt('0.00001')).toBe(true);
  });
  it('does not confuse a profitable stop with zero additional downside from the current mark', () => {
    const result = advice(position(), frame('110'));
    expect(new Decimal(result.stopPnl).gt(0)).toBe(true);
    expect(result.additionalRisk).toBe('40');
    expect(new Decimal(result.currentPnl).minus(result.stopPnl).toString()).toBe(result.additionalRisk);
    expect(result.additionalRiskPct).toBe('20');
  });
  it.each([
    { side: 'long' as const, entryPrice: '125', margin: '200', leverage: '5', current: '-200', stop: '-232', target: '-136', stopPct: '-116', targetPct: '-68', risk: '32', riskPct: '16' },
    { side: 'short' as const, entryPrice: '80', margin: '200', leverage: '4', current: '-200', stop: '-240', target: '-120', stopPct: '-120', targetPct: '-60', risk: '40', riskPct: '20' },
  ])('flags a %s target that remains below breakeven as loss, not target profit', sample => {
    const result = advice(position(sample));
    expect(result).toMatchObject({ currentPnl: sample.current, stopPnl: sample.stop, targetPnl: sample.target,
      stopReturnPct: sample.stopPct, targetReturnPct: sample.targetPct, additionalRisk: sample.risk,
      additionalRiskPct: sample.riskPct, targetStillLoss: true });
    expect(new Decimal(result.targetPnl).lt(0)).toBe(true); expect(new Decimal(result.targetReturnPct).lt(0)).toBe(true);
  });
  it.each([['long', '108'], ['short', '92']] as const)('keeps exactly breakeven distinct from loss for %s', (side, entryPrice) => {
    const result = advice(position({ side, entryPrice, margin: entryPrice, leverage: '1' }));
    expect(result.targetPnl).toBe('0'); expect(result.targetReturnPct).toBe('0'); expect(result.targetStillLoss).toBe(false);
  });
  it('uses declared entry-based quantity for very small decimal prices without binary rounding', () => {
    const p = position({ entryPrice: '0.0000000001', margin: '0.0001', leverage: '1' });
    const f = frame('0.000000000123'); f.atr!.value = '0.000000000002';
    const result = advice(p, f);
    expect(result).toMatchObject({ referencePrice: '0.000000000123', currentPnl: '0.000023', stopPnl: '0.000019',
      targetPnl: '0.000031', stopReturnPct: '19', targetReturnPct: '31', additionalRisk: '0.000004', additionalRiskPct: '4',
      plan: { stopPrice: '0.000000000119', takeProfitPrice: '0.000000000131' } });
  });
  it('retains the observed source timestamp and normalized current mark in the frozen explanation', () => {
    const f = frame('100.0000'); f.mark!.sourceTime = NOW - 1000;
    const result = advice(position(), f);
    expect(result.referencePrice).toBe('100'); expect(result.markSourceTime).toBe(NOW - 1000);
    expect(result.plan.generatedAt).toBe(NOW); expect(result.atr).toBe('2');
  });
});

describe('advice direction evidence, not an invented trade prediction', () => {
  it.each([
    ['long', 'long', 'aligned'], ['short', 'short', 'aligned'], ['long', 'short', 'opposed'], ['short', 'long', 'opposed'],
    ['long', 'wait', 'wait'], ['short', 'wait', 'wait'],
  ] as const)('labels a %s position with a %s signal as %s', (side, bias, status) => {
    const f = frame(); f.signal!.bias = bias;
    const result = advice(position({ side }), f);
    expect(result.signalStatus).toBe(status); expect(result.signalReason.length).toBeGreaterThan(10);
    if (status === 'aligned') expect(result.signalReason).toContain('不把同向信号当作加仓依据');
    if (status === 'opposed') expect(result.signalReason).toContain('不代表必然反转');
    if (status === 'wait') expect(result.signalReason).toContain('不因观望信号推迟止损');
  });
  it('still provides price protection when signal data is missing, without claiming direction is confirmed', () => {
    const result = advice(position(), frame('100', { signal: null }));
    expect(result.signalStatus).toBe('unavailable'); expect(result.signalReason).toContain('只给价格保护建议');
    expect(result.plan.stopPrice).toBe('96'); expect(result.plan.takeProfitPrice).toBe('108');
  });
  it.each([
    { valid: false }, { valid: undefined }, { valid: 'true' }, { valid: 1 },
    { bias: 'buy' }, { bias: undefined }, { marketKey: 'spot:TESTUSDT' }, { marketKey: 'futures:OTHERUSDT' },
    { asOf: NOW + 1 }, { asOf: NOW - 30_001, windowEnd: NOW - 60_000 }, { asOf: NOW + .5 }, { asOf: NaN },
    { windowEnd: NOW + 60_000 }, { windowEnd: NOW - 1 }, { windowEnd: 0 }, { windowEnd: NaN },
    { windowEnd: NOW - 120_000 }, { windowEnd: NOW - 60_000 },
    { config: null }, { config: {} }, { config: { ...DEFAULT_DIRECTION_CONFIG, oiPct: NaN } },
    { config: { ...DEFAULT_DIRECTION_CONFIG, requireSpot: 'false' } },
    { config: { ...DEFAULT_DIRECTION_CONFIG, oiPct: 6 } }, { config: { ...DEFAULT_DIRECTION_CONFIG, pricePct: .6 } },
    { config: { ...DEFAULT_DIRECTION_CONFIG, flowSharePct: 61 } }, { config: { ...DEFAULT_DIRECTION_CONFIG, requireSpot: true } },
  ])('does not validate malformed, stale, future, mismatched evidence %j', change => {
    const f = frame(); f.signal = { ...f.signal!, ...change } as PositionMarketFrame['signal'];
    const result = advice(position(), f);
    expect(result.signalStatus).toBe('unavailable'); expect(result.signalReason).toContain('不判断持仓方向是否有利');
  });
  it('accepts a valid signal exactly 30 seconds old with a coherent minute endpoint', () => {
    const f = frame(); f.signal = { ...f.signal!, asOf: NOW - 30_000, windowEnd: NOW - 60_000 };
    expect(advice(position(), f).signalStatus).toBe('aligned');
  });
  it.each(Object.entries(DIRECTION_PRESETS))('requires and retains matching %s direction configuration', (_name, config) => {
    const f = frame(); f.signal!.config = { ...config };
    const result = advice(position(), f, config);
    expect(result.signalStatus).toBe('aligned'); expect(result.plan.directionConfig).toEqual(config);
  });
});

describe('no advice without valid same-contract price and volatility observations', () => {
  it.each([
    null, { source: 'last-trade' }, { marketKey: 'spot:TESTUSDT' }, { marketKey: 'futures:OTHERUSDT' },
    { sourceTime: NOW - 15_001 }, { receivedAt: NOW + 1 }, { sourceTime: NOW + 1 },
    { sourceTime: NOW, receivedAt: NOW - 1 }, { sourceTime: NaN }, { receivedAt: undefined },
    { markPrice: '0' }, { markPrice: '-1' }, { markPrice: 'NaN' }, { markPrice: '1e101' },
  ])('refuses missing, stale, future or corrupt marks %j', change => {
    const f = frame(); f.mark = change === null ? null : { ...f.mark!, ...change } as PositionMarketFrame['mark'];
    const result = proposePositionAdvice(position(), f, NOW, DEFAULT_DIRECTION_CONFIG);
    expect(result.advice).toBeNull(); expect(result.error).toContain('标记价');
  });
  it.each([
    null, { marketKey: 'futures:OTHERUSDT' }, { marketKey: 'spot:TESTUSDT' },
    { value: '0' }, { value: '-1' }, { value: 'NaN' }, { value: '1e101' }, { value: 2 },
    { asOf: NOW - 30_001 }, { asOf: NOW + 1 }, { asOf: NaN }, { lastCandleAt: NOW - 90_001 },
    { lastCandleAt: NOW + 1 }, { lastCandleAt: 0 },
  ])('refuses missing, stale, future or corrupt ATR %j', change => {
    const f = frame(); f.atr = change === null ? null : { ...f.atr!, ...change } as PositionMarketFrame['atr'];
    const result = proposePositionAdvice(position(), f, NOW, DEFAULT_DIRECTION_CONFIG);
    expect(result.advice).toBeNull(); expect(result.error).toContain('ATR');
  });
  it.each([['binance-mark-stream', 15_000], ['binance-premium-rest', 45_000]] as const)('accepts the inclusive %s freshness limit without treating older data as live', (source, age) => {
    const f = frame(); f.mark = { ...f.mark!, source, sourceTime: NOW - age, receivedAt: NOW - age };
    expect(advice(position(), f).markSourceTime).toBe(NOW - age);
    f.mark.sourceTime--;
    expect(proposePositionAdvice(position(), f, NOW, DEFAULT_DIRECTION_CONFIG).advice).toBeNull();
  });
  it('accepts inclusive ATR observation/candle freshness limits', () => {
    const f = frame(); f.atr = { ...f.atr!, asOf: NOW - 30_000, lastCandleAt: NOW - 90_000 };
    expect(advice(position(), f).atr).toBe('2');
  });
  it.each(['long', 'short'] as const)('does not generate invalid nonpositive protection/target prices for %s', side => {
    const f = frame(); f.atr!.value = '100';
    const result = proposePositionAdvice(position({ side }), f, NOW, DEFAULT_DIRECTION_CONFIG);
    expect(result.advice).toBeNull(); expect(result.error).not.toBeNull();
  });
  it.each([{ entryPrice: '0' }, { margin: '-1' }, { leverage: '126' }, { side: 'buy' }, { createdAt: NOW + 1 }])('rejects invalid position inputs %j', changes => {
    const result = proposePositionAdvice(position(changes as Partial<ManualPosition>), frame(), NOW, DEFAULT_DIRECTION_CONFIG);
    expect(result.advice).toBeNull(); expect(result.error).not.toBeNull();
  });
  it.each([null, {}, { ...DEFAULT_DIRECTION_CONFIG, oiPct: 0 }, { ...DEFAULT_DIRECTION_CONFIG, requireSpot: 1 }])('rejects invalid analysis configuration %j', config => {
    const result = proposePositionAdvice(position(), frame(), NOW, config as DirectionConfig);
    expect(result.advice).toBeNull(); expect(result.error).not.toBeNull();
  });
});

describe('advice remains a side-effect-free, unaccepted proposal', () => {
  it('does not mutate the position, market observations, direction config, or draft risk state', () => {
    const p = position(), f = frame(), config = { ...DEFAULT_DIRECTION_CONFIG }, state = createPositionRisk(p);
    const before = structuredClone({ p, f, config, state });
    const result = advice(p, f, config);
    expect({ p, f, config, state }).toEqual(before);
    expect(state).toMatchObject({ phase: 'draft', plan: null, fired: [], trailingActive: false });
    expect(result.plan).not.toHaveProperty('confirmedAt'); expect(result.plan).not.toHaveProperty('revision');
    const crossed = stepPositionRisk(state, { type: 'tick', frame: frame('90'), now: NOW });
    expect(crossed.events).toEqual([]); expect(crossed.state.phase).toBe('draft'); expect(crossed.state.plan).toBeNull();
  });
  it('copies configuration and numeric explanation so later source changes cannot silently change displayed advice', () => {
    const p = position(), f = frame(), config = { ...DEFAULT_DIRECTION_CONFIG }, result = advice(p, f, config);
    const original = structuredClone(result);
    p.entryPrice = '999'; f.mark!.markPrice = '1'; f.atr!.value = '999'; f.signal!.bias = 'short'; config.oiPct = 50;
    expect(result).toEqual(original); expect(result.plan.directionConfig).not.toBe(config);
  });
  it('returns independent proposals on repeat analysis, without reusing mutable output', () => {
    const first = advice(), second = advice();
    expect(first).toEqual(second); expect(first).not.toBe(second); expect(first.plan).not.toBe(second.plan);
    first.plan.stopPrice = '1'; first.plan.directionConfig.oiPct = 50;
    expect(second.plan.stopPrice).toBe('96'); expect(second.plan.directionConfig.oiPct).toBe(5);
  });
});
