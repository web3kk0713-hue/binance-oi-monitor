import { describe, expect, it, vi } from 'vitest';
import { createBrowserHistoryRecovery } from '../src/web/browserHistoryRecovery';
import { createFlowEngine } from '../src/shared/orderflow';
import type { FlowHistory, FlowMarket, FlowOi } from '../src/shared/flowTypes';

const end = 1_800_000_000_000, from = end - 3_600_000;
const market: FlowMarket = { key: 'futures:BTCUSDT', symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', assetId: 'binance:BTC', venue: 'futures' };
const known: FlowHistory = { market, from, to: end, candles: [], oi: [], events: [], depth: [] };
const point: FlowOi = { marketKey: market.key, timestamp: end - 300_000, receivedAt: end, quantity: 100, source: 'rest-5m' };
const completed = { candles: [], oi: [point], missingCandles: 0, missingOi: 0, error: null, retryAt: 0 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

describe('non-blocking browser historical recovery', () => {
  it('returns immediately, shares one active job, and writes only archive facts', async () => {
    const pending = deferred<typeof completed>(), recover = vi.fn(() => pending.promise), save = vi.fn(async () => {});
    const service = createBrowserHistoryRecovery({ recover, save, now: () => end });
    expect(service.ensure(market, known, from, end).pending).toBe(true);
    expect(service.ensure(market, known, from, end).pending).toBe(true);
    await Promise.resolve(); expect(recover).toHaveBeenCalledTimes(1); expect(save).not.toHaveBeenCalled();
    pending.resolve(completed); await service.settled();
    expect(save).toHaveBeenCalledWith({ candles: [], oi: [point], events: [], depth: [] }, [market]);
    expect(service.ensure(market, known, from, end)).toEqual({ pending: false, missingCandles: 0, missingOi: 0, message: null });
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('respects source cooldown and retries partial recovery after it expires', async () => {
    let clock = end;
    const recover = vi.fn(async () => ({ ...completed, missingOi: 5, error: '限流', retryAt: end + 120_000 }));
    const service = createBrowserHistoryRecovery({ recover, save: async () => {}, now: () => clock });
    service.ensure(market, known, from, end); await service.settled();
    clock += 60_000; expect(service.ensure(market, known, from, end)).toMatchObject({ pending: true, missingOi: 5, message: '限流' });
    expect(recover).toHaveBeenCalledTimes(1);
    clock += 60_001; service.ensure(market, known, from, end); await service.settled(); expect(recover).toHaveBeenCalledTimes(2);
  });

  it('does not label a newly expanded seven-day view complete from an earlier one-hour recovery', async () => {
    const service = createBrowserHistoryRecovery({ recover: async () => completed, save: async () => {}, now: () => end });
    service.ensure(market, known, from, end); await service.settled();
    expect(service.ensure(market, known, end - 7 * 86_400_000, end).pending).toBe(true);
    expect(service.ensure(market, known, from, end + 60_000).pending).toBe(true);
  });

  it('does not report persistence success when the browser transaction fails', async () => {
    const service = createBrowserHistoryRecovery({ recover: async () => completed, save: async () => { throw new Error('quota'); }, now: () => end });
    service.ensure(market, known, from, end); await service.settled();
    expect(service.ensure(market, known, from, end)).toMatchObject({ pending: true, message: expect.stringContaining('本机保存失败') });
  });

  it('cancels obsolete jobs on market change, ignores late results and avoids concurrent downloads', async () => {
    const pending = deferred<typeof completed>(), save = vi.fn(async () => {});
    let signal!: AbortSignal;
    const recover = vi.fn((_market, _known, _from, _to, s: AbortSignal) => { signal = s; return pending.promise; });
    const service = createBrowserHistoryRecovery({ recover, save, now: () => end });
    service.ensure(market, known, from, end); await Promise.resolve();
    const next = { ...market, key: 'futures:ETHUSDT', symbol: 'ETHUSDT', baseAsset: 'ETH', assetId: 'binance:ETH' };
    expect(service.ensure(next, { ...known, market: next }, from, end).pending).toBe(true);
    expect(signal.aborted).toBe(true); expect(recover).toHaveBeenCalledTimes(1);
    pending.resolve(completed); await service.settled(); expect(save).not.toHaveBeenCalled();
  });

  it('stops background work on teardown', async () => {
    const pending = deferred<typeof completed>(), save = vi.fn(async () => {});
    const service = createBrowserHistoryRecovery({ recover: () => pending.promise, save, now: () => end });
    service.ensure(market, known, from, end); service.cancel(); pending.resolve(completed); await service.settled();
    expect(save).not.toHaveBeenCalled();
  });

  it('cannot feed five-minute recovered OI into the live signal engine', () => {
    const engine = createFlowEngine(); engine.setMarkets([market]);
    expect(engine.ingestOi(point)).toBe(false);
    expect(engine.drainUpdates().oi).toEqual([]);
  });
});
