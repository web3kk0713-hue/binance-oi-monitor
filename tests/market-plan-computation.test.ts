import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMarketPlanComputationClient, type MarketPlanComputationClient, type MarketPlanComputationRequest,
  type MarketPlanComputationWorker } from '../src/web/marketPlanComputation';
import { computeMarketPlanRequest } from '../src/web/marketPlan.worker';
import type { MarketPlanInput } from '../src/shared/marketPlanTypes';
import { marketPlanFixture as fixture } from './market-plan-fixture';

class FakeWorker implements MarketPlanComputationWorker {
  requests: MarketPlanComputationRequest[] = []; terminated = 0;
  listeners = new Map<string, Set<(event: Event) => void>>();
  postMessage(value: unknown) { this.requests.push(value as MarketPlanComputationRequest); }
  terminate() { this.terminated++; }
  addEventListener(type: string, listener: (event: Event) => void) {
    const listeners = this.listeners.get(type) ?? new Set(); listeners.add(listener); this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: (event: Event) => void) { this.listeners.get(type)?.delete(listener); }
  message(value: unknown) { for (const listener of this.listeners.get('message') ?? []) listener(new MessageEvent('message', { data: value })); }
  error(type = 'error') { for (const listener of this.listeners.get(type) ?? []) listener(new Event(type)); }
  finish(index = this.requests.length - 1) { this.message(computeMarketPlanRequest(this.requests[index])); }
}
const clients: MarketPlanComputationClient[] = [];
const setup = () => {
  const worker = new FakeWorker(), factory = vi.fn(() => worker), client = createMarketPlanComputationClient(factory);
  clients.push(client); return { worker, client, factory };
};
afterEach(() => { for (const client of clients.splice(0)) client.close(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('market-plan bounded worker lifecycle', () => {
  it('creates lazily and validates the pure engine result without another history calculation', async () => {
    const { worker, client, factory } = setup(); expect(factory).not.toHaveBeenCalled();
    const pending = client.analyze(fixture()); worker.finish();
    expect(await pending).toMatchObject({ status: 'ready', plan: { entryLow: '98.5', stopPrice: '97.5' } });
    const second = client.analyze(fixture()); worker.finish(); await second; expect(factory).toHaveBeenCalledOnce();
  });
  it('keeps one active and one latest queued request; snapshots caller input immediately', async () => {
    const { worker, client } = setup(), input = fixture(), first = client.analyze(input), superseded = client.analyze(input);
    const rejected = expect(superseded).rejects.toMatchObject({ name: 'AbortError' });
    const latest = client.analyze({ ...input, id: 'latest' }); await rejected;
    input.market.assetId = 'mutated'; input.history.candles[0].high = '999';
    expect(worker.requests).toHaveLength(1); worker.finish(); await first;
    expect(worker.requests[1]).toMatchObject({ id: 3, input: { id: 'latest', market: { assetId: 'binance:BTC' } } });
    expect(worker.requests[1].input.history.candles[0].high).toBe('101'); worker.finish();
    expect(await latest).toMatchObject({ status: 'ready', plan: { id: 'latest' } });
  });
  it('closes idempotently and rejects both active and queued requests', async () => {
    const { worker, client } = setup(), first = client.analyze(fixture()), second = client.analyze(fixture());
    const a = expect(first).rejects.toMatchObject({ name: 'AbortError' }), b = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    client.close(); client.close(); await a; await b; expect(worker.terminated).toBe(1);
    expect([...worker.listeners.values()].every(value => value.size === 0)).toBe(true);
    await expect(client.analyze(fixture())).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('uses the bundled market worker URL and has no synchronous fallback when unavailable', async () => {
    vi.stubGlobal('Worker', undefined); const unavailable = createMarketPlanComputationClient(); clients.push(unavailable);
    await expect(unavailable.analyze(fixture())).rejects.toThrow('不支持后台计算');
    const fake = new FakeWorker(), constructor = vi.fn(function () { return fake; }); vi.stubGlobal('Worker', constructor);
    const client = createMarketPlanComputationClient(); clients.push(client); const pending = client.analyze(fixture());
    expect(constructor).toHaveBeenCalledWith(expect.any(URL), { type: 'module' });
    expect((constructor.mock.calls[0] as unknown as [URL])[0].pathname).toMatch(/marketPlan\.worker\.ts$/); fake.finish(); await pending;
  });
  it.each(['error', 'messageerror'])('rejects all outstanding work on %s and will not restart silently', async type => {
    const { worker, client, factory } = setup(), first = client.analyze(fixture()), second = client.analyze(fixture());
    const a = expect(first).rejects.toThrow('后台计算'), b = expect(second).rejects.toThrow('后台计算');
    worker.error(type); await a; await b; expect(worker.terminated).toBe(1);
    await expect(client.analyze(fixture())).rejects.toThrow('后台计算'); expect(factory).toHaveBeenCalledOnce();
  });
  it('times out and terminates an unresponsive computation', async () => {
    vi.useFakeTimers(); const { worker, client } = setup(), pending = client.analyze(fixture());
    const rejected = expect(pending).rejects.toThrow('超时'); vi.advanceTimersByTime(30_000); await rejected; expect(worker.terminated).toBe(1);
  });
  it('settles construction/post failures and uncloneable inputs without hanging', async () => {
    const failed = createMarketPlanComputationClient(() => { throw new Error('factory failed'); }); clients.push(failed);
    await expect(failed.analyze(fixture())).rejects.toThrow('factory failed');
    const { worker, client } = setup(); worker.postMessage = () => { throw new Error('post failed'); };
    await expect(client.analyze(fixture())).rejects.toThrow('post failed');
    const healthy = setup(), pending = healthy.client.analyze(fixture());
    await expect(healthy.client.analyze({ ...fixture(), function: () => 1 } as MarketPlanInput)).rejects.toThrow('无法复制');
    healthy.worker.finish(); expect((await pending).status).toBe('ready');
  });
});

describe('worker identity and protocol checks', () => {
  it('returns explicit unavailability and rejects malformed domain input without faking a plan', async () => {
    const { worker, client } = setup(), input = fixture(); input.reference.markPrice = '0';
    const pending = client.analyze(input); worker.finish(); expect((await pending).status).toBe('unavailable');
    expect(computeMarketPlanRequest({ schemaVersion: 1, type: 'analyze', id: 1, input: null })).toMatchObject({ type: 'result', output: { status: 'unavailable' } });
  });
  it('does not settle the new request from a late prior response', async () => {
    const { worker, client } = setup(), first = client.analyze(fixture()); worker.finish(); await first;
    let finished = false; const second = client.analyze(fixture()).then(value => { finished = true; return value; });
    worker.finish(0); await Promise.resolve(); expect(finished).toBe(false); worker.finish(); await second;
  });
  it.each([null, {}, { schemaVersion: 2, type: 'result', id: 1 }, { schemaVersion: 1, type: 'result', id: 99 },
    { schemaVersion: 1, type: 'result', id: 1, output: null }, { schemaVersion: 1, type: 'result', id: 1, output: { status: 'unavailable', reason: '' } },
  ])('rejects malformed response %#', async response => {
    const { worker, client } = setup(), pending = client.analyze(fixture()); worker.message(response); await expect(pending).rejects.toThrow('后台计算');
  });
  it.each(['id', 'side', 'market', 'reference', 'holding', 'config', 'stop', 'reward', 'time'] as const)('rejects changed result %s', async type => {
    const { worker, client } = setup(), pending = client.analyze(fixture()), response = computeMarketPlanRequest(worker.requests[0])!;
    if (response.type !== 'result' || response.output.status !== 'ready') throw new Error('fixture failed');
    const plan = response.output.plan;
    if (type === 'id') plan.id = 'another';
    if (type === 'side') plan.side = 'short';
    if (type === 'market') plan.market.assetId = 'another';
    if (type === 'reference') plan.referencePrice = '100.1';
    if (type === 'holding') plan.holdingLimitMs = 3_600_000;
    if (type === 'config') plan.directionConfig.oiPct = 1;
    if (type === 'stop') plan.stopPrice = '97.4';
    if (type === 'reward') plan.netRewardRisk = '100';
    if (type === 'time') { plan.generatedAt++; plan.waitUntil++; }
    worker.message(response); await expect(pending).rejects.toThrow('无法校验');
  });
  it('preserves protocol ids and makes unsupported requests visible', () => {
    expect(computeMarketPlanRequest(null)).toBeNull(); expect(computeMarketPlanRequest({ id: 0 })).toBeNull();
    expect(computeMarketPlanRequest({ id: 3, schemaVersion: 2, type: 'analyze', input: fixture() })).toMatchObject({ type: 'error', id: 3 });
  });
});
