import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFlowBackfill } from '../src/data/flowBackfill';
import type { FlowCandle, FlowHistory, FlowMarket, FlowOi } from '../src/shared/flowTypes';

const MINUTE = 60_000, FIVE = 5 * MINUTE, DAY = 24 * 60 * MINUTE;
const NOW = Date.UTC(2026, 8, 29, 12);
const market: FlowMarket = { key: 'futures:BTCUSDT', venue: 'futures', symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', assetId: 'binance:BTC' };
const spot: FlowMarket = { ...market, key: 'spot:BTCUSDT', venue: 'spot' };
const signal = () => new AbortController().signal;
function history(candles: FlowCandle[] = [], oi: FlowOi[] = [], selected = market): FlowHistory {
  return { market: selected, from: NOW - 7 * DAY, to: NOW, candles, oi, events: [], depth: [] };
}
function rawCandle(time: number): unknown[] { return [time, '100', '102', '99', '101', '10', time + MINUTE - 1, '1010', 12, '6', '606']; }
function candle(time: number, selected = market): FlowCandle {
  return { marketKey: selected.key, openTime: time, closeTime: time + MINUTE - 1, open: 100, high: 102, low: 99, close: 101,
    volume: 10, quoteVolume: 1010, takerBuyQuote: 606, trades: 12, closed: true, source: 'stream', sourceTime: time + MINUTE,
    receivedAt: time + MINUTE };
}
function rawOi(time: number) { return { symbol: market.symbol, timestamp: time, sumOpenInterest: '123.456', sumOpenInterestValue: '987654321' }; }
function page(url: URL): unknown[] {
  const start = Number(url.searchParams.get('startTime')), end = Number(url.searchParams.get('endTime'));
  const isOi = url.pathname.endsWith('openInterestHist'), step = isOi ? FIVE : MINUTE;
  const rows: unknown[] = [];
  for (let time = start; time <= end; time += step) rows.push(isOi ? rawOi(time) : rawCandle(time));
  return rows;
}
function transport(reply: (url: URL, init?: RequestInit) => Response | Promise<Response> = url => Response.json(page(url))) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => reply(new URL(String(input)), init)) as unknown as ReturnType<typeof vi.fn> & typeof fetch;
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('bounded browser-only history recovery', () => {
  it('bounds seven-day recovery to six alternating newest-first pages and resumes only missing data', async () => {
    const fetcher = transport(), recovery = createFlowBackfill({ fetcher });
    const first = await recovery.recover(market, history(), NOW - 30 * DAY, NOW + DAY, signal());
    expect(fetcher).toHaveBeenCalledTimes(6);
    const urls = fetcher.mock.calls.map(([url]) => new URL(String(url)));
    expect(urls.map(url => url.pathname.endsWith('openInterestHist'))).toEqual([false, true, false, true, false, true]);
    expect(urls.every(url => Number(url.searchParams.get('limit')) <= 500 && Number(url.searchParams.get('startTime')) >= NOW - 7 * DAY
      && Number(url.searchParams.get('endTime')) <= NOW)).toBe(true);
    expect(Number(urls[0].searchParams.get('endTime'))).toBe(NOW - 1);
    expect(Number(urls[1].searchParams.get('endTime'))).toBe(NOW);
    expect(first.candles).toHaveLength(1500); expect(first.oi).toHaveLength(1500);
    expect(first.missingCandles).toBe(10080 - 1500); expect(first.missingOi).toBe(2017 - 1500);
    expect(first.error).toContain('6页'); expect(first.retryAt).toBe(NOW + 30_000);
    expect(first.candles.every(row => row.source === 'rest' && row.receivedAt === NOW)).toBe(true);
    const paused = await recovery.recover(market, history(first.candles, first.oi), NOW - 7 * DAY, NOW, signal());
    expect(fetcher).toHaveBeenCalledTimes(6); expect(paused.candles).toEqual([]); expect(paused.error).toContain('冷却');
    vi.setSystemTime(NOW + 30_000);
    const second = await recovery.recover(market, history(first.candles, first.oi), NOW - 7 * DAY, NOW, signal());
    expect(fetcher).toHaveBeenCalledTimes(12); expect(second.missingOi).toBe(0);
    expect(second.candles.every(row => !first.candles.some(old => old.openTime === row.openTime))).toBe(true);
    expect(second.oi.every(row => !first.oi.some(old => old.timestamp === row.timestamp))).toBe(true);
  });

  it('requests only real minute gaps, excluding forming and partially requested candles', async () => {
    const fetcher = transport(), recovery = createFlowBackfill({ fetcher });
    const stored = [candle(NOW - 5 * MINUTE, spot), candle(NOW - 3 * MINUTE, spot), candle(NOW - 2 * MINUTE, spot)];
    const result = await recovery.recover(spot, history(stored, [], spot), NOW - 5 * MINUTE, NOW + 30_000, signal());
    expect(fetcher).toHaveBeenCalledTimes(2); expect(result.candles.map(row => row.openTime)).toEqual([NOW - 4 * MINUTE, NOW - MINUTE]);
    expect(result.missingCandles).toBe(0); expect(result.missingOi).toBe(0); expect(result.oi).toEqual([]); expect(result.error).toBeNull();
    const urls = fetcher.mock.calls.map(([url]) => new URL(String(url)));
    expect(urls.every(url => url.hostname === 'api.binance.com')).toBe(true);
    expect(Number(urls[0].searchParams.get('startTime'))).toBe(NOW - MINUTE);
    const noClosed = await createFlowBackfill({ fetcher }).recover(spot, history([], [], spot), NOW - MINUTE + 1, NOW - 1, signal());
    expect(noClosed.missingCandles).toBe(0); expect(noClosed.candles).toEqual([]);
  });

  it('preserves successful K lines when the OI page is empty and applies a one-minute cooldown', async () => {
    const fetcher = transport(url => Response.json(url.pathname.endsWith('openInterestHist') ? [] : page(url)));
    const recovery = createFlowBackfill({ fetcher });
    const result = await recovery.recover(market, history(), NOW - FIVE, NOW, signal());
    expect(result.candles).toHaveLength(5); expect(result.missingCandles).toBe(0); expect(result.missingOi).toBe(2);
    expect(result.error).toContain('空页'); expect(result.retryAt).toBe(NOW + MINUTE); expect(fetcher).toHaveBeenCalledTimes(2);
    await recovery.recover(market, history(result.candles), NOW - FIVE, NOW, signal()); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not starve older OI across rounds when the newest five-minute statistic stays unpublished', async () => {
    const fetcher = transport(url => Response.json(url.pathname.endsWith('openInterestHist')
      ? page(url).filter(row => (row as { timestamp: number }).timestamp !== NOW) : page(url)));
    const recovery = createFlowBackfill({ fetcher });
    const from = NOW - 6 * DAY;
    const first = await recovery.recover(market, history(), from, NOW, signal());
    expect(first.oi).toHaveLength(1499); expect(first.missingOi).toBe(1729 - 1499);
    expect(first.error).toContain('缺口'); expect(fetcher).toHaveBeenCalledTimes(6);
    vi.setSystemTime(NOW + MINUTE);
    const second = await recovery.recover(market, history(first.candles, first.oi), from, NOW, signal());
    expect(second.oi).toHaveLength(229); expect(second.missingOi).toBe(1);
    expect([...first.oi, ...second.oi].some(row => row.timestamp === from)).toBe(true);
    expect(second.oi.every(row => row.timestamp !== NOW)).toBe(true); expect(second.error).toContain('空页');
    expect(fetcher).toHaveBeenCalledTimes(12);
    const newest = fetcher.mock.calls.slice(6).map(([url]) => new URL(String(url))).find(url => url.pathname.endsWith('openInterestHist'))!;
    expect(newest.searchParams.get('startTime')).toBe(String(NOW)); expect(newest.searchParams.get('endTime')).toBe(String(NOW));
  });

  it('preserves the first source success and honors shared HTTP 429 Retry-After without alternate hosts', async () => {
    const fetcher = transport(url => url.pathname.endsWith('openInterestHist')
      ? new Response('', { status: 429, headers: { 'retry-after': '120' } }) : Response.json(page(url)));
    const result = await createFlowBackfill({ fetcher }).recover(market, history(), NOW - FIVE, NOW, signal());
    expect(result.candles).toHaveLength(5); expect(result.oi).toEqual([]); expect(result.missingOi).toBe(2);
    expect(result.error).toContain('HTTP_429'); expect(result.retryAt).toBe(NOW + 120_000);
    expect(fetcher.mock.calls.every(([url]) => new URL(String(url)).hostname === 'fapi.binance.com')).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('bounds elapsed recovery work at twenty seconds and retains already successful pages', async () => {
    let calls = 0;
    const fetcher = transport(async (url, init) => {
      calls++;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 7000);
        init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal!.reason); }, { once: true });
      });
      return Response.json(page(url));
    });
    const pending = createFlowBackfill({ fetcher }).recover(market, history(), NOW - 7 * DAY, NOW, signal());
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await pending;
    expect(calls).toBe(3); expect(result.candles).toHaveLength(500); expect(result.oi).toHaveLength(500);
    expect(result.error).toContain('20秒'); expect(result.retryAt).toBe(NOW + 80_000);
  });

  it('cancels an active request and makes no subsequent request', async () => {
    const controller = new AbortController();
    const fetcher = transport((_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    const pending = createFlowBackfill({ fetcher }).recover(market, history(), NOW - FIVE, NOW, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0); controller.abort(); await rejected;
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(createFlowBackfill({ fetcher }).recover(market, history(), NOW - FIVE, NOW, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects wrong identities, future/unaligned/NaN OI and duplicate rows without inventing FDV or USD', async () => {
    const existing = Array.from({ length: 5 }, (_, i) => candle(NOW - FIVE + i * MINUTE));
    const fetcher = transport(() => Response.json([
      { ...rawOi(NOW - FIVE), symbol: 'ETHUSDT' }, { ...rawOi(NOW - FIVE), sumOpenInterest: 'NaN' },
      rawOi(NOW + FIVE), rawOi(NOW - 1), rawOi(NOW), rawOi(NOW),
    ]));
    const result = await createFlowBackfill({ fetcher }).recover(market, history(existing), NOW - FIVE, NOW, signal());
    expect(result.oi).toEqual([{ marketKey: market.key, timestamp: NOW, receivedAt: NOW, quantity: 123.456, source: 'rest-5m' }]);
    expect(result.missingOi).toBe(1); expect(result.error).toContain('无效');
    expect(Object.keys(result.oi[0]).sort()).toEqual(['marketKey', 'quantity', 'receivedAt', 'source', 'timestamp']);
    const url = new URL(String(fetcher.mock.calls[0][0])); expect(url.pathname).toBe('/futures/data/openInterestHist'); expect(url.searchParams.get('period')).toBe('5m');
  });

  it('rejects invalid/future/duplicate K lines and counts the still-missing closed minute', async () => {
    const malformed = rawCandle(NOW - 2 * MINUTE); malformed[2] = 'NaN';
    const fetcher = transport(() => Response.json([malformed, rawCandle(NOW - MINUTE), rawCandle(NOW - MINUTE), rawCandle(NOW)]));
    const result = await createFlowBackfill({ fetcher }).recover(spot, history([], [], spot), NOW - 2 * MINUTE, NOW, signal());
    expect(result.candles).toHaveLength(1); expect(result.candles[0].openTime).toBe(NOW - MINUTE); expect(result.missingCandles).toBe(1);
    expect(result.error).toContain('无效'); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not trust malformed known rows, mismatched market metadata or unsafe request parameters', async () => {
    const fetcher = transport(), recovery = createFlowBackfill({ fetcher });
    const known = history([{ ...candle(NOW - MINUTE, spot), close: NaN }, { ...candle(NOW - 2 * MINUTE, spot), marketKey: market.key }], [], spot);
    expect((await recovery.recover(spot, known, NOW - 2 * MINUTE, NOW, signal())).candles).toHaveLength(2);
    for (const [from, to] of [[NaN, NOW], [NOW, NOW - 1], [NOW - 1.5, NOW], [0, NOW], [NOW - MINUTE, Infinity]]) {
      await expect(recovery.recover(market, history(), from, to, signal())).rejects.toThrow('参数');
    }
    await expect(recovery.recover({ ...market, symbol: 'BTCUSDT?x=1' }, history(), NOW - MINUTE, NOW, signal())).rejects.toThrow('身份');
    await expect(recovery.recover({ ...market, assetId: 'binance:ETH' }, history(), NOW - MINUTE, NOW, signal())).rejects.toThrow('身份');
    await expect(recovery.recover(spot, history(), NOW - MINUTE, NOW, signal())).rejects.toThrow('身份');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('continues the other source after a non-throttle failure without looping on the failed page', async () => {
    const fetcher = transport(url => url.pathname.endsWith('/klines') ? new Response('', { status: 500 }) : Response.json(page(url)));
    const result = await createFlowBackfill({ fetcher }).recover(market, history(), NOW - FIVE, NOW, signal());
    expect(result.candles).toEqual([]); expect(result.missingCandles).toBe(5); expect(result.oi).toHaveLength(2);
    expect(result.error).toContain('HTTP_500'); expect(result.retryAt).toBe(NOW + MINUTE); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('coalesces duplicate in-flight markets and keeps transport requests serial across markets', async () => {
    let active = 0, maximum = 0;
    const fetcher = transport(async url => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 10)); active--; return Response.json(page(url)); });
    const recovery = createFlowBackfill({ fetcher });
    const first = recovery.recover(spot, history([], [], spot), NOW - MINUTE, NOW, signal());
    const duplicate = await recovery.recover(spot, history([], [], spot), NOW - MINUTE, NOW, signal());
    expect(duplicate.error).toContain('正在补取');
    const second = recovery.recover(market, history(), NOW - MINUTE, NOW, signal());
    await vi.advanceTimersByTimeAsync(50); await Promise.all([first, second]);
    expect(maximum).toBe(1); expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('bounds cooldown metadata without evicting still-active cooldowns to bypass the limit', async () => {
    const fetcher = transport(), recovery = createFlowBackfill({ fetcher });
    const markets = Array.from({ length: 129 }, (_, i): FlowMarket => ({ ...spot, key: `spot:X${i}USDT`, symbol: `X${i}USDT`, baseAsset: `X${i}`, assetId: `binance:X${i}` }));
    for (const selected of markets.slice(0, 128)) await recovery.recover(selected, history([], [], selected), NOW - MINUTE, NOW, signal());
    const overflow = await recovery.recover(markets[128], history([], [], markets[128]), NOW - MINUTE, NOW, signal());
    expect(overflow.error).toContain('已满'); expect(fetcher).toHaveBeenCalledTimes(128);
    const first = await recovery.recover(markets[0], history([], [], markets[0]), NOW - MINUTE, NOW, signal());
    expect(first.error).toContain('冷却'); expect(fetcher).toHaveBeenCalledTimes(128);
    vi.setSystemTime(NOW + 30_000);
    const resumed = await recovery.recover(markets[128], history([], [], markets[128]), NOW - MINUTE, NOW, signal());
    expect(resumed.missingCandles).toBe(0); expect(fetcher).toHaveBeenCalledTimes(129);
  });
});
