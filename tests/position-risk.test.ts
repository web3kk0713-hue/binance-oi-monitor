import { describe, expect, it } from 'vitest';
import { DEFAULT_DIRECTION_CONFIG, DIRECTION_PRESETS } from '../src/shared/directionConfig';
import { createPositionRisk, proposeRiskPlan, stepPositionRisk, validPositionState, valuePosition } from '../src/shared/positionRisk';
import type { ManualPosition, PositionMarketFrame, PositionRiskState, RiskPlanDraft } from '../src/shared/positionTypes';

const NOW = Date.UTC(2026, 8, 25, 12);
const position = (changes: Partial<ManualPosition> = {}): ManualPosition => ({ id: 'p1', marketKey: 'futures:TEST_USDT', symbol: 'TEST_USDT', assetId: 'binance:TEST_',
  side: 'long', entryPrice: '100', margin: '100', leverage: '10', createdAt: NOW - 60_000, ...changes });
function frame(price = '100', now = NOW, changes: Partial<PositionMarketFrame> = {}): PositionMarketFrame {
  return { mark: { marketKey: position().marketKey, markPrice: price, sourceTime: now, receivedAt: now, source: 'binance-mark-stream' },
    atr: { marketKey: position().marketKey, value: '2', asOf: now, lastCandleAt: now - 1000 },
    signal: { marketKey: position().marketKey, windowEnd: Math.floor(now / 60_000) * 60_000, asOf: now, valid: true, bias: 'long', config: { ...DEFAULT_DIRECTION_CONFIG } }, ...changes };
}
const plan = (changes: Partial<RiskPlanDraft> = {}): RiskPlanDraft => ({ stopPrice: '95', takeProfitPrice: '120',
  trailing: { activationPrice: '110', callbackPct: '5' }, signalWeakening: true, directionConfig: { ...DEFAULT_DIRECTION_CONFIG }, method: 'manual', generatedAt: NOW, ...changes });
const shortPlan = () => plan({ stopPrice: '105', takeProfitPrice: '80', trailing: { activationPrice: '90', callbackPct: '5' } });
function arm(p = position(), draft = plan()): PositionRiskState {
  const result = stepPositionRisk(createPositionRisk(p), { type: 'confirm', plan: draft, frame: frame(), now: NOW, expectedPlanRevision: 0 });
  expect(result.error).toBeNull(); expect(validPositionState(result.state)).toBe(true);
  return result.state;
}
const tick = (state: PositionRiskState, price: string, offset: number, changes: Partial<PositionMarketFrame> = {}) =>
  stepPositionRisk(state, { type: 'tick', frame: frame(price, NOW + offset, changes), now: NOW + offset });

