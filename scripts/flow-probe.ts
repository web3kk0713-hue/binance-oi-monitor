import { createFlowFeed } from '../src/data/flowFeed';
import { writeFile } from 'node:fs/promises';

// Real public source probe. It never places orders or uses a secret.
const startedAt = Date.now(), duration = Math.max(30, Number(process.argv[2] ?? 360)) * 1000;
let closedCandles = 0, detected = 0, depth = 0;
const samples: unknown[] = [];
const feed = createFlowFeed({ mode: 'server', onUpdate: update => { closedCandles += update.candles.length; detected += update.events.length; depth += update.depth.length; } });
await feed.start();
const timer = setInterval(() => {
  const s = feed.snapshot(), btc = s.rows.find(r => r.market.key === 'futures:BTCUSDT');
  const point = { elapsedSeconds: Math.round((Date.now() - startedAt) / 1000), status: s.status, btc,
    events: s.events.slice(0, 3), closedCandles, eventUpdates: detected, depthPoints: depth, memoryMiB: Math.round(process.memoryUsage().rss / 1024 / 1024) };
  samples.push(point); console.log(JSON.stringify(point));
}, 30_000);
await new Promise<void>(resolve => setTimeout(resolve, duration));
clearInterval(timer); feed.stop();
await writeFile('D:/CodexProjects/binance-oi-monitor/docs/workflow/flow-runtime-probe.json', JSON.stringify({ startedAt, completedAt: Date.now(), samples }, null, 2));
