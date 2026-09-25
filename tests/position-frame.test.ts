import { describe, expect, it } from 'vitest';
import { DEFAULT_DIRECTION_CONFIG, DIRECTION_PRESETS } from '../src/shared/directionConfig';
import { positionMarketFrame } from '../src/shared/positionFrame';
import { createFlowEngine } from '../src/shared/orderflow';
import { createPositionRisk, stepPositionRisk } from '../src/shared/positionRisk';
import type { FlowMetrics, FlowSnapshot } from '../src/shared/flowTypes';
import type { ManualPosition, MarkObservation } from '../src/shared/positionTypes';
import type { AssetRow, ContractEvidence, Snapshot } from '../src/shared/types';

const NOW = Date.UTC(2026, 8, 25, 12, 0, 5);
const position = (changes: Partial<ManualPosition> = {}): ManualPosition => ({ id: 'p1', marketKey: 'futures:TEST_LONGUSDT', symbol: 'TEST_LONGUSDT',
  assetId: 'synthetic:TEST_LONG', side: 'long', entryPrice: '100', margin: '100', leverage: '10', createdAt: NOW - 60_000, ...changes });
const mark = (changes: Partial<MarkObservation> = {}): MarkObservation => ({ marketKey: position().marketKey, markPrice: '100.000000000000000001',
  sourceTime: NOW - 1000, receivedAt: NOW - 500, source: 'binance-mark-stream', ...changes });
const row = (changes: Partial<FlowMetrics> = {}): FlowMetrics => ({ market: { key: position().marketKey, symbol: position().symbol,
  assetId: position().assetId, baseAsset: 'TEST_LONG', quoteAsset: 'USDT', venue: 'futures' }, asOf: NOW, status: 'live', reason: '',
  price: 999, priceChange5m: 1, volume5m: 100_000, buyShare5m: 60, delta5m: 20_000, volumeMultiple: 2, vwap5m: 90,
  range5mPct: 1, atr14: 2, oiChange5m: 5, funding: null, depth: null, baselineWindows: 12, tradeSamples: 1000,
  largeTradeThreshold: 100_000, lastTradeAt: NOW - 1000, lastCandleAt: NOW - 2000, ...changes });
const flow = (changes: Partial<FlowSnapshot> = {}): FlowSnapshot => ({ schemaVersion: 1, marks: [mark()], rows: [row()], events: [],
  status: { mode: 'direct', startedAt: NOW - 3_600_000, asOf: NOW, connectedStreams: 1, totalStreams: 1, markets: 1,
    readyMarkets: 1, warmingMarkets: 0, staleMarkets: 0, backfilledMarkets: 1, errors: [], retentionDays: 7, scope: '' }, ...changes });
const contract = (changes: Partial<ContractEvidence> = {}): ContractEvidence => ({ symbol: position().symbol, baseAsset: 'TEST_LONG', quoteAsset: 'USDT',
  openInterest: null, markPrice: '101.000000000000000002', indexPrice: '102', quoteUsd: '1', oiTime: null,
  priceTime: NOW - 2000, priceObservedAt: NOW - 1000, oiUsd: null, ...changes });
const asset = (changes: Partial<AssetRow> = {}): AssetRow => ({ id: position().assetId, symbol: 'TEST_LONG', name: 'Synthetic', contracts: [position().symbol],
  priceUsd: 888, oiUsd: null, marketCapUsd: null, fdvUsd: null, oiToFdv: null, oiToMarketCap: null, circulatingSupply: null, maxSupply: null,
  updatedAt: NOW, oiUpdatedAt: null, priceUpdatedAt: NOW - 2000, supplyUpdatedAt: null, complete: false, alertEligible: false, issues: ['OI unavailable'],
  supplySource: null, mappingStatus: 'unmapped', evidence: { contracts: [contract()], supply: null, mapping: '' }, ...changes });
const valuation = (changes: Partial<Snapshot> = {}): Snapshot => ({ schemaVersion: 1, mode: 'direct', startedAt: NOW - 30_000, asOf: NOW, durationMs: 0,
  universe: { contracts: 1, assets: 1 }, coverage: { oi: 0, marketCap: 0, fdv: 0, eligible: 0, failedContracts: 1 }, assets: [asset()], errors: [], ...changes });
const read = (f: FlowSnapshot | null = flow(), v: Snapshot | null = valuation()) => positionMarketFrame(position(), f, v, NOW, DEFAULT_DIRECTION_CONFIG);

