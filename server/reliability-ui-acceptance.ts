/** Loopback-only synthetic failure/recovery harness. Never opens exchange connections. */
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { buildApp } from './app';
import { loadConfig } from './config';
import { SqliteDatabase } from './database';
import { MonitorStore } from './store';
import type { AssetRow, Snapshot } from '../src/shared/types';

const store = new MonitorStore(new SqliteDatabase(':memory:')); await store.initialize();
const config = loadConfig({ HOST: '127.0.0.1', PORT: '8794', SQLITE_PATH: ':memory:',
  ALLOWED_ORIGINS: 'http://127.0.0.1:8794', COLLECT_ON_START: 'false' });
let failedUntil = 0;
function sample(at: number, failed = false, factor = 1): Snapshot {
  const price = 2 * (1 + .04 * factor), quantity = 100 * (1 + .06 * factor);
  const asset: AssetRow = { id: 'synthetic:TEST_RECOVERY', symbol: 'TEST_RECOVERY', name: '合成验收样本 · 非真实行情',
    contracts: ['TEST_RECOVERYUSDT'], priceUsd: price, oiUsd: failed ? null : quantity * price, oiQuantity: failed ? null : quantity,
    marketCapUsd: price * 800, fdvUsd: price * 1000, oiToFdv: failed ? null : quantity / 10, oiToMarketCap: failed ? null : quantity / 8,
    circulatingSupply: 800, maxSupply: 1000, updatedAt: at, oiUpdatedAt: failed ? null : at - 1000,
    priceUpdatedAt: at - 1000, supplyUpdatedAt: at - 1000, complete: !failed, alertEligible: !failed,
    issues: failed ? ['合成测试：HTTP_429，非真实上游限流'] : ['合成测试样本，非真实行情'], supplySource: 'test-only', mappingStatus: 'verified',
    evidence: { mapping: 'Synthetic acceptance only', supply: { provider: 'CoinGecko', id: 'synthetic-recovery',
      circulating: 800, total: 1000, max: 1000, providerPriceUsd: price, updatedAt: at - 1000, fetchedAt: at - 1000,
      url: 'https://example.invalid/synthetic-test' }, contracts: [{ symbol: 'TEST_RECOVERYUSDT', baseAsset: 'TEST_RECOVERY', quoteAsset: 'USDT',
      openInterest: failed ? null : String(quantity), markPrice: String(price), indexPrice: String(price), quoteUsd: '1',
      oiTime: failed ? null : at - 1000, priceTime: at - 1000, quoteTime: at - 1000, unitMultiplier: 1,
      oiUsd: failed ? null : quantity * price, ...(failed ? { error: 'Synthetic HTTP_429' } : {}) }] } };
  return { schemaVersion: 1, mode: 'server', startedAt: at - 1500, asOf: at, durationMs: 1500, collectionIntervalMs: 30_000,
    universe: { assets: 1, contracts: 1 }, coverage: { oi: failed ? 0 : 1, marketCap: 1, fdv: 1, eligible: failed ? 0 : 1, failedContracts: failed ? 1 : 0 },
    errors: failed ? ['合成验收：HTTP_429，非真实上游限流'] : [], assets: [asset], ...(failed ? { retryAt: failedUntil } : {}) };
}
const initial = Date.now();
for (let index = 0; index < 12; index++) await store.commitCollection(sample(initial - (12 - index) * 30_000, false, Math.max(0, index - 2) / 10), {}, []);
const { app, scheduler } = await buildApp({ store, config, startJobs: false, flowEnabled: false,
  collector: { collect: async () => sample(Date.now(), Date.now() < failedUntil) },
  flowFeedFactory: () => { throw new Error('Synthetic acceptance must not connect upstream'); } });
app.addHook('onRequest', async (_request, reply) => {
  // Also block the selected-asset browser-only live feed during synthetic valuation checks.
  reply.header('Content-Security-Policy', "connect-src 'self'");
});

// Deliberately separate entry point; production server/index.ts does not register any test routes.
app.get('/acceptance', async (_request, reply) => reply.type('text/html').send(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>合成验收 · 非真实行情</title>
<body><h1>仅本机合成验收</h1><p>内存数据库，无交易所连接。失败由终端 fail 命令触发，冷却 90 秒后自动恢复。</p>
<button id="start">打开合成验收页面</button><script>document.getElementById('start').onclick=()=>{localStorage.setItem('oi-monitor:v1:settings',JSON.stringify({mode:'server',backendUrl:location.origin,notifications:false}));location.href='/?view=changes';};</script></body></html>`));
const root = resolve('dist');
app.get('/*', async (request, reply) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  const file = resolve(root, pathname === '/' ? 'index.html' : `.${pathname}`);
  if (!file.startsWith(root + sep)) return reply.code(404).send();
  try {
    const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
    return reply.type(types[extname(file)] ?? 'application/octet-stream').send(await readFile(file));
  } catch { return reply.code(404).send(); }
});
await app.listen({ host: '127.0.0.1', port: 8794 }); await scheduler.runOnce();
const timer = setInterval(() => void scheduler.runOnce(), 1000);
console.log('SYNTHETIC ONLY: http://127.0.0.1:8794/acceptance — commands: fail, status, stop');
const input = createInterface({ input: process.stdin });
let closing = false;
async function stop() { if (closing) return; closing = true; clearInterval(timer); input.close(); await app.close(); process.exit(0); }
input.on('line', command => {
  if (command.trim() === 'stop') void stop();
  if (command.trim() === 'fail') { failedUntil = Date.now() + 90_000; console.log(`Synthetic failure queued for next 30-second slot; recovery ${new Date(failedUntil).toISOString()}`); }
  if (command.trim() === 'status') console.log(JSON.stringify(scheduler.status()));
});
process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
