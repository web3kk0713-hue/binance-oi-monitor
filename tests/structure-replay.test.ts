import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { proposeStructureAdvice } from '../src/shared/structureAdvice';
import { replayStructureAdvice, startStructureShadow, stepStructureShadow, validStructureShadowBook } from '../src/shared/structureReplay';
import type { MarkObservation } from '../src/shared/positionTypes';
import type { StructureAdvice, StructureCandle, StructureHistory, StructureShadow, StructureShadowBook } from '../src/shared/structureTypes';
import { structureFixture } from './structure-fixture';

const NOW = Date.UTC(2026, 8, 28, 12), INTERVAL = 300_000;
const D = Decimal.clone({ precision: 80 });
const percent = (pnl: string) => new D(pnl).div(104).mul(100).toFixed();
const advice = (changes: Partial<StructureAdvice> = {}): StructureAdvice => ({
  version: 'structure-v1', mode: 'live', position: { id: 'p1', marketKey: 'futures:TESTUSDT', symbol: 'TESTUSDT', assetId: 'binance:TEST',
    side: 'long', entryPrice: '104', margin: '104', leverage: '10', createdAt: NOW - 86_400_000 },
  generatedAt: NOW, asOf: NOW, referencePrice: '100', tickSize: '0.05', historyFrom: NOW - 7 * 86_400_000, historyTo: NOW - 1,
  atr15: '1', buffer: '0.25', quantity: '10', currentPnl: '-40', additionalRisk: '22.5', additionalRiskPct: percent('22.5'),
  remainingRewardRisk: new D('2.75').div('2.25').toFixed(), stop: { price: '97.75', structurePrice: '98', confirmedAt: NOW - 3600_000, pnl: '-62.5', returnOnMarginPct: percent('-62.5') },
  target1: { price: '102.75', structurePrice: '103', confirmedAt: NOW - 1800_000, pnl: '-12.5', returnOnMarginPct: percent('-12.5') },
  target2: { price: '104.75', structurePrice: '105', confirmedAt: NOW - 900_000, pnl: '7.5', returnOnMarginPct: percent('7.5') },
  trends: (['5m', '15m', '1h', '4h'] as const).map(interval => ({ interval, direction: 'flat', changePct: '0', from: NOW - 7200_000, to: NOW - 1 })),
  reasons: ['闭合结构'], warnings: ['未经收益验证'], ...changes,
});
const mark = (price = '100', at = NOW, changes: Partial<MarkObservation> = {}): MarkObservation => ({
  marketKey: 'futures:TESTUSDT', markPrice: price, sourceTime: at, receivedAt: at, source: 'binance-mark-stream', ...changes,
});
const candle = (at: number, changes: Partial<StructureCandle> = {}): StructureCandle => ({
  openTime: at, closeTime: at + INTERVAL - 1, open: '100', high: '101', low: '99', close: '100', ...changes,
});
const history = (bars = 48, from = NOW): StructureHistory => ({ schemaVersion: 1, marketKey: 'futures:TESTUSDT', symbol: 'TESTUSDT', tickSize: '0.05',
  intervalMs: INTERVAL, from, to: from + bars * INTERVAL, fetchedAt: from + bars * INTERVAL,
  candles: Array.from({ length: bars }, (_, i) => candle(from + i * INTERVAL)),
});
const start = () => startStructureShadow('shadow-1', advice(), mark(), NOW);
const book = (records: StructureShadow[] = [start()]): StructureShadowBook => ({ schemaVersion: 1, revision: 1,
  updatedAt: Math.max(NOW, ...records.map(r => r.lastMark?.receivedAt ?? r.startedAt)), records });

