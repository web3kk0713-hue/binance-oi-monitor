/**
 * LOOPBACK SYNTHETIC UI ACCEPTANCE ONLY. Never imported by server/index.ts.
 * No exchange collector, socket, credentials, persistent database, or outbound fetch.
 * Build first, then: node --import tsx server/position-ui-acceptance.ts
 */
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import Fastify from 'fastify';
import { toHistoryPoint } from '../src/shared/history';
import type { AssetRow, BackendStatus, HistoryPoint, Snapshot } from '../src/shared/types';
import type { FlowCandle, FlowDepth, FlowEvent, FlowHistory, FlowMarket, FlowMetrics, FlowOi, FlowSnapshot } from '../src/shared/flowTypes';

const MINUTE = 60_000;
const WINDOW = 5 * MINUTE;
const startedAt = Date.now();
const syntheticLabel = '合成验收样本 · 非真实行情 · 无上游连接';
interface Definition {
  symbol: string; oi: number; price: number; missingFdv: boolean;
  futuresBuyShare?: number; spotBuyShare?: number; missingFunding?: boolean; missingNativeOi?: boolean;
}
const definitions: readonly Definition[] = [
  { symbol: 'TEST_FLAT', oi: .10, price: .002, missingFdv: false, spotBuyShare: 62 },
  { symbol: 'TEST_UP', oi: .06, price: .04, missingFdv: false },
  { symbol: 'TEST_DOWN', oi: -.08, price: -.05, missingFdv: false },
  { symbol: 'TEST_MISSING', oi: .10, price: 0, missingFdv: true },
  { symbol: 'TEST_LONG', oi: .08, price: .02, missingFdv: false, futuresBuyShare: 68, spotBuyShare: 62 },
  { symbol: 'TEST_SHORT', oi: .09, price: -.02, missingFdv: false, futuresBuyShare: 32, spotBuyShare: 38 },
  { symbol: 'TEST_CONFLICT', oi: .08, price: .02, missingFdv: false, futuresBuyShare: 68, spotBuyShare: 35 },
  { symbol: 'TEST_FUNDING_MISSING', oi: .08, price: .02, missingFdv: false, futuresBuyShare: 68, spotBuyShare: 62, missingFunding: true },
  { symbol: 'TEST_NO_OI', oi: .08, price: .02, missingFdv: false, futuresBuyShare: 68, spotBuyShare: 62, missingNativeOi: true },
  { symbol: 'TEST_SENSITIVE', oi: .02, price: .003, missingFdv: false, futuresBuyShare: 57, spotBuyShare: 60 },
  { symbol: 'TEST_SENSITIVE_SHORT', oi: .02, price: -.003, missingFdv: false, futuresBuyShare: 43, spotBuyShare: 40 },
  { symbol: 'TEST_PENDING', oi: .12, price: .015, missingFdv: false, futuresBuyShare: 68 },
];

let staleAt: number | null = null;
let riskMark: string | null = null;
let lastSnapshotAt = startedAt;
const snapshotFrames = [startedAt];
const observationTime = () => staleAt ?? Date.now();
const assetId = (item: Definition) => `synthetic:${item.symbol}`;
const contractSymbol = (item: Definition) => `${item.symbol}USDT`;
const progressAt = (at: number, end: number) => Math.max(0, Math.min(1, (at - (end - WINDOW)) / WINDOW));

/** Each frame repeats one fixed 5m scenario; waiting does not compound its returns. */
function assetAt(item: Definition, at: number, end: number): AssetRow {
  const progress = progressAt(at, end);
  const price = 2 * (1 + item.price * progress);
  const quantity = 100 * (1 + item.oi * progress);
  const sourceTime = at - 1000;
  const oiUsd = quantity * price;
  const fdvUsd = item.missingFdv ? null : price * 1000;
  const symbol = contractSymbol(item);
  return {
    id: assetId(item), symbol: item.symbol, name: syntheticLabel, contracts: [symbol],
    priceUsd: price, oiUsd, oiQuantity: quantity, marketCapUsd: price * 800, fdvUsd,
    oiToFdv: fdvUsd === null ? null : oiUsd / fdvUsd * 100,
    oiToMarketCap: quantity / 800 * 100, circulatingSupply: 800,
    maxSupply: item.missingFdv ? null : 1000,
    updatedAt: at, oiUpdatedAt: sourceTime, priceUpdatedAt: sourceTime, supplyUpdatedAt: sourceTime,
    complete: true, alertEligible: !item.missingFdv, supplySource: 'SYNTHETIC ONLY', mappingStatus: 'verified',
    issues: [syntheticLabel, ...(item.missingFdv ? ['合成测试：最大供应量未知，FDV 保持空值'] : [])],
    evidence: {
      mapping: 'SYNTHETIC UI acceptance only; not a production token mapping',
      supply: {
        provider: 'CoinGecko', id: `synthetic-${item.symbol.toLowerCase()}`,
        circulating: 800, total: 1000, max: item.missingFdv ? null : 1000,
        providerPriceUsd: price, updatedAt: sourceTime, fetchedAt: sourceTime,
        url: 'https://example.invalid/synthetic-position-acceptance',
      },
      contracts: [{
        symbol, baseAsset: item.symbol, quoteAsset: 'USDT', openInterest: String(quantity),
        markPrice: String(price), indexPrice: String(price), quoteUsd: '1', unitMultiplier: 1,
        oiUsd, oiTime: sourceTime, priceTime: sourceTime, quoteTime: sourceTime,
        oiObservedAt: sourceTime, priceObservedAt: sourceTime, quoteObservedAt: sourceTime,
      }],
    },
  };
}