describe('manual linear USDT validation and valuation', () => {
  it('creates only draft positions and copies user inputs', () => {
    const input = position(); const result = createPositionRisk(input);
    input.margin = '999';
    expect(result).toMatchObject({ phase: 'draft', plan: null, fired: [], position: { margin: '100' } });
    expect(validPositionState(result)).toBe(true);
    expect(tick(result, '90', 1000).events).toEqual([]);
  });
  it.each([
    { id: '' }, { id: '../x' }, { symbol: 'BTCUSDC' }, { symbol: '<x>USDT' }, { marketKey: 'spot:TEST_USDT' },
    { side: 'buy' }, { entryPrice: '0' }, { entryPrice: '-1' }, { entryPrice: 'NaN' }, { entryPrice: '0x10' },
    { entryPrice: '1e1000000' }, { margin: 'Infinity' }, { margin: '' }, { margin: 100 }, { leverage: '.5' },
    { leverage: '0' }, { leverage: '125.000001' }, { createdAt: 0 }, { createdAt: NOW + .5 }, { assetId: '<BTC>' },
  ])('rejects malformed position %j', change => {
    expect(() => createPositionRisk(position(change as Partial<ManualPosition>))).toThrow();
  });
  it('allows finite opaque asset IDs used by source-verified acceptance fixtures, and the configured leverage ceiling', () => {
    expect(validPositionState(createPositionRisk(position({ assetId: 'synthetic:TEST_LONG', leverage: '125' })))).toBe(true);
  });
  it('estimates long and short PnL from declared entry margin, never an account or liquidation value', () => {
    expect(valuePosition(position(), frame('110'), NOW)).toEqual({ quantity: '10', notional: '1000', pnl: '100', returnOnMarginPct: '100', markPrice: '110' });
    expect(valuePosition(position({ side: 'short' }), frame('90'), NOW)?.pnl).toBe('100');
    expect(valuePosition(position(), frame('90'), NOW)?.returnOnMarginPct).toBe('-100');
    expect(valuePosition(position({ side: 'short' }), frame('110'), NOW)?.pnl).toBe('-100');
  });
  it('retains decimal precision and native 1000-token contract units', () => {
    expect(valuePosition(position({ entryPrice: '.1', margin: '.3', leverage: '7' }), frame('.100000000000000001'), NOW))
      .toMatchObject({ quantity: '21', notional: '2.1', pnl: '0.000000000000000021' });
    const p = position({ symbol: '1000PEPEUSDT', marketKey: 'futures:1000PEPEUSDT', assetId: 'binance:PEPE', entryPrice: '.01', margin: '20', leverage: '5' });
    const f = frame('.011'); f.mark!.marketKey = p.marketKey;
    expect(valuePosition(p, f, NOW)).toMatchObject({ quantity: '10000', notional: '100', pnl: '10' });
  });
  it('enforces separate WS15s/REST45s freshness and source receipt order', () => {
    for (const [source, age] of [['binance-mark-stream', 15_000], ['binance-premium-rest', 45_000]] as const) {
      const f = frame(); f.mark = { ...f.mark!, source, sourceTime: NOW - age, receivedAt: NOW - age };
      expect(valuePosition(position(), f, NOW)).not.toBeNull();
      f.mark.sourceTime--;
      expect(valuePosition(position(), f, NOW)).toBeNull();
    }
    for (const mutation of [{ sourceTime: NOW + 1 }, { receivedAt: NOW + 1 }, { sourceTime: NOW, receivedAt: NOW - 1 },
      { marketKey: 'futures:TEST_USDC' }, { markPrice: '0' }, { source: 'last-trade' }, { sourceTime: NaN }]) {
      expect(valuePosition(position(), frame('100', NOW, { mark: { ...frame().mark!, ...mutation } as PositionMarketFrame['mark'] }), NOW)).toBeNull();
    }
  });
});

