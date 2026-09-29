import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStructureHistoryClient } from '../src/data/structureHistory';
import { binanceRequestWeight, createSourceClient } from '../src/data/http';
import { STRUCTURE_INTERVAL_MS as STEP } from '../src/shared/structureTypes';

const END = 1_800_000_000_000;
const SPAN = 14 * 86_400_000;
const signal = () => new AbortController().signal;
const market = (symbol = 'BTCUSDT') => ({ symbol, status: 'TRADING', contractType: 'PERPETUAL', quoteAsset: 'USDT', marginAsset: 'USDT', pricePrecision: 8,
  filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.10' }] });
const catalog = () => ({ symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', '币安人生USDT'].map(market),
  rateLimits: [{ rateLimitType: 'REQUEST_WEIGHT', interval: 'MINUTE', intervalNum: 1, limit: 2400 }] });
const candle = (open: number): unknown[] => [open, '100.00', '101.00', '99.00', '100.50', '0', open + STEP - 1, '0', 0, '0', '0', '0'];
function page(url: URL): unknown[][] {
  const start = Number(url.searchParams.get('startTime')), end = Number(url.searchParams.get('endTime'));
  return Array.from({ length: Math.min(1500, Math.floor((end + 1 - start) / STEP)) }, (_, index) => candle(start + index * STEP));
}
function transport(change?: (url: URL, value: unknown) => unknown) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://fapi.binance.com');
    const value = url.pathname === '/fapi/v1/exchangeInfo' ? catalog() : page(url);
    return Response.json(change ? change(url, value) : value);
  }) as unknown as typeof fetch;
}
function client(fetcher = transport(), clock: () => number = () => END + 1234) { return createStructureHistoryClient(fetcher, clock); }
afterEach(() => vi.useRealTimers());

