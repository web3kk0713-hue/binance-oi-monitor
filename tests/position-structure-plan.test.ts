import { describe, expect, it } from 'vitest';
import { DEFAULT_DIRECTION_CONFIG } from '../src/shared/directionConfig';
import { proposeStructureRiskPlan } from '../src/shared/positionAdvice';
import { createPositionRisk, stepPositionRisk, validPositionState } from '../src/shared/positionRisk';
import type { PositionMarketFrame, PositionRiskState, RiskPlanDraft } from '../src/shared/positionTypes';
import { proposeStructureAdvice } from '../src/shared/structureAdvice';
import { validateStructureAdvice } from '../src/shared/structureReplay';
import { emptyPositionBook, validPositionBook } from '../src/web/positionBook';
import { structureFixture, STRUCTURE_TEST_NOW as NOW } from './structure-fixture';

function setup(side: 'long' | 'short' = 'long', openedAt?: number) {
  const input = structureFixture(side);
  if (openedAt !== undefined) input.position.openedAt = openedAt;
  const result = proposeStructureAdvice(input);
  if (result.status !== 'ready') throw new Error(result.reason);
  const advice = result.advice, state = createPositionRisk(input.position);
  const proposal = proposeStructureRiskPlan(input.position, advice, DEFAULT_DIRECTION_CONFIG, NOW);
  if (!proposal.plan) throw new Error(proposal.error!);
  const frame = (at = NOW, price = '100'): PositionMarketFrame => ({
    mark: { ...input.reference, markPrice: price, sourceTime: at, receivedAt: at }, atr: null, signal: null,
  });
  const confirm = (plan = proposal.plan!, previous = state, at = NOW, price = '100', revision = previous.plan?.revision ?? 0) =>
    stepPositionRisk(previous, { type: 'confirm', plan, expectedPlanRevision: revision, frame: frame(at, price), now: at });
  return { input, advice, state, plan: proposal.plan, frame, confirm };
}