describe('explicit volatility draft and confirmation', () => {
  it('proposes symmetric 2ATR protection, 2R target and 1R activation without arming', () => {
    const long = proposeRiskPlan(position(), frame(), NOW, DEFAULT_DIRECTION_CONFIG);
    const short = proposeRiskPlan(position({ side: 'short' }), frame(), NOW, DEFAULT_DIRECTION_CONFIG);
    expect(long.error).toBeNull(); expect(short.error).toBeNull();
    expect(long.plan).toMatchObject({ stopPrice: '96', takeProfitPrice: '108', trailing: { activationPrice: '104' }, method: 'atr-example', generatedAt: NOW });
    expect(short.plan).toMatchObject({ stopPrice: '104', takeProfitPrice: '92', trailing: { activationPrice: '96' } });
    expect(long.plan!.trailing!.callbackPct).toBe('1.92308');
    expect(short.plan!.trailing!.callbackPct).toBe('2.08333');
    expect(createPositionRisk(position()).phase).toBe('draft');
  });
  it('does not invent ATR or silently replace invalid data with a fixed percent', () => {
    for (const atr of [null, { ...frame().atr!, value: '0' }, { ...frame().atr!, value: '100' },
      { ...frame().atr!, asOf: NOW + 1 }, { ...frame().atr!, lastCandleAt: NOW - 90_001 }, { ...frame().atr!, marketKey: 'futures:OTHERUSDT' }]) {
      expect(proposeRiskPlan(position(), frame('100', NOW, { atr }), NOW, DEFAULT_DIRECTION_CONFIG).plan).toBeNull();
    }
    expect(proposeRiskPlan(position(), frame('100', NOW, { mark: null }), NOW, DEFAULT_DIRECTION_CONFIG).plan).toBeNull();
  });
  it('does not round a manually confirmed callback to the suggested draft precision', () => {
    const callbackPct = '1.923076923076923076923076923076923076923';
    const state = arm(position(), plan({ trailing: { activationPrice: '110', callbackPct } }));
    expect(state.plan!.trailing!.callbackPct).toBe(callbackPct);
  });
  it.each(['95', '94', '120', '121'])('blocks confirmation when the current long price %s already crossed a line', price => {
    const result = stepPositionRisk(createPositionRisk(position()), { type: 'confirm', plan: plan(), frame: frame(price), now: NOW, expectedPlanRevision: 0 });
    expect(result.error).toContain('已到达'); expect(result.state.phase).toBe('draft'); expect(result.events).toEqual([]);
  });
  it.each(['105', '106', '80', '79'])('blocks confirmation when the current short price %s already crossed a line', price => {
    expect(stepPositionRisk(createPositionRisk(position({ side: 'short' })), { type: 'confirm', plan: shortPlan(), frame: frame(price), now: NOW, expectedPlanRevision: 0 }).error).toContain('已到达');
  });
  it.each([
    { stopPrice: '0' }, { takeProfitPrice: 'NaN' }, { takeProfitPrice: '94' }, { stopPrice: '121' },
    { generatedAt: NOW + 1 }, { generatedAt: NOW - 60_001 }, { signalWeakening: 'yes' },
    { trailing: { activationPrice: '121', callbackPct: '5' } }, { trailing: { activationPrice: '110', callbackPct: '100' } },
    { trailing: { activationPrice: '110', callbackPct: '0' } }, { directionConfig: {} },
  ])('rejects invalid confirmed draft %j', change => {
    expect(stepPositionRisk(createPositionRisk(position()), { type: 'confirm', plan: plan(change as Partial<RiskPlanDraft>), frame: frame(), now: NOW, expectedPlanRevision: 0 }).error).not.toBeNull();
  });
  it('requires CAS revision, copies confirmation, and makes reread retries idempotent without rearming', () => {
    const draft = plan(); const initial = createPositionRisk(position());
    const confirmed = stepPositionRisk(initial, { type: 'confirm', plan: draft, frame: frame(), now: NOW, expectedPlanRevision: 0 });
    draft.stopPrice = '1'; draft.directionConfig.oiPct = 1;
    expect(confirmed.state.plan).toMatchObject({ stopPrice: '95', directionConfig: { oiPct: 5 }, revision: 1 });
    const fired = tick(confirmed.state, '94', 1000).state;
    expect(stepPositionRisk(fired, { type: 'confirm', plan: plan(), frame: frame('94', NOW + 1000), now: NOW + 1000, expectedPlanRevision: 0 }).error).toContain('版本');
    const retried = stepPositionRisk(fired, { type: 'confirm', plan: plan(), frame: frame('94', NOW + 1000), now: NOW + 1000, expectedPlanRevision: 1 });
    expect(retried.state).toEqual(fired); expect(retried.events).toEqual([]);
    const reordered = plan({ directionConfig: { requireSpot: false, flowSharePct: 60, pricePct: .5, oiPct: 5 } });
    expect(stepPositionRisk(fired, { type: 'confirm', plan: reordered, frame: frame('94', NOW + 1000), now: NOW + 1000, expectedPlanRevision: 1 }).state).toEqual(fired);
    const revised = stepPositionRisk(confirmed.state, { type: 'confirm', plan: plan({ stopPrice: '96' }), frame: frame('100', NOW + 2000), now: NOW + 2000, expectedPlanRevision: 1 });
    expect(revised.state.plan?.revision).toBe(2);
  });
});

