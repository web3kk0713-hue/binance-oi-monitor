import Decimal from 'decimal.js';
import type { FlowCandle, FlowDepth, FlowEvent, FlowEventKind, FlowEvidence, FlowHistory, FlowMarket,
  FlowMetrics, FlowOi, FlowOutcome, FlowQuote, FlowTrade, FlowUpdate } from './flowTypes';

const D = Decimal.clone({ precision: 40 });
const MINUTE = 60_000;
/** Experimental, deterministic flow-v1 rules. Amounts are native quote currency, never assumed USD.
 * ATR = SMA of 14 one-minute true ranges (15 closed candles), not Wilder's recursive ATR.
 * The bounded engine is not the seven-day archive: drainUpdates must be persisted by its owner.
 */
export const FLOW_RULES = Object.freeze({
  version: 'flow-v1' as const, windowMs: 5 * MINUTE, maxMarkets: 2000, candleLimit: 360,
  oiLimit: 128, depthLimit: 360, eventLimit: 2000, pendingEventLimit: 5000, pendingEvidenceLimit: 100_000,
  baselineMax: 60, baselineMin: 12, candleStaleMs: 75_000, messageLagMs: 15_000,
  oiMaxGapMs: 45_000, quoteStaleMs: 60_000, depthStaleMs: 15_000,
  sampleLimit: 10_000, globalSampleLimit: 500_000, sampleMin: 1000,
  sampleLookbackMs: 60 * MINUTE, continuousWarmupMs: 5 * MINUTE,
  largeQuantile: 0.995, largeMinimumQuote: 100_000, thresholdRefreshMs: 5000,
  largeCooldownMs: MINUTE, directionalCooldownMs: 5 * MINUTE,
  pressureSharePct: 65, pressureMinutes: 4, volumeMultiple: 2,
  breakoutWindows: 12, divergencePricePct: 0.5, divergenceDeltaShare: 0.2, divergenceOiPct: -0.5,
  depthBaselineMs: 5 * MINUTE, depthMinSamples: 60, depthLossRatio: 0.6,
  spreadMultiple: 2, depthPersistenceMs: 10_000, depthMaxGapMs: 5000,
  outcomeEntryMaxDelayMs: 90_000,
});

interface Sample { id: string; time: number; receivedAt: number; amount: number; price: number; }
interface Threshold { at: number; value: number | null; count: number; first: number; }
interface State {
  market: FlowMarket; connected: boolean; connectedAt: number; continuityAt: number;
  candles: Map<number, FlowCandle>; trades: Map<string, Sample>; oi: Map<number, FlowOi>; depth: Map<number, FlowDepth>;
  quote: FlowQuote | null; latestTrade: Sample | null; latestStreamAt: number | null; latestStreamReceivedAt: number | null;
  threshold: Threshold | null; evicted: boolean; lastPruned: number; pendingBlocked: boolean; evidenceBlocked: boolean;
  retiredTradeId: bigint | null;
  cooldown: Map<FlowEventKind, number>; evaluatedEnd: number;
  depthSince: number | null; depthLast: number | null;
}
interface EventState { event: FlowEvent; entry: { price: number; at: number } | null; lastClose: number | null; blocked: boolean; }
interface WindowSummary { candles: FlowCandle[]; volume: number; buy: number; delta: number; vwap: number | null;
  change: number; range: number; atr: number | null; baselines: number[]; priorWindows: FlowCandle[][]; multiple: number | null; }

const finite = (value: number) => Number.isFinite(value);
const positive = (value: number) => finite(value) && value > 0;
const nonnegative = (value: number) => finite(value) && value >= 0;
const time = (value: number) => Number.isSafeInteger(value) && value >= 0;
const marketToken = (value: string) => typeof value === 'string' && /^[\p{L}\p{N}_]{1,40}$/u.test(value);
const knownAt = (source: number, received: number, now: number) => time(source) && time(received) && source <= received && received <= now;
const fresh = (source: number, received: number, now: number, age: number) => knownAt(source, received, now) && now - source <= age && now - received <= age;
const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b); const center = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[center] : new D(sorted[center - 1]).add(sorted[center]).div(2).toNumber();
};
const sum = (values: number[]) => values.reduce((total, value) => total.add(value), new D(0)).toNumber();
const pct = (end: number, start: number) => new D(end).div(start).sub(1).mul(100).toNumber();
const sampleKey = (key: string, id: string) => JSON.stringify([key, id]);
const candleKey = (candle: FlowCandle) => `${candle.marketKey}:${candle.openTime}`;
const observationKey = (row: FlowDepth | FlowOi) => `${row.marketKey}:${row.timestamp}`;
const cloneEvent = (event: FlowEvent): FlowEvent => ({ ...event, evidence: event.evidence.map(row => ({ ...row })),
  outcomes: event.outcomes.map(row => ({ ...row })), ...(event.rawTrade ? { rawTrade: { ...event.rawTrade } } : {}) });
const evidence = (label: string, value: number | null, unit: string, baseline?: number | null): FlowEvidence =>
  ({ label, value, unit, ...(baseline === undefined ? {} : { baseline }) });

