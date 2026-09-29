/** Read-only public-source runtime check. No account API, orders, uploads or private position data. */
import { createStructureHistoryClient } from '../src/data/structureHistory';
import { proposeStructureAdvice, validateStructureHistory } from '../src/shared/structureAdvice';
import { replayStructureAdvice } from '../src/shared/structureReplay';
import { STRUCTURE_LOOKBACK_MS } from '../src/shared/structureTypes';

const history = await createStructureHistoryClient().load('BTCUSDT', new AbortController().signal);
if (!validateStructureHistory(history)) throw new Error('Live history failed domain validation');
const now = Date.now();
const totals = { samples: 0, ready: 0, refused: 0, stop: 0, target1: 0, ambiguous: 0, unresolved: 0, incomplete: 0 };
let elapsed = 0, maximum = 0;
for (let at = history.from + STRUCTURE_LOOKBACK_MS; at + 4 * 3_600_000 <= history.to; at += 12 * 3_600_000) {
  const candle = history.candles.find(c => c.closeTime + 1 === at)!;
  for (const side of ['long', 'short'] as const) {
    const started = performance.now();
    const result = proposeStructureAdvice({ history, now, mode: 'replay',
      position: { id: 'hypothetical-probe', marketKey: history.marketKey, symbol: history.symbol, assetId: 'binance:BTC',
        side, entryPrice: candle.close, margin: '100', leverage: '2', createdAt: at },
      reference: { marketKey: history.marketKey, markPrice: candle.close, sourceTime: at, receivedAt: at, source: 'binance-premium-rest' } });
    const duration = performance.now() - started; elapsed += duration; maximum = Math.max(maximum, duration);
    totals.samples++;
    if (result.status !== 'ready') { totals.refused++; continue; }
    totals.ready++;
    const outcome = replayStructureAdvice(result.advice, history);
    if (outcome.reason === '方案无效，未进行回放') throw new Error('Engine and replay contracts disagree');
    totals[outcome.outcome]++;
  }
}
console.log(JSON.stringify({ source: 'Binance /fapi/v1/markPriceKlines interval=5m', symbol: history.symbol,
  tickSize: history.tickSize, rows: history.candles.length, from: new Date(history.from).toISOString(),
  toExclusive: new Date(history.to).toISOString(), fetchedAt: new Date(history.fetchedAt).toISOString(),
  totals, calculationMs: { average: Number((elapsed / totals.samples).toFixed(2)), max: Number(maximum.toFixed(2)) },
  scope: 'Hypothetical mechanical touch diagnosis, not strategy profitability, not browser/IDB acceptance' }, null, 2));
