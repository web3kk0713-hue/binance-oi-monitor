import Decimal from 'decimal.js';
import { UNIT_ALIASES } from '../data/aliases';
import type { AssetRow } from './types';

export const LIVE_WINDOW_MS = 300_000;
export const LIVE_QUOTE_MAX_AGE_MS = 15_000;
export const LIVE_SILENCE_MS = 30_000;
export const LIVE_PAUSE_MS = 10_000;
export const LIVE_MAX_TRADES = 50_000;

export interface MarketObservation {
  symbol: string | null; quoteAsset: string | null;
  status: 'connecting' | 'warming' | 'live' | 'stale' | 'unavailable';
  /** Prices are quote currency per normalized token, not USD. */
  price: number | null; bid: number | null; ask: number | null; spreadBps: number | null;
  /** Observed taker quote turnover in (now - 5m, now], partial while warming. */
  buyQuote: number | null; sellQuote: number | null; buyShare: number | null;
  coveredMs: number;
  /** Last valid receipt time; a Spot bookTicker does not supply source time. */
  updatedAt: number | null;
  message: string;
}

export interface MarketTarget {
  venue: 'futures' | 'spot'; symbol: string; baseAsset: string; quoteAsset: string; multiplier: number;
}
export interface MarketTrade {
  id: number; sourceTime: number; eventTime: number | null; receivedAt: number;
  price: number; quoteValue: Decimal; side: 'buy' | 'sell';
}
export interface MarketBook {
  id: number; sourceTime: number | null; receivedAt: number; bid: number; ask: number; spreadBps: number;
}

const safeSymbol = (symbol: string) => /^[\p{L}\p{N}_]{1,40}$/u.test(symbol);
const stableQuotes = new Set(['USDT', 'USDC', 'USD1', 'U']);
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const timestamp = (value: unknown): value is number => integer(value) && value > 0;
function positive(value: unknown): Decimal | null {
  if ((typeof value !== 'string' && typeof value !== 'number') || value === '') return null;
  try { const number = new Decimal(value); return number.isFinite() && number.gt(0) ? number : null; } catch { return null; }
}
const freshSource = (time: number, now: number) => timestamp(now) && time <= now && now - time <= LIVE_QUOTE_MAX_AGE_MS;
const validTarget = (target: MarketTarget) => safeSymbol(target.symbol) && Number.isFinite(target.multiplier) && target.multiplier >= 1;

/** Use explicit Binance contract evidence and reviewed aliases only; never strip digits. */
export function selectFuturesMarket(asset: AssetRow | undefined): MarketTarget | null {
  if (!asset) return null;
  const candidates = asset.evidence.contracts.filter(contract => {
    const normalized = UNIT_ALIASES[contract.baseAsset]?.symbol ?? contract.baseAsset;
    return asset.contracts.includes(contract.symbol) && normalized === asset.symbol && safeSymbol(contract.symbol) && stableQuotes.has(contract.quoteAsset);
  }).sort((a, b) => Number(b.quoteAsset === 'USDT') - Number(a.quoteAsset === 'USDT') || a.symbol.localeCompare(b.symbol));
  const contract = candidates[0];
  return contract ? { venue: 'futures', symbol: contract.symbol, baseAsset: asset.symbol, quoteAsset: contract.quoteAsset,
    multiplier: UNIT_ALIASES[contract.baseAsset]?.multiplier ?? 1 } : null;
}

/** The requested name is a candidate only. A successful exchangeInfo match is mandatory. */
export function verifySpotMarket(response: unknown, baseAsset: string): MarketTarget | null {
  const root = object(response);
  if (!safeSymbol(baseAsset) || !Array.isArray(root?.symbols)) return null;
  const symbol = `${baseAsset}USDT`;
  const matched = root.symbols.map(object).find(row => row?.symbol === symbol && row.baseAsset === baseAsset
    && row.quoteAsset === 'USDT' && row.status === 'TRADING' && row.isSpotTradingAllowed === true);
  return matched ? { venue: 'spot', symbol, baseAsset, quoteAsset: 'USDT', multiplier: 1 } : null;
}

export function emptyMarket(message: string, target: MarketTarget | null = null, status: MarketObservation['status'] = 'unavailable'): MarketObservation {
  return { symbol: target?.symbol ?? null, quoteAsset: target?.quoteAsset ?? null, status, price: null, bid: null, ask: null,
    spreadBps: null, buyQuote: null, sellQuote: null, buyShare: null, coveredMs: 0, updatedAt: null, message };
}