function sample(at: number): Snapshot {
  const assetCount = definitions.length;
  const fdvCount = definitions.filter(item => !item.missingFdv).length;
  return {
    schemaVersion: 1, mode: 'server', startedAt: at - 1500, asOf: at, durationMs: 1500,
    collectionIntervalMs: 30_000, universe: { contracts: assetCount, assets: assetCount },
    coverage: { oi: assetCount, marketCap: assetCount, fdv: fdvCount, eligible: fdvCount, failedContracts: 0 },
    assets: definitions.map(item => assetAt(item, at, at)),
    errors: [syntheticLabel, ...(staleAt === null ? [] : ['合成测试：当前快照故意停在 120 秒前，不能用于实时判断'])],
  };
}

function historyPoint(item: Definition, at: number, end: number): HistoryPoint {
  return toHistoryPoint(assetAt(item, at, end), { startedAt: at - 1500, asOf: at, collectionIntervalMs: 30_000 });
}

/** Baseline requests contain the exact snapshot time minus an integer-minute window. */
function matchingFrame(at: number): number {
  return [...snapshotFrames].reverse().find(frame => {
    const elapsed = frame - at;
    return elapsed >= MINUTE && elapsed <= 7 * 86_400_000 && elapsed % MINUTE === 0;
  }) ?? lastSnapshotAt;
}

function market(item: Definition, venue: 'futures' | 'spot' = 'futures'): FlowMarket {
  const symbol = contractSymbol(item);
  return { key: `${venue}:${symbol}`, venue, symbol, baseAsset: item.symbol, quoteAsset: 'USDT', assetId: assetId(item) };
}
const markets = [
  ...definitions.map(item => market(item)),
  ...definitions.filter(item => item.spotBuyShare !== undefined).map(item => market(item, 'spot')),
];
const definitionFor = (value: FlowMarket) => definitions.find(item => assetId(item) === value.assetId)!;
const buyShareFor = (item: Definition, venue: 'futures' | 'spot') => venue === 'spot' ? item.spotBuyShare ?? 62 : item.futuresBuyShare ?? 65;

function depthFor(value: FlowMarket, at: number, price: number): FlowDepth {
  return {
    marketKey: value.key, timestamp: at - 1000, receivedAt: at - 500,
    bid: price * .99995, ask: price * 1.00005, bidDepthQuote: 250_000, askDepthQuote: 210_000,
    bandBps: 10, spreadBps: 1, buySlippageBps: 2.1, sellSlippageBps: 2.4,
    orderSizeQuote: 10_000, complete: true, reason: null,
  };
}

function flowRow(value: FlowMarket, at: number): FlowMetrics {
  const item = definitionFor(value);
  // TEST_UP alone has intentionally old flow/funding even while valuation is fresh.
  const intentionallyStale = item.symbol === 'TEST_UP';
  const rowAt = intentionallyStale ? at - 180_000 : at;
  const price = 2 * (1 + item.price);
  const buyShare = buyShareFor(item, value.venue);
  return {
    market: value, asOf: rowAt, status: intentionallyStale || staleAt !== null ? 'stale' : 'live',
    reason: intentionallyStale ? '合成测试：该市场订单流与资金费率故意过期，应显示不可用'
      : item.missingNativeOi ? '合成测试：5m 单合约 OI 基线正在预热；不能借用估值页 OI 代替' : syntheticLabel,
    price, priceChange5m: item.price * 100, volume5m: 1_000_000, buyShare5m: buyShare,
    delta5m: 1_000_000 * (2 * buyShare / 100 - 1), volumeMultiple: 2.2,
    vwap5m: price * .999, range5mPct: Math.abs(item.price) * 100 + .2, atr14: .012,
    oiChange5m: value.venue === 'futures' && !item.missingNativeOi ? item.oi * 100 : null,
    funding: value.venue === 'spot' || item.missingFunding ? null : {
      marketKey: value.key, markPrice: price, indexPrice: price,
      fundingRate: .0001, fundingIntervalHours: 8,
      nextFundingTime: Math.floor(at / (8 * 3_600_000) + 1) * 8 * 3_600_000,
      timestamp: rowAt - 1000, receivedAt: rowAt - 500,
    },
    depth: depthFor(value, rowAt, price), baselineWindows: 30, tradeSamples: 1200,
    largeTradeThreshold: 50_000, lastTradeAt: rowAt - 1000, lastCandleAt: rowAt - 1000,
  };
}

