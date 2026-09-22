export class SourceError extends Error {
  constructor(public readonly code: string, public readonly url: string, detail: string) {
    super(`${code}: ${new URL(url).hostname} ${detail}`);
    this.name = 'SourceError';
  }
}

/** A shared semaphore also bounds metadata requests, not only OI workers. */
export function createSourceClient(fetcher: typeof fetch, concurrency: number) {
  let active = 0;
  const waiters: Array<() => void> = [];
  const cooldowns = new Map<string, number>();

  async function acquire(signal: AbortSignal) {
    if (signal.aborted) throw new DOMException('采集已取消', 'AbortError');
    if (active >= concurrency) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => { signal.removeEventListener('abort', abort); resolve(); };
        const abort = () => {
          const index = waiters.indexOf(wake);
          if (index >= 0) waiters.splice(index, 1);
          reject(new DOMException('采集已取消', 'AbortError'));
        };
        waiters.push(wake);
        signal.addEventListener('abort', abort, { once: true });
      });
    } else active++;
    if (signal.aborted) { release(); throw new DOMException('采集已取消', 'AbortError'); }
  }
  function release() {
    const next = waiters.shift();
    if (next) next();
    else active--;
  }

  return async function request<T>(url: string, signal: AbortSignal, headers?: Record<string, string>): Promise<T> {
    const host = new URL(url).hostname;
    const blockedUntil = cooldowns.get(host) ?? 0;
    if (Date.now() < blockedUntil) {
      throw new SourceError('RATE_LIMIT_COOLDOWN', url, `等待至 ${new Date(blockedUntil).toISOString()}`);
    }
    await acquire(signal);
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error('REQUEST_TIMEOUT_8S')), 8000);
    try {
      if (signal.aborted) controller.abort(signal.reason);
      // A queued request must recheck the cooldown established by another worker.
      if (Date.now() < (cooldowns.get(host) ?? 0)) {
        throw new SourceError('RATE_LIMIT_COOLDOWN', url, '上游限流，本轮不重试');
      }
      const response = await fetcher(url, { signal: controller.signal, headers, cache: 'no-store' });
      if (!response.ok) {
        if (response.status === 429 || response.status === 418) {
          const retry = response.headers.get('retry-after');
          const seconds = retry == null ? NaN : Number(retry);
          const supplied = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry ?? '') - Date.now();
          const delay = Math.max(response.status === 418 ? 15 * 60_000 : 60_000, Number.isFinite(supplied) ? supplied : 0);
          cooldowns.set(host, Date.now() + delay);
        }
        throw new SourceError(`HTTP_${response.status}`, url, response.statusText || '请求失败');
      }
      return await response.json() as T;
    } catch (error) {
      if (error instanceof SourceError) throw error;
      if (controller.signal.aborted) throw new SourceError(signal.aborted ? 'ROUND_ABORTED' : 'REQUEST_TIMEOUT', url, '请求取消或超过时间预算');
      throw new SourceError('NETWORK_ERROR', url, error instanceof Error ? error.message : '网络不可用');
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      release();
    }
  };
}
