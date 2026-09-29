import Decimal from 'decimal.js';
import { validateMarketPlan } from '../shared/marketPlan';
import type { MarketPlanInput, MarketPlanResult } from '../shared/marketPlanTypes';

export interface MarketPlanComputationRequest { schemaVersion: 1; type: 'analyze'; id: number; input: MarketPlanInput }
export type MarketPlanComputationResponse = { schemaVersion: 1; type: 'result'; id: number; output: MarketPlanResult }
  | { schemaVersion: 1; type: 'error'; id: number; message: string };
export interface MarketPlanComputationWorker {
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: Event) => void): void;
  removeEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: Event) => void): void;
}
export interface MarketPlanComputationClient { analyze(input: MarketPlanInput): Promise<MarketPlanResult>; close(): void }
interface Job { request: MarketPlanComputationRequest; resolve(value: MarketPlanResult): void; reject(error: Error): void }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2000;
const abort = () => new DOMException('进场计划分析已取消或被更新请求替代', 'AbortError');
/** Bounded plan validation only. There are no historical scans or structure calculations on this thread. */
function validOutput(value: unknown, request: MarketPlanComputationRequest): value is MarketPlanResult {
  if (!object(value)) return false;
  if (value.status === 'unavailable') return text(value.reason);
  if (value.status !== 'ready' || !validateMarketPlan(value.plan)) return false;
  const plan = value.plan, input = request.input;
  return plan.id === input.id && plan.side === input.side && plan.generatedAt === input.now && plan.asOf === input.reference.sourceTime
    && plan.holdingLimitMs === input.holdingLimitMs && new Decimal(plan.referencePrice).eq(input.reference.markPrice)
    && new Decimal(plan.tickSize).eq(input.history.tickSize)
    && (['key', 'venue', 'symbol', 'baseAsset', 'quoteAsset', 'assetId'] as const).every(key => plan.market[key] === input.market[key])
    && (['oiPct', 'pricePct', 'flowSharePct', 'requireSpot'] as const).every(key => plan.directionConfig[key] === input.directionConfig[key]);
}

/** One active request and one latest-wins queued request. Worker failure never falls back to UI-thread analysis. */
export function createMarketPlanComputationClient(factory: () => MarketPlanComputationWorker = () => {
  if (typeof Worker === 'undefined') throw new Error('当前浏览器不支持后台计算，进场计划暂不可用；行情刷新不受影响。');
  return new Worker(new URL('./marketPlan.worker.ts', import.meta.url), { type: 'module' });
}): MarketPlanComputationClient {
  let worker: MarketPlanComputationWorker | null = null, active: Job | null = null, queued: Job | null = null;
  let sequence = 0, closed = false, failure: Error | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  const clearWatchdog = () => { if (watchdog !== null) clearTimeout(watchdog); watchdog = null; };
  const detach = () => {
    clearWatchdog();
    if (!worker) return;
    worker.removeEventListener('message', onMessage); worker.removeEventListener('error', onError); worker.removeEventListener('messageerror', onMessageError);
    worker.terminate(); worker = null;
  };
  const fail = (error: Error) => { failure = error; detach(); active?.reject(error); queued?.reject(error); active = null; queued = null; };
  const dispatch = (job: Job) => {
    active = job;
    try {
      if (!worker) {
        worker = factory(); worker.addEventListener('message', onMessage); worker.addEventListener('error', onError); worker.addEventListener('messageerror', onMessageError);
      }
      watchdog = setTimeout(() => fail(new Error('进场计划后台计算超时，请重新分析。')), 30_000);
      worker.postMessage(job.request);
    } catch (error) { fail(error instanceof Error ? error : new Error('进场计划后台计算无法启动。')); }
  };
  const onMessage = (event: Event) => {
    if (closed || failure) return;
    const value: unknown = (event as MessageEvent).data;
    if (!object(value) || value.schemaVersion !== 1 || !positiveInteger(value.id) || !['result', 'error'].includes(value.type as string)) {
      fail(new Error('进场计划后台计算返回格式无效。')); return;
    }
    if (!active || value.id !== active.request.id) {
      if (value.id > sequence) fail(new Error('进场计划后台计算返回未知请求。'));
      return;
    }
    if (value.type === 'error') { fail(new Error(text(value.message) ? value.message : '进场计划后台计算失败。')); return; }
    let valid = false;
    try { valid = validOutput(value.output, active.request); } catch { /* Malformed clone must settle with a visible failure. */ }
    if (!valid) { fail(new Error('进场计划后台计算结果无法校验。')); return; }
    const completed = active; active = null; clearWatchdog(); completed.resolve(value.output as MarketPlanResult);
    const next = queued; queued = null; if (next) dispatch(next);
  };
  const onError = () => fail(new Error('进场计划后台计算进程异常，请重新分析。'));
  const onMessageError = () => fail(new Error('进场计划后台计算结果传输失败。'));
  return {
    analyze(input) {
      if (closed) return Promise.reject(abort());
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        let request: MarketPlanComputationRequest;
        try {
          if (sequence >= Number.MAX_SAFE_INTEGER) throw new Error('进场计划请求序号已耗尽。');
          request = { schemaVersion: 1, type: 'analyze', id: ++sequence, input: structuredClone(input) };
        } catch { reject(new Error('进场计划分析输入无法复制。')); return; }
        const job = { request, resolve, reject };
        if (active) { queued?.reject(abort()); queued = job; } else dispatch(job);
      });
    },
    close() {
      if (closed) return; closed = true; detach();
      active?.reject(abort()); queued?.reject(abort()); active = null; queued = null;
    },
  };
}
