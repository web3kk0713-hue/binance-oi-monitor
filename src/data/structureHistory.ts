import Decimal from 'decimal.js';
import { STRUCTURE_INTERVAL_MS, STRUCTURE_LOOKBACK_MS, type StructureCandle, type StructureHistory } from '../shared/structureTypes';
import { createSourceClient, SourceError } from './http';

const BASE = 'https://fapi.binance.com';
const EXCHANGE_URL = `${BASE}/fapi/v1/exchangeInfo`;
const HISTORY_MS = STRUCTURE_LOOKBACK_MS * 2;
const PAGE_LIMIT = 1500;
const METADATA_TTL_MS = 60_000;
const ExactDecimal = Decimal.clone({ precision: 160 });
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const abortError = () => new DOMException('历史读取已取消', 'AbortError');
function checkAbort(signal: AbortSignal) { if (signal.aborted) throw abortError(); }
function decimal(value: unknown): Decimal | null {
  // Binance sends plain decimal strings. Coercing numbers, blanks, Infinity or
  // scientific overflow here could turn corrupt upstream data into a price.
  if (typeof value !== 'string' || value.length > 128 || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const parsed = new ExactDecimal(value);
  return parsed.isFinite() && parsed.gt(0) && Math.abs(parsed.e) <= 100 ? parsed : null;
}
function cloneHistory(history: StructureHistory): StructureHistory {
  return { ...history, candles: history.candles.map(candle => ({ ...candle })) };
}
function checkedClock(now: () => number): number {
  const time = now();
  if (!Number.isSafeInteger(time) || time < HISTORY_MS || time >= 8_640_000_000_000_000) throw new Error('本机时间无效，无法确定完整历史区间');
  return time;
}
function parseCandle(raw: unknown, expectedOpen: number, to: number, url: string): StructureCandle {
  if (!Array.isArray(raw) || raw.length < 7 || !Number.isSafeInteger(raw[0]) || !Number.isSafeInteger(raw[6])
    || raw[0] !== expectedOpen || raw[0] % STRUCTURE_INTERVAL_MS !== 0
    || raw[6] !== expectedOpen + STRUCTURE_INTERVAL_MS - 1 || raw[6] >= to) {
    throw new SourceError('HISTORY_INVALID', url, '历史 K 线时间不连续、重复或包含未收盘数据');
  }
  const [open, high, low, close] = raw.slice(1, 5).map(decimal);
  if (!open || !high || !low || !close || high.lt(open) || high.lt(low) || high.lt(close) || low.gt(open) || low.gt(close)) {
    throw new SourceError('HISTORY_INVALID', url, '历史 K 线价格格式或高低范围无效');
  }
  return { openTime: raw[0], closeTime: raw[6], open: raw[1], high: raw[2], low: raw[3], close: raw[4] };
}

/** Public, on-demand research history only; not a persistent market-data backend. */
export function createStructureHistoryClient(fetcher: typeof fetch = fetch, now: () => number = Date.now): {
  load(symbol: string, signal: AbortSignal): Promise<StructureHistory>;
} {
  const request = createSourceClient(fetcher, 2, { priority: 'background' });
  const cache = new Map<string, StructureHistory>();
  let metadata: { rows: Record<string, unknown>[]; fetchedAt: number } | null = null;
  // Serialize whole loads, not only HTTP calls. Identical queued requests use
  // the completed cache; cancelling one caller never cancels another caller.
  let tail: Promise<void> = Promise.resolve();

  async function tickSizeFor(symbol: string, signal: AbortSignal): Promise<string> {
    const at = checkedClock(now);
    if (!metadata || at < metadata.fetchedAt || at - metadata.fetchedAt >= METADATA_TTL_MS) {
      const response = record(await request<unknown>(EXCHANGE_URL, signal));
      checkAbort(signal);
      if (!Array.isArray(response?.symbols) || response.symbols.length === 0 || response.symbols.length > 10_000) {
        throw new SourceError('HISTORY_IDENTITY', EXCHANGE_URL, '合约目录格式无效');
      }
      const rows = response.symbols.map(record);
      if (rows.some(row => row === null)) throw new SourceError('HISTORY_IDENTITY', EXCHANGE_URL, '合约目录存在无效记录');
      if (Array.isArray(response.rateLimits)) for (const raw of response.rateLimits) {
        const limit = record(raw);
        if (limit?.rateLimitType === 'REQUEST_WEIGHT' && limit.interval === 'MINUTE' && limit.intervalNum === 1
          && typeof limit.limit === 'number') request.setBinanceWeightLimit(limit.limit);
      }
      metadata = { rows: rows as Record<string, unknown>[], fetchedAt: checkedClock(now) };
    }
    const matches = metadata.rows.filter(row => row.symbol === symbol);
    const market = matches[0];
    if (matches.length !== 1 || market.status !== 'TRADING' || market.contractType !== 'PERPETUAL'
      || market.quoteAsset !== 'USDT' || market.marginAsset !== 'USDT' || !Array.isArray(market.filters)) {
      metadata = null;
      throw new SourceError('HISTORY_IDENTITY', EXCHANGE_URL, '仅支持目录中明确匹配的在交易 USDT 本位永续合约');
    }
    const filters = market.filters.map(record).filter(filter => filter?.filterType === 'PRICE_FILTER');
    if (filters.length !== 1 || !decimal(filters[0]?.tickSize)) {
      metadata = null;
      throw new SourceError('HISTORY_IDENTITY', EXCHANGE_URL, '缺少有效的 PRICE_FILTER.tickSize，不能用价格精度替代');
    }
    return filters[0]!.tickSize as string;
  }

  async function loadNow(symbol: string, signal: AbortSignal): Promise<StructureHistory> {
    checkAbort(signal);
    const startedAt = checkedClock(now);
    const to = Math.floor(startedAt / STRUCTURE_INTERVAL_MS) * STRUCTURE_INTERVAL_MS;
    const from = to - HISTORY_MS;
    for (const [key, history] of cache) if (history.to !== to || history.fetchedAt > startedAt) cache.delete(key);
    const cached = cache.get(symbol);
    if (cached) { cache.delete(symbol); cache.set(symbol, cached); return cloneHistory(cached); }
    const tickSize = await tickSizeFor(symbol, signal);
    checkAbort(signal);
    const candles: StructureCandle[] = [];
    const count = HISTORY_MS / STRUCTURE_INTERVAL_MS;
    // Exactly three bounded pages for 14 days of 5m bars. Short, overlapping or
    // unordered pages fail closed instead of filling gaps or probing forever.
    for (let offset = 0; offset < count; offset += PAGE_LIMIT) {
      checkAbort(signal);
      const expected = Math.min(PAGE_LIMIT, count - offset);
      const start = from + offset * STRUCTURE_INTERVAL_MS;
      const url = new URL(`${BASE}/fapi/v1/markPriceKlines`);
      url.search = new URLSearchParams({ symbol, interval: '5m', startTime: String(start), endTime: String(to - 1), limit: String(PAGE_LIMIT) }).toString();
      const raw = await request<unknown>(url.href, signal);
      checkAbort(signal);
      if (!Array.isArray(raw) || raw.length !== expected) {
        throw new SourceError('HISTORY_INCOMPLETE', url.href, '未获取完整 14 天历史；新上市、缺失或异常分页均不生成候选方案');
      }
      raw.forEach((row, index) => candles.push(parseCandle(row, start + index * STRUCTURE_INTERVAL_MS, to, url.href)));
    }
    const fetchedAt = checkedClock(now);
    if (fetchedAt < startedAt) throw new Error('读取期间本机时间回退，请校准时间后重试');
    checkAbort(signal);
    const history: StructureHistory = { schemaVersion: 1, marketKey: `futures:${symbol}`, symbol, tickSize,
      intervalMs: STRUCTURE_INTERVAL_MS, from, to, fetchedAt, candles };
    if (fetchedAt < to + STRUCTURE_INTERVAL_MS) {
      cache.set(symbol, history);
      while (cache.size > 3) cache.delete(cache.keys().next().value!);
    }
    return cloneHistory(history);
  }

  function load(symbol: string, signal: AbortSignal): Promise<StructureHistory> {
    if (signal.aborted) return Promise.reject(abortError());
    // Unicode names are real Binance instruments. Exact catalog identity, not
    // a guessed symbol normalization, ultimately determines eligibility.
    if (typeof symbol !== 'string' || !/^[\p{L}\p{N}_]{1,40}$/u.test(symbol)) return Promise.reject(new Error('合约代码格式无效'));
    const task = tail.then(() => loadNow(symbol, signal));
    tail = task.then(() => undefined, () => undefined);
    return new Promise((resolve, reject) => {
      const abort = () => reject(abortError());
      signal.addEventListener('abort', abort, { once: true });
      // Attach both settlement handlers even after the consumer aborts, so a
      // late transport rejection cannot become an unhandled rejection.
      task.then(resolve, error => reject(signal.aborted ? abortError() : error))
        .finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    });
  }
  return { load };
}