describe('latched price risks and explicit closure', () => {
  it.each([['long', '94', 'stop'], ['long', '121', 'take-profit'], ['short', '106', 'stop'], ['short', '79', 'take-profit']] as const)
    ('triggers %s %s %s once and never auto-closes', (side, price, rule) => {
      const state = arm(position({ side }), side === 'long' ? plan({ trailing: null }) : { ...shortPlan(), trailing: null });
      const first = tick(state, price, 1000); expect(first.events.map(e => e.rule)).toEqual([rule]);
      expect(first.state.phase).toBe('triggered'); expect(first.state.closedAt).toBeNull();
      expect(first.events[0].id).toBe(`p1:1:${rule}`);
      expect(tick(first.state, price, 2000).events).toEqual([]);
      expect(validPositionState(first.state)).toBe(true);
      const closed = stepPositionRisk(first.state, { type: 'close', now: NOW + 3000 });
      expect(closed.state.phase).toBe('closed'); expect(tick(closed.state, price, 4000).events).toEqual([]);
    });
  it('activates trailing from observed marks, persists best price through reload, and checks inclusive callback', () => {
    let state = arm(position(), plan({ takeProfitPrice: '150' }));
    state = tick(state, '109', 1000).state; expect(state.trailingActive).toBe(false);
    state = tick(state, '110', 2000).state; expect(state).toMatchObject({ trailingActive: true, bestPrice: '110' });
    state = tick(state, '120', 3000).state;
    state = JSON.parse(JSON.stringify(state)) as PositionRiskState;
    expect(validPositionState(state)).toBe(true);
    expect(tick(state, '114.000000000000000001', 4000).events).toEqual([]);
    const fired = tick(state, '114', 5000);
    expect(fired.events.map(e => e.rule)).toEqual(['trailing']); expect(fired.state.bestPrice).toBe('120');
    expect(tick(fired.state, '113', 6000).events).toEqual([]);
  });
  it('tracks the short-side minimum and starts from the confirmation mark if already activated', () => {
    let state = arm(position({ side: 'short' }), { ...shortPlan(), takeProfitPrice: '50' });
    state = tick(state, '90', 1000).state; state = tick(state, '80', 2000).state;
    expect(tick(state, '84', 3000).events.map(e => e.rule)).toEqual(['trailing']);
    const active = arm(position(), plan({ trailing: { activationPrice: '99', callbackPct: '1' } }));
    expect(active).toMatchObject({ trailingActive: true, bestPrice: '100' });
  });
  it('isolates duplicates, old samples and conflicting equal timestamps', () => {
    const state = arm();
    expect(tick(state, '100', 0).events).toEqual([]);
    const old = frame('94', NOW + 1000); old.mark!.sourceTime = NOW - 1;
    expect(stepPositionRisk(state, { type: 'tick', frame: old, now: NOW + 1000 }).events).toEqual([]);
    const conflict = tick(state, '94', 0);
    expect(conflict.state.gap).toBe(true); expect(conflict.events).toEqual([]); expect(conflict.error).toContain('冲突');
    expect(tick(conflict.state, '100', 0).error).toContain('等待');
    const recovered = tick(conflict.state, '94', 1000);
    expect(recovered.events[0]).toMatchObject({ rule: 'stop', afterGap: true, sourceTime: NOW + 1000 });
  });
  it('does not synthesize crossed prices during a gap; recovery time is explicit', () => {
    const state = arm();
    const stopped = tick(state, '100', 20_000, { mark: null });
    expect(stopped.state.gap).toBe(true); expect(stopped.events).toEqual([]); expect(stopped.valuation).toBeNull();
    const recovered = tick(stopped.state, '94', 21_000);
    expect(recovered.events[0]).toMatchObject({ afterGap: true, timestamp: NOW + 21_000, sourceTime: NOW + 21_000 });
    expect(recovered.events[0].message).toContain('实际首次触发时间未知');
    expect(tick(state, '100', 60_000).events).toEqual([]);
    const rest = frame('94', NOW + 30_000); rest.mark!.source = 'binance-premium-rest';
    expect(stepPositionRisk(state, { type: 'tick', frame: rest, now: NOW + 30_000 }).events[0].afterGap).toBe(true);
  });
});