describe('historical first-touch diagnosis excludes the reference candle and never simulates execution', () => {
  it('does not use the already-open reference bar, even if its high and low cross both prices', () => {
    const a = advice({ asOf: NOW + 1000, generatedAt: NOW + 1000 }), h = history();
    h.candles[0] = candle(NOW, { high: '110', low: '90' });
    expect(replayStructureAdvice(a, h)).toMatchObject({ outcome: 'unresolved', bars: 47, touchedAt: null, observedTo: h.to });
  });
  it.each([['stop', { low: '97.75' }], ['target1', { high: '102.75' }]] as const)('diagnoses inclusive %s touch in a later closed bar', (outcome, changes) => {
    const h = history(); h.candles[2] = candle(NOW + 2 * INTERVAL, changes);
    expect(replayStructureAdvice(advice(), h)).toMatchObject({ outcome, touchedAt: NOW + 2 * INTERVAL, bars: 3 });
    expect(replayStructureAdvice(advice(), h).reason).toContain('具体时刻、成交及费用未知');
  });
  it('reports same-bar protection and target touches as ambiguous, not as a chosen profitable path', () => {
    const h = history(); h.candles[1] = candle(NOW + INTERVAL, { high: '103', low: '97' });
    expect(replayStructureAdvice(advice(), h)).toMatchObject({ outcome: 'ambiguous', bars: 2, touchedAt: NOW + INTERVAL });
  });
  it('keeps a completed no-touch window unresolved instead of inventing an exit or loss', () => {
    const result = replayStructureAdvice(advice(), history());
    expect(result).toMatchObject({ outcome: 'unresolved', touchedAt: null, bars: 48 });
    expect(result.reason).toContain('未强制平仓');
  });
  it('separately handles short-side crossings using high for protection and low for target', () => {
    const a = advice(); a.position.side = 'short'; a.currentPnl = '40';
    a.stop = { ...a.stop, price: '102.25', structurePrice: '102', pnl: '17.5', returnOnMarginPct: percent('17.5') };
    a.target1 = { ...a.target1, price: '97.25', structurePrice: '97', pnl: '67.5', returnOnMarginPct: percent('67.5') };
    a.target2 = { ...a.target2!, price: '95.25', structurePrice: '95', pnl: '87.5', returnOnMarginPct: percent('87.5') };
    const h = history(); h.candles[0] = candle(NOW, { low: '97.25' });
    expect(replayStructureAdvice(a, h).outcome).toBe('target1');
    h.candles[0] = candle(NOW, { high: '102.25' });
    expect(replayStructureAdvice(a, h).outcome).toBe('stop');
  });
  it('does not treat a partial or absent future window as no-touch success', () => {
    expect(replayStructureAdvice(advice(), history(1))).toMatchObject({ outcome: 'incomplete', bars: 1 });
    expect(replayStructureAdvice(advice(), history(1, NOW - INTERVAL))).toMatchObject({ outcome: 'incomplete', bars: 0 });
    expect(replayStructureAdvice(advice(), { ...history(), candles: [] })).toMatchObject({ outcome: 'incomplete', bars: 0 });
  });
  it.each(['gap', 'duplicate', 'future', 'wrong-symbol', 'wrong-price', 'wrong-tick'] as const)('refuses %s history instead of repairing it silently', kind => {
    const h = history();
    if (kind === 'gap') h.candles.splice(2, 1);
    if (kind === 'duplicate') h.candles[2] = h.candles[1];
    if (kind === 'future') h.fetchedAt = h.to - 1;
    if (kind === 'wrong-symbol') { h.marketKey = 'futures:OTHERUSDT'; h.symbol = 'OTHERUSDT'; }
    if (kind === 'wrong-price') h.candles[0].high = 'NaN';
    if (kind === 'wrong-tick') h.tickSize = '0.01';
    expect(replayStructureAdvice(advice(), h)).toMatchObject({ outcome: 'incomplete', bars: 0 });
  });
  it('does not inspect later bars after the requested horizon', () => {
    const h = history(49); h.candles[48] = candle(NOW + 48 * INTERVAL, { low: '90' });
    expect(replayStructureAdvice(advice(), h).outcome).toBe('unresolved');
  });
  it('includes a full candle closing exactly at the horizon when the reference is the preceding millisecond close', () => {
    const a = advice({ asOf: NOW - 1 }), h = history();
    h.candles[47] = candle(NOW + 47 * INTERVAL, { low: '97' });
    expect(replayStructureAdvice(a, h)).toMatchObject({ outcome: 'stop', bars: 48 });
  });
  it.each([0, -1, 300001, NaN, Infinity, 8 * 86_400_000])('rejects invalid replay horizon %s', horizon => {
    expect(replayStructureAdvice(advice(), history(), horizon).outcome).toBe('incomplete');
  });
});

