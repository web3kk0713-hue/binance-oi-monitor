export class SourceError extends Error {
  constructor(public readonly code: string, public readonly url: string, detail: string, public readonly retryAt = 0) {
    super(`${code}: ${new URL(url).hostname} ${detail}`);
    this.name = 'SourceError';
  }
}

type Governor = { cooldowns: Map<string, number>; limit: number; minute: number; used: number; backgroundUsed: number; blocked: number; backgroundBlocked: number };
const governors = new WeakMap<typeof fetch, Governor>();
const GOVERNOR_KEY = 'oi-monitor:v1:source-budget:v1';
export function binanceRequestWeight(url: URL): number {
  const limit = Number(url.searchParams.get('limit') ?? 500);
  if (url.pathname === '/fapi/v1/klines') return limit < 100 ? 1 : limit < 500 ? 2 : limit <= 1000 ? 5 : 10;
  if (url.pathname === '/fapi/v1/depth') return limit <= 50 ? 2 : limit <= 100 ? 5 : limit <= 500 ? 10 : 20;
  return !url.searchParams.has('symbol') && ['/fapi/v1/premiumIndex', '/fapi/v1/assetIndex'].includes(url.pathname) ? 10 : 1;
}
/** Per-client semaphore, shared transport/IP budget. Injected test transports stay isolated. */
export function createSourceClient(fetcher: typeof fetch, concurrency: number, options: { priority?: 'critical' | 'background' } = {}) {
  let active = 0;
  const waiters: Array<() => void> = [];
  let governor = governors.get(fetcher);
  if (!governor) { governor = { cooldowns: new Map(), limit: 1200, minute: -1, used: 0, backgroundUsed: 0, blocked: 0, backgroundBlocked: 0 }; governors.set(fetcher, governor); }
  const budgetState = governor;
  const cooldowns = budgetState.cooldowns;
  const background = options.priority === 'background';
  // Persist only public source throttling metadata. Refresh must not reset a known ban.
  const persistent = typeof window !== 'undefined' && fetcher === fetch;
  function mergeStored() {
    if (!persistent) return;
    try {
      const saved = JSON.parse(localStorage.getItem(GOVERNOR_KEY) ?? 'null');
      if (!saved || typeof saved !== 'object') return;
      if (Number.isInteger(saved.limit) && saved.limit > 0 && saved.limit <= 10_000_000) budgetState.limit = saved.limit;
      if (saved.minute === Math.floor(Date.now() / 60_000)) {
        if (Number.isSafeInteger(saved.used) && saved.used >= 0) budgetState.used = Math.max(budgetState.used, saved.used);
        if (Number.isSafeInteger(saved.backgroundUsed) && saved.backgroundUsed >= 0) budgetState.backgroundUsed = Math.max(budgetState.backgroundUsed, saved.backgroundUsed);
      }
      for (const [host, at] of Object.entries(saved.cooldowns ?? {})) {
        if (['fapi.binance.com', 'api.binance.com', 'api.coingecko.com', 'pro-api.coinmarketcap.com'].includes(host)
          && typeof at === 'number' && Number.isSafeInteger(at) && at > Date.now() && at < 8_640_000_000_000_000) cooldowns.set(host, Math.max(cooldowns.get(host) ?? 0, at));
      }
    } catch { /* Storage can be disabled. The in-memory governor remains active. */ }
  }
  function persist() {
    if (!persistent) return;
    try { localStorage.setItem(GOVERNOR_KEY, JSON.stringify({ limit: budgetState.limit, minute: budgetState.minute,
      used: budgetState.used, backgroundUsed: budgetState.backgroundUsed,
      cooldowns: Object.fromEntries([...cooldowns].filter(([, at]) => at > Date.now())) })); } catch { /* No secret or market history is stored here. */ }
  }
  // A conservative bootstrap budget is replaced by exchangeInfo's current limit.
  // Keep 20% free for metadata, other clients on the same IP, and in-flight requests.
  function refreshWeightWindow() {
    const minute = Math.floor(Date.now() / 60_000);
    if (minute !== budgetState.minute) { budgetState.minute = minute; budgetState.used = 0; budgetState.backgroundUsed = 0; budgetState.blocked = 0; budgetState.backgroundBlocked = 0; }
    mergeStored();
  }
  function retryAt(host = 'fapi.binance.com') {
    refreshWeightWindow();
    const reset = (budgetState.minute + 1) * 60_000;
    const weightBlocked = host === 'fapi.binance.com' ? Math.max(budgetState.blocked,
      budgetState.used >= Math.floor(budgetState.limit * 0.8) ? reset : 0,
      background ? Math.max(budgetState.backgroundBlocked, budgetState.backgroundUsed >= Math.floor(budgetState.limit * 0.2) ? reset : 0) : 0) : 0;
    const at = Math.max(cooldowns.get(host) ?? 0, weightBlocked);
    return at > Date.now() ? at : 0;
  }
  function deferUntil(at: number, host = 'fapi.binance.com') {
    refreshWeightWindow();
    if (!Number.isSafeInteger(at) || at <= Date.now() || at >= 8_640_000_000_000_000) return;
    cooldowns.set(host, Math.max(cooldowns.get(host) ?? 0, at)); persist();
  }
  function reserveWeight(url: URL) {
    if (url.hostname !== 'fapi.binance.com') return;
    refreshWeightWindow();
    const weight = binanceRequestWeight(url);
    const budget = Math.floor(budgetState.limit * 0.8);
    if (budgetState.used + weight > budget || background && budgetState.backgroundUsed + weight > Math.floor(budgetState.limit * 0.2)) {
      const reset = (budgetState.minute + 1) * 60_000;
      if (background) budgetState.backgroundBlocked = reset; else budgetState.blocked = reset;
      throw new SourceError('RATE_LIMIT_BUDGET', url.href, `${background ? '历史补取配额已暂停，优先保留 OI 额度' : '主动配额保护'} ${budgetState.used}/${budget}，等待至 ${new Date(reset).toISOString()}`, reset);
    }
    budgetState.used += weight;
    if (background) budgetState.backgroundUsed += weight;
    persist();
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
    refreshWeightWindow();
    const blockedUntil = cooldowns.get(host) ?? 0;
    if (Date.now() < blockedUntil) {
      throw new SourceError('RATE_LIMIT_COOLDOWN', url, `等待至 ${new Date(blockedUntil).toISOString()}`, blockedUntil);
    }
    await acquire(signal);
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error('REQUEST_TIMEOUT_8S')), 8000);
    try {
      if (signal.aborted) controller.abort(signal.reason);
      // A queued request must recheck the cooldown established by another worker.
      refreshWeightWindow();
      const queuedUntil = cooldowns.get(host) ?? 0;
      if (Date.now() < queuedUntil) {
        throw new SourceError('RATE_LIMIT_COOLDOWN', url, `等待至 ${new Date(queuedUntil).toISOString()}`, queuedUntil);
      }
      reserveWeight(target);
      const response = await fetcher(url, { signal: controller.signal, headers, cache: 'no-store' });
      if (host === 'fapi.binance.com') {
        refreshWeightWindow();
        const header = response.headers.get('x-mbx-used-weight-1m');
        const upstreamWeight = header === null ? NaN : Number(header);
        if (Number.isFinite(upstreamWeight) && upstreamWeight >= 0) { budgetState.used = Math.max(budgetState.used, upstreamWeight); persist(); }
      }
      if (!response.ok) {
        if (response.status === 429 || response.status === 418) {
          const retry = response.headers.get('retry-after');
          const seconds = retry == null ? NaN : Number(retry);
          const supplied = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry ?? '') - Date.now();
          const delay = Math.max(response.status === 418 ? 15 * 60_000 : 60_000, Number.isFinite(supplied) ? supplied : 0);
          deferUntil(Date.now() + delay, host);
        }
        const at = cooldowns.get(host) ?? 0;
        throw new SourceError(`HTTP_${response.status}`, url, `${response.statusText || '请求失败'}${at > Date.now() ? `；等待至 ${new Date(at).toISOString()}` : ''}`, at);
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
    retryAt, deferUntil,
    setBinanceWeightLimit(limit: number) {
      if (Number.isInteger(limit) && limit > 0 && limit <= 10_000_000) { budgetState.limit = limit; persist(); }
    },
  });
}