describe('on-demand structure history', () => {
  it('verifies exact instrument and trading tick before fetching three complete closed pages', async () => {
    let time = END + 1234;
    // A changing clock proves fetchedAt is completion time, not a candle time.
    const liveFetcher = vi.fn(async (input: string | URL | Request) => {
      time += 10;
      const url = new URL(String(input)); return Response.json(url.pathname.endsWith('exchangeInfo') ? catalog() : page(url));
    }) as unknown as typeof fetch;
    const history = await client(liveFetcher, () => time).load('BTCUSDT', signal());
    expect(history).toMatchObject({ schemaVersion: 1, marketKey: 'futures:BTCUSDT', symbol: 'BTCUSDT', tickSize: '0.10', intervalMs: STEP,
      from: END - SPAN, to: END, fetchedAt: time });
    expect(history.fetchedAt).toBe(END + 1274);
    expect(history.candles).toHaveLength(4032);
    expect(history.candles[0]).toEqual({ openTime: END - SPAN, closeTime: END - SPAN + STEP - 1, open: '100.00', high: '101.00', low: '99.00', close: '100.50' });
    expect(history.candles.at(-1)?.closeTime).toBe(END - 1);
    const urls = vi.mocked(liveFetcher).mock.calls.map(args => new URL(String(args[0])));
    expect(urls.map(url => url.pathname)).toEqual(['/fapi/v1/exchangeInfo', ...Array(3).fill('/fapi/v1/markPriceKlines')]);
    expect(urls.slice(1).map(url => url.searchParams.get('startTime'))).toEqual([0, 1500, 3000].map(offset => String(END - SPAN + offset * STEP)));
    for (const url of urls.slice(1)) expect(Object.fromEntries(url.searchParams)).toMatchObject({ symbol: 'BTCUSDT', interval: '5m', limit: '1500', endTime: String(END - 1) });
  });

  it('accepts a Unicode instrument only when it is in the exact verified catalog', async () => {
    expect((await client().load('币安人生USDT', signal())).marketKey).toBe('futures:币安人生USDT');
    const fetcher = transport(); await expect(client(fetcher).load('btcusdt', signal())).rejects.toMatchObject({ code: 'HISTORY_IDENTITY' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['unknown symbol', (row: ReturnType<typeof market>) => ({ ...row, symbol: 'BTCUSDC' })],
    ['paused', (row: ReturnType<typeof market>) => ({ ...row, status: 'PENDING_TRADING' })],
    ['delivery', (row: ReturnType<typeof market>) => ({ ...row, contractType: 'CURRENT_QUARTER' })],
    ['wrong quote', (row: ReturnType<typeof market>) => ({ ...row, quoteAsset: 'USDC' })],
    ['wrong margin', (row: ReturnType<typeof market>) => ({ ...row, marginAsset: 'BTC' })],
    ['zero tick', (row: ReturnType<typeof market>) => ({ ...row, filters: [{ filterType: 'PRICE_FILTER', tickSize: '0' }] })],
    ['missing tick despite precision', (row: ReturnType<typeof market>) => ({ ...row, filters: [] })],
    ['duplicate tick', (row: ReturnType<typeof market>) => ({ ...row, filters: [...row.filters, ...row.filters] })],
  ])('rejects %s identity before any candle request', async (_name, change) => {
    const fetcher = transport((url, data) => url.pathname.endsWith('exchangeInfo') ? { symbols: [change(market())] } : data);
    await expect(client(fetcher).load('BTCUSDT', signal())).rejects.toMatchObject({ code: 'HISTORY_IDENTITY' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([null, {}, { symbols: [] }, { symbols: [null] }, { symbols: [market(), market()] }])('rejects malformed or conflicting directory %j', async data => {
    const fetcher = transport((url, value) => url.pathname.endsWith('exchangeInfo') ? data : value);
    await expect(client(fetcher).load('BTCUSDT', signal())).rejects.toMatchObject({ code: 'HISTORY_IDENTITY' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['numeric price', (row: unknown[]) => { row[1] = 100; }],
    ['blank price', (row: unknown[]) => { row[1] = ''; }],
    ['negative price', (row: unknown[]) => { row[3] = '-1'; }],
    ['zero price', (row: unknown[]) => { row[3] = '0'; }],
    ['NaN', (row: unknown[]) => { row[1] = 'NaN'; }],
    ['infinity', (row: unknown[]) => { row[2] = 'Infinity'; }],
    ['overflow', (row: unknown[]) => { row[2] = `1${'0'.repeat(101)}`; }],
    ['out-of-range close', (row: unknown[]) => { row[4] = '102'; }],
    ['inverted bounds', (row: unknown[]) => { row[3] = '102'; }],
    ['string time', (row: unknown[]) => { row[0] = String(row[0]); }],
    ['unaligned open', (row: unknown[]) => { row[0] = Number(row[0]) + 1; }],
    ['wrong close', (row: unknown[]) => { row[6] = Number(row[6]) - 1; }],
    ['partial bar', (row: unknown[]) => { row[0] = END; row[6] = END + STEP - 1; }],
  ])('fails closed on %s instead of skipping the bar', async (_name, change) => {
    const fetcher = transport((url, data) => {
      if (url.pathname.endsWith('markPriceKlines')) change((data as unknown[][])[20]); return data;
    });
    await expect(client(fetcher).load('BTCUSDT', signal())).rejects.toMatchObject({ code: 'HISTORY_INVALID' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(['missing', 'empty', 'duplicate', 'conflict', 'unordered', 'extra', 'short-new-listing', 'non-array'])('rejects %s page in bounded calls', async kind => {
    const fetcher = transport((url, data) => {
      if (!url.pathname.endsWith('markPriceKlines')) return data;
      const rows = data as unknown[][];
      if (kind === 'non-array') return { code: -1 };
      if (kind === 'empty') return [];
      if (kind === 'missing') rows.splice(20, 1);
      if (kind === 'short-new-listing') return rows.slice(1000);
      if (kind === 'duplicate' || kind === 'conflict') { rows[20] = [...rows[19]]; if (kind === 'conflict') rows[20][4] = '100.99'; }
      if (kind === 'unordered') [rows[20], rows[21]] = [rows[21], rows[20]];
      if (kind === 'extra') rows.push(candle(Number(rows.at(-1)![0]) + STEP));
      return rows;
    });
    await expect(client(fetcher).load('BTCUSDT', signal())).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects page overlap across pagination without an unbounded recovery loop', async () => {
    const fetcher = transport((url, data) => {
      if (url.pathname.endsWith('markPriceKlines') && Number(url.searchParams.get('startTime')) > END - SPAN) {
        (data as unknown[][])[0] = candle(Number(url.searchParams.get('startTime')) - STEP);
      } return data;
    });
    await expect(client(fetcher).load('BTCUSDT', signal())).rejects.toMatchObject({ code: 'HISTORY_INVALID' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('uses immutable copies and a three-symbol LRU cache only within the current five-minute boundary', async () => {
    let time = END + 1234;
    const fetcher = transport(), historyClient = client(fetcher, () => time);
    const first = await historyClient.load('BTCUSDT', signal()); first.candles[0].close = '0'; first.tickSize = '9';
    expect((await historyClient.load('BTCUSDT', signal())).candles[0].close).toBe('100.50');
    expect((await historyClient.load('BTCUSDT', signal())).tickSize).toBe('0.10');
    expect(fetcher).toHaveBeenCalledTimes(4);
    await historyClient.load('ETHUSDT', signal()); await historyClient.load('SOLUSDT', signal());
    await historyClient.load('BTCUSDT', signal()); await historyClient.load('XRPUSDT', signal());
    expect(fetcher).toHaveBeenCalledTimes(13);
    await historyClient.load('ETHUSDT', signal()); expect(fetcher).toHaveBeenCalledTimes(16);
    time = END + STEP;
    const next = await historyClient.load('BTCUSDT', signal());
    expect(next.to).toBe(END + STEP); expect(fetcher).toHaveBeenCalledTimes(20);
  });

  it('expires metadata after one minute even when another symbol history is still cached', async () => {
    let time = END + 1234;
    const fetcher = transport(), historyClient = client(fetcher, () => time);
    await historyClient.load('BTCUSDT', signal()); time += 60_000;
    await historyClient.load('ETHUSDT', signal());
    expect(vi.mocked(fetcher).mock.calls.filter(args => String(args[0]).includes('exchangeInfo'))).toHaveLength(2);
  });

  it('serializes identical loads without duplicate accepted fetches', async () => {
    const fetcher = transport(), historyClient = client(fetcher);
    const [first, second] = await Promise.all([historyClient.load('BTCUSDT', signal()), historyClient.load('BTCUSDT', signal())]);
    expect(first).toEqual(second); expect(first).not.toBe(second); expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('cancels a queued caller immediately without cancelling an active caller', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const base = transport();
    const fetcher = vi.fn(async (...args: Parameters<typeof fetch>) => { await gate; return base(...args); }) as unknown as typeof fetch;
    const historyClient = client(fetcher), controller = new AbortController();
    const first = historyClient.load('BTCUSDT', signal());
    const queued = historyClient.load('BTCUSDT', controller.signal);
    const rejection = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await rejection; release();
    expect((await first).candles).toHaveLength(4032);
    expect((await historyClient.load('BTCUSDT', signal())).candles).toHaveLength(4032);
    expect(base).toHaveBeenCalledTimes(4);
  });

  it('does not poison retry after an active transport abort', async () => {
    const base = transport(); let didStart!: () => void;
    const started = new Promise<void>(resolve => { didStart = resolve; });
    const fetcher = vi.fn((...args: Parameters<typeof fetch>) => {
      if (vi.mocked(fetcher).mock.calls.length > 1) return base(...args);
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException('aborted', 'AbortError'));
        args[1]?.signal?.addEventListener('abort', abort, { once: true }); didStart();
      });
    }) as unknown as typeof fetch;
    const historyClient = client(fetcher), controller = new AbortController();
    const first = historyClient.load('BTCUSDT', controller.signal);
    const rejection = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await started; controller.abort(); await rejection;
    expect((await historyClient.load('BTCUSDT', signal())).candles).toHaveLength(4032);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it('never accepts or caches late data from a cancelled transport that ignores abort', async () => {
    let release!: () => void, didStart!: () => void;
    const started = new Promise<void>(resolve => { didStart = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; }); const base = transport();
    const fetcher = vi.fn(async (...args: Parameters<typeof fetch>) => {
      if (vi.mocked(fetcher).mock.calls.length === 1) { didStart(); await gate; } return base(...args);
    }) as unknown as typeof fetch;
    const historyClient = client(fetcher), controller = new AbortController();
    const pending = historyClient.load('BTCUSDT', controller.signal), rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await started; controller.abort(); await rejection; release();
    await historyClient.load('BTCUSDT', signal()); expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it('retries all candle pages after a failed partial download', async () => {
    let broken = true;
    const fetcher = transport((url, data) => broken && url.pathname.endsWith('markPriceKlines') ? [] : data), historyClient = client(fetcher);
    await expect(historyClient.load('BTCUSDT', signal())).rejects.toMatchObject({ code: 'HISTORY_INCOMPLETE' });
    broken = false; expect((await historyClient.load('BTCUSDT', signal())).candles).toHaveLength(4032);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it('does not retain invalid identity metadata when a corrected source is retried', async () => {
    let broken = true;
    const fetcher = transport((url, data) => broken && url.pathname.endsWith('exchangeInfo') ? { symbols: [{ ...market(), filters: [] }] } : data);
    const historyClient = client(fetcher);
    await expect(historyClient.load('BTCUSDT', signal())).rejects.toMatchObject({ code: 'HISTORY_IDENTITY' });
    broken = false; expect((await historyClient.load('BTCUSDT', signal())).candles).toHaveLength(4032);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it('rejects already-aborted, malformed-symbol and invalid-clock reads before network work', async () => {
    const fetcher = transport(), historyClient = client(fetcher), controller = new AbortController(); controller.abort();
    await expect(historyClient.load('BTCUSDT', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(historyClient.load('BTCUSDT&other=1', signal())).rejects.toThrow('代码格式');
    await expect(client(fetcher, () => NaN).load('BTCUSDT', signal())).rejects.toThrow('时间无效');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('mark candle request budget', () => {
  it.each([[1, 1], [99, 1], [100, 2], [499, 2], [500, 5], [1000, 5], [1001, 10], [1500, 10]])('counts limit %i as weight %i', (limit, weight) => {
    expect(binanceRequestWeight(new URL(`https://fapi.binance.com/fapi/v1/markPriceKlines?symbol=BTCUSDT&limit=${limit}`))).toBe(weight);
  });

  it('charges mark history against shared background quota and preserves critical OI capacity', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(END + 1234);
    const fetcher = transport((url, data) => url.pathname.endsWith('exchangeInfo') ? { ...catalog(), rateLimits: [
      { rateLimitType: 'REQUEST_WEIGHT', interval: 'MINUTE', intervalNum: 1, limit: 100 },
    ] } : data);
    await expect(client(fetcher).load('BTCUSDT', signal())).rejects.toMatchObject({ code: 'RATE_LIMIT_BUDGET' });
    expect(fetcher).toHaveBeenCalledTimes(2); // metadata 1 + first 1500-bar page 10; another page would exceed 20.
    const critical = createSourceClient(fetcher, 1);
    await critical('https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT', signal());
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