describe('live local shadow records stay separate from adopted risk plans', () => {
  it('freezes a live candidate and seed observation without recording a touch or formal plan', () => {
    const a = advice(), m = mark(), record = startStructureShadow('shadow-1', a, m, NOW), before = structuredClone(record);
    a.stop.price = '1'; m.markPrice = '1';
    expect(record).toEqual(before); expect(record.touches).toEqual([]); expect(record).not.toHaveProperty('plan');
    expect(record.advice).not.toHaveProperty('stopPrice'); expect(record.advice).not.toHaveProperty('confirmedAt');
    expect(validStructureShadowBook(book([record]))).toBe(true);
  });
  it('records target1, target2 and stop once each without closing or changing its frozen candidate', () => {
    const first = start(), original = structuredClone(first), target = stepStructureShadow(first, mark('105', NOW + 1000), NOW + 1000);
    expect(target.touches.map(t => t.rule)).toEqual(['target1', 'target2']);
    const again = stepStructureShadow(target, mark('105', NOW + 2000), NOW + 2000);
    const stopped = stepStructureShadow(again, mark('97', NOW + 3000), NOW + 3000);
    expect(stopped.touches.map(t => t.rule)).toEqual(['target1', 'target2', 'stop']);
    expect(stopped.stoppedAt).toBeNull(); expect(stopped.advice).toEqual(original.advice); expect(first).toEqual(original);
    expect(validStructureShadowBook(book([stopped]))).toBe(true);
  });
  it('retains the original timestamp and receipt when the same mark is redelivered', () => {
    const first = start(), once = stepStructureShadow(first, mark('103', NOW + 1000), NOW + 1000);
    const duplicate = stepStructureShadow(once, mark('103.0', NOW + 1000, { receivedAt: NOW + 2000 }), NOW + 2000);
    expect(duplicate).toEqual(once); expect(duplicate.lastMark!.receivedAt).toBe(NOW + 1000);
  });
  it('does not label a repeated fresh seed observation just before start as a missed interval', () => {
    const a = advice({ asOf: NOW - 1 }), m = mark('100', NOW - 1), seeded = startStructureShadow('seed', a, m, NOW);
    expect(stepStructureShadow(seeded, m, NOW + 1000)).toEqual(seeded);
  });
  it('isolates a conflicting same-timestamp price and preserves a sticky gap after recovery', () => {
    const once = stepStructureShadow(start(), mark('101', NOW + 1000), NOW + 1000);
    const conflict = stepStructureShadow(once, mark('103', NOW + 1000, { receivedAt: NOW + 2000 }), NOW + 2000);
    expect(conflict.gap).toBe(true); expect(conflict.lastMark).toEqual(once.lastMark); expect(conflict.touches).toEqual([]);
    const recovered = stepStructureShadow(conflict, mark('103', NOW + 3000), NOW + 3000);
    expect(recovered.gap).toBe(true); expect(recovered.touches[0]).toMatchObject({ rule: 'target1', afterGap: true, sourceTime: NOW + 3000 });
  });
  it.each(['null', 'old', 'future', 'wrong', 'malformed', 'before-start', 'out-of-order'] as const)('does not create touches for %s observations', kind => {
    const original = stepStructureShadow(start(), mark('100', NOW + 2000), NOW + 2000);
    let m: MarkObservation | null = mark('90', NOW + 3000), now = NOW + 3000;
    if (kind === 'null') m = null;
    if (kind === 'old') now += 15_001;
    if (kind === 'future') m = mark('90', now + 1);
    if (kind === 'wrong') m!.marketKey = 'futures:OTHERUSDT';
    if (kind === 'malformed') m!.markPrice = 'NaN';
    if (kind === 'before-start') m = mark('90', NOW - 1);
    if (kind === 'out-of-order') m = mark('90', NOW + 1000);
    const result = stepStructureShadow(original, m, now);
    expect(result.touches).toEqual([]); expect(result.lastMark).toEqual(original.lastMark); expect(result.gap).toBe(true);
  });
  it('uses inclusive 15-second freshness and marks gaps exceeding that interval', () => {
    const atBoundary = stepStructureShadow(start(), mark('103', NOW + 15_000), NOW + 15_000);
    expect(atBoundary.touches[0].afterGap).toBe(false);
    const afterBoundary = stepStructureShadow(start(), mark('103', NOW + 15_001), NOW + 15_001);
    expect(afterBoundary.touches[0].afterGap).toBe(true);
    const stale = stepStructureShadow(start(), mark('103', NOW + 1000), NOW + 16_001);
    expect(stale.touches).toEqual([]);
  });
  it('does not expire an existing observation record after the candidate start TTL', () => {
    const result = stepStructureShadow(start(), mark('103', NOW + 8 * 86_400_000), NOW + 8 * 86_400_000);
    expect(result.touches).toHaveLength(1); expect(result.touches[0].afterGap).toBe(true);
    expect(result.stoppedAt).toBeNull(); expect(validStructureShadowBook(book([result]))).toBe(true);
  });
  it('keeps a manually stopped record unchanged', () => {
    const record = { ...start(), stoppedAt: NOW + 1000 };
    expect(stepStructureShadow(record, mark('90', NOW + 2000), NOW + 2000)).toEqual(record);
  });
  it.each(['replay', 'expired', 'future-advice', 'wrong-market', 'stale-mark', 'already-stop', 'already-target'] as const)('refuses to start %s candidates', kind => {
    const a = advice(); let m = mark(), now = NOW;
    if (kind === 'replay') a.mode = 'replay';
    if (kind === 'expired') { now += 60_000; m = mark('100', now); }
    if (kind === 'future-advice') a.generatedAt++;
    if (kind === 'wrong-market') m.marketKey = 'futures:OTHERUSDT';
    if (kind === 'stale-mark') now += 15_001;
    if (kind === 'already-stop') m.markPrice = a.stop.price;
    if (kind === 'already-target') m.markPrice = a.target1.price;
    expect(() => startStructureShadow('shadow-1', a, m, now)).toThrow();
  });
});

