import type { FlowCandle, FlowHistory, FlowMarket, FlowOi } from '../shared/flowTypes';
import { UNIT_ALIASES } from './aliases';
import { parseRestCandles, record } from './flowParsing';
import { createSourceClient, SourceError } from './http';

const MINUTE = 60_000, FIVE_MINUTES = 5 * MINUTE, RETENTION = 7 * 24 * 60 * MINUTE;
const MAX_PAGES = 6, PAGE_SIZE = 500, ROUND_BUDGET = 20_000, CACHE_LIMIT = 128;
type Lane = 'candles' | 'oi';
interface RecoveryResult {
  candles: FlowCandle[]; oi: FlowOi[]; missingCandles: number; missingOi: number; error: string | null; retryAt: number;
}
interface Cooldown { retryAt: number; next: Lane; running: boolean; }
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value < 8_640_000_000_000_000;
const token = (value: unknown): value is string => typeof value === 'string' && /^[\p{L}\p{N}_]{1,40}$/u.test(value);
const decimal = (value: unknown): value is string => typeof value === 'string' && value.length <= 128 && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value));
function validMarket(market: FlowMarket): boolean {
  return !!market && (market.venue === 'futures' || market.venue === 'spot') && token(market.symbol)
    && token(market.baseAsset) && token(market.quoteAsset) && market.symbol === `${market.baseAsset}${market.quoteAsset}`
    && market.key === `${market.venue}:${market.symbol}` && market.assetId === `binance:${UNIT_ALIASES[market.baseAsset]?.symbol ?? market.baseAsset}`;
}
function validKnownCandle(row: FlowCandle, key: string, at: number): boolean {
  return row.marketKey === key && row.closed && timestamp(row.openTime) && row.openTime % MINUTE === 0
    && row.closeTime === row.openTime + MINUTE - 1 && row.closeTime < at && timestamp(row.sourceTime)
    && row.sourceTime >= row.closeTime && timestamp(row.receivedAt) && row.sourceTime <= row.receivedAt && row.receivedAt <= at
    && (row.source === 'rest' || row.source === 'stream') && [row.open, row.high, row.low, row.close].every(v => Number.isFinite(v) && v > 0)
    && row.high >= Math.max(row.open, row.close, row.low) && row.low <= Math.min(row.open, row.close)
    && [row.volume, row.quoteVolume, row.takerBuyQuote].every(v => Number.isFinite(v) && v >= 0)
    && row.takerBuyQuote <= row.quoteVolume && (row.volume === 0) === (row.quoteVolume === 0)
    && Number.isSafeInteger(row.trades) && row.trades >= 0;
}
function missingGrid(from: number, last: number, step: number): Set<number> {
  const missing = new Set<number>();
  for (let time = Math.ceil(from / step) * step; time <= last; time += step) missing.add(time);
  return missing;
}
function pageRange(missing: Set<number>, step: number): { start: number; last: number; count: number } | null {
  if (!missing.size) return null;
  const last = Math.max(...missing); let start = last, count = 1;
  while (count < PAGE_SIZE && missing.has(start - step)) { start -= step; count++; }
  return { start, last, count };
}