describe('live structure plan adoption contract', () => {
  it.each(['long', 'short'] as const)('freezes the %s plan without enabling legacy trailing or signal exits', side => {
    const f = setup(side), result = f.confirm();
    expect(result.error).toBeNull(); expect(validPositionState(result.state)).toBe(true);
    expect(result.state.plan).toMatchObject({ method: 'structure-v1', holdingLimitMs: 14_400_000,
      deadlineAt: NOW + 14_400_000, timingBasis: 'adopted-at', signalWeakening: false, trailing: null,
      stopPrice: f.advice.stop.price, takeProfitPrice: f.advice.target1.price });
    f.advice.stop.price = '1'; f.plan.structure!.reasons[0] = 'changed';
    expect(result.state.plan?.structure?.stop.price).not.toBe('1');
    expect(result.state.plan?.structure?.reasons[0]).not.toBe('changed');
  });
  it.each([30, 60, 120, 240])('allows the explicit %s-minute holding cap', minutes => {
    const f = setup(), proposal = proposeStructureRiskPlan(f.input.position, f.advice, DEFAULT_DIRECTION_CONFIG, NOW, minutes * 60_000);
    const result = f.confirm(proposal.plan!);
    expect(result.error).toBeNull(); expect(result.state.plan?.deadlineAt).toBe(NOW + minutes * 60_000);
  });
  it.each([0, 60_000, 1_799_999, 14_400_001, Number.NaN])('rejects unsupported holding period %s', holding => {
    const f = setup(); expect(proposeStructureRiskPlan(f.input.position, f.advice, DEFAULT_DIRECTION_CONFIG, NOW, holding).plan).toBeNull();
    expect(f.confirm({ ...f.plan, holdingLimitMs: holding }).error).not.toBeNull();
  });
  it('preserves actual opening time and does not use creation or re-adoption as the holding start', () => {
    const openedAt = NOW - 3_600_000, f = setup('long', openedAt), result = f.confirm();
    expect(f.advice.position.openedAt).toBe(openedAt); expect(validateStructureAdvice(f.advice)).toBe(true);
    expect(result.state.plan).toMatchObject({ deadlineAt: openedAt + 14_400_000, timingBasis: 'opened-at' });
    expect(JSON.parse(JSON.stringify(result.state)).position.openedAt).toBe(openedAt);
    expect(validPositionState(JSON.parse(JSON.stringify(result.state)))).toBe(true);
  });
  it('carries the market-plan holding preference without arming anything', () => {
    const input = structureFixture(); input.position.suggestedHoldingLimitMs = 1_800_000;
    const state = createPositionRisk(input.position), result = proposeStructureAdvice(input);
    expect(state.phase).toBe('draft'); expect(state.plan).toBeNull();
    expect(state.position.suggestedHoldingLimitMs).toBe(1_800_000);
    if (result.status !== 'ready') throw new Error(result.reason);
    expect(result.advice.position.suggestedHoldingLimitMs).toBe(1_800_000);
    expect(validateStructureAdvice(result.advice)).toBe(true);
    expect(proposeStructureRiskPlan(input.position, result.advice, DEFAULT_DIRECTION_CONFIG, NOW).plan?.holdingLimitMs).toBe(1_800_000);
    expect(proposeStructureRiskPlan({ ...input.position, suggestedHoldingLimitMs: 3_600_000 }, result.advice, DEFAULT_DIRECTION_CONFIG, NOW).plan).toBeNull();
    expect(() => createPositionRisk({ ...input.position, suggestedHoldingLimitMs: 1 })).toThrow();
  });
  it.each([0, NOW, NOW + 1, Number.NaN])('rejects invalid or post-record opening timestamp %s', openedAt => {
    const input = structureFixture(); input.position.openedAt = openedAt;
    expect(() => createPositionRisk(input.position)).toThrow();
    expect(proposeStructureAdvice(input).status).toBe('unavailable');
  });
  it('rejects replay, altered identity, altered levels and missing source provenance', () => {
    const f = setup(), replay = { ...f.advice, mode: 'replay' as const };
    expect(proposeStructureRiskPlan(f.input.position, replay, DEFAULT_DIRECTION_CONFIG, NOW).plan).toBeNull();
    expect(proposeStructureRiskPlan({ ...f.input.position, id: 'other' }, f.advice, DEFAULT_DIRECTION_CONFIG, NOW).plan).toBeNull();
    expect(f.confirm({ ...f.plan, structure: replay }).error).not.toBeNull();
    expect(f.confirm({ ...f.plan, stopPrice: '90' }).error).not.toBeNull();
    expect(f.confirm({ ...f.plan, structure: undefined }).error).not.toBeNull();
  });
  it.each([59_999, 60_000, 60_001])('keeps original candidate TTL at age %s', age => {
    const f = setup(), at = NOW + age;
    const proposal = proposeStructureRiskPlan(f.input.position, f.advice, DEFAULT_DIRECTION_CONFIG, at);
    const result = f.confirm(f.plan, f.state, at);
    expect(!!proposal.plan).toBe(age < 60_000); expect(result.error === null).toBe(age < 60_000);
  });
  it('rechecks current price, remaining room and margin before arming', () => {
    const f = setup();
    expect(f.confirm(f.plan, f.state, NOW, '97.5').error).toContain('已到达');
    expect(f.confirm(f.plan, f.state, NOW, '105.5').error).toContain('已到达');
    expect(f.confirm(f.plan, f.state, NOW, '104').error).toContain('剩余空间');
    expect(f.state.plan).toBeNull();
  });
  it('rejects candidate additional loss beyond margin even if bridge is bypassed', () => {
    const input = structureFixture(); input.position.leverage = '100';
    const result = proposeStructureAdvice(input);
    if (result.status !== 'ready') throw new Error(result.reason);
    expect(proposeStructureRiskPlan(input.position, result.advice, DEFAULT_DIRECTION_CONFIG, NOW).plan).toBeNull();
    const forged: RiskPlanDraft = { ...setup().plan, structure: result.advice };
    expect(stepPositionRisk(createPositionRisk(input.position), { type: 'confirm', plan: forged,
      expectedPlanRevision: 0, frame: { mark: input.reference, atr: null, signal: null }, now: NOW }).error).not.toBeNull();
  });
  it('keeps prior plan immutable across an expired replacement and CAS conflicts', () => {
    const f = setup(), armed = f.confirm().state;
    const replacement = { ...f.plan, holdingLimitMs: 3_600_000 };
    const expired = f.confirm(replacement, armed, NOW + 60_000);
    expect(expired.error).toContain('过期'); expect(expired.state).toBe(armed);
    expect(f.confirm(replacement, armed, NOW, '100', 0).error).toContain('版本');
    const retry = f.confirm(f.plan, armed, NOW + 120_000);
    expect(retry.error).toBeNull(); expect(retry.state).toEqual(armed);
  });
});

