import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFlowFeed } from '../src/data/flowFeed';

const HOUR = 3_600_000;
const START = Date.UTC(2026, 8, 23, 10);
class Socket {
  onopen: (() => void) | null = null; onclose: (() => void) | null = null;
  onerror: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null;
  closed = false; opened = false;
  constructor(readonly url: string) {}
  open() { if (!this.closed && !this.opened) { this.opened = true; this.onopen?.(); } }
  close() { this.closed = true; }
}
function instrumentedFeed() {
  vi.useFakeTimers(); vi.setSystemTime(START);
  const intervals = vi.spyOn(globalThis, 'setInterval');
  let universe = ['BTC', 'ETH'];
  const sockets: Socket[] = [];
  const market = (base: string) => ({ symbol: `${base}USDT`, baseAsset: base, quoteAsset: 'USDT', marginAsset: 'USDT', status: 'TRADING', contractType: 'PERPETUAL', underlyingType: 'COIN' });
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === '/fapi/v1/exchangeInfo') return Response.json({ symbols: universe.map(market) });
    if (url.pathname === '/api/v3/exchangeInfo') {
      const base = url.searchParams.get('symbol')!.replace(/USDT$/, '');
      return Response.json({ symbols: [{ ...market(base), isSpotTradingAllowed: true }] });
    }
    if (url.pathname.endsWith('fundingInfo') || url.pathname.endsWith('klines')) return Response.json([]);
    if (url.pathname.endsWith('depth')) return Response.json({ lastUpdateId: 100, bids: [['99', '1']], asks: [['101', '1']] });
    throw new Error(`Unexpected test endpoint: ${url.pathname}`);
  }) as unknown as typeof fetch;
  const feed = createFlowFeed({ mode: 'direct', fetcher, socketFactory: url => { const socket = new Socket(url); sockets.push(socket); return socket as unknown as WebSocket; } });
  const settle = async () => { await vi.advanceTimersByTimeAsync(0); sockets.forEach(socket => socket.open()); await vi.advanceTimersByTimeAsync(0); };
  const refreshUniverse = async (next: string[]) => {
    universe = next; vi.setSystemTime(Date.now() + HOUR);
    // Invoke the registered hourly work without simulating unrelated millions of live messages.
    const hourly = intervals.mock.calls.filter(([, delay]) => delay === HOUR).map(([callback]) => callback);
    for (const callback of hourly) if (typeof callback === 'function') callback();
    await settle();
  };
  return { feed, sockets, fetcher, settle, refreshUniverse };
}
const activeFutures = (sockets: Socket[]) => sockets.filter(socket => !socket.closed && socket.url.includes('/market/stream?streams='));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('orderflow recovery regression paths', () => {
  it('rebuilds only futures shards when a removed market reappears, without duplicate active subscriptions', async () => {
    const { feed, sockets, settle, refreshUniverse } = instrumentedFeed();
    feed.selectMarket('futures:ETHUSDT');
    try {
      await feed.start(); await settle();
      const firstFutures = activeFutures(sockets)[0];
      const markStream = sockets.find(socket => socket.url.includes('!markPrice'))!;
      const spotStream = sockets.find(socket => socket.url.includes('stream.binance.com:9443'))!;
      const depthStream = sockets.find(socket => socket.url.includes('/public/ws/ethusdt@depth'))!;
      expect(markStream).toBeDefined(); expect(spotStream).toBeDefined(); expect(depthStream).toBeDefined();

      await refreshUniverse(['ETH']);
      expect(firstFutures.closed).toBe(true);
      expect(activeFutures(sockets)).toHaveLength(1);
      expect(activeFutures(sockets).some(socket => socket.url.includes('btcusdt@'))).toBe(false);

      await refreshUniverse(['BTC', 'ETH']);
      expect(activeFutures(sockets)).toHaveLength(1);
      expect(activeFutures(sockets).filter(socket => socket.url.includes('btcusdt@'))).toHaveLength(1);
      expect(markStream.closed).toBe(false); expect(spotStream.closed).toBe(false); expect(depthStream.closed).toBe(false);
      const count = sockets.length;
      await refreshUniverse(['BTC', 'ETH']);
      expect(sockets).toHaveLength(count);
    } finally { await feed.stop(); }
    expect(sockets.every(socket => socket.closed)).toBe(true);
  });

  it('resolves a spot notification selected before discovery and independently verifies exactly one spot stream', async () => {
    const { feed, sockets, fetcher, settle } = instrumentedFeed();
    feed.selectMarket('spot:BTCUSDT');
    try {
      await feed.start(); await settle();
      const requests = vi.mocked(fetcher).mock.calls.map(([url]) => String(url));
      expect(requests.filter(url => url.includes('/api/v3/exchangeInfo?symbol=BTCUSDT'))).toHaveLength(1);
      expect(sockets.filter(socket => !socket.closed && socket.url.includes('stream.binance.com:9443') && socket.url.includes('btcusdt@'))).toHaveLength(1);
      expect(feed.snapshot().rows.some(row => row.market.key === 'spot:BTCUSDT')).toBe(true);
      const count = sockets.length;
      feed.selectMarket('spot:BTCUSDT'); await settle();
      expect(sockets).toHaveLength(count);
    } finally { await feed.stop(); }
  });
});