// Stable ID and time allow replay to remain selected across repeated polling.
const eventTime = startedAt - 2 * MINUTE;
function syntheticEvent(symbol: string, side: 'buy' | 'sell', id: string): FlowEvent {
  const item = definitions.find(value => value.symbol === symbol)!;
  const replayMarket = market(item), replayPrice = assetAt(item, eventTime, startedAt).priceUsd!;
  const changePct = side === 'buy' ? .1 : -.1;
  return {
    id, ruleVersion: 'flow-v1', marketKey: replayMarket.key,
    symbol: replayMarket.symbol, assetId: replayMarket.assetId, venue: 'futures', quoteAsset: 'USDT',
    kind: side === 'buy' ? 'large_buy' : 'large_sell', severity: 'warning',
    title: `合成测试 · ${side === 'buy' ? '大额主动买入' : '大额主动卖出'}`,
    timestamp: eventTime, detectedAt: eventTime + 500, referencePrice: replayPrice,
    evidence: [{ label: '单笔成交额', value: 75_000, unit: 'USDT', baseline: 50_000 },
      { label: '主动买入占比', value: buyShareFor(item, 'futures'), unit: '%' }],
    reason: '合成验收事件，用于验证固定回放与当前方向评估分离；不是交易所事件，不包含历史方向结论。',
    invalidation: '仅 UI 验收，不构成多空建议或已验证策略。', dataStatus: 'complete',
    rawTrade: { marketKey: replayMarket.key, id: `${id}-trade`, price: String(replayPrice),
      quantity: String(75_000 / replayPrice), quoteQuantity: '75000', timestamp: eventTime, receivedAt: eventTime + 500, side },
    outcomes: [{ minutes: 1, price: replayPrice * (1 + changePct / 100), changePct,
      availableAt: eventTime + MINUTE + 1500, entryPrice: replayPrice, entryAt: eventTime + 1000 }],
  };
}
const events = [
  syntheticEvent('TEST_FLAT', 'buy', 'synthetic-position-flat-buy'),
  syntheticEvent('TEST_LONG', 'buy', 'synthetic-direction-long-buy'),
  syntheticEvent('TEST_SHORT', 'sell', 'synthetic-direction-short-sell'),
  syntheticEvent('TEST_SENSITIVE', 'buy', 'synthetic-direction-sensitive-buy'),
  syntheticEvent('TEST_PENDING', 'buy', 'synthetic-direction-pending-buy'),
];

function flowSnapshot(): FlowSnapshot {
  const at = observationTime();
  const rows = markets.map(value => flowRow(value, at));
  return {
    schemaVersion: 1,
    status: {
      mode: 'server', startedAt, asOf: at, connectedStreams: 0, totalStreams: 0,
      markets: rows.length, readyMarkets: rows.filter(row => row.status === 'live').length,
      warmingMarkets: 0, staleMarkets: rows.filter(row => row.status === 'stale').length,
      backfilledMarkets: rows.length, errors: [syntheticLabel], retentionDays: 7,
      scope: `${syntheticLabel}；${definitions.length} 个合约与 ${markets.length - definitions.length} 个现货；TEST_UP 订单流故意过期。`,
    },
    rows, events,
    marks: rows.filter(row => row.market.venue === 'futures').map(row => ({ marketKey: row.market.key,
      markPrice: riskMark ?? String(row.price), sourceTime: at - 1000, receivedAt: at - 500, source: 'binance-mark-stream' as const })),
  };
}

