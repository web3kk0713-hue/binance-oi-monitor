// Deterministic transport tests; never use live provider endpoints.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSourceClient } from '../src/data/http';

afterEach(() => { vi.useRealTimers(); });

describe('source transport budgets and rate limits', () => {
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
