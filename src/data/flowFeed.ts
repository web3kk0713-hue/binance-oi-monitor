import { createFlowEngine } from '../shared/orderflow';
import type { FlowEvent, FlowFeedOptions, FlowHistory, FlowMarket, FlowSnapshot, FlowUpdate } from '../shared/flowTypes';
import type { Snapshot } from '../shared/types';
import type { MarkObservation } from '../shared/positionTypes';
import { createSourceClient, SourceError } from './http';
import { UNIT_ALIASES } from './aliases';
import { verifySpotMarket } from '../shared/liveMarket';
import { createFlowBook } from './flowDepth';
import { discoverFlowMarkets, finite, integer, parseFlowCandle, parseFlowQuote, parseFlowTrade, parseRestCandles, record } from './flowParsing';

const FAPI = 'https://fapi.binance.com';
const SPOT = 'https://api.binance.com';
const MINUTE = 60_000;
interface Connection { socket: WebSocket | null; stop: () => void; restart: () => void; lastMessage: number; opened: boolean; }

/** Shared browser/server ingestion; no credentials, trades, or private account APIs. */
export function createFlowFeed(options: FlowFeedOptions) {
  const now = options.now ?? Date.now, fetcher = options.fetcher ?? fetch;
  const request = createSourceClient(fetcher, 3, { priority: 'background' }), engine = createFlowEngine();
  const controller = new AbortController(), startedAt = now();
  const markets = new Map<string, FlowMarket>(), connections = new Set<Connection>();
  const futuresConnections = new Set<Connection>();
  const backfilled = new Set<string>(), queued = new Map<string, number>(), errors = new Map<string, string>();
  const intervals = new Map<string, number>();
  const marks = new Map<string, MarkObservation>();
  const timers: Array<ReturnType<typeof setInterval>> = [];
  let stopped = false, started = false, warming = 0, selecting = 0, selected: string | null = null;
  let stopSelection: (() => void) | null = null, latestOi: Snapshot | null = null, lastTick = now();
  let pendingWrite: FlowUpdate | null = null, startupRetry: ReturnType<typeof setTimeout> | null = null;
  let flushPromise: Promise<void> | null = null, stopPromise: Promise<void> | null = null;
  function report(key: string, error: unknown) {
    errors.set(key, error instanceof Error ? error.message : String(error));
    if (errors.size > 8) errors.delete(errors.keys().next().value!);
  }
  function syncMarkets() { engine.setMarkets([...markets.values()]); }
  function enqueue(key: string, delay = 0) { if (markets.has(key)) queued.set(key, now() + delay); }
  function connect(url: string, keys: string[], consume: (raw: unknown) => void, opened?: () => void, closed?: () => void): Connection {
    let active = true, retry = 0, retryTimer: ReturnType<typeof setTimeout> | null = null;
    const c: Connection = { socket: null, lastMessage: now(), opened: false, stop, restart };
    function closeCurrent() {
      const ws = c.socket; c.socket = null; c.opened = false;
      engine.setConnected(keys, false, now()); closed?.();
      if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; try { ws.close(); } catch { /* Already closed or opening was cancelled. */ } }
    }
    function schedule() {
      if (!active || stopped || retryTimer) return;
      retryTimer = setTimeout(() => { retryTimer = null; open(); }, Math.min(30_000, 1000 * 2 ** Math.min(retry++, 5)));
    }
    function open() {
      if (!active || stopped) return;
      c.lastMessage = now();
      try {
        const ws = options.socketFactory ? options.socketFactory(url) : new WebSocket(url); c.socket = ws;
        ws.onopen = () => {
          if (!active || c.socket !== ws) return;
          c.opened = true; retry = 0; c.lastMessage = now(); errors.delete(url);
          engine.setConnected(keys, true, now()); keys.forEach(k => enqueue(k)); opened?.();
        };
        ws.onmessage = event => {
          if (!active || c.socket !== ws || typeof event.data !== 'string' || event.data.length > 2_000_000) return;
          try { const raw = JSON.parse(event.data); c.lastMessage = now(); consume(record(raw)?.data ?? raw); }
          catch { /* Malformed messages never become observations. */ }
        };
        ws.onerror = () => { report(url, '行情连接异常，正在退避重连'); };
        ws.onclose = () => { if (c.socket !== ws) return; closeCurrent(); schedule(); };
      } catch (e) { report(url, e); schedule(); }
    }
    function stop() { active = false; if (retryTimer) clearTimeout(retryTimer); closeCurrent(); connections.delete(c); }
    function restart() { if (!active || stopped) return; closeCurrent(); schedule(); }
    connections.add(c); open(); return c;
  }
  function consumeMarket(raw: unknown, venue: 'futures' | 'spot') {
    const r = record(raw), market = markets.get(`${venue}:${r?.s}`); if (!market) return;
    const at = now();
    if (r?.e === 'aggTrade') { const trade = parseFlowTrade(raw, market, at); if (trade) engine.ingestTrade(trade); }
    if (r?.e === 'kline') { const candle = parseFlowCandle(raw, market, at); if (candle) engine.ingestCandle(candle); }
  }
  function consumeMark(raw: unknown, receivedAt: number) {
    const r = record(raw), market = markets.get(`futures:${r?.s}`);
    if (!market || market.venue !== 'futures' || r?.s !== market.symbol || r.e !== 'markPriceUpdate'
      || !Number.isSafeInteger(receivedAt) || receivedAt <= 0 || !integer(r.E) || r.E <= 0 || r.E > receivedAt
      || typeof r.p !== 'string' || r.p.length > 128 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(r.p)
      || !Number.isFinite(Number(r.p)) || Number(r.p) <= 0) return;
    const previous = marks.get(market.key);
    // Preserve the earliest receipt for the same source observation; never rewind.
    if (previous && previous.sourceTime >= r.E) return;
    marks.set(market.key, { marketKey: market.key, markPrice: r.p, sourceTime: r.E, receivedAt, source: 'binance-mark-stream' });
  }
  async function warmQueue() {
    if (stopped || warming >= 2) return;
    const entry = [...queued].find(([, due]) => due <= now()); if (!entry) return;
    const [key] = entry; queued.delete(key); const market = markets.get(key); if (!market) return;
    warming++;
    try {
      const root = market.venue === 'futures' ? `${FAPI}/fapi/v1` : `${SPOT}/api/v3`;
      const data = await request<unknown>(`${root}/klines?symbol=${encodeURIComponent(market.symbol)}&interval=1m&limit=360&endTime=${Math.floor(now() / MINUTE) * MINUTE - 1}`, controller.signal);
      if (stopped) return;
      for (const c of parseRestCandles(data, market, now())) engine.ingestCandle(c);
      backfilled.add(key); errors.delete(`warm:${market.symbol}`);
    } catch (e) { if (!stopped) { report(`warm:${market.symbol}`, e); enqueue(key, 65_000); } }
    finally { warming--; }
  }
  function selectDepth(market: FlowMarket): () => void {
    const book = createFlowBook(market.key); let alive = true, ready = false, seeding = false, buffer: unknown[] = [];
    let lastDepth = 0, seededAt = 0, nextSeedAt = 0, snapshotAbort = new AbortController();
    function reset() { ready = false; buffer = []; book.reset(); engine.invalidateDepth(market.key); snapshotAbort.abort(); snapshotAbort = new AbortController(); }
    async function seed() {
      if (!alive || seeding || now() < nextSeedAt || stopped) return;
      seeding = true; const signal = AbortSignal.any([controller.signal, snapshotAbort.signal]);
      try {
        const raw = await request<unknown>(`${FAPI}/fapi/v1/depth?symbol=${encodeURIComponent(market.symbol)}&limit=1000`, signal);
        if (!alive || signal.aborted || stopped) return;
        if (!book.seed(raw)) throw new Error('盘口快照无效');
        ready = true; seededAt = now();
        const pending = buffer; buffer = [];
        for (const item of pending) apply(item);
        errors.delete('depth');
      } catch (e) { if (alive && !stopped && !signal.aborted) { report('depth', e); nextSeedAt = now() + 65_000; } }
      finally { seeding = false; }
    }
    function apply(raw: unknown) {
      const result = book.update(raw);
      if (result === 'gap') { ready = false; buffer = [raw]; nextSeedAt = Math.max(nextSeedAt, now() + 2000); return; }
      const r = record(raw); const at = now();
      if (result === 'ok' && integer(r?.T) && r.T <= at && at - r.T <= 5000 && at - lastDepth >= 1000) {
        const depth = book.snapshot(r.T, at); if (depth) engine.ingestDepth(depth); lastDepth = at;
        // A fast move can leave the original snapshot's verified band. Re-seed at most twice/minute.
        if (depth && !depth.complete && at - seededAt >= 30_000) { ready = false; buffer = []; nextSeedAt = at; }
      }
    }
    const c = connect(`wss://fstream.binance.com/public/ws/${encodeURIComponent(market.symbol.toLowerCase())}@depth@100ms`, [], raw => {
      const r = record(raw);
      if (r?.e !== 'depthUpdate' || r.s !== market.symbol || (r.st != null && r.st !== 1)) return;
      if (ready && now() - seededAt >= 300_000) reset();
      if (!ready) { buffer.push(raw); if (buffer.length > 2000) { buffer = []; report('depth', '盘口同步缓存满，等待新快照'); } void seed(); }
      else apply(raw);
    }, () => { reset(); void seed(); }, reset);
    return () => { alive = false; c.stop(); reset(); };
  }
  async function installSelection(key: string | null) {
    const token = ++selecting;
    stopSelection?.(); stopSelection = null;
    const market = key ? markets.get(key) : undefined; if (!market || market.venue !== 'futures' || stopped) return;
    let spotRetry: ReturnType<typeof setTimeout> | null = null;
    const cleanup = [selectDepth(market)]; stopSelection = () => { if (spotRetry) clearTimeout(spotRetry); cleanup.forEach(fn => fn()); };
    const base = UNIT_ALIASES[market.baseAsset]?.symbol ?? market.baseAsset, assetId = market.assetId;
    async function connectSpot(attempt = 0): Promise<void> { try {
      const response = await request<unknown>(`${SPOT}/api/v3/exchangeInfo?symbol=${encodeURIComponent(`${base}USDT`)}`, controller.signal);
      if (stopped || token !== selecting) return;
      const target = verifySpotMarket(response, base); if (!target) { report('spot', `${base} 未找到核实可交易的 USDT 现货对`); return; }
      const spot: FlowMarket = { key: `spot:${target.symbol}`, venue: 'spot', symbol: target.symbol, baseAsset: base, quoteAsset: target.quoteAsset, assetId };
      markets.set(spot.key, spot); syncMarkets(); enqueue(spot.key); errors.delete('spot');
      const name = encodeURIComponent(spot.symbol.toLowerCase());
      const conn = connect(`wss://stream.binance.com:9443/stream?streams=${name}@aggTrade/${name}@kline_1m`, [spot.key], raw => consumeMarket(raw, 'spot'));
      cleanup.push(conn.stop);
    } catch (e) {
      if (!stopped && token === selecting) {
        report('spot', e);
        // Do not retry unavailable/restricted markets through alternate hosts. Temporary failures back off.
        const terminal = e instanceof SourceError && ['HTTP_400', 'HTTP_403', 'HTTP_404', 'HTTP_451'].includes(e.code);
        if (!terminal && attempt < 5) spotRetry = setTimeout(() => { spotRetry = null; void connectSpot(attempt + 1); }, Math.min(300_000, 65_000 * 2 ** attempt));
      }
    } }
    await connectSpot();
  }
  function resolveSelection(key: string | null): string | null {
    const picked = key ? markets.get(key) : null;
    // Resolve notification/deep-link spot intent only against an approved futures identity.
    if (key?.startsWith('spot:')) {
      const candidate = [...markets.values()].find(m => m.venue === 'futures' && m.quoteAsset === 'USDT'
        && (picked ? m.assetId === picked.assetId : `spot:${UNIT_ALIASES[m.baseAsset]?.symbol ?? m.baseAsset}USDT` === key));
      return candidate?.key ?? key;
    }
    return key;
  }
  function selectMarket(key: string | null) {
    const target = resolveSelection(key);
    if (selected === target) return; selected = target;
    if (started && markets.size) { if (target) enqueue(target); void installSelection(target); }
  }
  function updateSnapshot(snapshot: Snapshot) {
    latestOi = snapshot;
    for (const asset of snapshot.assets) for (const c of asset.evidence.contracts) {
      const key = `futures:${c.symbol}`; if (!markets.has(key)) continue;
      const quantity = finite(c.openInterest); const timestamp = c.oiTime; const receivedAt = c.oiObservedAt;
      if (quantity !== null && timestamp != null && receivedAt != null && timestamp <= now() && receivedAt <= now()) engine.ingestOi({ marketKey: key, quantity, timestamp, receivedAt });
    }
  }
  function flush(publish = true): Promise<void> {
    if (flushPromise) return flushPromise;
    const previousStorageError = errors.get('storage');
    flushPromise = Promise.resolve().then(async () => {
      try {
        const update = pendingWrite ?? engine.drainUpdates(); pendingWrite = update;
        if (update.candles.length || update.events.length || update.depth.length || update.oi.length) await options.onUpdate?.(update);
        pendingWrite = null; errors.delete('storage');
      } catch (e) { report('storage', `历史写入失败：${e instanceof Error ? e.message : e}`); }
    }).finally(() => {
      flushPromise = null;
      // Heartbeats already publish live data. Publish again only for an actual
      // persistence-state transition, or an explicit final shutdown flush.
      if (publish || errors.get('storage') !== previousStorageError) options.onChange?.();
    });
    return flushPromise;
  }
  async function fundingIntervals() {
    try {
      const rows = await request<unknown>(`${FAPI}/fapi/v1/fundingInfo`, controller.signal);
      if (Array.isArray(rows)) for (const raw of rows) { const r = record(raw); if (typeof r?.symbol === 'string' && integer(r.fundingIntervalHours) && r.fundingIntervalHours > 0) intervals.set(r.symbol, r.fundingIntervalHours); }
    } catch (e) { if (!stopped) report('funding', e); }
  }
  function openMarkets(found: FlowMarket[]) {
    for (let i = 0; i < found.length; i += 60) {
      const group = found.slice(i, i + 60);
      const names = group.flatMap(m => [`${encodeURIComponent(m.symbol.toLowerCase())}@aggTrade`, `${encodeURIComponent(m.symbol.toLowerCase())}@kline_1m`]);
      futuresConnections.add(connect(`wss://fstream.binance.com/market/stream?streams=${names.join('/')}`, group.map(m => m.key), raw => consumeMarket(raw, 'futures')));
    }
  }
  async function refreshUniverse() {
    try {
      const data = await request<unknown>(`${FAPI}/fapi/v1/exchangeInfo`, controller.signal); if (stopped) return;
      const found = discoverFlowMarkets(data); if (!found.length) throw new Error('交易对目录为空，保留旧目录并暂停变更');
      const foundKeys = new Set(found.map(m => m.key)), oldKeys = new Set([...markets.values()].filter(m => m.venue === 'futures').map(m => m.key));
      const changed = foundKeys.size !== oldKeys.size || [...foundKeys].some(k => !oldKeys.has(k));
      if (changed) { futuresConnections.forEach(c => c.stop()); futuresConnections.clear(); }
      for (const [key, m] of markets) if (m.venue === 'futures' && !foundKeys.has(key)) { markets.delete(key); marks.delete(key); queued.delete(key); backfilled.delete(key); }
      found.forEach(m => markets.set(m.key, m)); syncMarkets();
      if (changed) { openMarkets(found); found.forEach(m => enqueue(m.key)); }
      if (selected && !markets.has(selected)) { selected = found[0].key; void installSelection(selected); }
      errors.delete('universe');
    } catch (e) { if (!stopped) report('universe', e); }
  }
  async function start() {
    if (started || stopped) return; started = true;
    try {
      const data = await request<unknown>(`${FAPI}/fapi/v1/exchangeInfo`, controller.signal);
      if (stopped) return;
      const root = record(data);
      if (Array.isArray(root?.rateLimits)) for (const raw of root.rateLimits) {
        const r = record(raw); if (r?.rateLimitType === 'REQUEST_WEIGHT' && r.interval === 'MINUTE' && r.intervalNum === 1 && integer(r.limit)) request.setBinanceWeightLimit(r.limit);
      }
      const found = discoverFlowMarkets(data); if (!found.length) throw new Error('未找到范围内可交易合约');
      errors.delete('start');
      found.forEach(m => markets.set(m.key, m)); syncMarkets();
      openMarkets(found);
      connect('wss://fstream.binance.com/market/ws/!markPrice@arr@1s', [], raw => {
        if (!Array.isArray(raw)) return;
        const receivedAt = now();
        for (const value of raw) {
          consumeMark(value, receivedAt);
          const r = record(value), m = markets.get(`futures:${r?.s}`);
          if (m) { const q = parseFlowQuote(value, m, receivedAt, intervals.get(m.symbol) ?? null); if (q) engine.ingestQuote(q); }
        }
      }, undefined, () => marks.clear());
      found.forEach(m => enqueue(m.key));
      if (latestOi) updateSnapshot(latestOi);
      selected = resolveSelection(selected ?? found[0].key); void installSelection(selected); void fundingIntervals();
      timers.push(setInterval(() => void warmQueue(), 500));
      timers.push(setInterval(() => void fundingIntervals(), 3_600_000));
      timers.push(setInterval(() => void refreshUniverse(), 3_600_000));
      timers.push(setInterval(() => {
        const at = now(), paused = at - lastTick > 15_000; lastTick = at;
        for (const c of connections) if (paused || at - c.lastMessage > 30_000) c.restart();
        // One immediate normal publication per cycle; never block market/freshness
        // updates on storage. flush separately reports persistence transitions.
        void flush(false); options.onChange?.();
      }, 5000));
      options.onChange?.();
    } catch (e) {
      if (!stopped) { report('start', e); options.onChange?.(); started = false;
        startupRetry = setTimeout(() => { startupRetry = null; void start().catch(() => {}); }, 65_000);
      } throw e;
    }
  }
  function snapshot(): FlowSnapshot {
    const at = now(), rows = engine.metrics(at);
    return { schemaVersion: 1, rows, events: engine.events(), marks: [...marks.values()]
      .filter(mark => markets.has(mark.marketKey) && mark.sourceTime <= at && mark.receivedAt <= at).map(mark => ({ ...mark })),
      status: { mode: options.mode, startedAt, asOf: at,
      connectedStreams: [...connections].filter(c => c.opened).length, totalStreams: connections.size,
      markets: rows.length, readyMarkets: rows.filter(r => r.status === 'live').length, warmingMarkets: rows.filter(r => r.status === 'warming').length,
      staleMarkets: rows.filter(r => r.status === 'stale' || r.status === 'disconnected').length, backfilledMarkets: backfilled.size,
      errors: [...errors.values()], retentionDays: 7,
      scope: `USDⓈ-M 加密永续成交/K线；${options.mode === 'direct' ? '所选标的' : '默认 BTCUSDT'}现货与标准深度（不含RPI）；OI目标30秒；历史从实际采集开始` } };
  }
  function history(key: string, from: number, to: number): FlowHistory { return engine.history(key, from, to); }
  function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopped = true; selecting++; controller.abort(); if (startupRetry) clearTimeout(startupRetry);
    timers.forEach(clearInterval); stopSelection?.(); [...connections].forEach(c => c.stop());
    // Await any in-flight writer, then drain observations that arrived while it was blocked.
    stopPromise = (async () => { await flush(); await flush(); })();
    return stopPromise;
  }
  return { start, stop, updateSnapshot, selectMarket, snapshot, history,
    markets: (): FlowMarket[] => [...markets.values()].map(market => ({ ...market })),
    hydrateEvents: (events: FlowEvent[]) => engine.hydrateEvents(events) };
}