describe('strict persistent shadow book recovery', () => {
  it('round trips an engine candidate with zero recent ATR and a positive two-tick buffer', () => {
    const input = structureFixture('long', NOW);
    for (const c of input.history.candles.slice(-45)) Object.assign(c, { open: '100', high: '100', low: '100', close: '100' });
    const result = proposeStructureAdvice(input);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(result.reason);
    expect(result.advice).toMatchObject({ atr15: '0', buffer: '0.2' });
    const record = startStructureShadow('zero-atr', result.advice, input.reference, input.now);
    expect(validStructureShadowBook(book([record]))).toBe(true);
    const corrupt = book([structuredClone(record)]); corrupt.records[0].advice.atr15 = '-0.01';
    expect(validStructureShadowBook(corrupt)).toBe(false);
  });
  it.each(['long', 'short'] as const)('round trips actual engine-produced %s advice through shadow persistence', side => {
    const input = structureFixture(side, NOW), result = proposeStructureAdvice(input);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(result.reason);
    const record = startStructureShadow('generated', result.advice, input.reference, input.now);
    expect(validStructureShadowBook(book([record]))).toBe(true);
    const crossed = stepStructureShadow(record, { ...input.reference, markPrice: result.advice.target1.price,
      sourceTime: NOW + 1000, receivedAt: NOW + 1000 }, NOW + 1000);
    expect(crossed.touches[0].rule).toBe('target1');
    expect(validStructureShadowBook(book([crossed]))).toBe(true);
  });
  it('accepts a genuine empty book and unchanged generated record without requiring current freshness', () => {
    expect(validStructureShadowBook({ schemaVersion: 1, revision: 0, updatedAt: 0, records: [] })).toBe(true);
    expect(validStructureShadowBook(book())).toBe(true);
  });
  it.each([
    (b: StructureShadowBook) => { b.records[0].advice.stop.price = 'NaN'; },
    (b: StructureShadowBook) => { b.records[0].advice.stop.price = '97.751'; },
    (b: StructureShadowBook) => { b.records[0].advice.target1.price = '90'; },
    (b: StructureShadowBook) => { b.records[0].advice.position.marketKey = 'futures:OTHERUSDT'; },
    (b: StructureShadowBook) => { b.records[0].advice.position.leverage = '126'; },
    (b: StructureShadowBook) => { b.records[0].advice.quantity = '1e101'; },
    (b: StructureShadowBook) => { b.records[0].advice.quantity = '999'; },
    (b: StructureShadowBook) => { b.records[0].advice.currentPnl = '999'; },
    (b: StructureShadowBook) => { b.records[0].advice.stop.pnl = '999'; },
    (b: StructureShadowBook) => { b.records[0].advice.stop.returnOnMarginPct = '999'; },
    (b: StructureShadowBook) => { b.records[0].advice.additionalRisk = '999'; },
    (b: StructureShadowBook) => { b.records[0].advice.additionalRiskPct = '999'; },
    (b: StructureShadowBook) => { b.records[0].advice.remainingRewardRisk = '999'; },
    (b: StructureShadowBook) => { b.records[0].advice.buffer = '999'; },
    (b: StructureShadowBook) => { b.records[0].advice.trends[1] = b.records[0].advice.trends[0]; },
    (b: StructureShadowBook) => { b.records[0].advice.trends[0].to = NOW + 1; },
    (b: StructureShadowBook) => { b.records[0].advice.warnings = ['x'.repeat(2001)]; },
    (b: StructureShadowBook) => { b.records[0].advice.stop.confirmedAt = NOW + 1; },
    (b: StructureShadowBook) => { b.records[0].advice.mode = 'replay'; },
    (b: StructureShadowBook) => { b.records[0].lastMark = null; },
    (b: StructureShadowBook) => { b.records[0].startedAt = NOW + 60_000; },
    (b: StructureShadowBook) => { b.records[0].stoppedAt = NOW - 1; },
    (b: StructureShadowBook) => { b.records.push(structuredClone(b.records[0])); },
    (b: StructureShadowBook) => { b.records[0].touches.push({ rule: 'stop', sourceTime: NOW + 1, receivedAt: NOW + 1, price: '100', afterGap: false }); },
    (b: StructureShadowBook) => { b.revision = NaN; },
    (b: StructureShadowBook) => { b.updatedAt = NOW - 1; },
    (b: StructureShadowBook) => { Object.assign(b.records[0].advice, { method: 'manual', stopPrice: '97.75', takeProfitPrice: '102.75' }); },
  ])('rejects malformed or semantically foreign persisted data case %#', mutate => {
    const b = book(); mutate(b); expect(validStructureShadowBook(b)).toBe(false);
  });
  it('bounds records at 100 and validates observation uniqueness and chronology', () => {
    const records = Array.from({ length: 100 }, (_, i) => ({ ...start(), id: `shadow-${i}` }));
    expect(validStructureShadowBook(book(records))).toBe(true);
    expect(validStructureShadowBook(book([...records, { ...start(), id: 'shadow-100' }]))).toBe(false);
    const touched = stepStructureShadow(start(), mark('103', NOW + 1000), NOW + 1000), b = book([touched]);
    b.records[0].touches.push(structuredClone(b.records[0].touches[0]));
    expect(validStructureShadowBook(b)).toBe(false);
  });
  it('rejects conflicting same-source evidence and an omitted touch for the latest observation', () => {
    const touched = stepStructureShadow(start(), mark('105', NOW + 1000), NOW + 1000);
    const conflict = book([structuredClone(touched)]); conflict.records[0].touches[0].price = '103';
    expect(validStructureShadowBook(conflict)).toBe(false);
    const missing = book([structuredClone(touched)]); missing.records[0].touches = [];
    expect(validStructureShadowBook(missing)).toBe(false);
  });
});