function flowHistory(value: FlowMarket | undefined, from: number, to: number): FlowHistory {
  const result: FlowHistory = { market: value ?? null, from, to, candles: [], events: [], depth: [], oi: [] };
  if (!value) return result;
  const item = definitionFor(value), end = lastSnapshotAt;
  const observedTo = Math.min(to, observationTime());
  const share = buyShareFor(item, value.venue) / 100;
  const candles: FlowCandle[] = [], oi: FlowOi[] = [];
  for (let openTime = Math.floor(from / MINUTE) * MINUTE; openTime + MINUTE <= observedTo; openTime += MINUTE) {
    const closeTime = openTime + MINUTE - 1;
    const open = assetAt(item, openTime, end).priceUsd!;
    const close = assetAt(item, closeTime, end).priceUsd!;
    candles.push({ marketKey: value.key, openTime, closeTime, open, close,
      high: Math.max(open, close) * 1.0002, low: Math.min(open, close) * .9998,
      volume: 200_000 / close, quoteVolume: 200_000, takerBuyQuote: 200_000 * share,
      trades: 240, closed: true, sourceTime: closeTime, receivedAt: closeTime + 1, source: 'rest' });
  }
  if (value.venue === 'futures' && !item.missingNativeOi) {
    for (let timestamp = from; timestamp <= observedTo; timestamp += 30_000) {
      oi.push({ marketKey: value.key, quantity: assetAt(item, timestamp, end).oiQuantity!, timestamp, receivedAt: timestamp });
    }
  }
  result.candles = candles; result.oi = oi;
  result.events = events.filter(event => event.marketKey === value.key && event.timestamp >= from && event.detectedAt <= observedTo);
  const depth = depthFor(value, observedTo, assetAt(item, observedTo, end).priceUsd!);
  if (depth.timestamp >= from) result.depth = [depth];
  return result;
}

const app = Fastify({ logger: false });
app.addHook('onRequest', async (_request, reply) => {
  reply.header('Content-Security-Policy', "connect-src 'self'");
  reply.header('Cache-Control', 'no-store');
  reply.header('X-Content-Type-Options', 'nosniff');
});

app.get('/api/v1/snapshot', async () => {
  lastSnapshotAt = observationTime();
  if (snapshotFrames.at(-1) !== lastSnapshotAt) snapshotFrames.push(lastSnapshotAt);
  if (snapshotFrames.length > 128) snapshotFrames.shift();
  return sample(lastSnapshotAt);
});
app.get('/api/v1/health', async (): Promise<BackendStatus> => ({
  mode: 'server', version: 'SYNTHETIC-ACCEPTANCE', collecting: false, lastSuccess: lastSnapshotAt,
  storage: 'synthetic in-memory frames; no production database', pushEnabled: false, retentionDays: 7,
  lastError: staleAt === null ? null : '合成测试：快照故意过期', collectionIntervalMs: 30_000,
}));
app.get<{ Querystring: { at?: string } }>('/api/v1/change-baselines', async (request, reply) => {
  const at = Number(request.query.at);
  if (!Number.isSafeInteger(at) || at <= 0 || at > Date.now()) return reply.code(400).send({ error: 'invalid_synthetic_time' });
  const frame = matchingFrame(at);
  return definitions.map(item => historyPoint(item, at, frame));
});
app.get<{ Querystring: { assetId?: string; hours?: string } }>('/api/v1/history', async request => {
  const item = definitions.find(value => assetId(value) === request.query.assetId);
  if (!item) return [];
  const hours = boundedHours(request.query.hours, 24), end = lastSnapshotAt;
  const points: HistoryPoint[] = [];
  for (let at = end - hours * 3_600_000; at <= end; at += 30_000) points.push(historyPoint(item, at, end));
  return points;
});
app.get('/api/v1/flow/snapshot', async () => flowSnapshot());
app.get<{ Querystring: { marketKey?: string; hours?: string; to?: string } }>('/api/v1/flow/history', async (request, reply) => {
  const to = request.query.to === undefined ? Date.now() : Number(request.query.to);
  if (!Number.isSafeInteger(to) || to <= 0 || to > Date.now() + 1000) return reply.code(400).send({ error: 'invalid_synthetic_time' });
  const hours = boundedHours(request.query.hours, 24);
  return flowHistory(markets.find(value => value.key === request.query.marketKey), to - hours * 3_600_000, to);
});
app.get<{ Querystring: { marketKey?: string } }>('/api/v1/flow/events', async request => events.filter(event => !request.query.marketKey || request.query.marketKey === event.marketKey));
app.get('/api/v1/alerts', async () => []);
app.get('/api/v1/push/key', async () => ({ publicKey: null }));

function boundedHours(raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? fallback);
  return Number.isFinite(value) ? Math.max(1 / 60, Math.min(168, value)) : fallback;
}

