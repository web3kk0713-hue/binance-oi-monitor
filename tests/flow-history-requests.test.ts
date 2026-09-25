import { describe, expect, it, vi } from 'vitest';
import type { FlowHistory } from '../src/shared/flowTypes';
import { createFlowHistoryRequests } from '../src/web/useFlowMonitor';

const end = 1_800_000_000_000;
const history: FlowHistory = { market: null, from: end - 3_600_000, to: end, candles: [], events: [], depth: [], oi: [] };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

describe('bounded shared history requests', () => {
  it('shares only an identical in-flight market/window request', async () => {
    const pending = deferred<FlowHistory>(); const load = vi.fn(() => pending.promise);
    const requests = createFlowHistoryRequests(load);
    const first = requests.read('futures:BTCUSDT', 1, end), second = requests.read('futures:BTCUSDT', 1, end);
    await Promise.resolve(); expect(load).toHaveBeenCalledTimes(1);
    pending.resolve(history); expect(await first).toBe(history); expect(await second).toBe(history);
  });

  it.each([
    ['spot:BTCUSDT', 1, end], ['futures:ETHUSDT', 1, end],
    ['futures:BTCUSDT', 24, end], ['futures:BTCUSDT', 1, end - 1],
  ] as const)('does not merge a different market or observable replay cutoff (%s, %s, %s)', async (key, hours, to) => {
    const load = vi.fn(async () => history); const requests = createFlowHistoryRequests(load);
    await Promise.all([requests.read('futures:BTCUSDT', 1, end), requests.read(key, hours, to)]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not cache completed ranges whose late evidence may have changed', async () => {
    const load = vi.fn(async () => history); const requests = createFlowHistoryRequests(load);
    await requests.read('futures:BTCUSDT', 1, end); await requests.read('futures:BTCUSDT', 1, end);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('cancels one consumer without aborting another consumer sharing its request', async () => {
    const pending = deferred<FlowHistory>(); let sourceSignal!: AbortSignal;
    const load = vi.fn((_key: string, _hours: number, _to: number, signal: AbortSignal) => { sourceSignal = signal; return pending.promise; });
    const requests = createFlowHistoryRequests(load), consumer = new AbortController();
    const first = requests.read('futures:BTCUSDT', 1, end, consumer.signal);
    const second = requests.read('futures:BTCUSDT', 1, end);
    await Promise.resolve(); const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    consumer.abort(); await rejected; expect(sourceSignal.aborted).toBe(false);
    pending.resolve(history); expect(await second).toBe(history); expect(load).toHaveBeenCalledTimes(1);
  });

  it('aborts the underlying request once its last consumer leaves and permits a clean retry', async () => {
    const pending = deferred<FlowHistory>(); let sourceSignal!: AbortSignal;
    const load = vi.fn((_key: string, _hours: number, _to: number, signal: AbortSignal) => { sourceSignal = signal; return pending.promise; });
    const requests = createFlowHistoryRequests(load), consumer = new AbortController();
    const first = requests.read('futures:BTCUSDT', 1, end, consumer.signal);
    await Promise.resolve(); const oldSource = sourceSignal, rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    consumer.abort(); await rejected; expect(oldSource.aborted).toBe(true);
    const retry = requests.read('futures:BTCUSDT', 1, end); await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(2); expect(sourceSignal).not.toBe(oldSource); expect(sourceSignal.aborted).toBe(false);
    pending.resolve(history); expect(await retry).toBe(history);
  });

  it('rejects already-aborted reads before starting any loader work', async () => {
    const load = vi.fn(async () => history), requests = createFlowHistoryRequests(load), consumer = new AbortController();
    consumer.abort(new Error('cancelled before request'));
    await expect(requests.read('futures:BTCUSDT', 1, end, consumer.signal)).rejects.toThrow('cancelled before request');
    expect(load).not.toHaveBeenCalled();
  });

  it('cancelAll immediately rejects subscribers even when a local storage read ignores cancellation', async () => {
    const pending = deferred<FlowHistory>(), requests = createFlowHistoryRequests(() => pending.promise);
    const first = requests.read('futures:BTCUSDT', 1, end), second = requests.read('futures:ETHUSDT', 1, end);
    await Promise.resolve();
    const rejectedFirst = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const rejectedSecond = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    requests.cancelAll(); await Promise.all([rejectedFirst, rejectedSecond]);
    pending.resolve(history); await Promise.resolve();
  });

  it('shares failure without keeping a failed response and then retries', async () => {
    const pending = deferred<FlowHistory>(); const load = vi.fn(() => pending.promise);
    const requests = createFlowHistoryRequests(load);
    const first = requests.read('futures:BTCUSDT', 1, end), second = requests.read('futures:BTCUSDT', 1, end);
    const rejectedFirst = expect(first).rejects.toThrow('offline'), rejectedSecond = expect(second).rejects.toThrow('offline');
    pending.reject(new Error('offline')); await Promise.all([rejectedFirst, rejectedSecond]);
    load.mockResolvedValue(history); expect(await requests.read('futures:BTCUSDT', 1, end)).toBe(history);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('preserves rejection values including null instead of resolving undefined', async () => {
    const requests = createFlowHistoryRequests(() => Promise.reject(null));
    await expect(requests.read('futures:BTCUSDT', 1, end)).rejects.toBeNull();
  });
});
