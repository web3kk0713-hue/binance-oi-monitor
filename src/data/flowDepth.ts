import type { FlowDepth } from '../shared/flowTypes';
import { finite, integer, record } from './flowParsing';

type Level = [number, number];
function levels(v: unknown): Level[] | null {
  if (!Array.isArray(v) || v.length > 10_000) return null;
  const result: Level[] = [];
  for (const row of v) {
    if (!Array.isArray(row)) return null;
    const p = finite(row[0]), q = finite(row[1]);
    if (!p || q === null) return null;
    result.push([p, q]);
  }
  return result;
}
/** Sequence-checked UM order book. Unknown outer levels never count as zero liquidity. RPI is excluded by the source. */
export function createFlowBook(marketKey: string) {
  const bids = new Map<number, number>(), asks = new Map<number, number>();
  let last = -1, bridged = false, lower = Infinity, upper = 0;
  function reset() { bids.clear(); asks.clear(); last = -1; bridged = false; lower = Infinity; upper = 0; }
  function seed(value: unknown): boolean {
    reset(); const r = record(value); const b = levels(r?.bids), a = levels(r?.asks);
    if (!integer(r?.lastUpdateId) || !b?.length || !a?.length) return false;
    for (const [p, q] of b) if (q > 0) bids.set(p, q);
    for (const [p, q] of a) if (q > 0) asks.set(p, q);
    lower = Math.min(...bids.keys()); upper = Math.max(...asks.keys()); last = r.lastUpdateId;
    return true;
  }
  function update(value: unknown): 'ok' | 'old' | 'gap' {
    const r = record(value), b = levels(r?.b), a = levels(r?.a);
    if (!r || !integer(r.U) || !integer(r.u) || !integer(r.pu) || !b || !a || r.u < r.U || last < 0) return 'gap';
    if (r.u < last || (bridged && r.u === last)) return 'old';
    if ((!bridged && !(r.U <= last && r.u >= last)) || (bridged && r.pu !== last)) { reset(); return 'gap'; }
    for (const [p, q] of b) q === 0 ? bids.delete(p) : bids.set(p, q);
    for (const [p, q] of a) q === 0 ? asks.delete(p) : asks.set(p, q);
    bridged = true; last = r.u;
    if (bids.size > 5000 || asks.size > 5000) { reset(); return 'gap'; }
    return 'ok';
  }
  function snapshot(timestamp: number, receivedAt: number, orderSizeQuote = 10_000, bandBps = 10): FlowDepth | null {
    if (!bridged || !bids.size || !asks.size) return null;
    const b = [...bids].sort((x, y) => y[0] - x[0]), a = [...asks].sort((x, y) => x[0] - y[0]);
    const bid = b[0][0], ask = a[0][0], mid = (bid + ask) / 2;
    if (ask <= bid) return null;
    const lo = mid * (1 - bandBps / 10_000), hi = mid * (1 + bandBps / 10_000);
    const complete = lower <= lo && upper >= hi && receivedAt - timestamp <= 5000 && timestamp <= receivedAt;
    function slippage(rows: Level[], best: number, side: 'buy' | 'sell') {
      let remaining = orderSizeQuote, base = 0;
      for (const [p, q] of rows) {
        if (p < lower || p > upper) break; // Depth outside the seeded range is not fully known.
        const used = Math.min(remaining, p * q); base += used / p; remaining -= used;
        if (remaining < 1e-8) break;
      }
      if (remaining > 1e-8 || base <= 0) return null;
      return Math.max(0, (side === 'buy' ? orderSizeQuote / base / best - 1 : 1 - orderSizeQuote / base / best) * 10_000);
    }
    return { marketKey, timestamp, receivedAt, bid, ask, bandBps, spreadBps: (ask - bid) / mid * 10_000,
      bidDepthQuote: b.filter(([p]) => p >= lo).reduce((s, [p, q]) => s + p * q, 0),
      askDepthQuote: a.filter(([p]) => p <= hi).reduce((s, [p, q]) => s + p * q, 0),
      buySlippageBps: complete ? slippage(a, ask, 'buy') : null, sellSlippageBps: complete ? slippage(b, bid, 'sell') : null,
      orderSizeQuote, complete, reason: complete ? null : '可验证盘口未完整覆盖价格±10bp或数据过期；不判断流动性异常' };
  }
  return { seed, update, snapshot, reset };
}