function payload(value: unknown): Record<string, unknown> | null {
  const root = object(value);
  return root && 'data' in root ? object(root.data) : root;
}

export function parseMarketTrade(value: unknown, target: MarketTarget, receivedAt: number): MarketTrade | null {
  const row = payload(value);
  if (!validTarget(target) || row?.e !== 'aggTrade' || row.s !== target.symbol || (target.venue === 'futures' && row.st != null && row.st !== 1)
    || !integer(row.a) || !timestamp(row.T) || !freshSource(row.T, receivedAt) || typeof row.m !== 'boolean') return null;
  const price = positive(row.p); const quantity = positive(row.q);
  if (!price || !quantity) return null;
  const normalized = price.div(target.multiplier).toNumber();
  const quoteValue = price.mul(quantity); // Native price × native quantity: do NOT apply the multiplier again.
  if (!Number.isFinite(normalized) || normalized <= 0 || !Number.isFinite(quoteValue.toNumber())) return null;
  return { id: row.a, sourceTime: row.T, eventTime: timestamp(row.E) ? row.E : null, receivedAt,
    price: normalized, quoteValue, side: row.m ? 'sell' : 'buy' }; // Buyer-maker means seller-taker.
}

export function parseMarketBook(value: unknown, target: MarketTarget, receivedAt: number): MarketBook | null {
  const row = payload(value);
  if (!validTarget(target) || !timestamp(receivedAt) || row?.s !== target.symbol || !integer(row.u)
    || (target.venue === 'futures' && row.st != null && row.st !== 1)) return null;
  // Spot's bookTicker has no exchange timestamp; never relabel receipt time as source time.
  const sourceTime = target.venue === 'futures' ? row.T : null;
  if (target.venue === 'futures' && (!timestamp(sourceTime) || !freshSource(sourceTime, receivedAt))) return null;
  const bid = positive(row.b); const ask = positive(row.a);
  if (!bid || !ask || !positive(row.B) || !positive(row.A) || ask.lt(bid)) return null;
  const normalizedBid = bid.div(target.multiplier).toNumber(); const normalizedAsk = ask.div(target.multiplier).toNumber();
  if (!Number.isFinite(normalizedBid) || !Number.isFinite(normalizedAsk) || normalizedBid <= 0 || normalizedAsk <= 0) return null;
  return { id: row.u, sourceTime: typeof sourceTime === 'number' ? sourceTime : null, receivedAt,
    bid: normalizedBid, ask: normalizedAsk, spreadBps: ask.sub(bid).div(ask.add(bid).div(2)).mul(10_000).toNumber() };
}

export interface MarketWindowInput {
  target: MarketTarget; trades: Iterable<MarketTrade>; latestTrade: MarketTrade | null; book: MarketBook | null;
  continuousSince: number | null; now: number; connected: boolean; phase?: 'connecting' | 'stale'; note?: string;
}

/** Pure as-of projection, also used by deterministic boundary tests. */
export function observeMarket(input: MarketWindowInput): MarketObservation {
  const { target, now, latestTrade, book, continuousSince } = input;
  if (!input.connected) return emptyMarket(input.note ?? '正在连接官方行情', target, input.phase ?? 'connecting');
  const priceFresh = latestTrade !== null && freshSource(latestTrade.sourceTime, now) && freshSource(latestTrade.receivedAt, now);
  const bookFresh = book !== null && freshSource(book.receivedAt, now) && (book.sourceTime === null || freshSource(book.sourceTime, now));
  const coveredMs = continuousSince === null ? 0 : Math.min(LIVE_WINDOW_MS, Math.max(0, now - continuousSince));
  let buy = new Decimal(0); let sell = new Decimal(0); let count = 0;
  const seen = new Set<number>();
  for (const trade of input.trades) {
    if (seen.has(trade.id) || trade.sourceTime <= now - LIVE_WINDOW_MS || trade.sourceTime > now || trade.receivedAt > now) continue;
    seen.add(trade.id); count++;
    if (trade.side === 'buy') buy = buy.add(trade.quoteValue); else sell = sell.add(trade.quoteValue);
  }
  const total = buy.add(sell);
  const turnoverValid = count > 0 && Number.isFinite(total.toNumber());
  const stale = continuousSince !== null && (!priceFresh || !bookFresh);
  const status = stale ? 'stale' : coveredMs === LIVE_WINDOW_MS && priceFresh && bookFresh ? 'live' : 'warming';
  return {
    symbol: target.symbol, quoteAsset: target.quoteAsset, status,
    price: priceFresh ? latestTrade!.price : null, bid: bookFresh ? book!.bid : null, ask: bookFresh ? book!.ask : null,
    spreadBps: bookFresh ? book!.spreadBps : null,
    buyQuote: turnoverValid ? buy.toNumber() : null, sellQuote: turnoverValid ? sell.toNumber() : null,
    buyShare: turnoverValid && total.gt(0) ? buy.div(total).mul(100).toNumber() : null, coveredMs,
    updatedAt: Math.max(latestTrade && latestTrade.receivedAt <= now ? latestTrade.receivedAt : 0, book && book.receivedAt <= now ? book.receivedAt : 0) || null,
    message: stale ? `${input.note ? `${input.note}；` : ''}成交或报价未更新；不视为完整实时窗口`
      : status === 'live' ? '连续观察5分钟；仅含该市场实际收到的成交'
        : `${input.note ? `${input.note}；` : ''}已观察${Math.floor(coveredMs / 1000)}秒，未满5分钟`,
  };
}

