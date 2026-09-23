import Decimal from 'decimal.js';
import { UNIT_ALIASES } from './aliases';
import type { FlowCandle, FlowMarket, FlowQuote, FlowTrade } from '../shared/flowTypes';
const ExactDecimal = Decimal.clone({ precision: 80 });

export const record = (v: unknown): Record<string, unknown> | null => v != null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
export const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
export function finite(v: unknown, minimum = 0): number | null {
  if ((typeof v !== 'string' && typeof v !== 'number') || v === '') return null;
  const n = Number(v); return Number.isFinite(n) && n >= minimum ? n : null;
}
// Binance's verified catalog includes single-character assets and Chinese token symbols.
const validSymbol = (v: unknown): v is string => typeof v === 'string' && /^[\p{L}\p{N}_]{1,40}$/u.test(v);
const fresh = (t: unknown, now: number): t is number => integer(t) && t > 0 && t <= now && now - t <= 15_000;
export function discoverFlowMarkets(raw: unknown): FlowMarket[] {
  const root = record(raw); if (!Array.isArray(root?.symbols)) throw new Error('交易对目录格式无效');
  const stable = new Set(['USDT', 'USDC', 'USD1', 'U']);
  const result = new Map<string, FlowMarket>();
  for (const item of root.symbols) {
    const r = record(item);
    if (!r || r.status !== 'TRADING' || r.contractType !== 'PERPETUAL' || r.underlyingType !== 'COIN'
      || !validSymbol(r.symbol) || !validSymbol(r.baseAsset) || !validSymbol(r.quoteAsset)
      || !stable.has(String(r.marginAsset)) || !stable.has(r.quoteAsset)) continue;
    const base = UNIT_ALIASES[r.baseAsset]?.symbol ?? r.baseAsset;
    const key = `futures:${r.symbol}`;
    result.set(key, { key, venue: 'futures', symbol: r.symbol, baseAsset: r.baseAsset, quoteAsset: r.quoteAsset, assetId: `binance:${base}` });
  }
  return [...result.values()].sort((a, b) => Number(b.symbol === 'BTCUSDT') - Number(a.symbol === 'BTCUSDT')
    || Number(b.symbol === 'ETHUSDT') - Number(a.symbol === 'ETHUSDT') || a.symbol.localeCompare(b.symbol));
}

function candle(marketKey: string, raw: unknown[], source: 'rest' | 'stream', receivedAt: number, sourceTime: number, closed: boolean): FlowCandle | null {
  const [t, o, h, l, c, v, T, q, n, , Q] = raw;
  if (!integer(t) || !integer(T) || t % 60_000 !== 0 || T !== t + 59_999 || t > receivedAt || sourceTime > receivedAt || (closed && T >= receivedAt) || !integer(n)) return null;
  const [open, high, low, close, volume, quoteVolume, takerBuyQuote] = [o, h, l, c, v, q, Q].map(x => finite(x));
  if ([open, high, low, close, volume, quoteVolume, takerBuyQuote].some(x => x === null)
    || open! <= 0 || low! <= 0 || close! <= 0 || high! < Math.max(open!, close!, low!) || low! > Math.min(open!, close!) || takerBuyQuote! > quoteVolume! * 1.00000001) return null;
  return { marketKey, openTime: t, closeTime: T, open: open!, high: high!, low: low!, close: close!, volume: volume!, quoteVolume: quoteVolume!, takerBuyQuote: takerBuyQuote!, trades: n, closed, source, sourceTime, receivedAt };
}
export function parseRestCandles(value: unknown, market: FlowMarket, receivedAt: number): FlowCandle[] {
  if (!Array.isArray(value)) throw new Error(`${market.symbol} K线格式无效`);
  return value.flatMap(v => { if (!Array.isArray(v) || !integer(v[6])) return []; const c = candle(market.key, v, 'rest', receivedAt, v[6], true); return c ? [c] : []; });
}
export function parseFlowCandle(value: unknown, market: FlowMarket, receivedAt: number): FlowCandle | null {
  const r = record(value); const k = record(r?.k);
  if (r?.e !== 'kline' || r.s !== market.symbol || (market.venue === 'futures' && r.st != null && r.st !== 1)
    || !fresh(r.E, receivedAt) || !k || k.i !== '1m' || k.s !== market.symbol || typeof k.x !== 'boolean') return null;
  return candle(market.key, [k.t, k.o, k.h, k.l, k.c, k.v, k.T, k.q, k.n, k.V, k.Q], 'stream', receivedAt, r.E, k.x);
}
export function parseFlowTrade(value: unknown, market: FlowMarket, receivedAt: number): FlowTrade | null {
  const r = record(value);
  if (r?.e !== 'aggTrade' || r.s !== market.symbol || (market.venue === 'futures' && r.st != null && r.st !== 1)
    || !integer(r.a) || !fresh(r.T, receivedAt) || !fresh(r.E, receivedAt) || typeof r.m !== 'boolean'
    || typeof r.p !== 'string' || typeof r.q !== 'string') return null;
  try {
    const p = new ExactDecimal(r.p); const q = new ExactDecimal(r.q); const amount = p.mul(q);
    if (!p.isFinite() || !q.isFinite() || p.lte(0) || q.lte(0) || !Number.isFinite(amount.toNumber())) return null;
    return { marketKey: market.key, id: String(r.a), price: r.p, quantity: r.q, quoteQuantity: amount.toFixed(), timestamp: r.T, receivedAt, side: r.m ? 'sell' : 'buy' };
  } catch { return null; }
}
export function parseFlowQuote(value: unknown, market: FlowMarket, receivedAt: number, interval: number | null): FlowQuote | null {
  const r = record(value);
  if (r?.e !== 'markPriceUpdate' || r.s !== market.symbol || (r.st != null && r.st !== 1) || !fresh(r.E, receivedAt)) return null;
  const mark = finite(r.p), index = finite(r.i), rate = finite(r.r, -1);
  if (!mark || !index) return null;
  return { marketKey: market.key, markPrice: mark, indexPrice: index, fundingRate: rate,
    nextFundingTime: integer(r.T) && r.T > 0 ? r.T : null, fundingIntervalHours: interval, timestamp: r.E, receivedAt };
}