describe('existing-source mark adaptation, never substituted asset or trade prices', () => {
  it('uses the raw same-contract stream mark independently of funding and trade price', () => {
    expect(read().mark).toEqual(mark());
    expect(read().mark?.markPrice).not.toBe(String(row().price));
    expect(read(flow({ rows: [row({ funding: null, status: 'warming' })] })).mark).toEqual(mark());
    expect(read(flow({ rows: [row({ funding: null, status: 'disconnected' })] })).mark).toEqual(mark());
    expect(read(flow({ rows: [row({ status: 'warming' })] })).atr).toBeNull();
  });
  it('chooses the newest exact mark, not another asset or array order', () => {
    const marks = [mark({ sourceTime: NOW - 10_000, receivedAt: NOW - 9000, markPrice: '99' }),
      mark({ marketKey: 'futures:OTHERUSDT', sourceTime: NOW, receivedAt: NOW, markPrice: '99999' }), mark()];
    expect(read(flow({ marks })).mark).toEqual(mark());
    expect(read(flow({ marks: [...marks].reverse() })).mark).toEqual(mark());
  });
  it('falls back to exact raw premium evidence without requiring OI/FDV completeness', () => {
    expect(read(null).mark).toEqual({ marketKey: position().marketKey, markPrice: contract().markPrice, sourceTime: contract().priceTime,
      receivedAt: contract().priceObservedAt, source: 'binance-premium-rest' });
    expect(read(flow({ marks: [] })).mark?.source).toBe('binance-premium-rest');
    expect(read(flow({ marks: [mark({ sourceTime: NOW - 15_001 })] })).mark?.source).toBe('binance-premium-rest');
    expect(read(null, valuation({ assets: [] })).mark).toBeNull();
  });
  it('does not use funding mark numbers, lastGood, token index price or other quote contracts', () => {
    const f = flow({ marks: [], rows: [row({ funding: { marketKey: position().marketKey, markPrice: 777, indexPrice: 666,
      timestamp: NOW, receivedAt: NOW, fundingRate: 0, fundingIntervalHours: 8, nextFundingTime: NOW + 1000 } })] });
    const v = valuation({ assets: [asset({ evidence: { contracts: [contract({ markPrice: null })], supply: null, mapping: '' } })],
      lastGood: { [position().assetId]: { assetId: position().assetId, timestamp: NOW, complete: true, priceUsd: 555,
        oiUsd: 1, fdvUsd: 2, marketCapUsd: 2, oiToFdv: 50, oiToMarketCap: 50 } } });
    expect(read(f, v).mark).toBeNull();
    expect(read(null, valuation({ assets: [asset({ evidence: { contracts: [contract({ quoteAsset: 'USDC' })], supply: null, mapping: '' } })] })).mark).toBeNull();
  });
  it('quarantines conflicting latest timestamps, but accepts equivalent decimal representations', () => {
    expect(read(flow({ marks: [mark(), mark({ markPrice: '999' })] })).mark).toBeNull();
    expect(read(flow({ marks: [mark({ markPrice: '100' }), mark({ markPrice: '100.0' })] })).mark?.markPrice).toBe('100');
    const v = valuation({ assets: [asset({ evidence: { contracts: [contract(), contract({ markPrice: '999' })], supply: null, mapping: '' } })] });
    expect(read(null, v).mark).toBeNull();
  });
  it.each([
    { sourceTime: NOW + 1 }, { receivedAt: NOW + 1 }, { sourceTime: NOW, receivedAt: NOW - 1 },
    { sourceTime: NOW - 15_001 }, { markPrice: '0' }, { markPrice: 'NaN' }, { markPrice: '-1' },
  ])('rejects invalid stream mark %j without inventing a replacement', change => {
    expect(read(flow({ marks: [mark(change)] }), null).mark).toBeNull();
  });
  it.each([
    { priceTime: NOW + 1 }, { priceObservedAt: NOW + 1 }, { priceTime: NOW, priceObservedAt: NOW - 1 },
    { priceTime: NOW - 45_001 }, { priceObservedAt: undefined }, { priceTime: null }, { markPrice: 'Infinity' },
  ])('rejects missing, reversed or old premium source metadata %j', change => {
    expect(read(null, valuation({ assets: [asset({ evidence: { contracts: [contract(change)], supply: null, mapping: '' } })] })).mark).toBeNull();
  });
  it('checks source observation cannot postdate its enclosing snapshot', () => {
    expect(read(flow({ status: { ...flow().status, asOf: NOW - 1000 } }), null).mark).toBeNull();
    expect(read(null, valuation({ asOf: NOW - 1500 })).mark).toBeNull();
    expect(read(flow({ status: { ...flow().status, asOf: NOW + 1 } }), null).mark).toBeNull();
    expect(read(null, valuation({ asOf: NOW + 1 })).mark).toBeNull();
  });
  it('binds exact asset identity, native contract symbol, quote and venue', () => {
    for (const market of [{ ...row().market, assetId: 'synthetic:OTHER' }, { ...row().market, symbol: 'OTHERUSDT' },
      { ...row().market, venue: 'spot' as const }, { ...row().market, quoteAsset: 'USDC' }])
      expect(read(flow({ rows: [row({ market })] }), null).mark).toBeNull();
    expect(read(null, valuation({ assets: [asset({ id: 'synthetic:OTHER' })] })).mark).toBeNull();
    expect(read(null, valuation({ assets: [asset({ contracts: ['OTHERUSDT'] })] })).mark).toBeNull();
    expect(read(flow({ rows: [row(), row()] }), null).mark).toBeNull();
  });
  it('does not divide native 1000-token prices by a token multiplier', () => {
    const p = position({ symbol: '1000PEPEUSDT', marketKey: 'futures:1000PEPEUSDT', assetId: 'binance:PEPE', entryPrice: '.01' });
    const v = valuation({ assets: [asset({ id: p.assetId, contracts: [p.symbol], priceUsd: .00001,
      evidence: { contracts: [contract({ symbol: p.symbol, markPrice: '.011', unitMultiplier: 1000 })], supply: null, mapping: '' } })] });
    expect(positionMarketFrame(p, null, v, NOW, DEFAULT_DIRECTION_CONFIG).mark?.markPrice).toBe('.011');
  });
});

