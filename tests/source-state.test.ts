import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSourceClient } from '../src/data/http';

const KEY = 'oi-monitor:v1:source-budget:v1';
const OI = 'https://fapi.binance.com/fapi/v1/openInterest?symbol=TESTUSDT';
const KLINE = 'https://fapi.binance.com/fapi/v1/klines?symbol=TESTUSDT&limit=360';
const START = 1_800_000_000_000;
const values = new Map<string, string>();
const signal = () => new AbortController().signal;
function reload(response = () => Response.json({})) {
  const transport = vi.fn(async () => response());
  vi.stubGlobal('fetch', transport);
  return { transport, request: createSourceClient(fetch, 2) };
}
beforeEach(() => {
  values.clear(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(START);
  vi.stubGlobal('window', {});
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('browser source governor survives reload', () => {
  it('restores an upstream ban for a fresh transport before any request, then recovers at its deadline', async () => {
    const first = reload(() => new Response(null, { status: 429, headers: { 'retry-after': '180' } }));
    await expect(first.request(OI, signal())).rejects.toMatchObject({ code: 'HTTP_429', retryAt: START + 180_000 });
    const next = reload();
    expect(next.request.retryAt()).toBe(START + 180_000);
    await expect(next.request(OI, signal())).rejects.toMatchObject({ code: 'RATE_LIMIT_COOLDOWN' });
    expect(next.transport).not.toHaveBeenCalled();
    vi.setSystemTime(START + 180_000);
    await next.request(OI, signal()); expect(next.transport).toHaveBeenCalledTimes(1);
  });

  it('keeps used weight in the same minute without charging the next minute for old requests', async () => {
    const first = reload(); first.request.setBinanceWeightLimit(100);
    for (let i = 0; i < 80; i++) await first.request(OI, signal());
    const next = reload();
    expect(next.request.retryAt()).toBe(START + 60_000);
    await expect(next.request(OI, signal())).rejects.toMatchObject({ code: 'RATE_LIMIT_BUDGET' });
    expect(next.transport).not.toHaveBeenCalled();
    vi.setSystemTime(START + 60_000);
    expect(next.request.retryAt()).toBe(0);
    await next.request(OI, signal()); expect(next.transport).toHaveBeenCalledTimes(1);
  });

  it('restores background limits independently so OI can still use its reserved capacity', async () => {
    const first = reload(); first.request.setBinanceWeightLimit(100);
    const background = createSourceClient(fetch, 2, { priority: 'background' });
    for (let i = 0; i < 10; i++) await background(KLINE, signal());
    const next = reload(), restoredBackground = createSourceClient(fetch, 2, { priority: 'background' });
    await expect(restoredBackground(KLINE, signal())).rejects.toMatchObject({ code: 'RATE_LIMIT_BUDGET' });
    expect(next.request.retryAt()).toBe(0);
    await next.request(OI, signal()); expect(next.transport).toHaveBeenCalledTimes(1);
  });

  it('honors a longer cooldown published by another page and never shortens it', async () => {
    const { request, transport } = reload(); request.deferUntil(START + 60_000);
    const saved = JSON.parse(values.get(KEY)!);
    values.set(KEY, JSON.stringify({ ...saved, cooldowns: { 'fapi.binance.com': START + 600_000 } }));
    request.deferUntil(START + 30_000);
    expect(request.retryAt()).toBe(START + 600_000);
    await expect(request(OI, signal())).rejects.toMatchObject({ retryAt: START + 600_000 });
    expect(transport).not.toHaveBeenCalled();
  });

  it('ignores malformed storage while preserving an in-memory ban', async () => {
    const { request, transport } = reload(); request.deferUntil(START + 60_000);
    values.set(KEY, '{bad json');
    await expect(request(OI, signal())).rejects.toMatchObject({ code: 'RATE_LIMIT_COOLDOWN' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('still protects the session when browser storage is denied', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('Denied'); }, setItem: () => { throw new Error('Denied'); } });
    const { request, transport } = reload(() => new Response(null, { status: 429 }));
    await expect(request(OI, signal())).rejects.toMatchObject({ code: 'HTTP_429' });
    await expect(request(OI, signal())).rejects.toMatchObject({ code: 'RATE_LIMIT_COOLDOWN' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
