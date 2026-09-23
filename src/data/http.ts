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
  // A conservative bootstrap budget is replaced by exchangeInfo's current limit.
  // Keep 20% free for metadata, other clients on the same IP, and in-flight requests.
  let binanceLimit = 1200;
  let weightMinute = -1;
  let usedWeight = 0;
  function refreshWeightWindow() {
    const minute = Math.floor(Date.now() / 60_000);
    if (minute !== weightMinute) { weightMinute = minute; usedWeight = 0; }
  }
  function reserveWeight(url: URL) {
    if (url.hostname !== 'fapi.binance.com') return;
    refreshWeightWindow();
    const weight = !url.searchParams.has('symbol') && ['/fapi/v1/premiumIndex', '/fapi/v1/assetIndex'].includes(url.pathname) ? 10 : 1;
    const budget = Math.floor(binanceLimit * 0.8);
    if (usedWeight + weight > budget) throw new SourceError('RATE_LIMIT_BUDGET', url.href, `主动配额保护 ${usedWeight}/${budget}，本轮跳过，等待下一配额窗口`);
    usedWeight += weight;
  }

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

  async function request<T>(url: string, signal: AbortSignal, headers?: Record<string, string>): Promise<T> {
    const target = new URL(url);
    const host = target.hostname;
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
      reserveWeight(target);
      const response = await fetcher(url, { signal: controller.signal, headers, cache: 'no-store' });
      if (host === 'fapi.binance.com') {
        refreshWeightWindow();
        const header = response.headers.get('x-mbx-used-weight-1m');
        const upstreamWeight = header === null ? NaN : Number(header);
        if (Number.isFinite(upstreamWeight) && upstreamWeight >= 0) usedWeight = Math.max(usedWeight, upstreamWeight);
      }
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
  }
  return Object.assign(request, {
    setBinanceWeightLimit(limit: number) {
      if (Number.isInteger(limit) && limit > 0 && limit <= 10_000_000) binanceLimit = limit;
    },
  });
}