function validCandle(row: FlowCandle): boolean {
  return time(row.openTime) && row.openTime % MINUTE === 0 && row.closeTime === row.openTime + MINUTE - 1
    && knownAt(row.sourceTime, row.receivedAt, row.receivedAt) && row.sourceTime >= row.openTime
    && (!row.closed || row.sourceTime >= row.closeTime)
    && [row.open, row.high, row.low, row.close].every(positive)
    && row.high >= Math.max(row.open, row.close, row.low) && row.low <= Math.min(row.open, row.close)
    && [row.volume, row.quoteVolume, row.takerBuyQuote].every(nonnegative) && row.takerBuyQuote <= row.quoteVolume
    && (row.volume === 0) === (row.quoteVolume === 0)
    && Number.isSafeInteger(row.trades) && row.trades >= 0 && (row.source === 'rest' || row.source === 'stream');
}

function sameCandle(a: FlowCandle, b: FlowCandle): boolean {
  return a.closed === b.closed && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close
    && a.volume === b.volume && a.quoteVolume === b.quoteVolume && a.takerBuyQuote === b.takerBuyQuote && a.trades === b.trades;
}

function minutes(state: State, endOpen: number, length: number, now: number): FlowCandle[] | null {
  const rows: FlowCandle[] = [];
  for (let index = length - 1; index >= 0; index--) {
    const row = state.candles.get(endOpen - index * MINUTE);
    if (!row?.closed || row.closeTime > now || !knownAt(row.sourceTime, row.receivedAt, now)) return null;
    rows.push(row);
  }
  return rows;
}

function summarize(state: State, now: number): WindowSummary | null {
  const endOpen = Math.floor(now / MINUTE) * MINUTE - MINUTE;
  const rows = minutes(state, endOpen, 5, now); if (!rows) return null;
  const volume = sum(rows.map(row => row.quoteVolume)); const buy = sum(rows.map(row => row.takerBuyQuote));
  const baseVolume = sum(rows.map(row => row.volume));
  if (![volume, buy, baseVolume].every(nonnegative)) return null;
  const start = rows[0].openTime;
  // Non-overlapping UTC-aligned five-minute baselines end before the current rolling window begins.
  const previousEnd = Math.floor(start / FLOW_RULES.windowMs) * FLOW_RULES.windowMs - MINUTE;
  const baselines: number[] = []; const priorWindows: FlowCandle[][] = [];
  for (let index = 0; index < Math.ceil(FLOW_RULES.candleLimit / 5) && baselines.length < FLOW_RULES.baselineMax; index++) {
    const window = minutes(state, previousEnd - index * FLOW_RULES.windowMs, 5, now);
    if (index < FLOW_RULES.breakoutWindows && window) priorWindows.push(window);
    if (window) { const amount = sum(window.map(row => row.quoteVolume)); if (nonnegative(amount)) baselines.push(amount); }
  }
  const base = baselines.length >= FLOW_RULES.baselineMin ? median(baselines) : null;
  const atrRows = minutes(state, endOpen, 15, now);
  const ranges = atrRows?.slice(1).map((row, index) => Math.max(row.high - row.low, Math.abs(row.high - atrRows[index].close), Math.abs(row.low - atrRows[index].close)));
  const vwap = baseVolume > 0 ? new D(volume).div(baseVolume).toNumber() : null;
  const change = pct(rows[4].close, rows[0].open);
  const range = new D(Math.max(...rows.map(row => row.high))).sub(Math.min(...rows.map(row => row.low))).div(rows[0].open).mul(100).toNumber();
  const atr = ranges ? new D(sum(ranges)).div(14).toNumber() : null;
  const multiple = base !== null && base > 0 ? new D(volume).div(base).toNumber() : null;
  if ([vwap, change, range, atr, multiple].some(value => value !== null && !finite(value))) return null;
  return { candles: rows, volume, buy, delta: new D(buy).mul(2).sub(volume).toNumber(),
    vwap, change, range, atr, baselines, priorWindows, multiple };
}

function oiChange(state: State, now: number, end: number): number | null {
  if (state.market.venue !== 'futures') return null;
  const rows = [...state.oi.values()].filter(row => row.timestamp >= state.continuityAt && row.timestamp <= end
    && knownAt(row.timestamp, row.receivedAt, now) && row.receivedAt - row.timestamp <= FLOW_RULES.oiMaxGapMs).sort((a, b) => a.timestamp - b.timestamp);
  const latest = rows.at(-1);
  if (!latest || end - latest.timestamp > FLOW_RULES.oiMaxGapMs || now - latest.timestamp > FLOW_RULES.candleStaleMs) return null;
  const target = latest.timestamp - FLOW_RULES.windowMs;
  const index = rows.findLastIndex(row => row.timestamp <= target); if (index < 0) return null;
  const baseline = rows[index]; const observed = rows.slice(index);
  if (target - baseline.timestamp > FLOW_RULES.oiMaxGapMs || baseline.quantity <= 0 || observed.length < 10) return null;
  for (let i = 1; i < observed.length; i++) if (observed[i].timestamp - observed[i - 1].timestamp > FLOW_RULES.oiMaxGapMs
    || Math.abs(observed[i].receivedAt - observed[i - 1].receivedAt) > FLOW_RULES.oiMaxGapMs) return null;
  const change = pct(latest.quantity, baseline.quantity); return finite(change) ? change : null;
}

