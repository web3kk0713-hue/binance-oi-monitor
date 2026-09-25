import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFlowFeed } from '../src/data/flowFeed';
import type { FlowUpdate } from '../src/shared/flowTypes';
import type { Snapshot } from '../src/shared/types';

class Socket {
  onopen: (() => void) | null = null; onclose: (() => void) | null = null;
  onerror: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {}
  close() { this.closed = true; }
  open() { this.onopen?.(); }
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
const at = 1_800_000_000_000;
const row = { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', marginAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL', underlyingType: 'COIN' };
function harness(onUpdate?: (u: FlowUpdate) => void | Promise<void>, onChange?: () => void) {
  vi.useFakeTimers(); vi.setSystemTime(at); const sockets: Socket[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const u = new URL(String(url));
    if (u.pathname === '/fapi/v1/exchangeInfo') return Response.json({ symbols: [row] });
    if (u.pathname === '/api/v3/exchangeInfo') return Response.json({ symbols: [{ ...row, isSpotTradingAllowed: true }] });
    if (u.pathname.endsWith('fundingInfo')) return Response.json([]);
    if (u.pathname.endsWith('depth')) return Response.json({ lastUpdateId: 100, bids: [['99.99', '100'], ['99', '100']], asks: [['100.01', '100'], ['101', '100']] });
    if (u.pathname.endsWith('klines')) return Response.json([[at - 60_000, '100', '101', '99', '100', '100', at - 1, '10000', 20, '50', '5000']]);
    throw new Error('Unexpected URL');
  }) as unknown as typeof fetch;
  const feed = createFlowFeed({ mode: 'direct', fetcher, onUpdate, onChange, socketFactory: url => { const s = new Socket(url); sockets.push(s); return s as unknown as WebSocket; } });
  return { feed, sockets, fetcher };
}
afterEach(() => vi.useRealTimers());
describe('browser/server shared orderflow feed', () => {
  it('uses official futures and independently verified spot streams; stops every socket', async () => {
    const { feed, sockets, fetcher } = harness(); await feed.start(); await vi.advanceTimersByTimeAsync(0);
    expect(sockets.some(s => s.url.startsWith('wss://fstream.binance.com/market/stream?streams='))).toBe(true);
    expect(sockets.some(s => s.url.includes('stream.binance.com:9443'))).toBe(true);
    sockets.forEach(s => s.open()); await vi.advanceTimersByTimeAsync(1100);
    expect(feed.snapshot().rows.map(r => r.market.key)).toEqual(['futures:BTCUSDT', 'spot:BTCUSDT']);
    expect(feed.snapshot().status.backfilledMarkets).toBe(2); expect(feed.snapshot().events).toEqual([]);
    feed.stop(); await vi.advanceTimersByTimeAsync(0);
    expect(sockets.every(s => s.closed)).toBe(true);
    const calls = vi.mocked(fetcher).mock.calls.length; await vi.advanceTimersByTimeAsync(70_000); expect(vi.mocked(fetcher).mock.calls.length).toBe(calls);
  });
  it('retries the identical drained batch after persistence fails instead of silently losing it', async () => {
    const writes: FlowUpdate[] = [];
    const onUpdate = vi.fn(async (u: FlowUpdate) => { writes.push(u); if (writes.length === 1) throw new Error('disk unavailable'); });
    const { feed, sockets } = harness(onUpdate); await feed.start(); await vi.advanceTimersByTimeAsync(0); sockets.forEach(s => s.open());
    await vi.advanceTimersByTimeAsync(5100); expect(writes[0].candles).toHaveLength(2); expect(feed.snapshot().status.errors.join()).toContain('历史写入失败');
    await vi.advanceTimersByTimeAsync(5100); expect(writes[1]).toBe(writes[0]); expect(feed.snapshot().status.errors.join()).not.toContain('历史写入失败'); feed.stop();
  });
  it('records actual per-contract OI quantity and source timestamp without multiplying token units', async () => {
    const { feed } = harness(); await feed.start(); await vi.advanceTimersByTimeAsync(0);
    const snapshot = { assets: [{ evidence: { contracts: [{ symbol: 'BTCUSDT', openInterest: '123.456', oiTime: at - 100, oiObservedAt: at, unitMultiplier: 1000 }] } }] } as unknown as Snapshot;
    feed.updateSnapshot(snapshot); const history = feed.history('futures:BTCUSDT', at - 1000, at);
    expect(history.oi).toEqual([{ marketKey: 'futures:BTCUSDT', quantity: 123.456, timestamp: at - 100, receivedAt: at }]); feed.stop();
  });
  it('does not keep a disconnected market live and retries a dead socket with backoff', async () => {
    const { feed, sockets } = harness(); await feed.start(); await vi.advanceTimersByTimeAsync(0); sockets.forEach(s => s.open());
    const socket = sockets.find(s => s.url.includes('market/stream?streams='))!; socket.onclose?.();
    expect(feed.snapshot().rows.find(r => r.market.key === 'futures:BTCUSDT')?.status).toBe('disconnected');
    const count = sockets.length; await vi.advanceTimersByTimeAsync(999); expect(sockets).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(1); expect(sockets.length).toBeGreaterThan(count); feed.stop();
  });
  it('waits for an in-flight write and persists observations arriving before shutdown', async () => {
    let release: (() => void) | undefined; const writes: FlowUpdate[] = [];
    const { feed, sockets } = harness(async u => { writes.push(u); if (writes.length === 1) await new Promise<void>(r => { release = r; }); });
    await feed.start(); await vi.advanceTimersByTimeAsync(0); sockets.forEach(s => s.open()); await vi.advanceTimersByTimeAsync(5100);
    feed.updateSnapshot({ assets: [{ evidence: { contracts: [{ symbol: 'BTCUSDT', openInterest: '42', oiTime: at + 5000, oiObservedAt: at + 5100 }] } }] } as unknown as Snapshot);
    const stopped = feed.stop(); expect(writes).toHaveLength(1); release!(); await stopped;
    expect(writes.flatMap(u => u.oi).map(o => o.quantity)).toEqual([42]);
  });
  it('switching from futures to its verified spot view preserves subscriptions', async () => {
    const { feed, sockets } = harness(); await feed.start(); await vi.advanceTimersByTimeAsync(0); const count = sockets.length;
    feed.selectMarket('spot:BTCUSDT'); await vi.advanceTimersByTimeAsync(0);
    expect(sockets.length).toBe(count); expect(sockets.filter(s => s.closed)).toHaveLength(0); await feed.stop();
  });
  it('resolves a cold-start spot notification against the discovered contract before subscribing', async () => {
    const { feed, sockets, fetcher } = harness(); feed.selectMarket('spot:BTCUSDT'); await feed.start(); await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(fetcher).mock.calls.some(([url]) => String(url).includes('/api/v3/exchangeInfo?symbol=BTCUSDT'))).toBe(true);
    expect(sockets.filter(s => s.url.includes('stream.binance.com:9443'))).toHaveLength(1); await feed.stop();
  });
  it('publishes once per normal 5s cycle instead of once for flush and once for heartbeat', async () => {
    const onChange = vi.fn(), { feed, sockets } = harness(undefined, onChange);
    await feed.start(); await vi.advanceTimersByTimeAsync(0); sockets.forEach(s => s.open());
    onChange.mockClear();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onChange).toHaveBeenCalledTimes(3);
    await feed.stop();
  });
  it('publishes immediate freshness on every cycle even while the first disk write is blocked', async () => {
    let release: (() => void) | undefined;
    const onChange = vi.fn(), { feed, sockets } = harness(() => new Promise<void>(resolve => { release = resolve; }), onChange);
    await feed.start(); await vi.advanceTimersByTimeAsync(0); sockets.forEach(s => s.open()); onChange.mockClear();
    await vi.advanceTimersByTimeAsync(5000); expect(onChange).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000); expect(onChange).toHaveBeenCalledTimes(2);
    release!(); await vi.advanceTimersByTimeAsync(0); expect(onChange).toHaveBeenCalledTimes(2);
    await feed.stop();
  });
  it('returns an isolated market directory without constructing a metrics snapshot', async () => {
    const { feed } = harness(); await feed.start(); await vi.advanceTimersByTimeAsync(0);
    const snapshot = vi.spyOn(feed, 'snapshot');
    const directory = feed.markets(); expect(directory).toHaveLength(2);
    directory[0].symbol = 'MUTATED'; directory.pop();
    expect(feed.markets()[0].symbol).toBe('BTCUSDT'); expect(feed.markets()).toHaveLength(2);
    expect(snapshot).not.toHaveBeenCalled(); await feed.stop();
  });
  it('retains raw marks independently of missing or invalid funding and settlement metadata', async () => {
    const { feed, sockets } = harness(); await feed.start(); await vi.advanceTimersByTimeAsync(0); sockets.forEach(s => s.open());
    const socket = sockets.find(s => s.url.includes('!markPrice'))!;
    socket.message([{ e: 'markPriceUpdate', s: 'BTCUSDT', E: at, p: '100.123456789012345678901234', i: 'bad', r: null, T: at - 1 }]);
    const snapshot = feed.snapshot();
    expect(snapshot.rows.find(row => row.market.key === 'futures:BTCUSDT')!.funding).toBeNull();
    expect(snapshot.marks).toEqual([{ marketKey: 'futures:BTCUSDT', markPrice: '100.123456789012345678901234',
      sourceTime: at, receivedAt: at, source: 'binance-mark-stream' }]);
    snapshot.marks![0].markPrice = '999'; expect(feed.snapshot().marks![0].markPrice).toBe('100.123456789012345678901234');
    await feed.stop();
  });
  it('rejects wrong identity, event type, invalid source time and nondecimal raw marks', async () => {
    const { feed, sockets } = harness(); await feed.start(); await vi.advanceTimersByTimeAsync(0); sockets.forEach(s => s.open());
    const socket = sockets.find(s => s.url.includes('!markPrice'))!;
    const good = { e: 'markPriceUpdate', s: 'BTCUSDT', E: at, p: '100.00' };
    const invalid = [{ s: 'ETHUSDT' }, { s: 'btcusdt' }, { e: 'aggTrade' }, { E: at + 1 }, { E: String(at) },
      { E: 0 }, { E: -1 }, { E: at + .5 }, { p: 100 }, { p: '0' }, { p: '-1' }, { p: 'Infinity' },
      { p: '0x10' }, { p: '1e3' }, { p: '' }, { p: ' 1' }, { p: '01' }, { p: '1'.repeat(129) }];
    for (const value of invalid) socket.message([{ ...good, ...value }]);
    expect(feed.snapshot().marks).toEqual([]);
    sockets.find(s => s.url.includes('market/stream?streams='))!.message({ e: 'aggTrade', s: 'BTCUSDT', E: at, T: at, a: 1, p: '100', q: '2', m: false });
    expect(feed.snapshot().marks).toEqual([]);
    socket.message([good]); expect(feed.snapshot().marks).toHaveLength(1); await feed.stop();
  });
  it('never rewinds mark source time and preserves earliest receipt for duplicate observations', async () => {
    const { feed, sockets } = harness(); await feed.start(); await vi.advanceTimersByTimeAsync(0); sockets.forEach(s => s.open());
    const socket = sockets.find(s => s.url.includes('!markPrice'))!;
    socket.message([{ e: 'markPriceUpdate', s: 'BTCUSDT', E: at, p: '100' }]);
    vi.setSystemTime(at + 10);
    socket.message([{ e: 'markPriceUpdate', s: 'BTCUSDT', E: at, p: '101' }, { e: 'markPriceUpdate', s: 'BTCUSDT', E: at - 1, p: '99' }]);
    expect(feed.snapshot().marks![0]).toMatchObject({ markPrice: '100', receivedAt: at });
    socket.message([{ e: 'markPriceUpdate', s: 'BTCUSDT', E: at + 1, p: '102' }]);
    expect(feed.snapshot().marks![0]).toMatchObject({ markPrice: '102', sourceTime: at + 1, receivedAt: at + 10 }); await feed.stop();
  });
  it('clears marks immediately when the mark stream disconnects or the feed stops', async () => {
    const { feed, sockets } = harness(); await feed.start(); await vi.advanceTimersByTimeAsync(0); sockets.forEach(s => s.open());
    const socket = sockets.find(s => s.url.includes('!markPrice'))!;
    socket.message([{ e: 'markPriceUpdate', s: 'BTCUSDT', E: at, p: '100' }]);
    expect(feed.snapshot().marks).toHaveLength(1); socket.onclose?.(); expect(feed.snapshot().marks).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    const next = sockets.filter(s => s.url.includes('!markPrice')).at(-1)!; next.open();
    next.message([{ e: 'markPriceUpdate', s: 'BTCUSDT', E: at + 1000, p: '101' }]);
    expect(feed.snapshot().marks).toHaveLength(1); await feed.stop(); expect(feed.snapshot().marks).toEqual([]);
  });
});
