import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSourceClient } from '../src/data/http';

const OI = 'https://fapi.binance.com/fapi/v1/openInterest?symbol=TESTUSDT';
const KLINE = 'https://fapi.binance.com/fapi/v1/klines?symbol=TESTUSDT&limit=360';
const signal = () => new AbortController().signal;
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('rate-limit recovery uses a real deadline, not blind refresh', () => {
  it('shares a rolling OI-history quota between metadata and backfill without starving live OI', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1_800_000_000_000);
    const fetcher = vi.fn(async () => Response.json({})) as unknown as typeof fetch;
    const metadata = createSourceClient(fetcher, 4, { priority: 'background' });
    const recovery = createSourceClient(fetcher, 1, { priority: 'background' });
    const live = createSourceClient(fetcher, 12); live.setBinanceWeightLimit(10_000);
    const history = 'https://fapi.binance.com/futures/data/openInterestHist?symbol=TESTUSDT&period=5m&limit=1';
    for (let i = 0; i < 400; i++) await metadata(history, signal());
    vi.setSystemTime(1_800_000_060_000);
    for (let i = 0; i < 400; i++) await recovery(history, signal());
    await expect(metadata(history, signal())).rejects.toMatchObject({ code: 'RATE_LIMIT_HISTORY_BUDGET', retryAt: 1_800_000_300_000 });
    await live(OI, signal());
    expect(fetcher).toHaveBeenCalledTimes(801);
    expect(live.retryAt()).toBe(0);
    vi.setSystemTime(1_800_000_300_000);
    await metadata(history, signal());
    expect(fetcher).toHaveBeenCalledTimes(802);
  });

  it('exposes the first 429 deadline and never lets a later 429 shorten an existing 418 ban', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1_800_000_000_000);
    const replies: ((response: Response) => void)[] = [];
    const fetcher = vi.fn(() => new Promise<Response>(resolve => replies.push(resolve))) as unknown as typeof fetch;
    const request = createSourceClient(fetcher, 2);
    const first = request(OI, signal()), second = request(OI, signal());
    const failures = Promise.allSettled([first, second]); await Promise.resolve();
    replies[0](new Response(null, { status: 418, headers: { 'retry-after': '1800' } }));
    await first.catch(() => undefined);
    replies[1](new Response(null, { status: 429, headers: { 'retry-after': '60' } }));
    await failures;
    vi.setSystemTime(Date.now() + 61_000);
    const blocked = request(OI, signal());
    // A shortened ban sends an unexpected third fetch: fail immediately rather than hanging.
    await Promise.resolve();
    if (replies[2]) replies[2](Response.json({}));
    await expect(blocked).rejects.toMatchObject({ code: 'RATE_LIMIT_COOLDOWN' });
    expect(request.retryAt()).toBe(1_800_001_800_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reserves most exchange capacity for OI while bounding background history independently', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1_800_000_000_000);
    const fetcher = vi.fn(async () => Response.json({})) as unknown as typeof fetch;
    const background = createSourceClient(fetcher, 2, { priority: 'background' });
    const critical = createSourceClient(fetcher, 12); critical.setBinanceWeightLimit(100);
    for (let i = 0; i < 10; i++) await background(KLINE, signal());
    await expect(background(KLINE, signal())).rejects.toMatchObject({ code: 'RATE_LIMIT_BUDGET' });
    for (let i = 0; i < 60; i++) await critical(OI, signal());
    await expect(critical(OI, signal())).rejects.toMatchObject({ code: 'RATE_LIMIT_BUDGET' });
    expect(critical.retryAt()).toBe(1_800_000_060_000);
    vi.setSystemTime(1_800_000_060_000);
    expect(critical.retryAt()).toBe(0);
    await critical(OI, signal());
  });

  it('restores only a future deadline and keeps other source hosts independent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1_800_000_000_000);
    const fetcher = vi.fn(async () => Response.json({})) as unknown as typeof fetch;
    const request = createSourceClient(fetcher, 1);
    request.deferUntil(Date.now() + 120_000);
    request.deferUntil(Date.now() + 30_000);
    await expect(request(OI, signal())).rejects.toMatchObject({ code: 'RATE_LIMIT_COOLDOWN' });
    await request('https://api.coingecko.com/test', signal());
    expect(fetcher).toHaveBeenCalledTimes(1);
    request.deferUntil(NaN); request.deferUntil(-1);
    expect(request.retryAt()).toBe(1_800_000_120_000);
  });
});
