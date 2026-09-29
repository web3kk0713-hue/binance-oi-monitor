import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStructureComputationClient, type StructureComputationClient, type StructureComputationRequest,
  type StructureComputationResponse, type StructureComputationWorker } from '../src/web/structureComputation';
import { computeStructureRequest } from '../src/web/structure.worker';
import type { StructureInput } from '../src/shared/structureTypes';
import { structureFixture } from './structure-fixture';

class FakeWorker implements StructureComputationWorker {
  requests: StructureComputationRequest[] = [];
  terminated = 0;
  postError: Error | null = null;
  listeners = new Map<string, Set<(event: Event) => void>>();
  postMessage(value: unknown) {
    if (this.postError) throw this.postError;
    this.requests.push(value as StructureComputationRequest);
  }
  terminate() { this.terminated++; }
  addEventListener(type: string, listener: (event: Event) => void) {
    const listeners = this.listeners.get(type) ?? new Set(); listeners.add(listener); this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: (event: Event) => void) { this.listeners.get(type)?.delete(listener); }
  message(data: unknown) { for (const listener of this.listeners.get('message') ?? []) listener(new MessageEvent('message', { data })); }
  error(type = 'error') { for (const listener of this.listeners.get(type) ?? []) listener(new Event(type)); }
  finish(index = this.requests.length - 1) { this.message(computeStructureRequest(this.requests[index])); }
}
const clients: StructureComputationClient[] = [];
const setup = () => {
  const worker = new FakeWorker(), factory = vi.fn(() => worker), client = createStructureComputationClient(factory);
  clients.push(client); return { worker, client, factory };
};
afterEach(() => { for (const client of clients.splice(0)) client.close(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const unavailable: StructureComputationResponse = { schemaVersion: 1, type: 'result', id: 1,
  output: { result: { status: 'unavailable', code: 'structure', reason: '没有有效结构' }, replay: null } };

describe('off-main-thread structure client lifecycle', () => {
  it('lazily starts one worker and returns the exact pure-engine live candidate', async () => {
    const { worker, client, factory } = setup(); expect(factory).not.toHaveBeenCalled();
    const input = structureFixture(), pending = client.analyze(input);
    expect(factory).toHaveBeenCalledOnce(); expect(worker.requests).toHaveLength(1);
    expect(worker.requests[0]).toMatchObject({ schemaVersion: 1, type: 'analyze', id: 1, input });
    worker.finish();
    expect(await pending).toMatchObject({ result: { status: 'ready', advice: { version: 'structure-v1', stop: { price: '97.5' } } }, replay: null });
    const second = client.analyze(input); worker.finish(); await second;
    expect(factory).toHaveBeenCalledOnce(); expect(worker.requests.map(request => request.id)).toEqual([1, 2]);
  });
  it('keeps one active and at most one latest queued request; superseded queued work never dispatches', async () => {
    const { worker, client } = setup(), input = structureFixture();
    const first = client.analyze(input), superseded = client.analyze({ ...input, now: input.now + 1 });
    const rejected = expect(superseded).rejects.toMatchObject({ name: 'AbortError' });
    const latest = client.analyze({ ...input, now: input.now + 2 });
    await rejected;
    expect(worker.requests).toHaveLength(1);
    worker.finish(); await first;
    expect(worker.requests.map(request => request.id)).toEqual([1, 3]);
    worker.finish(); expect((await latest).result).toMatchObject({ status: 'ready', advice: { generatedAt: input.now + 2 } });
  });
  it('snapshots both active and queued input before the caller mutates it', async () => {
    const { worker, client } = setup(), input = structureFixture();
    const first = client.analyze(input), second = client.analyze(input);
    input.position.margin = '999'; input.history.candles[0].high = '999';
    worker.finish(); await first;
    expect(worker.requests[1].input.position.margin).toBe('100');
    expect(worker.requests[1].input.history.candles[0].high).toBe('101');
    worker.finish(); await second;
  });
  it('rejects active and queued work on close, detaches listeners, and never restarts', async () => {
    const { worker, client, factory } = setup(), first = client.analyze(structureFixture()), second = client.analyze(structureFixture());
    const a = expect(first).rejects.toMatchObject({ name: 'AbortError' }), b = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    client.close(); client.close(); await a; await b;
    expect(worker.terminated).toBe(1); expect([...worker.listeners.values()].every(listeners => listeners.size === 0)).toBe(true);
    await expect(client.analyze(structureFixture())).rejects.toMatchObject({ name: 'AbortError' }); expect(factory).toHaveBeenCalledOnce();
  });
  it('can close before the lazy worker is created', () => {
    const { client, factory } = setup(); client.close(); expect(factory).not.toHaveBeenCalled();
  });
  it('uses a repository-relative module worker URL with the default browser factory', async () => {
    const fake = new FakeWorker(), constructor = vi.fn(function () { return fake; }); vi.stubGlobal('Worker', constructor);
    const client = createStructureComputationClient(); clients.push(client);
    const pending = client.analyze(structureFixture());
    expect(constructor).toHaveBeenCalledWith(expect.any(URL), { type: 'module' });
    expect((constructor.mock.calls[0] as unknown as [URL])[0].pathname).toMatch(/\/src\/web\/structure\.worker\.ts$/);
    fake.finish(); await pending;
  });
});

describe('worker errors are explicit, with no synchronous heavy fallback', () => {
  it('reports unsupported browsers without calling the analysis engine on the main thread', async () => {
    vi.stubGlobal('Worker', undefined); const client = createStructureComputationClient(); clients.push(client);
    await expect(client.analyze(structureFixture())).rejects.toThrow('不支持后台计算');
  });
  it('handles construction and postMessage failure without hanging promises', async () => {
    const client = createStructureComputationClient(() => { throw new Error('constructor failed'); }); clients.push(client);
    await expect(client.analyze(structureFixture())).rejects.toThrow('constructor failed');
    const second = setup(); second.worker.postError = new Error('post failed');
    await expect(second.client.analyze(structureFixture())).rejects.toThrow('post failed');
    expect(second.worker.terminated).toBe(1);
  });
  it.each(['error', 'messageerror'])('rejects all pending work on %s and does not silently retry', async type => {
    const { worker, client, factory } = setup(), first = client.analyze(structureFixture()), second = client.analyze(structureFixture());
    const a = expect(first).rejects.toThrow('后台计算'), b = expect(second).rejects.toThrow('后台计算');
    worker.error(type); await a; await b;
    await expect(client.analyze(structureFixture())).rejects.toThrow('后台计算');
    expect(worker.terminated).toBe(1); expect(factory).toHaveBeenCalledOnce();
  });
  it('rejects an explicit worker computation error', async () => {
    const { worker, client } = setup(), pending = client.analyze(structureFixture());
    worker.message({ schemaVersion: 1, type: 'error', id: 1, message: '测试计算失败' });
    await expect(pending).rejects.toThrow('测试计算失败');
  });
  it('times out an unresponsive worker and clears its queued work', async () => {
    vi.useFakeTimers(); const { worker, client } = setup(), first = client.analyze(structureFixture()), second = client.analyze(structureFixture());
    const a = expect(first).rejects.toThrow('超时'), b = expect(second).rejects.toThrow('超时');
    vi.advanceTimersByTime(30_000); await a; await b; expect(worker.terminated).toBe(1);
  });
  it('rejects an uncloneable input without poisoning an already running job', async () => {
    const { worker, client } = setup(), first = client.analyze(structureFixture());
    await expect(client.analyze({ ...structureFixture(), bad: () => 1 } as StructureInput)).rejects.toThrow('无法复制');
    worker.finish(); expect((await first).result.status).toBe('ready');
  });
});

describe('response schemas and request identity', () => {
  it('accepts an explicit unavailable result with no fabricated replay', async () => {
    const { worker, client } = setup(), pending = client.analyze(structureFixture()); worker.message(unavailable);
    expect(await pending).toEqual(unavailable.type === 'result' ? unavailable.output : null);
  });
  it('ignores a late duplicate response without resolving the next active request', async () => {
    const { worker, client } = setup(), first = client.analyze(structureFixture()); worker.message(unavailable); await first;
    let resolved = false; const second = client.analyze(structureFixture()).then(output => { resolved = true; return output; });
    worker.message(unavailable); await Promise.resolve(); expect(resolved).toBe(false);
    worker.finish(); await second; expect(resolved).toBe(true);
  });
  it.each([null, {}, { ...unavailable, schemaVersion: 2 }, { ...unavailable, id: 0 }, { ...unavailable, id: 1.5 },
    { ...unavailable, id: 99 }, { ...unavailable, type: 'other' }, { ...unavailable, output: null },
    { ...unavailable, output: { result: { status: 'unavailable', code: 'magic', reason: 'x' }, replay: null } },
  ])('rejects malformed protocol response %#', async response => {
    const { worker, client } = setup(), pending = client.analyze(structureFixture()); worker.message(response);
    await expect(pending).rejects.toThrow('后台计算'); expect(worker.terminated).toBe(1);
  });
  it.each(['identity', 'time', 'decimal', 'level', 'trend', 'sparse-trend', 'message', 'replay'])('rejects malformed ready output %s', async kind => {
    const { worker, client } = setup(), pending = client.analyze(structureFixture());
    const response = computeStructureRequest(worker.requests[0])!;
    if (response.type !== 'result' || response.output.result.status !== 'ready') throw new Error('fixture failed');
    const advice = response.output.result.advice;
    if (kind === 'identity') advice.position.marketKey = 'futures:OTHERUSDT';
    if (kind === 'time') advice.asOf++;
    if (kind === 'decimal') advice.quantity = 'Infinity';
    if (kind === 'level') advice.target1.price = 'invalid';
    if (kind === 'trend') advice.trends[0].interval = '4h';
    if (kind === 'sparse-trend') delete advice.trends[0];
    if (kind === 'message') advice.reasons = ['x'.repeat(2001)];
    if (kind === 'replay') response.output.replay = { outcome: 'unresolved', touchedAt: null, bars: 0, observedTo: 0, reason: 'unexpected' };
    worker.message(response); await expect(pending).rejects.toThrow('无法校验');
  });
});

describe('pure worker entrypoint runs only local proposal/replay calculations', () => {
  it('runs replay only for a ready historical input with an explicit horizon', async () => {
    const { worker, client } = setup(), input = structureFixture(); input.mode = 'replay';
    const first = client.analyze(input, 4 * 3_600_000); worker.finish();
    expect(await first).toMatchObject({ result: { status: 'ready' }, replay: { outcome: 'incomplete', bars: 0 } });
    const second = client.analyze(input); worker.finish(); expect((await second).replay).toBeNull();
    input.mode = 'live'; const third = client.analyze(input, 4 * 3_600_000); worker.finish(); expect((await third).replay).toBeNull();
  });
  it('returns a normal unavailable result for malformed domain input without trying replay', () => {
    expect(computeStructureRequest({ schemaVersion: 1, type: 'analyze', id: 1, input: null, horizonMs: 300_000 }))
      .toMatchObject({ type: 'result', output: { result: { status: 'unavailable', code: 'invalid' }, replay: null } });
  });
  it('does not invent request IDs and explicitly rejects unsupported request schemas', () => {
    expect(computeStructureRequest(null)).toBeNull(); expect(computeStructureRequest({ id: -1 })).toBeNull();
    expect(computeStructureRequest({ id: 2, schemaVersion: 2, type: 'analyze', input: structureFixture() }))
      .toMatchObject({ schemaVersion: 1, type: 'error', id: 2 });
  });
});