export function createFlowEngine() {
  const states = new Map<string, State>();
  const globalSamples = new Map<string, { state: State; id: string }>();
  const allEvents = new Map<string, EventState>(); const eventIds = new Map<string, Set<string>>();
  const updates = { candles: new Map<string, FlowCandle>(), events: new Map<string, FlowEvent>(),
    depth: new Map<string, FlowDepth>(), oi: new Map<string, FlowOi>() };

  function removeSample(state: State, id: string, evicted = false) {
    state.trades.delete(id); globalSamples.delete(sampleKey(state.market.key, id));
    // Binance aggregate IDs are numeric. A retired-ID watermark prevents an old retransmission
    // from re-entering the bounded sample after its payload has been evicted.
    if (/^\d+$/.test(id)) { const numeric = BigInt(id); if (state.retiredTradeId === null || numeric > state.retiredTradeId) state.retiredTradeId = numeric; }
    // A sliding cache eviction must not turn a five-second quantile cache into a sort per trade.
    if (state.trades.size < FLOW_RULES.sampleMin) state.threshold = null;
    if (evicted) state.evicted = true;
  }
  function clearSamples(state: State) { for (const id of state.trades.keys()) globalSamples.delete(sampleKey(state.market.key, id)); state.trades.clear(); state.threshold = null; }
  function clearDepth(state: State) { state.depth.clear(); state.depthSince = null; state.depthLast = null; }
  function cap<T extends FlowCandle | FlowDepth | FlowOi>(map: Map<number, T>, limit: number) {
    while (map.size > limit) {
      map.delete(Math.min(...map.keys()));
    }
  }
  function canQueueEvidence(state: State, queue: { has(key: string): boolean }, key: string): boolean {
    if (queue.has(key) || updates.candles.size + updates.depth.size + updates.oi.size < FLOW_RULES.pendingEvidenceLimit) return true;
    state.evidenceBlocked = true; return false;
  }
  function pruneSamples(state: State, now: number) {
    if (now - state.lastPruned < 1000) return;
    for (const [id, sample] of state.trades) if (sample.time < now - FLOW_RULES.sampleLookbackMs) removeSample(state, id);
    state.lastPruned = now;
  }
  function threshold(state: State, now: number): Threshold {
    const cached = state.threshold;
    if (cached && now >= cached.at && now - cached.at < FLOW_RULES.thresholdRefreshMs
      && (cached.value === null || state.trades.size >= FLOW_RULES.sampleMin)) return cached;
    const samples = [...state.trades.values()].filter(row => row.time >= now - FLOW_RULES.sampleLookbackMs && knownAt(row.time, row.receivedAt, now));
    const first = samples.length ? Math.min(...samples.map(row => row.time)) : now;
    const enough = state.connected && now - state.connectedAt >= FLOW_RULES.continuousWarmupMs && samples.length >= FLOW_RULES.sampleMin;
    let value: number | null = null;
    if (enough) { const amounts = samples.map(row => row.amount).sort((a, b) => a - b);
      value = Math.max(FLOW_RULES.largeMinimumQuote, amounts[Math.ceil(amounts.length * FLOW_RULES.largeQuantile) - 1]); }
    const result = { at: now, value, count: samples.length, first };
    state.threshold = result; return result;
  }
  function status(state: State, now: number, summary: WindowSummary | null): FlowMetrics['status'] {
    if (!state.connected) return 'disconnected';
    if (state.evidenceBlocked) return 'stale';
    if (state.latestStreamAt === null || state.latestStreamReceivedAt === null || !knownAt(state.latestStreamAt, state.latestStreamReceivedAt, now)
      || state.latestStreamAt < state.connectedAt) return 'warming';
    if (now - state.latestStreamAt > FLOW_RULES.candleStaleMs) return 'stale';
    return summary ? 'live' : 'warming';
  }
  function recordEvent(state: State, kind: FlowEventKind, timestamp: number, detectedAt: number, referencePrice: number,
    title: string, rows: FlowEvidence[], reason: string, invalidation: string, rawTrade?: FlowTrade) {
    const cooldown = kind.startsWith('large_') ? FLOW_RULES.largeCooldownMs : FLOW_RULES.directionalCooldownMs;
    if (state.evidenceBlocked) return;
    const previous = state.cooldown.get(kind);
    if (previous !== undefined && (detectedAt < previous || detectedAt - previous < cooldown)) return;
    const id = `${FLOW_RULES.version}:${state.market.key}:${kind}:${rawTrade?.id ?? timestamp}`;
    if (allEvents.has(id)) return;
    if (updates.events.size >= FLOW_RULES.pendingEventLimit) { state.pendingBlocked = true; return; }
    const event: FlowEvent = { id, ruleVersion: 'flow-v1', marketKey: state.market.key, symbol: state.market.symbol,
      assetId: state.market.assetId, venue: state.market.venue, quoteAsset: state.market.quoteAsset, kind,
      severity: kind === 'flow_divergence' ? 'info' : 'warning', title, timestamp, detectedAt, referencePrice,
      evidence: rows, reason: `实验性规则；${reason}`, invalidation, dataStatus: 'complete', outcomes: [], ...(rawTrade ? { rawTrade: { ...rawTrade } } : {}) };
    state.cooldown.set(kind, detectedAt); allEvents.set(id, { event, entry: null, lastClose: null, blocked: false });
    if (!eventIds.has(state.market.key)) eventIds.set(state.market.key, new Set());
    eventIds.get(state.market.key)!.add(id); updates.events.set(id, cloneEvent(event));
    while (allEvents.size > FLOW_RULES.eventLimit) {
      const oldest = [...allEvents.values()].reduce((a, b) => a.event.detectedAt <= b.event.detectedAt ? a : b);
      allEvents.delete(oldest.event.id); eventIds.get(oldest.event.marketKey)?.delete(oldest.event.id);
    }
  }
  function outcomes(candle: FlowCandle) {
    if (!candle.closed || candle.source !== 'stream') return;
    for (const id of eventIds.get(candle.marketKey) ?? []) {
      const row = allEvents.get(id)!; const event = row.event;
      if (row.blocked || event.outcomes.length === 3 || candle.closeTime <= event.detectedAt || candle.receivedAt <= event.detectedAt) continue;
      if (row.lastClose !== null && candle.closeTime <= row.lastClose) continue;
      if (candle.receivedAt - candle.closeTime > FLOW_RULES.messageLagMs
        || (!row.entry && candle.closeTime - event.detectedAt > FLOW_RULES.outcomeEntryMaxDelayMs)
        || (row.lastClose !== null && candle.closeTime !== row.lastClose + MINUTE)) { row.blocked = true; continue; }
      if (!row.entry) { row.entry = { price: candle.close, at: candle.closeTime }; row.lastClose = candle.closeTime; continue; }
      row.lastClose = candle.closeTime;
      const elapsed = (candle.closeTime - row.entry.at) / MINUTE;
      if (elapsed === 1 || elapsed === 5 || elapsed === 15) {
        if (event.outcomes.some(result => result.minutes === elapsed)) continue;
        const change = pct(candle.close, row.entry.price); if (!finite(change)) { row.blocked = true; continue; }
        event.outcomes.push({ minutes: elapsed, price: candle.close, changePct: change,
          availableAt: candle.receivedAt, entryPrice: row.entry.price, entryAt: row.entry.at });
        updates.events.set(event.id, cloneEvent(event));
      }
    }
  }
  function detectCandle(state: State, candle: FlowCandle) {
    if (candle.source !== 'stream' || !candle.closed || !state.connected || candle.receivedAt < state.connectedAt
      || candle.receivedAt - candle.closeTime > FLOW_RULES.messageLagMs || candle.closeTime <= state.evaluatedEnd) return;
    state.evaluatedEnd = candle.closeTime;
    const summary = summarize(state, candle.receivedAt);
    if (!summary || status(state, candle.receivedAt, summary) !== 'live' || summary.multiple === null) return;
    const unit = state.market.quoteAsset; const baseline = median(summary.baselines);
    const common = [evidence('5m成交额', summary.volume, unit, baseline), evidence('成交额倍数', summary.multiple, '倍'),
      evidence('5m主动成交差', summary.delta, unit), evidence('完整5m基准窗口', summary.baselines.length, '个')];
    if (summary.multiple >= FLOW_RULES.volumeMultiple) {
      const buyMinutes = summary.candles.filter(row => row.quoteVolume > 0 && row.takerBuyQuote / row.quoteVolume * 100 >= FLOW_RULES.pressureSharePct).length;
      const sellMinutes = summary.candles.filter(row => row.quoteVolume > 0 && (1 - row.takerBuyQuote / row.quoteVolume) * 100 >= FLOW_RULES.pressureSharePct).length;
      if (buyMinutes >= FLOW_RULES.pressureMinutes || sellMinutes >= FLOW_RULES.pressureMinutes) {
        const buy = buyMinutes >= FLOW_RULES.pressureMinutes;
        recordEvent(state, buy ? 'buy_pressure' : 'sell_pressure', candle.closeTime, candle.receivedAt, candle.close,
          buy ? '持续主动买压' : '持续主动卖压', [...common, evidence('同向分钟', buy ? buyMinutes : sellMinutes, '/5')],
          '5根完整1m中至少4根同向主动成交占比达到65%，成交额至少为此前基准的2倍。',
          '主动方向不代表开平仓或净资金流；对冲、平仓及被动吸收均可能产生该现象。');
      }
      if ((candle.closeTime + 1) % FLOW_RULES.windowMs === 0 && summary.priorWindows.length === FLOW_RULES.breakoutWindows) {
        const prior = summary.priorWindows.flat(); const high = Math.max(...prior.map(row => row.high)); const low = Math.min(...prior.map(row => row.low));
        if (candle.close > high || candle.close < low) {
          const up = candle.close > high;
          recordEvent(state, up ? 'breakout_up' : 'breakout_down', candle.closeTime, candle.receivedAt, candle.close,
            up ? '放量突破区间' : '放量跌破区间', [...common, evidence('此前12窗边界', up ? high : low, unit)],
            '完整5m收盘越过此前12个完整非重叠5m区间，成交额至少为基准2倍。', '假突破、新闻冲击及流动性变化均可能出现；不预测后续延续。');
        }
      }
    }
    const oi = oiChange(state, candle.receivedAt, candle.closeTime + 1);
    if (oi !== null && oi <= FLOW_RULES.divergenceOiPct && Math.abs(summary.change) >= FLOW_RULES.divergencePricePct
      && summary.volume > 0 && Math.abs(summary.delta) / summary.volume >= FLOW_RULES.divergenceDeltaShare
      && Math.sign(summary.delta) !== Math.sign(summary.change)) {
      recordEvent(state, 'flow_divergence', candle.closeTime, candle.receivedAt, candle.close, '价量与持仓分歧',
        [...common, evidence('5m价格变化', summary.change, '%'), evidence('连续原始OI约5m变化', oi, '%')],
        '价格变化至少0.5%，主动成交差占比至少20%且方向相反，原始OI数量下降至少0.5%。',
        '不能归因新增多空或特定主体；被动吸收、现货带动和跨市场对冲均可能解释。');
    }
  }
  function detectDepth(state: State, depth: FlowDepth) {
    const now = depth.receivedAt;
    if (!state.connected || !depth.complete || !fresh(depth.timestamp, now, now, FLOW_RULES.depthStaleMs)) { state.depthSince = null; return; }
    const rows = [...state.depth.values()].filter(row => row.timestamp < depth.timestamp && row.timestamp >= depth.timestamp - FLOW_RULES.depthBaselineMs
      && row.timestamp >= state.continuityAt && row.complete && row.bandBps === depth.bandBps
      && knownAt(row.timestamp, row.receivedAt, now) && row.receivedAt - row.timestamp <= FLOW_RULES.depthStaleMs).sort((a, b) => a.timestamp - b.timestamp);
    if (rows.length < FLOW_RULES.depthMinSamples || depth.timestamp - rows[0].timestamp < FLOW_RULES.depthBaselineMs - FLOW_RULES.depthMaxGapMs) { state.depthSince = null; return; }
    if (rows.some((row, index) => index > 0 && row.timestamp - rows[index - 1].timestamp > FLOW_RULES.depthMaxGapMs)) { state.depthSince = null; return; }
    const baseDepth = median(rows.map(row => row.bidDepthQuote + row.askDepthQuote))!;
    const baseSpread = median(rows.map(row => row.spreadBps))!;
    const total = depth.bidDepthQuote + depth.askDepthQuote;
    const abnormal = baseDepth > 0 && baseSpread > 0 && total <= baseDepth * (1 - FLOW_RULES.depthLossRatio)
      && depth.spreadBps >= baseSpread * FLOW_RULES.spreadMultiple;
    if (!abnormal) { state.depthSince = null; state.depthLast = depth.timestamp; return; }
    if (state.depthLast === null || depth.timestamp - state.depthLast > FLOW_RULES.depthMaxGapMs) state.depthSince = null;
    state.depthSince ??= depth.timestamp; state.depthLast = depth.timestamp;
    if (depth.timestamp - state.depthSince >= FLOW_RULES.depthPersistenceMs) {
      recordEvent(state, 'liquidity_drop', depth.timestamp, now, new D(depth.bid).add(depth.ask).div(2).toNumber(), '可见盘口变薄',
        [evidence('范围内双边深度', total, state.market.quoteAsset, baseDepth), evidence('价差', depth.spreadBps, 'bp', baseSpread),
          evidence('盘口范围', depth.bandBps, 'bp'), evidence('持续时间', depth.timestamp - state.depthSince, 'ms')],
        '仅所选交易对公开可见盘口；深度下降至少60%、价差至少翻倍并连续10秒。',
        '标准盘口不含RPI，不代表完整可执行流动性；撤单、行情跳动或数据缺口不能直接认定操纵。');
    }
  }

  return {
    setMarkets(markets: readonly FlowMarket[]) {
      const valid = markets.filter(row => row.key && row.key.length <= 128 && (row.venue === 'spot' || row.venue === 'futures')
        && marketToken(row.symbol) && marketToken(row.quoteAsset) && marketToken(row.baseAsset)).slice(0, FLOW_RULES.maxMarkets);
      const keys = new Set(valid.map(row => row.key));
      for (const [key, state] of states) if (!keys.has(key)) { clearSamples(state); states.delete(key); }
      for (const market of valid) {
        const prior = states.get(market.key);
        if (prior && ['symbol', 'venue', 'quoteAsset', 'baseAsset', 'assetId'].every(key => prior.market[key as keyof FlowMarket] === market[key as keyof FlowMarket])) continue;
        if (prior) clearSamples(prior);
        states.set(market.key, { market: { ...market }, connected: false, connectedAt: Infinity, continuityAt: Infinity,
          candles: new Map(), trades: new Map(), oi: new Map(), depth: new Map(), quote: null, latestTrade: null, latestStreamAt: null, latestStreamReceivedAt: null,
          threshold: null, evicted: false, lastPruned: 0, pendingBlocked: false, evidenceBlocked: false, retiredTradeId: null,
          cooldown: new Map([...allEvents.values()].filter(row => row.event.marketKey === market.key).sort((a, b) => a.event.detectedAt - b.event.detectedAt).map(row => [row.event.kind, row.event.detectedAt])),
          evaluatedEnd: -1, depthSince: null, depthLast: null });
      }
    },
    setConnected(keys: Iterable<string>, connected: boolean, now: number) {
      if (!time(now)) return;
      for (const key of keys) {
        const state = states.get(key); if (!state || state.connected === connected) continue;
        state.connected = connected; state.continuityAt = now; state.connectedAt = connected ? now : Infinity;
        clearSamples(state); clearDepth(state); state.latestTrade = null; state.latestStreamAt = null; state.latestStreamReceivedAt = null;
        if (!connected) for (const id of eventIds.get(key) ?? []) allEvents.get(id)!.blocked = true;
      }
    },
    invalidateDepth(key: string) {
      const state = states.get(key);
      // Invalidate working depth immediately without fabricating a source timestamp or deleting
      // genuine observations already queued for persistence. A new baseline must warm from zero.
      if (state) clearDepth(state);
    },
    ingestCandle(input: FlowCandle) {
      const state = states.get(input.marketKey); if (!state || !validCandle(input)) return false;
      const row = { ...input }; const prior = state.candles.get(row.openTime);
      if (prior && (prior.closed && !row.closed || row.sourceTime < prior.sourceTime || row.receivedAt < prior.receivedAt)) return false;
      if (row.source === 'stream' && row.receivedAt - row.sourceTime <= FLOW_RULES.messageLagMs && row.receivedAt >= state.connectedAt
        && row.sourceTime >= (state.latestStreamAt ?? 0)) { state.latestStreamAt = row.sourceTime; state.latestStreamReceivedAt = row.receivedAt; }
      if (prior?.closed) {
        // REST may win the close-frame race. A fresh stream close can still be evaluated now,
        // without re-persisting the identical bar or pretending REST generated an earlier alert.
        if (sameCandle(prior, row) && prior.source === 'rest' && row.source === 'stream' && state.connected) { outcomes(row); detectCandle(state, row); }
        // Freeze the first complete version and its earliest observed availability. A later REST
        // reload cannot make an earlier as-of bar disappear or rewrite its evidence.
        return false;
      }
      if (prior && sameCandle(prior, row) && prior.sourceTime === row.sourceTime && prior.receivedAt === row.receivedAt) return false;
      if (!canQueueEvidence(state, updates.candles, candleKey(row))) return false;
      state.candles.set(row.openTime, row);
      // The feed drains every five seconds. A forming minute occupies one coalesced pending key;
      // its final close replaces that key, while detection still accepts closed minutes only.
      updates.candles.set(candleKey(row), row);
      cap(state.candles, FLOW_RULES.candleLimit);
      if (row.closed && state.connected) { outcomes(row); detectCandle(state, row); }
      return true;
    },
    ingestTrade(input: FlowTrade) {
      const state = states.get(input.marketKey);
      if (!state?.connected || !input.id || input.id.length > 128 || (input.side !== 'buy' && input.side !== 'sell')
        || !fresh(input.timestamp, input.receivedAt, input.receivedAt, FLOW_RULES.messageLagMs) || input.timestamp < state.continuityAt || state.trades.has(input.id)) return false;
      if (state.retiredTradeId !== null && /^\d+$/.test(input.id) && BigInt(input.id) <= state.retiredTradeId) return false;
      let price: number; let amount: number;
      try {
        const p = new D(input.price); const q = new D(input.quantity); const supplied = new D(input.quoteQuantity); const product = p.mul(q);
        if (!p.isFinite() || !p.gt(0) || !q.isFinite() || !q.gt(0) || !supplied.isFinite() || !supplied.gt(0)
          || product.sub(supplied).abs().gt(D.max(new D('0.00000001'), product.abs().mul('0.0000000001')))) return false;
        price = p.toNumber(); amount = product.toNumber(); if (!positive(price) || !positive(amount)) return false;
      } catch { return false; }
      pruneSamples(state, input.receivedAt);
      // Compute the threshold before adding this trade: the candidate never trains its own threshold.
      const candidate = amount >= FLOW_RULES.largeMinimumQuote ? threshold(state, input.receivedAt) : null;
      const sample: Sample = { id: input.id, time: input.timestamp, receivedAt: input.receivedAt, amount, price };
      const inOrder = !state.latestTrade || sample.time >= state.latestTrade.time;
      state.trades.set(input.id, sample); globalSamples.set(sampleKey(state.market.key, input.id), { state, id: input.id });
      if (inOrder) state.latestTrade = sample;
      while (state.trades.size > FLOW_RULES.sampleLimit) removeSample(state, state.trades.keys().next().value!, true);
      while (globalSamples.size > FLOW_RULES.globalSampleLimit) { const oldest = globalSamples.values().next().value!; removeSample(oldest.state, oldest.id, true); }
      if (candidate?.value !== null && candidate?.value !== undefined && amount >= candidate.value && inOrder) {
        recordEvent(state, input.side === 'buy' ? 'large_buy' : 'large_sell', input.timestamp, input.receivedAt, price,
          input.side === 'buy' ? '大额主动买入成交' : '大额主动卖出成交',
          [evidence('聚合成交额', amount, state.market.quoteAsset, candidate.value), evidence('此前实际样本', candidate.count, '条'),
            evidence('样本源时间覆盖', input.timestamp - candidate.first, 'ms')],
          '连续连接至少5分钟；此前60分钟内最多10000条实际聚合成交样本、至少1000条；P99.5与100000报价币最低额取大值，阈值缓存5秒。',
          'aggTrade不是单个完整订单，不识别账户、鲸鱼或开平仓；样本不代表7天完整交易。', input);
      }
      return true;
    },
    ingestQuote(input: FlowQuote) {
      const state = states.get(input.marketKey);
      if (!state || !positive(input.markPrice) || !positive(input.indexPrice) || !knownAt(input.timestamp, input.receivedAt, input.receivedAt)
        || (input.fundingRate !== null && !finite(input.fundingRate))
        || (input.nextFundingTime !== null && !time(input.nextFundingTime))
        || (input.fundingIntervalHours !== null && !positive(input.fundingIntervalHours))) return false;
      if (state.quote && (input.timestamp <= state.quote.timestamp || input.receivedAt < state.quote.receivedAt)) return false;
      state.quote = { ...input }; return true;
    },
    ingestOi(input: FlowOi) {
      const state = states.get(input.marketKey);
      if (!state || state.market.venue !== 'futures' || !nonnegative(input.quantity) || !knownAt(input.timestamp, input.receivedAt, input.receivedAt)
        || state.oi.has(input.timestamp)) return false;
      if (!canQueueEvidence(state, updates.oi, observationKey(input))) return false;
      const row = { ...input }; state.oi.set(row.timestamp, row); updates.oi.set(observationKey(row), row);
      cap(state.oi, FLOW_RULES.oiLimit); return true;
    },
    ingestDepth(input: FlowDepth) {
      const state = states.get(input.marketKey);
      if (!state || !knownAt(input.timestamp, input.receivedAt, input.receivedAt) || !positive(input.bid) || !positive(input.ask) || input.ask < input.bid
        || ![input.bidDepthQuote, input.askDepthQuote, input.spreadBps].every(nonnegative) || !positive(input.bandBps)
        || !finite(input.bidDepthQuote + input.askDepthQuote)
        || !positive(input.orderSizeQuote) || (input.buySlippageBps !== null && !nonnegative(input.buySlippageBps))
        || (input.sellSlippageBps !== null && !nonnegative(input.sellSlippageBps))) return false;
      const newest = state.depth.size ? Math.max(...state.depth.keys()) : -1;
      if (input.timestamp <= newest) return false;
      if (!canQueueEvidence(state, updates.depth, observationKey(input))) return false;
      const row = { ...input }; detectDepth(state, row); state.depth.set(row.timestamp, row); updates.depth.set(observationKey(row), row);
      cap(state.depth, FLOW_RULES.depthLimit); return true;
    },
    metrics(now: number): FlowMetrics[] {
      if (!time(now)) return [];
      return [...states.values()].map(state => {
        const summary = summarize(state, now); const phase = status(state, now, summary); const current = phase === 'live';
        const availableCandles = [...state.candles.values()].filter(row => knownAt(row.sourceTime, row.receivedAt, now));
        const latest = availableCandles.sort((a, b) => b.sourceTime - a.sourceTime)[0];
        const t = state.latestTrade && knownAt(state.latestTrade.time, state.latestTrade.receivedAt, now) ? state.latestTrade : null;
        const samples = [...state.trades.values()].filter(row => row.time >= now - FLOW_RULES.sampleLookbackMs && knownAt(row.time, row.receivedAt, now));
        const large = threshold(state, now);
        const funding = state.connected && state.quote && fresh(state.quote.timestamp, state.quote.receivedAt, now, FLOW_RULES.quoteStaleMs)
          && (state.quote.nextFundingTime === null || state.quote.nextFundingTime > now) ? { ...state.quote } : null;
        const depth = [...state.depth.values()].filter(row => fresh(row.timestamp, row.receivedAt, now, FLOW_RULES.depthStaleMs)).sort((a, b) => b.timestamp - a.timestamp)[0];
        let reason = phase === 'disconnected' ? '行情连接中断，暂停事件规则' : phase === 'stale' ? '源行情过期，暂停事件规则'
          : phase === 'warming' ? '等待当时已收到的5根连续完整1m及新鲜流行情' : '基于最近5根已闭合1m；规则尚未验证收益';
        if (current && summary!.baselines.length < FLOW_RULES.baselineMin) reason += '；完整5m基准不足12窗';
        if (large.value === null) reason += state.evicted ? '；大额样本缓存淘汰后重新预热' : '；大额样本不足1000条或连续连接未满5分钟';
        if (state.pendingBlocked) reason += '；事件待持久化队列已满，已抑制新事件';
        if (state.evidenceBlocked) reason += '；证据待持久化队列已满，已暂停接收新证据和事件';
        const livePrice = t && fresh(t.time, t.receivedAt, now, FLOW_RULES.messageLagMs) && (!latest || t.time >= latest.sourceTime)
          ? t.price : latest && fresh(latest.sourceTime, latest.receivedAt, now, FLOW_RULES.candleStaleMs) ? latest.close : null;
        return { market: { ...state.market }, asOf: now, status: phase, reason, price: state.connected ? livePrice : null,
          priceChange5m: current ? summary!.change : null, volume5m: current ? summary!.volume : null,
          buyShare5m: current && summary!.volume > 0 ? new D(summary!.buy).div(summary!.volume).mul(100).toNumber() : null,
          delta5m: current ? summary!.delta : null, volumeMultiple: current ? summary!.multiple : null,
          vwap5m: current ? summary!.vwap : null, range5mPct: current ? summary!.range : null, atr14: current ? summary!.atr : null,
          oiChange5m: current ? oiChange(state, now, Math.floor(now / MINUTE) * MINUTE) : null,
          funding, depth: state.connected && depth ? { ...depth } : null, baselineWindows: summary?.baselines.length ?? 0,
          tradeSamples: samples.length, largeTradeThreshold: state.connected ? large.value : null,
          lastTradeAt: t?.time ?? null, lastCandleAt: latest?.sourceTime ?? null };
      });
    },
    events(): FlowEvent[] { return [...allEvents.values()].map(row => cloneEvent(row.event)).sort((a, b) => b.detectedAt - a.detectedAt || a.id.localeCompare(b.id)); },
    history(key: string, from: number, to: number): FlowHistory {
      const state = states.get(key); const valid = time(from) && time(to) && from <= to;
      return { market: state ? { ...state.market } : null, from, to,
        candles: valid && state ? [...state.candles.values()].filter(row => row.openTime >= from && row.openTime <= to && knownAt(row.sourceTime, row.receivedAt, to)).sort((a, b) => a.openTime - b.openTime).map(row => ({ ...row })) : [],
        events: valid ? [...allEvents.values()].filter(row => row.event.marketKey === key && row.event.detectedAt >= from && row.event.detectedAt <= to).map(row => ({ ...cloneEvent(row.event), outcomes: row.event.outcomes.filter(outcome => outcome.availableAt <= to).map(outcome => ({ ...outcome })) })).sort((a, b) => b.detectedAt - a.detectedAt) : [],
        depth: valid && state ? [...state.depth.values()].filter(row => row.timestamp >= from && row.timestamp <= to && knownAt(row.timestamp, row.receivedAt, to)).sort((a, b) => a.timestamp - b.timestamp).map(row => ({ ...row })) : [],
        oi: valid && state ? [...state.oi.values()].filter(row => row.timestamp >= from && row.timestamp <= to && knownAt(row.timestamp, row.receivedAt, to)).sort((a, b) => a.timestamp - b.timestamp).map(row => ({ ...row })) : [] };
    },
    hydrateEvents(events: readonly FlowEvent[]) {
      for (const original of [...events].sort((a, b) => b.detectedAt - a.detectedAt).slice(0, FLOW_RULES.eventLimit)) {
        if (allEvents.size >= FLOW_RULES.eventLimit) break;
        if (!original.id || allEvents.has(original.id) || original.ruleVersion !== 'flow-v1' || !positive(original.referencePrice)
          || !knownAt(original.timestamp, original.detectedAt, original.detectedAt)) continue;
        const event = cloneEvent(original); event.outcomes = event.outcomes.filter(outcome => [1, 5, 15].includes(outcome.minutes)
          && positive(outcome.price) && finite(outcome.changePct) && time(outcome.availableAt) && outcome.availableAt > event.detectedAt);
        const latest = [...event.outcomes].sort((a, b) => b.minutes - a.minutes)[0];
        const entry = latest?.entryPrice && latest.entryAt !== undefined && positive(latest.entryPrice) && latest.entryAt > event.detectedAt
          ? { price: latest.entryPrice, at: latest.entryAt } : null;
        allEvents.set(event.id, { event, entry, lastClose: entry && latest ? entry.at + latest.minutes * MINUTE : null, blocked: !entry || latest?.minutes === 15 });
        if (!eventIds.has(event.marketKey)) eventIds.set(event.marketKey, new Set()); eventIds.get(event.marketKey)!.add(event.id);
        const state = states.get(event.marketKey);
        if (state) state.cooldown.set(event.kind, Math.max(state.cooldown.get(event.kind) ?? 0, event.detectedAt));
      }
    },
    drainUpdates(): FlowUpdate {
      const result: FlowUpdate = { candles: [...updates.candles.values()].map(row => ({ ...row })), events: [...updates.events.values()].map(cloneEvent),
        depth: [...updates.depth.values()].map(row => ({ ...row })), oi: [...updates.oi.values()].map(row => ({ ...row })) };
      updates.candles.clear(); updates.events.clear(); updates.depth.clear(); updates.oi.clear();
      for (const state of states.values()) { state.pendingBlocked = false; state.evidenceBlocked = false; }
      return result;
    },
  };
}
