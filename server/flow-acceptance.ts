/** Explicit, temporary localhost acceptance runner. Does not load .env or install a service. */
import { resolve } from 'node:path';
import { createCollector } from '../src/data/collector';
import { buildApp } from './app';
import { loadConfig } from './config';
import { SqliteDatabase } from './database';
import { MonitorStore } from './store';

const stamp = process.argv[2];
if (!stamp || !/^\d{8}-\d{6}$/.test(stamp)) throw new Error('Expected a fixed YYYYMMDD-HHMMSS acceptance identifier');
const readOnly = process.argv[3] === 'read-only';
const path = resolve('data', `flow-acceptance-${stamp}.sqlite`);
const config = loadConfig({ HOST: '127.0.0.1', PORT: '8793', SQLITE_PATH: path,
  ALLOWED_ORIGINS: 'http://127.0.0.1:5178,http://localhost:5178,http://127.0.0.1:4178,http://localhost:4178,https://web3kk0713-hue.github.io',
  NOTIFICATION_URL: 'http://127.0.0.1:5178', COLLECT_ON_START: readOnly ? 'false' : 'true' });
const store = new MonitorStore(new SqliteDatabase(path)); await store.initialize();
const initialSnapshot = await store.latest() ?? undefined;
const { app } = await buildApp({ store, config, startJobs: !readOnly, logger: false,
  collector: createCollector({ mode: 'server', concurrency: 12, initialSnapshot }) });
await app.listen({ host: config.host, port: config.port });
process.stdout.write(JSON.stringify({ type: 'started', at: new Date().toISOString(), url: 'http://127.0.0.1:8793', path, readOnly }) + '\n');
let busy = false, closing = false;
async function report() {
  if (busy || closing) return; busy = true;
  try {
    const [health, flow, oi, history] = await Promise.all([
      fetch('http://127.0.0.1:8793/api/v1/health').then(r => r.json()),
      fetch('http://127.0.0.1:8793/api/v1/flow/snapshot').then(r => r.json()),
      fetch('http://127.0.0.1:8793/api/v1/snapshot').then(r => r.json()),
      fetch('http://127.0.0.1:8793/api/v1/flow/history?marketKey=futures:BTCUSDT&hours=1').then(r => r.json()),
    ]) as Array<any>;
    process.stdout.write(JSON.stringify({ type: 'sample', at: new Date().toISOString(), health,
      flow: { ...flow.status, persistedVisibleEvents: flow.events?.length, kinds: [...new Set(flow.events?.map((event: any) => event.kind))] },
      oi: { asOf: oi.asOf ?? null, durationMs: oi.durationMs ?? null, coverage: oi.coverage ?? null },
      history: { candles: history.candles?.length ?? 0, events: history.events?.length ?? 0, depth: history.depth?.length ?? 0, oi: history.oi?.length ?? 0,
        firstCandle: history.candles?.[0]?.openTime ?? null, lastCandle: history.candles?.at(-1)?.openTime ?? null } }) + '\n');
  } catch { process.stdout.write(JSON.stringify({ type: 'probe_error', at: new Date().toISOString() }) + '\n'); }
  finally { busy = false; }
}
const timer = setInterval(() => { void report(); }, 30_000); timer.unref();
void report();
async function stop() {
  if (closing) return; closing = true; clearInterval(timer);
  await app.close(); process.stdout.write(JSON.stringify({ type: 'stopped', at: new Date().toISOString(), path }) + '\n');
  process.exit(0);
}
process.on('SIGINT', () => { void stop(); }); process.on('SIGTERM', () => { void stop(); });
process.stdin.setEncoding('utf8'); process.stdin.on('data', data => { if (String(data).trim() === 'stop') void stop(); });