app.get('/acceptance', async (_request, reply) => reply.type('text/html').send(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>合成验收 · 非真实行情</title>
<body><h1>仅本机合成验收 · 非真实行情</h1><p>无交易所连接、无持久数据库。所有 TEST_* 数据都是 UI 验收夹具。</p>
<ul><li>TEST_FLAT：5m OI 数量 +10%，价格/FDV +0.2%，OI/FDV 相对增长 +10%；价格未达到方向阈值。</li><li>TEST_UP：+6% / +4%，但订单流故意过期。</li><li>TEST_DOWN：−8% / −5%，减仓不直接判空。</li><li>TEST_MISSING：OI +10%，价格不变，FDV 缺失。</li>
<li>TEST_LONG：5m OI +8%，价格 +2%，合约/现货主动买入 68%/62%；用于多方候选验收。</li>
<li>TEST_SHORT：5m OI +9%，价格 −2%，合约/现货主动买入 32%/38%；用于空方候选验收。</li>
<li>TEST_CONFLICT：5m OI +8%，价格 +2%，合约买入 68% 但现货仅 35%；用于冲突观望验收。</li>
<li>TEST_FUNDING_MISSING：同向买入与 OI/价格条件具备，但资金费率缺失；必须显示风险未知。</li>
<li>TEST_NO_OI：估值页 OI 有变化，但单合约 5m OI 基线缺失；必须继续预热，不能借用聚合 OI 给方向。</li>
<li>TEST_SENSITIVE：5m OI +2%，价格 +0.3%，合约/现货主动买入 57%/60%；标准档观望，敏感档可出现偏多候选。</li>
<li>TEST_SENSITIVE_SHORT：5m OI +2%，价格 −0.3%，合约/现货主动买入 43%/40%；标准档观望，敏感档可出现偏空候选。</li>
<li>TEST_PENDING：5m OI +12%，价格 +1.5%，合约主动买入 68%，没有现货样本；允许缺少现货时只能待确认，要求现货确认时必须观望。</li></ul>
<p>除 TEST_FUNDING_MISSING 与故意过期样本外，费率 0.01%，8h。点击合成买入/卖出事件可验证回放与当前方向分离。所有数值均为验收样本，不是交易建议。</p>
<button data-view="changes">打开变化监控合成验收</button><button data-view="flow">打开异常监控合成验收</button>
<p>终端命令：stale（快照故意过期）、live（恢复新鲜）、status、stop。更改后点击页面刷新或等待轮询。</p>
<script>document.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>{localStorage.setItem('oi-monitor:v1:settings',JSON.stringify({mode:'server',backendUrl:location.origin,notifications:false}));location.href='/?view='+button.dataset.view;});</script></body></html>`));

const root = resolve('dist');
app.get('/*', async (request, reply) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  const file = resolve(root, pathname === '/' ? 'index.html' : `.${pathname}`);
  if (!file.startsWith(root + sep)) return reply.code(404).send();
  try {
    const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
    const content = await readFile(file);
    if (extname(file) === '.html') return reply.type('text/html').send(content.toString().replace(/<title>.*?<\/title>/s, '<title>合成验收 · 非真实行情</title>'));
    return reply.type(types[extname(file)] ?? 'application/octet-stream').send(content);
  } catch { return reply.code(404).send(); }
});

await app.listen({ host: '127.0.0.1', port: 8794 });
console.log('SYNTHETIC ONLY: http://127.0.0.1:8794/acceptance — commands: stale, live, status, stop');
const input = createInterface({ input: process.stdin });
let closing = false;
async function stop() { if (closing) return; closing = true; input.close(); await app.close(); process.exit(0); }
input.on('line', line => {
  const command = line.trim();
  if (command === 'stop') void stop();
  if (command === 'stale') { staleAt = Date.now() - 120_000; console.log('SYNTHETIC stale mode: the next snapshot is already 120s old.'); }
  if (command === 'live') { staleAt = null; console.log('SYNTHETIC live mode: fresh fixed-return frames restored.'); }
  if (command === 'status') console.log(JSON.stringify({ synthetic: true, mode: staleAt === null ? 'live' : 'stale', asOf: lastSnapshotAt, frameCount: snapshotFrames.length }));
  if (/^mark [0-9]+(?:\.[0-9]+)?$/.test(command)) { riskMark = command.slice(5); console.log(`SYNTHETIC risk mark override: ${riskMark}`); }
  if (command === 'mark reset') { riskMark = null; console.log('SYNTHETIC risk mark reset.'); }
});
process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