describe('signal weakness has two distinct valid windows, not missing-data inference', () => {
  function advance(state: PositionRiskState, through: number, signalAt: (offset: number) => PositionMarketFrame['signal']) {
    const events = [];
    for (let offset = 10_000; offset <= through; offset += 10_000) {
      const result = tick(state, '100', offset, { signal: signalAt(offset) }); state = result.state; events.push(...result.events);
    }
    return { state, events };
  }
  const signal = (offset: number, bias: 'long' | 'short' | 'wait') => ({ ...frame('100', NOW + offset).signal!, bias });
  it('does not count repeated polls, and fires once after two consecutive new minute endpoints', () => {
    const state = arm();
    const result = advance(state, 130_000, offset => signal(offset, offset < 60_000 ? 'long' : 'wait'));
    expect(result.events.map(e => e.rule)).toEqual(['signal-weakening']);
    expect(result.events[0].timestamp).toBe(NOW + 120_000);
    expect(validPositionState(result.state)).toBe(true);
  });
  it('requires an aligned baseline and does not confuse quality failure or config mismatch with weakness', () => {
    const state = arm();
    for (const bad of [null, { ...signal(60_000, 'wait'), valid: false },
      { ...signal(60_000, 'wait'), config: { ...DIRECTION_PRESETS.sensitive } }]) {
      const result = advance(state, 180_000, offset => offset < 60_000 ? signal(offset, 'long') : offset < 120_000 ? bad : signal(offset, 'wait'));
      expect(result.events).toEqual([]);
    }
    const short = arm(position({ side: 'short' }), shortPlan());
    expect(advance(short, 180_000, offset => signal(offset, 'long')).events).toEqual([]);
  });
  it('does not advance the signal counter for future, wrong-market or out-of-order windows', () => {
    const state = arm();
    for (const change of [{ windowEnd: NOW + 60_000 }, { asOf: NOW + 60_000 }, { marketKey: 'futures:OTHERUSDT' }]) {
      const result = tick(state, '100', 1000, { signal: { ...signal(1000, 'wait'), ...change } });
      expect(result.state.weakWindows).toBe(0); expect(result.events).toEqual([]);
    }
  });
});

describe('strict persisted-state recovery', () => {
  it('rejects malformed nested plans, decimals, times and transition state', () => {
    const state = arm();
    const cases: unknown[] = [null, {}, [], { ...state, position: { ...state.position, side: 'x' } },
      { ...state, position: { ...state.position, margin: 'Infinity' } }, { ...state, phase: 'draft' },
      { ...state, plan: { ...state.plan, revision: 0 } }, { ...state, plan: { ...state.plan, confirmedAt: NOW - 1 } },
      { ...state, plan: { ...state.plan, directionConfig: {} } }, { ...state, plan: { ...state.plan, stopPrice: '-1' } },
      { ...state, lastMark: null }, { ...state, lastMark: { ...state.lastMark, marketKey: 'futures:OTHERUSDT' } },
      { ...state, lastMark: { ...state.lastMark, sourceTime: NOW + 1 } }, { ...state, fired: ['stop', 'stop'] },
      { ...state, phase: 'triggered' }, { ...state, phase: 'closed', closedAt: null }, { ...state, weakWindows: 3 },
      { ...state, trailingActive: true, bestPrice: '1' }, { ...state, bestPrice: '110' },
    ];
    for (const item of cases) expect(validPositionState(item), JSON.stringify(item)).toBe(false);
  });
  it('never mutates previous state, command draft, observations or config', () => {
    const state = arm(); const before = structuredClone(state), data = frame('94', NOW + 1000), original = structuredClone(data);
    stepPositionRisk(state, { type: 'tick', frame: data, now: NOW + 1000 });
    expect(state).toEqual(before); expect(data).toEqual(original);
  });
});
