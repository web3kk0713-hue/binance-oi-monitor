import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('document', { baseURI: 'https://example.test/binance-oi-monitor/' });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('notification service-worker registration recovery', () => {
  it('clears a rejected registration and succeeds on the next attempt', async () => {
    const worker = { showNotification: vi.fn(async () => {}) };
    const register = vi.fn().mockRejectedValueOnce(new Error('temporary network error')).mockResolvedValue(worker);
    vi.stubGlobal('navigator', { serviceWorker: { register, ready: Promise.resolve(worker) } });
    const { registerNotifications } = await import('../src/web/notifications');
    await expect(registerNotifications()).rejects.toThrow('temporary network error');
    await expect(registerNotifications()).resolves.toBe(worker);
    expect(register).toHaveBeenCalledTimes(2);
    expect(register).toHaveBeenNthCalledWith(2, 'https://example.test/binance-oi-monitor/sw.js', { scope: './' });
  });
  it('deduplicates concurrent registrations and retains a successfully ready worker', async () => {
    const worker = { showNotification: vi.fn() }, register = vi.fn().mockResolvedValue(worker);
    vi.stubGlobal('navigator', { serviceWorker: { register, ready: Promise.resolve(worker) } });
    const { registerNotifications } = await import('../src/web/notifications');
    const first = registerNotifications(), second = registerNotifications();
    expect(second).toBe(first); expect(await first).toBe(worker); expect(await registerNotifications()).toBe(worker);
    expect(register).toHaveBeenCalledTimes(1);
  });
  it('shares one failure with concurrent callers, then permits a fresh deduplicated retry', async () => {
    const worker = { showNotification: vi.fn() }, register = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(worker);
    vi.stubGlobal('navigator', { serviceWorker: { register, ready: Promise.resolve(worker) } });
    const { registerNotifications } = await import('../src/web/notifications');
    const failed = await Promise.allSettled([registerNotifications(), registerNotifications()]);
    expect(failed.every(result => result.status === 'rejected')).toBe(true); expect(register).toHaveBeenCalledTimes(1);
    const retry = await Promise.all([registerNotifications(), registerNotifications()]);
    expect(retry).toEqual([worker, worker]); expect(register).toHaveBeenCalledTimes(2);
  });
  it('also retries if obtaining the ready worker rejects after registration succeeds', async () => {
    const worker = { showNotification: vi.fn() }, register = vi.fn().mockResolvedValue(worker);
    let failReady = true;
    const serviceWorker = { register, get ready() { return failReady ? Promise.reject(new Error('activation failed')) : Promise.resolve(worker); } };
    vi.stubGlobal('navigator', { serviceWorker });
    const { registerNotifications } = await import('../src/web/notifications');
    await expect(registerNotifications()).rejects.toThrow('activation failed');
    failReady = false;
    await expect(registerNotifications()).resolves.toBe(worker); expect(register).toHaveBeenCalledTimes(2);
  });
  it('reports unsupported service workers without poisoning a later supported attempt', async () => {
    vi.stubGlobal('navigator', {});
    const { registerNotifications } = await import('../src/web/notifications');
    await expect(registerNotifications()).rejects.toThrow('不支持系统推送');
    const worker = { showNotification: vi.fn() }, register = vi.fn().mockResolvedValue(worker);
    vi.stubGlobal('navigator', { serviceWorker: { register, ready: Promise.resolve(worker) } });
    await expect(registerNotifications()).resolves.toBe(worker); expect(register).toHaveBeenCalledTimes(1);
  });
});
