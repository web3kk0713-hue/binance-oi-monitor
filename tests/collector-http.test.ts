// Deterministic transport tests; never use live provider endpoints.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSourceClient } from '../src/data/http';

afterEach(() => { vi.useRealTimers(); });

describe('source transport budgets and rate limits', () => {
  it('applies a dynamically supplied weight budget before sending requests and resets the next minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_800_000_000_000);
    const fetcher = vi.fn(async () => Response.json({ ok: true })) as unknown as typeof fetch;
    const request = createSourceClient(fetcher, 12);
    request.setBinanceWeightLimit(10);
    const signal = new AbortController().signal;
    for (let i = 0; i < 8; i++) await request(`https://fapi.binance.com/fapi/v1/openInterest?symbol=TEST${i}`, signal);
    await expect(request('https://fapi.binance.com/fapi/v1/openInterest?symbol=BLOCKED', signal)).rejects.toMatchObject({ code: 'RATE_LIMIT_BUDGET' });
    expect(fetcher).toHaveBeenCalledTimes(8);
    vi.setSystemTime(Date.now() + 60_000);
    await request('https://fapi.binance.com/fapi/v1/openInterest?symbol=NEXT', signal);
    expect(fetcher).toHaveBeenCalledTimes(9);
  });

  it('counts bulk mark/FX weights and upstream shared-IP usage, without throttling unrelated hosts', async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true })) as unknown as typeof fetch;
    const request = createSourceClient(fetcher, 12);
    request.setBinanceWeightLimit(25);
    const signal = new AbortController().signal;
    await request('https://fapi.binance.com/fapi/v1/premiumIndex', signal);
    await request('https://fapi.binance.com/fapi/v1/assetIndex', signal);
    await expect(request('https://fapi.binance.com/fapi/v1/openInterest?symbol=TEST', signal)).rejects.toMatchObject({ code: 'RATE_LIMIT_BUDGET' });
    await request('https://example.org/supply', signal);
    expect(fetcher).toHaveBeenCalledTimes(3);

    const busyFetcher = vi.fn(async () => Response.json({}, { headers: { 'x-mbx-used-weight-1m': '80' } })) as unknown as typeof fetch;
    const sharedIp = createSourceClient(busyFetcher, 12);
    sharedIp.setBinanceWeightLimit(100);
    await sharedIp('https://fapi.binance.com/fapi/v1/exchangeInfo', signal);
    await expect(sharedIp('https://fapi.binance.com/fapi/v1/openInterest?symbol=TEST', signal)).rejects.toMatchObject({ code: 'RATE_LIMIT_BUDGET' });
    expect(busyFetcher).toHaveBeenCalledTimes(1);
  });

  it('bounds all concurrent requests and removes aborted queued requests', async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => {
      active++;
      maxActive = Math.max(active, maxActive);
      releases.push(() => { active--; resolve(Response.json({ ok: true })); });
    })) as unknown as typeof fetch;
    const request = createSourceClient(fetcher, 2);
    const allowed = new AbortController();
    const cancelled = new AbortController();
    const first = request('https://example.org/1', allowed.signal);
    const second = request('https://example.org/2', allowed.signal);
    const queued = request('https://example.org/3', cancelled.signal);
    const rejection = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    cancelled.abort();
    await rejection;
    releases.splice(0).forEach(release => release());
    await Promise.all([first, second]);
    expect(maxActive).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('aborts a slow upstream after 8 seconds instead of consuming the entire round', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    })) as unknown as typeof fetch;
    const request = createSourceClient(fetcher, 1);
    const work = request('https://example.org/slow', new AbortController().signal);
    const rejection = expect(work).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(8001);
    await rejection;
  });

  it('respects the upstream Retry-After window across rounds without hammering the same host', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fetcher = vi.fn(async () => new Response(null, { status: 429, headers: { 'retry-after': '180' } })) as unknown as typeof fetch;
    const request = createSourceClient(fetcher, 1);
    const signal = new AbortController().signal;
    await expect(request('https://example.org/first', signal)).rejects.toMatchObject({ code: 'HTTP_429' });
    vi.setSystemTime(Date.now() + 120_000);
    await expect(request('https://example.org/next', signal)).rejects.toMatchObject({ code: 'RATE_LIMIT_COOLDOWN' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 61_000);
    await expect(request('https://example.org/next', signal)).rejects.toMatchObject({ code: 'HTTP_429' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