/** Bounded mutable transport buffer; parsing and the displayed as-of projection stay pure. */
export function createMarketTracker(target: MarketTarget, maxTrades = LIVE_MAX_TRADES) {
  const limit = Number.isFinite(maxTrades) ? Math.max(1, Math.min(LIVE_MAX_TRADES, Math.floor(maxTrades))) : LIVE_MAX_TRADES;
  const trades = new Map<number, MarketTrade>();
  let latestTrade: MarketTrade | null = null; let book: MarketBook | null = null;
  let continuousSince: number | null = null; let lastTradeReceivedAt: number | null = null;
  let connected = false; let phase: 'connecting' | 'stale' = 'connecting';
  let note = ''; let lastClock: number | null = null; let floor = 0; let lastPruned = 0;
  function clearWindow(now: number, reason: string) {
    trades.clear(); latestTrade = null; continuousSince = null; lastTradeReceivedAt = null; floor = now; note = reason;
  }
  function advance(now: number) {
    if (lastClock !== null && (now < lastClock || now - lastClock > LIVE_PAUSE_MS)) {
      clearWindow(now, '页面暂停或时钟变化，重新积累'); book = null;
    } else if (lastTradeReceivedAt !== null && now - lastTradeReceivedAt > LIVE_SILENCE_MS) {
      clearWindow(now, '成交流超过30秒未更新，重新积累');
    }
    lastClock = now;
    if (now - lastPruned >= 1000) {
      for (const [id, trade] of trades) if (trade.sourceTime <= now - LIVE_WINDOW_MS) trades.delete(id);
      lastPruned = now;
    }
  }
  return {
    connect(now: number) {
      clearWindow(now, ''); book = null; lastClock = now; connected = true; phase = 'connecting';
    },
    disconnect(now: number, reason = '连接中断，5分钟窗口重新积累') {
      clearWindow(now, reason); book = null; lastClock = now; connected = false; phase = 'stale';
    },
    ingest(value: unknown, receivedAt: number): boolean {
      if (!connected) return false;
      advance(receivedAt);
      const row = payload(value);
      if (!row || row.s !== target.symbol || (target.venue === 'futures' && row.st != null && row.st !== 1)) return false;
      if (row.e === 'aggTrade') {
        // An already-counted retransmission may now be old; it must not erase valid newer trades.
        if (integer(row.a) && trades.has(row.a)) return false;
        const trade = parseMarketTrade(row, target, receivedAt);
        if (!trade) { clearWindow(receivedAt, '成交时间或数值异常，重新积累'); return false; }
        if (trade.sourceTime < floor) return false;
        if (trades.size >= limit) clearWindow(receivedAt, '成交缓存达到上限，重新积累');
        trades.set(trade.id, trade);
        continuousSince ??= receivedAt;
        lastTradeReceivedAt = receivedAt;
        if (!latestTrade || trade.sourceTime > latestTrade.sourceTime || (trade.sourceTime === latestTrade.sourceTime && trade.id > latestTrade.id)) latestTrade = trade;
        return true;
      }
      if (row.e === 'bookTicker' || (target.venue === 'spot' && 'b' in row && 'u' in row)) {
        const next = parseMarketBook(row, target, receivedAt);
        if (!next) { book = null; return false; }
        if (book && (next.id <= book.id || (next.sourceTime !== null && book.sourceTime !== null && next.sourceTime < book.sourceTime))) return false;
        book = next;
        return true;
      }
      return false;
    },
    observe(now: number): MarketObservation {
      advance(now);
      return observeMarket({ target, trades: trades.values(), latestTrade, book, continuousSince, now, connected, phase, note });
    },
    get size() { return trades.size; },
  };
}
