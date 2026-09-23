/** Synthetic, loopback-only browser acceptance. In-memory DB; never requests exchange APIs. */
import { buildApp } from './app';
import { loadConfig } from './config';
import { SqliteDatabase } from './database';
import { MonitorStore } from './store';
import type { AssetRow, Snapshot } from '../src/shared/types';

const store = new MonitorStore(new SqliteDatabase(':memory:')); await store.initialize();
const initial = Date.now();
const config = loadConfig({ HOST: '127.0.0.1', PORT: '8794', SQLITE_PATH: ':memory:',
  ALLOWED_ORIGINS: 'http://127.0.0.1:4178', COLLECT_ON_START: 'false' });
function row(symbol: string, at: number, factor: number, fdvFactor: number, missing = false): AssetRow {
  const price = 10 * fdvFactor, oiQuantity = 100 * factor, fdv = missing ? null : 10_000 * fdvFactor;
  return { id: `synthetic:${symbol}`, symbol, name: '仅本机验收的合成样本，非真实行情', contracts: [`${symbol}USDT`],
    priceUsd: price, oiUsd: oiQuantity * price, oiQuantity, marketCapUsd: fdv, fdvUsd: fdv,
    oiToFdv: fdv === null ? null : oiQuantity * price / fdv * 100, oiToMarketCap: null,
    circulatingSupply: 1000, maxSupply: missing ? null : 1000, updatedAt: at, oiUpdatedAt: at - 1000,
    priceUpdatedAt: at - 1000, supplyUpdatedAt: at - 1000, complete: true, alertEligible: !missing,
    issues: ['合成测试样本，非真实行情', ...(missing ? ['测试：最大供应量缺失'] : [])], supplySource: 'test-only', mappingStatus: 'verified',
    evidence: { mapping: 'synthetic acceptance only', supply: { provider: 'CoinGecko', id: 'synthetic', circulating: 1000, total: 1000, max: missing ? null : 1000,
      fetchedAt: at - 1000, updatedAt: at - 1000, url: 'https://example.invalid/synthetic-test' },
      contracts: [{ symbol: `${symbol}USDT`, baseAsset: symbol, quoteAsset: 'USDT', openInterest: String(oiQuantity), markPrice: String(price), indexPrice: String(price),
        quoteUsd: '1', oiTime: at - 1000, priceTime: at - 1000, quoteTime: at - 1000, oiUsd: oiQuantity * price, unitMultiplier: 1 }] } };
}
async function seed(at: number) {
  for (let index = 0; index <= 12; index++) {
    const time = at - (12 - index) * 30_000, progress = Math.max(0, index - 2) / 10;
    const assets = [row('TEST_UP', time, 1 + 0.06 * progress, 1 + 0.04 * progress), row('TEST_DOWN', time, 1 - 0.08 * progress, 1 - 0.05 * progress), row('TEST_MISSING', time, 1 + 0.1 * progress, 1, true)];
    const snapshot: Snapshot = { schemaVersion: 1, mode: 'server', startedAt: time - 1500, asOf: time, durationMs: 1500,
      collectionIntervalMs: 30_000, universe: { assets: 3, contracts: 3 }, coverage: { oi: 3, marketCap: 2, fdv: 2, eligible: 2, failedContracts: 0 },
      errors: ['仅本机验收：合成样本，不是真实行情'], assets };
    await store.commitCollection(snapshot, {}, []);
  }
}
await seed(initial);
const { app } = await buildApp({ store, config, startJobs: false, collector: { collect: async () => { throw new Error('Synthetic acceptance must never collect upstream'); } },
  flowFeedFactory: () => { throw new Error('Synthetic acceptance must never start streams'); } });
await app.listen({ host: '127.0.0.1', port: 8794 });
let pending = false;
const timer = setInterval(() => { if (!pending) { pending = true; void seed(Date.now()).finally(() => { pending = false; }); } }, 30_000);
console.log('SYNTHETIC ONLY: http://127.0.0.1:8794 — no upstream connections, in-memory DB');
let closing = false;
async function stop() { if (closing) return; closing = true; clearInterval(timer); await app.close(); process.exit(0); }
process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
process.stdin.on('data', data => { if (String(data).trim() === 'stop') void stop(); });