describe('independent ATR and machine-readable signal quality', () => {
  it('uses the engine closed-15-candle ATR, never the current open candle indicated by lastCandleAt', () => {
    const end = Math.floor(NOW / 60_000) * 60_000;
    const engineWith = (count: number) => {
      const engine = createFlowEngine();
      engine.setMarkets([row().market]); engine.setConnected([position().marketKey], true, end - 20 * 60_000);
      for (let i = count; i >= 1; i--) {
        const openTime = end - i * 60_000, closeTime = openTime + 60_000 - 1;
        expect(engine.ingestCandle({ marketKey: position().marketKey, openTime, closeTime, open: 100, high: 101, low: 99,
          close: 100, volume: 100, quoteVolume: 10_000, takerBuyQuote: 6000, trades: 100, closed: true,
          sourceTime: closeTime, receivedAt: closeTime + 1, source: 'stream' })).toBe(true);
      }
      expect(engine.ingestCandle({ marketKey: position().marketKey, openTime: end, closeTime: end + 60_000 - 1,
        open: 100, high: 9999, low: 1, close: 9000, volume: 100, quoteVolume: 900_000, takerBuyQuote: 600_000, trades: 100,
        closed: false, sourceTime: NOW - 1000, receivedAt: NOW - 500, source: 'stream' })).toBe(true);
      return engine;
    };
    const complete = engineWith(15).metrics(NOW);
    expect(complete[0]).toMatchObject({ status: 'live', atr14: 2, lastCandleAt: NOW - 1000 });
    expect(read(flow({ rows: complete })).atr?.value).toBe('2');
    const missing = engineWith(14).metrics(NOW);
    expect(missing[0]).toMatchObject({ status: 'live', atr14: null, lastCandleAt: NOW - 1000 });
    expect(read(flow({ rows: missing })).atr).toBeNull();
  });
  it('copies valid ATR with its exact source identity and timestamps', () => {
    expect(read().atr).toEqual({ marketKey: position().marketKey, value: '2', asOf: NOW, lastCandleAt: NOW - 2000 });
  });
  it.each([{ atr14: null }, { atr14: NaN }, { atr14: 0 }, { atr14: -1 }, { status: 'warming' as const },
    { asOf: NOW + 1 }, { asOf: NOW - 30_001 }, { lastCandleAt: NOW + 1 }, { lastCandleAt: NOW - 90_001 }])
    ('withholds invalid ATR without suppressing healthy independent marks %j', changes => {
      const result = read(flow({ rows: [row(changes)] }));
      expect(result.atr).toBeNull(); expect(result.mark).toEqual(mark());
    });
  it('passes valid wait as a real weak result, but not missing-data wait, with copied config', () => {
    expect(read().signal).toMatchObject({ valid: true, bias: 'long', config: DEFAULT_DIRECTION_CONFIG });
    expect(read(flow({ rows: [row({ oiChange5m: 0 })] })).signal).toMatchObject({ valid: true, bias: 'wait' });
    expect(read(flow({ rows: [row({ oiChange5m: null })] })).signal).toMatchObject({ valid: false, bias: 'wait' });
    expect(read(flow({ rows: [row({ buyShare5m: 60, delta5m: -1 })] })).signal?.valid).toBe(false);
    const config = { ...DIRECTION_PRESETS.strict };
    const result = positionMarketFrame(position(), flow({ rows: [row({ oiChange5m: 11, priceChange5m: 2, buyShare5m: 70 })] }), valuation(), NOW, config);
    expect(result.signal).toMatchObject({ valid: false, bias: 'wait', config });
    expect(result.signal!.config).not.toBe(config);
  });
  it.each([{ oiChange5m: 0 }, { priceChange5m: 0 }, { buyShare5m: 60 }])
    ('withholds missing required spot even when futures fail earlier %j', change => {
      const futures = row({ oiChange5m: 11, priceChange5m: 2, buyShare5m: 70, ...change });
      const adapted = positionMarketFrame(position(), flow({ rows: [futures] }), valuation(), NOW, DIRECTION_PRESETS.strict);
      expect(adapted.signal).toMatchObject({ valid: false, bias: 'wait', config: DIRECTION_PRESETS.strict });
      expect(adapted.mark).toEqual(mark());
      const neutralSpot = row({ market: { ...row().market, key: `spot:${position().symbol}`, venue: 'spot' },
        oiChange5m: null, buyShare5m: 50, delta5m: 0, priceChange5m: 0 });
      expect(positionMarketFrame(position(), flow({ rows: [futures, neutralSpot] }), valuation(), NOW, DIRECTION_PRESETS.strict).signal)
        .toMatchObject({ valid: true, bias: 'wait' });
    });
  it('does not emit weakening across two closed minute endpoints with required spot missing', () => {
    const config = DIRECTION_PRESETS.strict;
    const at = (now: number, complete: boolean) => {
      const futures = row({ asOf: now, lastCandleAt: now - 1000, oiChange5m: complete ? 11 : 0,
        priceChange5m: 2, buyShare5m: 70, delta5m: 40_000 });
      const spot = row({ market: { ...row().market, key: `spot:${position().symbol}`, venue: 'spot' },
        asOf: now, lastCandleAt: now - 1000, oiChange5m: null });
      return positionMarketFrame(position(), flow({ status: { ...flow().status, asOf: now },
        marks: [mark({ markPrice: '100', sourceTime: now, receivedAt: now })], rows: complete ? [futures, spot] : [futures] }), null, now, config);
    };
    let state = stepPositionRisk(createPositionRisk(position()), { type: 'confirm', expectedPlanRevision: 0, now: NOW, frame: at(NOW, true),
      plan: { stopPrice: '95', takeProfitPrice: '120', trailing: null, signalWeakening: true,
        directionConfig: config, method: 'manual', generatedAt: NOW } }).state;
    expect(state.signalBaseline).toBe(true);
    for (let offset = 10_000; offset <= 130_000; offset += 10_000) {
      const result = stepPositionRisk(state, { type: 'tick', now: NOW + offset, frame: at(NOW + offset, false) });
      expect(result.error).toBeNull(); expect(result.events).toEqual([]); state = result.state;
    }
    expect(state).toMatchObject({ phase: 'armed', signalBaseline: false, weakWindows: 0, lastSignalWindow: null });
  });
  it('handles missing and malformed data without any network or storage side effects', () => {
    expect(read(null, null)).toEqual({ mark: null, atr: null, signal: null });
    expect(read({ rows: [null] } as unknown as FlowSnapshot, { assets: [null] } as unknown as Snapshot)).toEqual({ mark: null, atr: null, signal: null });
    expect(positionMarketFrame(position({ symbol: '<script>' }), flow(), valuation(), NOW, DEFAULT_DIRECTION_CONFIG)).toEqual({ mark: null, atr: null, signal: null });
    const f = flow(), v = valuation(), beforeF = structuredClone(f), beforeV = structuredClone(v);
    positionMarketFrame(position(), f, v, NOW, DEFAULT_DIRECTION_CONFIG);
    expect(f).toEqual(beforeF); expect(v).toEqual(beforeV);
  });
});
