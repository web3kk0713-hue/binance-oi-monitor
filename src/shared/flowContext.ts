import type { FlowMetrics, FlowSnapshot, FlowVenue } from './flowTypes';

/** One market per venue. Amounts retain quoteAsset; this is never an asset-wide sum. */
export interface FlowContextRow {
  marketKey: string; symbol: string; quoteAsset: string; asOf: number;
  buyShare5m: number | null; delta5m: number | null; priceChange5m: number | null;
  oiChange5m: number | null; windowStart: number | null; windowEnd: number | null;
  fundingRate: number | null; fundingIntervalHours: number | null; nextFundingTime: number | null;
  reason: string;
}

const SNAPSHOT_MAX_AGE_MS = 30_000;
const SOURCE_MAX_AGE_MS = 90_000;
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const fresh = (value: unknown, now: number, maxAge: number): value is number =>
  timestamp(value) && timestamp(now) && value <= now && now - value <= maxAge;
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const quoteRank = (quote: string) => quote === 'USDT' ? 0 : quote === 'USDC' ? 1 : 2;

function observationIssue(row: FlowMetrics, snapshotAt: number, now: number): string | null {
  if (!fresh(snapshotAt, now, SNAPSHOT_MAX_AGE_MS)) return '订单流快照时间无效或已过期';
  if (!fresh(row.asOf, now, SNAPSHOT_MAX_AGE_MS) || row.asOf > snapshotAt) return '交易对快照时间无效或已过期';
  if (row.status === 'disconnected') return '行情连接已中断';
  if (row.status === 'stale') return '源行情已过期';
  if (row.status !== 'live' && row.status !== 'warming') return '行情状态无效';
  return null;
}

function tradeIssue(row: FlowMetrics, now: number): string | null {
  if (row.status !== 'live') return '成交窗口预热中';
  if (!fresh(row.lastCandleAt, now, SOURCE_MAX_AGE_MS) || row.lastCandleAt > row.asOf) return 'K线时间无效或已过期';
  return null;
}

function project(row: FlowMetrics, snapshotAt: number, now: number): FlowContextRow {
  const result: FlowContextRow = {
    marketKey: row.market.key, symbol: row.market.symbol, quoteAsset: row.market.quoteAsset,
    asOf: timestamp(row.asOf) && row.asOf <= now ? row.asOf : 0,
    buyShare5m: null, delta5m: null, priceChange5m: null, oiChange5m: null,
    windowStart: null, windowEnd: null,
    fundingRate: null, fundingIntervalHours: null, nextFundingTime: null, reason: '',
  };
  const unavailable = observationIssue(row, snapshotAt, now);
  if (unavailable) return { ...result, reason: unavailable };

  const reasons: string[] = [];
  const tradeUnavailable = tradeIssue(row, now);
  if (tradeUnavailable) reasons.push(tradeUnavailable);
  else {
    // This is the flow engine's closed-candle window, not lastCandleAt (which may
    // belong to a currently open candle). OI uses observations near these bounds.
    result.windowEnd = Math.floor(row.asOf / 60_000) * 60_000;
    result.windowStart = result.windowEnd - 5 * 60_000;
    result.buyShare5m = finite(row.buyShare5m) && row.buyShare5m >= 0 && row.buyShare5m <= 100 ? row.buyShare5m : null;
    result.delta5m = finite(row.delta5m) ? row.delta5m : null;
    result.priceChange5m = finite(row.priceChange5m) && row.priceChange5m >= -100 ? row.priceChange5m : null;
    result.oiChange5m = row.market.venue === 'futures' && finite(row.oiChange5m) && row.oiChange5m >= -100 ? row.oiChange5m : null;
    if ([result.buyShare5m, result.delta5m, result.priceChange5m].some(value => value === null)) reasons.push('部分5分钟成交数据不可用');
    if (row.market.venue === 'futures' && result.oiChange5m === null) reasons.push('同合约5分钟 OI 连续观测不足或无效');
  }

  // Funding is a separate observation, so a valid quote can survive trade-window warmup.
  // The same strict source <= receipt <= as-of ordering is used by the flow engine.
  if (row.market.venue === 'futures') {
    const quote = row.funding;
    if (!quote) reasons.push('资金费率待获取');
    else if (quote.marketKey !== row.market.key) reasons.push('资金费率交易对不匹配');
    else if (!fresh(quote.timestamp, now, SOURCE_MAX_AGE_MS) || !fresh(quote.receivedAt, now, SOURCE_MAX_AGE_MS)
      || quote.timestamp > quote.receivedAt || quote.receivedAt > row.asOf) reasons.push('资金费率时间无效或已过期');
    else {
      result.fundingRate = finite(quote.fundingRate) ? quote.fundingRate : null;
      result.fundingIntervalHours = finite(quote.fundingIntervalHours) && quote.fundingIntervalHours > 0 ? quote.fundingIntervalHours : null;
      result.nextFundingTime = timestamp(quote.nextFundingTime) && quote.nextFundingTime > now ? quote.nextFundingTime : null;
      if (result.fundingRate === null) reasons.push('资金费率不可用');
      if (result.fundingIntervalHours === null) reasons.push('结算周期未核实');
      if (result.nextFundingTime === null) reasons.push('下次结算时间未核实');
    }
  }
  result.reason = reasons.join('；') || '最近5根已闭合1m，单交易对数据';
  return result;
}

/** Read-only confirmation context; neither opens connections nor combines unlike quote currencies.
 * An explicit selected market is never silently replaced. Without one, live/fresh markets win,
 * then USDT, USDC, and a stable lexical order. Unavailable observations keep their identity only.
 */
export function selectFlowContext(snapshot: FlowSnapshot | null, assetId: string | undefined, now: number,
  preferredMarketKey?: string | null): { futures: FlowContextRow | null; spot: FlowContextRow | null } {
  if (!snapshot || !assetId || !Array.isArray(snapshot.rows)) return { futures: null, spot: null };
  const snapshotAt = snapshot.status?.asOf;
  const select = (venue: FlowVenue): FlowContextRow | null => {
    const rows = snapshot.rows.filter(row => row?.market?.assetId === assetId && row.market.venue === venue
      && typeof row.market.symbol === 'string' && row.market.symbol.length > 0
      && row.market.key === `${venue}:${row.market.symbol}`
      && typeof row.market.quoteAsset === 'string' && row.market.quoteAsset.length > 0);
    const readiness = (row: FlowMetrics) => observationIssue(row, snapshotAt, now) ? 2 : tradeIssue(row, now) ? 1 : 0;
    rows.sort((a, b) => Number(b.market.key === preferredMarketKey) - Number(a.market.key === preferredMarketKey)
      || readiness(a) - readiness(b) || quoteRank(a.market.quoteAsset) - quoteRank(b.market.quoteAsset)
      || compareText(a.market.quoteAsset, b.market.quoteAsset) || compareText(a.market.key, b.market.key));
    return rows.length ? project(rows[0], snapshotAt, now) : null;
  };
  return { futures: select('futures'), spot: select('spot') };
}
