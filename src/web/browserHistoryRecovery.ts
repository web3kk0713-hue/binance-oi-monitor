import type { FlowHistory, FlowMarket, FlowUpdate } from '../shared/flowTypes';

type Recovery = NonNullable<FlowHistory['recovery']>;
interface Recovered {
  candles: FlowHistory['candles']; oi: FlowHistory['oi']; missingCandles: number;
  missingOi: number; error: string | null; retryAt: number;
}
interface Options {
  recover: (market: FlowMarket, known: FlowHistory, from: number, to: number, signal: AbortSignal) => Promise<Recovered>;
  save: (update: FlowUpdate, markets: FlowMarket[]) => Promise<void>;
  now?: () => number;
}

/** One low-priority archive job. Reads never wait for the network and never feed the live signal engine. */
export function createBrowserHistoryRecovery(options: Options) {
  const now = options.now ?? Date.now;
  const states = new Map<string, { value: Recovery; retryAt: number; from: number; to: number }>();
  let active: { key: string; from: number; to: number; controller: AbortController; promise: Promise<void> } | null = null;
  const waiting = (): Recovery => ({ pending: true, missingCandles: 0, missingOi: 0, message: null });
  function ensure(market: FlowMarket, known: FlowHistory, from: number, to: number): Recovery {
    const key = market.key, old = states.get(key);
    if (active) {
      // A rolling live cutoff is not a new job; changing market or expanding the view is.
      if (active.key !== key || from < active.from - 60_000 || to < active.to - 60_000) active.controller.abort();
      return active.key === key && !active.controller.signal.aborted ? { ...(old?.value ?? waiting()), pending: true } : waiting();
    }
    if (old && now() < old.retryAt) {
      const sameRange = Math.ceil(from / 60_000) >= Math.ceil(old.from / 60_000)
        && Math.floor(to / 60_000) <= Math.floor(old.to / 60_000);
      return sameRange ? old.value : { ...waiting(), message: '等待补取冷却结束；实时采集继续' };
    }
    const controller = new AbortController();
    const job = { key, from, to, controller, promise: Promise.resolve() };
    active = job;
    job.promise = Promise.resolve().then(async () => {
      try {
        const result = await options.recover(market, known, from, to, controller.signal);
        if (controller.signal.aborted) return;
        if (result.candles.length || result.oi.length) {
          // No events, depth, FDV, or personal-position updates can originate in this path.
          await options.save({ candles: result.candles, oi: result.oi, events: [], depth: [] }, [market]);
        }
        if (controller.signal.aborted) return;
        states.delete(key);
        states.set(key, { from, to, retryAt: Math.max(now() + 30_000, result.retryAt), value: {
          pending: result.missingCandles > 0 || result.missingOi > 0,
          missingCandles: result.missingCandles, missingOi: result.missingOi, message: result.error,
        } });
      } catch {
        if (!controller.signal.aborted) states.set(key, { from, to, retryAt: now() + 60_000, value: {
          pending: true, missingCandles: old?.value.missingCandles ?? 0, missingOi: old?.value.missingOi ?? 0,
          message: '历史补取或本机保存失败，稍后自动重试；未确认的数据仍留空',
        } });
      } finally {
        if (active === job) active = null;
        while (states.size > 8) states.delete(states.keys().next().value!);
      }
    });
    return waiting();
  }
  return { ensure, cancel() { active?.controller.abort(); }, settled: () => active?.promise ?? Promise.resolve() };
}
