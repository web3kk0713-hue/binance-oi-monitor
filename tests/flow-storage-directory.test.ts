import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowMarket, FlowUpdate } from '../src/shared/flowTypes';

const mock = vi.hoisted(() => ({ directory: new Map<string, unknown>(), puts: [] as unknown[], getAllCount: 0, failWrite: false, failCommit: false }));
vi.mock('idb', () => ({ openDB: async () => ({ transaction: () => {
  const staged = new Map(mock.directory);
  let failed = false;
  return {
    objectStore: (name: string) => ({
      getAll: async () => { if (name !== 'markets') throw new Error('Unexpected store'); mock.getAllCount++; return [...staged.values()]; },
      get: async (key: string) => name === 'markets' ? staged.get(key) : undefined,
      put: async (value: { key: string }) => {
        if (name !== 'markets') throw new Error('This fixture tests directory-only writes');
        mock.puts.push(structuredClone(value));
        if (mock.failWrite) { mock.failWrite = false; failed = true; throw new Error('simulated transaction write failure'); }
        staged.set(value.key, structuredClone(value));
      },
    }),
    get done() {
      if (failed || mock.failCommit) { mock.failCommit = false; return Promise.reject(new Error('simulated transaction commit failure')); }
      mock.directory = staged; return Promise.resolve();
    },
  };
} }) }));
import { saveFlowUpdate } from '../src/web/flowStorage';

const first: FlowMarket = { key: 'futures:BTCUSDT', venue: 'futures', symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', assetId: 'binance:BTC' };
const update: FlowUpdate = { candles: [], oi: [], depth: [], events: [] };
beforeEach(() => { mock.directory = new Map(); mock.puts = []; mock.getAllCount = 0; mock.failWrite = false; mock.failCommit = false; });

describe('transaction-authoritative browser market directory writes', () => {
  it('writes a new directory once, then skips all unchanged market puts', async () => {
    await saveFlowUpdate(update, [first], 1000); await saveFlowUpdate(update, [{ ...first }], 2000);
    expect(mock.puts).toEqual([first]); expect(mock.getAllCount).toBe(2);
  });

  it('reduces 600-market repeat batches from 7200 potential puts/minute to zero unchanged puts', async () => {
    const markets = Array.from({ length: 600 }, (_, index) => ({ ...first, key: `futures:T${index}USDT`, symbol: `T${index}USDT`, baseAsset: `T${index}`, assetId: `binance:T${index}` }));
    await saveFlowUpdate(update, markets, 1000); expect(mock.puts).toHaveLength(600);
    mock.puts = [];
    for (let batch = 0; batch < 12; batch++) await saveFlowUpdate(update, markets, 2000 + batch * 5000);
    expect(mock.puts).toHaveLength(0); expect(mock.directory.size).toBe(600);
  });

  it.each(['venue', 'symbol', 'baseAsset', 'quoteAsset', 'assetId'] as const)('persists changes to %s instead of trusting only the key', async field => {
    await saveFlowUpdate(update, [first], 1000);
    const changed = { ...first, [field]: field === 'venue' ? 'spot' : 'CHANGED' } as FlowMarket;
    await saveFlowUpdate(update, [changed], 2000);
    expect(mock.puts).toEqual([first, changed]);
  });

  it('notices a directory change by another page before deciding whether to write', async () => {
    await saveFlowUpdate(update, [first], 1000); mock.puts = [];
    mock.directory.set(first.key, { ...first, assetId: 'other-page-value' });
    await saveFlowUpdate(update, [first], 2000);
    expect(mock.puts).toEqual([first]); expect(mock.directory.get(first.key)).toEqual(first);
  });

  it('retains historical markets absent from the latest active catalog', async () => {
    const archived = { ...first, key: 'futures:OLDUSDT', symbol: 'OLDUSDT' };
    mock.directory.set(archived.key, archived);
    await saveFlowUpdate(update, [first], 1000);
    expect(mock.directory.get(archived.key)).toEqual(archived);
  });

  it.each(['failWrite', 'failCommit'] as const)('does not cache a failed %s and retries the unchanged input', async fault => {
    mock[fault] = true;
    await expect(saveFlowUpdate(update, [first], 1000)).rejects.toThrow('simulated transaction');
    expect(mock.directory.size).toBe(0);
    await saveFlowUpdate(update, [first], 2000);
    expect(mock.puts).toEqual([first, first]); expect(mock.directory.get(first.key)).toEqual(first);
  });
});
