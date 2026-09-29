import { describe, expect, it } from 'vitest';
import { adoptEntryPlan, entryMarketMark, freshEntryMark, stepEntryWatch, validEntryBook, validEntryFill, validEntryWatch } from '../src/shared/entryWatch';
import { entryFlow, entryMarket, entryPlan, ENTRY_NOW as NOW } from './entry-fixture';

function adopted(side: 'long' | 'short' = 'long') {
  return adoptEntryPlan(entryPlan(side), entryFlow().marks![0], NOW);
}
describe('entry plan observation is not a trade', () => {
  it('freezes independent settings and prices, no personal position is created', () => {
    const plan = entryPlan(), watch = adoptEntryPlan(plan, entryFlow().marks![0], NOW);
    plan.directionConfig.oiPct = 99; plan.stopPrice = '1';
    expect(watch.plan.directionConfig.oiPct).toBe(5); expect(watch.plan.stopPrice).not.toBe('1');
    expect(watch.phase).toBe('watching'); expect(watch.filledPositionId).toBeNull(); expect(validEntryWatch(watch)).toBe(true);
  });
  it('requires a new direction window after adoption, not just current price inside zone', () => {
    const watch = adopted(), plan = watch.plan;
    const first = stepEntryWatch(watch, entryFlow(NOW + 20_000, plan.entryHigh), NOW + 20_000);
    expect(first.watch.phase).toBe('watching'); expect(first.events).toEqual([]);
    const next = stepEntryWatch(first.watch, entryFlow(NOW + 61_000, plan.entryHigh), NOW + 61_000);
    expect(next.watch.phase).toBe('ready'); expect(next.events).toHaveLength(1); expect(next.events[0].kind).toBe('ready');
    expect(next.watch.filledPositionId).toBeNull(); expect(next.watch.fillIntent).toBeNull();
  });
  it.each(['long', 'short'] as const)('notifies once for %s and can return to waiting without repeated entry alerts', side => {
    const watch = adopted(side), price = watch.plan.entryLow;
    const metrics = side === 'short' ? { priceChange5m: -1, buyShare5m: 35, delta5m: -30_000 } : {};
    const ready = stepEntryWatch(watch, entryFlow(NOW + 61_000, price, metrics), NOW + 61_000);
    expect(ready.watch.phase).toBe('ready'); expect(ready.events).toHaveLength(1);
    const waiting = stepEntryWatch(ready.watch, entryFlow(NOW + 65_000, '100', metrics), NOW + 65_000);
    expect(waiting.watch.phase).toBe('watching');
    const again = stepEntryWatch(waiting.watch, entryFlow(NOW + 70_000, price, metrics), NOW + 70_000);
    expect(again.watch.phase).toBe('ready'); expect(again.events).toHaveLength(0);
  });
  it('stale/contradictory feeds pause, restoration is current-only with gap disclosure', () => {
    const watch = adopted(), at = NOW + 61_000;
    const stale = stepEntryWatch(watch, entryFlow(), at);
    expect(stale.watch.gap).toBe(true); expect(stale.events).toEqual([]);
    const conflicting = entryFlow(at, watch.plan.entryHigh); conflicting.marks!.push({ ...conflicting.marks![0], markPrice: '100' });
    expect(entryMarketMark(conflicting, entryMarket.key, at)).toBeNull();
    const recovered = stepEntryWatch(stale.watch, entryFlow(at + 5000, watch.plan.entryHigh), at + 5000);
    expect(recovered.events[0]?.afterGap).toBe(true); expect(recovered.events[0]?.message).toContain('不补推测');
  });
  it('cannot confirm on another identity or silently replace symbol/quote', () => {
    const watch = adopted(), at = NOW + 61_000, flow = entryFlow(at, watch.plan.entryHigh);
    flow.rows[0].market.assetId = 'other';
    expect(stepEntryWatch(watch, flow, at).watch.reason).toContain('身份冲突');
    flow.rows[0].market.quoteAsset = 'USDC';
    expect(entryMarketMark(flow, entryMarket.key, at)).toBeNull();
  });
  it('source regression and same-time price conflict do not advance triggers', () => {
    const watch = adopted(), flow = entryFlow(NOW + 1, '99');
    flow.marks![0].sourceTime = NOW;
    expect(stepEntryWatch(watch, flow, NOW + 1).watch.gap).toBe(true);
    expect(() => stepEntryWatch(watch, null, NOW - 1)).toThrow('时钟');
  });
  it('expires once without current price and never closes or opens real positions', () => {
    const watch = adopted(), expired = stepEntryWatch(watch, null, watch.plan.waitUntil);
    expect(expired.watch.phase).toBe('expired'); expect(expired.events[0]).toMatchObject({ kind: 'expired', markPrice: null, sourceTime: null, afterGap: true });
    expect(stepEntryWatch(expired.watch, null, watch.plan.waitUntil + 5000).events).toEqual([]);
  });
  it.each(['stopPrice', 'targetPrice'] as const)('invalidates at %s, before any new entry trigger', field => {
    const watch = adopted(), at = NOW + 61_000;
    const result = stepEntryWatch(watch, entryFlow(at, watch.plan[field]), at);
    expect(result.watch.phase).toBe('invalidated'); expect(result.events[0].kind).toBe('invalidated');
  });
  it('TTL governs adoption only, not the accepted observation lifetime', () => {
    const plan = entryPlan();
    expect(() => adoptEntryPlan(plan, entryFlow(NOW + 60_000).marks![0], NOW + 60_000)).not.toThrow();
    expect(() => adoptEntryPlan(plan, entryFlow(NOW + 60_001).marks![0], NOW + 60_001)).toThrow('过期');
    const result = stepEntryWatch(adopted(), entryFlow(NOW + 120_000, plan.entryHigh), NOW + 120_000);
    expect(result.watch.phase).toBe('ready');
  });
  it('fresh mark boundaries and corrupt restored plans fail closed', () => {
    const mark = entryFlow().marks![0];
    expect(freshEntryMark(mark, mark.marketKey, NOW + 15_000)).toBe(true);
    expect(freshEntryMark(mark, mark.marketKey, NOW + 15_001)).toBe(false);
    expect(validEntryWatch({ ...adopted(), phase: 'filled' })).toBe(false);
    expect(validEntryWatch({ ...adopted(), lastMark: { ...mark, sourceTime: NOW + 1 } })).toBe(false);
    expect(validEntryBook({ schemaVersion: 1, revision: 0, updatedAt: NOW, watches: [adopted(), adopted()], events: [] })).toBe(false);
  });
  it('actual fill input requires finite exact values and a real nonfuture timestamp', () => {
    const input = { entryPrice: '99', margin: '100', leverage: '10', openedAt: NOW };
    expect(validEntryFill(input, NOW)).toBe(true);
    for (const change of [{ openedAt: NOW + 1 }, { leverage: '126' }, { entryPrice: 'NaN' }, { margin: '0' }])
      expect(validEntryFill({ ...input, ...change }, NOW)).toBe(false);
  });
});