/** Display/archive recovery only. Never connects to the live flow engine or invents 30s observations. */
export function createFlowBackfill(options: { fetcher?: typeof fetch; now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const request = createSourceClient(options.fetcher ?? fetch, 1, { priority: 'background' });
  const cooldowns = new Map<string, Cooldown>();

  async function recover(market: FlowMarket, known: FlowHistory, from: number, to: number, signal: AbortSignal): Promise<RecoveryResult> {
    signal.throwIfAborted();
    const startedAt = now();
    if (!timestamp(startedAt) || !timestamp(from) || !timestamp(to) || from > to || !validMarket(market)
      || !known || !Array.isArray(known.candles) || !Array.isArray(known.oi)
      || known.market && (!validMarket(known.market) || known.market.key !== market.key || known.market.assetId !== market.assetId)) {
      throw new Error('历史补取参数或交易对身份无效');
    }
    const boundedFrom = Math.max(from, startedAt - RETENTION), boundedTo = Math.min(to, startedAt);
    const candlesMissing = missingGrid(boundedFrom, Math.floor((Math.min(boundedTo, startedAt - 1) + 1) / MINUTE) * MINUTE - MINUTE, MINUTE);
    const oiMissing = market.venue === 'futures' ? missingGrid(boundedFrom, Math.floor(boundedTo / FIVE_MINUTES) * FIVE_MINUTES, FIVE_MINUTES) : new Set<number>();
    for (const row of known.candles) if (row && validKnownCandle(row, market.key, startedAt)) candlesMissing.delete(row.openTime);
    for (const row of known.oi) if (row && row.marketKey === market.key && timestamp(row.timestamp) && row.timestamp % FIVE_MINUTES === 0
      && timestamp(row.receivedAt) && row.timestamp <= row.receivedAt && row.receivedAt <= startedAt && Number.isFinite(row.quantity) && row.quantity >= 0
      && (row.source === undefined || row.source === 'rest-5m')) oiMissing.delete(row.timestamp);
    const candles: FlowCandle[] = [], oi: FlowOi[] = [];
    const result = (error: string | null, retryAt: number): RecoveryResult => ({ candles, oi, missingCandles: candlesMissing.size, missingOi: oiMissing.size, error, retryAt });
    if (!candlesMissing.size && !oiMissing.size) return result(null, 0);
    const previous = cooldowns.get(market.key);
    if (previous && (previous.running || previous.retryAt > startedAt)) return result(previous.running ? '此标的历史正在补取' : '历史补取冷却中，稍后继续', previous.retryAt);
    // Active requests are never evicted: that would allow a duplicate in-flight recovery.
    for (const [key, state] of cooldowns) {
      if (cooldowns.size < CACHE_LIMIT) break;
      if (!state.running && state.retryAt <= startedAt && key !== market.key) cooldowns.delete(key);
    }
    if (!previous && cooldowns.size >= CACHE_LIMIT) return result('历史补取队列已满，稍后继续', startedAt + 60_000);
    const state: Cooldown = { retryAt: startedAt + 30_000, next: previous?.next ?? 'candles', running: true };
    cooldowns.delete(market.key); cooldowns.set(market.key, state);
    // A not-yet-published newest point remains missing, but must not starve older
    // pages. Attempt each grid point at most once during this bounded round.
    const unattempted: Record<Lane, Set<number>> = { candles: new Set(candlesMissing), oi: new Set(oiMissing) };
    const budget = new AbortController(), combined = AbortSignal.any([signal, budget.signal]);
    const timeout = setTimeout(() => budget.abort(new Error('历史补取超过20秒预算')), ROUND_BUDGET);
    const errors = new Set<string>(), blocked = new Set<Lane>();
    let pages = 0, failed = false, upstreamRetryAt = 0;
    try {
      while (pages < MAX_PAGES) {
        signal.throwIfAborted();
        if (budget.signal.aborted || now() - startedAt >= ROUND_BUDGET) { errors.add('本轮历史补取达到20秒预算，稍后继续'); failed = true; break; }
        const available = (lane: Lane) => !blocked.has(lane) && unattempted[lane].size > 0;
        const lane: Lane = available(state.next) ? state.next : state.next === 'candles' ? 'oi' : 'candles';
        if (!available(lane)) break;
        state.next = lane === 'candles' ? 'oi' : 'candles';
        const missing = lane === 'candles' ? candlesMissing : oiMissing, step = lane === 'candles' ? MINUTE : FIVE_MINUTES;
        const page = pageRange(unattempted[lane], step)!;
        for (let time = page.start; time <= page.last; time += step) unattempted[lane].delete(time);
        const root = market.venue === 'futures' ? 'https://fapi.binance.com/fapi/v1/klines' : 'https://api.binance.com/api/v3/klines';
        const url = new URL(lane === 'candles' ? root : 'https://fapi.binance.com/futures/data/openInterestHist');
        url.searchParams.set('symbol', market.symbol); url.searchParams.set(lane === 'candles' ? 'interval' : 'period', lane === 'candles' ? '1m' : '5m');
        url.searchParams.set('limit', String(PAGE_SIZE)); url.searchParams.set('startTime', String(page.start));
        url.searchParams.set('endTime', String(page.last + (lane === 'candles' ? MINUTE - 1 : 0)));
        pages++;
        try {
          const raw = await request<unknown>(url.href, combined);
          signal.throwIfAborted();
          const receivedAt = now();
          if (!timestamp(receivedAt) || receivedAt < startedAt || budget.signal.aborted || receivedAt - startedAt >= ROUND_BUDGET) {
            errors.add('本轮历史补取达到20秒预算，稍后继续'); failed = true; break;
          }
          if (!Array.isArray(raw) || raw.length > PAGE_SIZE) throw new Error('历史响应格式或分页长度无效');
          const seen = new Set<number>(); let invalid = false;
          if (lane === 'candles') {
            const parsed = parseRestCandles(raw, market, receivedAt);
            invalid = parsed.length !== raw.length;
            for (const row of parsed) {
              if (!validKnownCandle(row, market.key, receivedAt) || row.openTime < page.start || row.openTime > page.last
                || row.closeTime > boundedTo || seen.has(row.openTime)) { invalid = true; continue; }
              seen.add(row.openTime);
              if (missing.delete(row.openTime)) candles.push(row);
            }
          } else {
            for (const item of raw) {
              const row = record(item), time = row?.timestamp, quantity = row?.sumOpenInterest;
              if (row?.symbol !== market.symbol || !timestamp(time) || time % FIVE_MINUTES !== 0 || time < page.start || time > page.last
                || time > boundedTo || time > receivedAt || !decimal(quantity) || seen.has(time)) { invalid = true; continue; }
              seen.add(time);
              if (missing.delete(time)) oi.push({ marketKey: market.key, quantity: Number(quantity), timestamp: time, receivedAt, source: 'rest-5m' });
            }
          }
          const incomplete = seen.size < page.count;
          if (invalid || incomplete) {
            failed = true;
            errors.add(`${lane === 'candles' ? '分钟K线' : '5分钟OI'}${invalid ? '响应含无效、重复或越界数据' : raw.length ? '历史仍有缺口' : '历史返回空页'}，稍后重试`);
          }
        } catch (error) {
          signal.throwIfAborted();
          failed = true; blocked.add(lane);
          if (error instanceof SourceError) upstreamRetryAt = Math.max(upstreamRetryAt, error.retryAt);
          errors.add(budget.signal.aborted ? '本轮历史补取达到20秒预算，稍后继续' : error instanceof Error ? error.message : '历史补取失败');
          // A shared Binance host cooldown applies to both futures endpoints.
          if (budget.signal.aborted || error instanceof SourceError && error.retryAt > now()) break;
        }
      }
      if (pages === MAX_PAGES && (candlesMissing.size || oiMissing.size)) errors.add('本轮已达6页上限，剩余历史稍后继续补取');
    } finally {
      clearTimeout(timeout); state.running = false;
      state.retryAt = Math.max(now() + (failed || signal.aborted ? 60_000 : 30_000), upstreamRetryAt);
    }
    candles.sort((a, b) => a.openTime - b.openTime); oi.sort((a, b) => a.timestamp - b.timestamp);
    return result(errors.size ? [...errors].join('；') : null, state.retryAt);
  }
  return { recover };
}