describe('durable clock and price reminders', () => {
  it('fires deadline exactly once without a quote, retains genuine quote time and never closes', () => {
    const f = setup(), armed = f.confirm().state, at = armed.plan!.deadlineAt!;
    const result = stepPositionRisk(armed, { type: 'tick', now: at, frame: { mark: null, atr: null, signal: null } });
    expect(result.events).toHaveLength(1); expect(result.events[0]).toMatchObject({ rule: 'time-exit', sourceTime: NOW, timestamp: at, afterGap: true });
    expect(result.events[0].message).toContain('不是当前可成交价');
    expect(result.state.phase).toBe('triggered'); expect(result.state.closedAt).toBeNull();
    expect(result.error).toContain('暂停'); expect(validPositionState(result.state)).toBe(true);
    const restored: PositionRiskState = JSON.parse(JSON.stringify(result.state));
    const again = stepPositionRisk(restored, { type: 'tick', now: at + 5000, frame: f.frame(at + 5000) });
    expect(again.events).toEqual([]); expect(validPositionState(again.state)).toBe(true);
    const book = { ...emptyPositionBook(), positions: [result.state], events: result.events };
    expect(validPositionBook(book)).toBe(true);
  });
  it('does not fire before deadline or when the user has marked the position closed', () => {
    const f = setup(), armed = f.confirm().state, at = armed.plan!.deadlineAt!;
    expect(stepPositionRisk(armed, { type: 'tick', now: at - 1, frame: f.frame(at - 1) }).events).toEqual([]);
    const closed = stepPositionRisk(armed, { type: 'close', now: NOW + 1000 }).state;
    expect(stepPositionRisk(closed, { type: 'tick', now: at, frame: f.frame(at) }).events).toEqual([]);
  });
  it('continues protective price reminders after a time alert', () => {
    const f = setup(), armed = f.confirm().state, at = armed.plan!.deadlineAt!;
    const timed = stepPositionRisk(armed, { type: 'tick', now: at, frame: f.frame(at) }).state;
    const stopped = stepPositionRisk(timed, { type: 'tick', now: at + 1000, frame: f.frame(at + 1000, '97') });
    expect(stopped.events.map(e => e.rule)).toEqual(['stop']); expect(stopped.state.fired).toEqual(['time-exit', 'stop']);
  });
  it('accepts an already overdue user-declared opening time but checks exit on the next tick', () => {
    const f = setup('long', NOW - 5 * 3_600_000), armed = f.confirm();
    expect(armed.error).toBeNull(); expect(armed.state.plan!.deadlineAt).toBeLessThan(NOW);
    const tick = stepPositionRisk(armed.state, { type: 'tick', frame: f.frame(), now: NOW });
    expect(tick.events.map(e => e.rule)).toEqual(['time-exit']);
  });
  it('leaves legacy stored plans without a deadline and rejects tampered deadline recovery', () => {
    const f = setup(), legacy: RiskPlanDraft = { stopPrice: '95', takeProfitPrice: '110', trailing: null,
      signalWeakening: false, directionConfig: { ...DEFAULT_DIRECTION_CONFIG }, method: 'manual', generatedAt: NOW };
    const old = f.confirm(legacy).state;
    expect(old.plan?.deadlineAt).toBeUndefined(); expect(validPositionState(JSON.parse(JSON.stringify(old)))).toBe(true);
    expect(stepPositionRisk(old, { type: 'tick', frame: f.frame(NOW + 86_400_000), now: NOW + 86_400_000 }).events).toEqual([]);
    const armed = f.confirm().state;
    for (const change of [{ deadlineAt: NOW }, { timingBasis: 'opened-at' }, { holdingLimitMs: 1 }, { structure: undefined }]) {
      expect(validPositionState({ ...armed, plan: { ...armed.plan, ...change } })).toBe(false);
    }
  });
});
