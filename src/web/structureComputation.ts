import type { StructureInput, StructureReplay, StructureResult } from '../shared/structureTypes';

export interface StructureComputationOutput { result: StructureResult; replay: StructureReplay | null }
export interface StructureComputationRequest { schemaVersion: 1; type: 'analyze'; id: number; input: StructureInput; horizonMs?: number }
export type StructureComputationResponse = { schemaVersion: 1; type: 'result'; id: number; output: StructureComputationOutput }
  | { schemaVersion: 1; type: 'error'; id: number; message: string };
export interface StructureComputationWorker {
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: Event) => void): void;
  removeEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: Event) => void): void;
}
export interface StructureComputationClient {
  analyze(input: StructureInput, horizonMs?: number): Promise<StructureComputationOutput>;
  close(): void;
}
interface Job {
  request: StructureComputationRequest;
  resolve(value: StructureComputationOutput): void;
  reject(error: Error): void;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const natural = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const positiveTime = (value: unknown): value is number => natural(value) && value > 0;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2000;
const decimal = (value: unknown): value is string => typeof value === 'string' && value.length <= 128
  && /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) && Number.isFinite(Number(value));
const abort = () => new DOMException('结构分析已取消或被更新请求替代', 'AbortError');

/** Cheap wire-shape/identity checks only; all candle scans and exact-decimal calculations remain in the worker. */
function validOutput(value: unknown, request: StructureComputationRequest): value is StructureComputationOutput {
  if (!object(value) || !object(value.result)) return false;
  const result = value.result;
  if (result.status === 'unavailable') return ['identity', 'invalid', 'history', 'stale', 'structure', 'space'].includes(result.code as string)
    && text(result.reason) && value.replay === null;
  if (result.status !== 'ready' || !object(result.advice)) return false;
  const advice = result.advice, position = advice.position;
  if (advice.version !== 'structure-v1' || advice.mode !== request.input.mode || advice.generatedAt !== request.input.now
    || advice.asOf !== request.input.reference.sourceTime || !object(position)
    || !['id', 'marketKey', 'symbol', 'assetId', 'side', 'entryPrice', 'margin', 'leverage', 'createdAt', 'openedAt', 'suggestedHoldingLimitMs'].every(key => position[key] === request.input.position[key as keyof StructureInput['position']])) return false;
  if (!['referencePrice', 'tickSize', 'atr15', 'buffer', 'quantity', 'currentPnl', 'additionalRisk', 'additionalRiskPct', 'remainingRewardRisk'].every(key => decimal(advice[key]))
    || !positiveTime(advice.historyFrom) || !positiveTime(advice.historyTo)) return false;
  const level = (item: unknown) => object(item) && ['price', 'structurePrice', 'pnl', 'returnOnMarginPct'].every(key => decimal(item[key])) && positiveTime(item.confirmedAt);
  if (!level(advice.stop) || !level(advice.target1) || advice.target2 !== null && !level(advice.target2)) return false;
  const intervals = ['5m', '15m', '1h', '4h'];
  if (!Array.isArray(advice.trends) || advice.trends.length !== 4 || !intervals.every((interval, index) => {
    const item = (advice.trends as unknown[])[index];
    return object(item) && item.interval === interval && ['up', 'down', 'flat', 'unavailable'].includes(item.direction as string)
      && (item.direction === 'unavailable' ? item.changePct === null && item.from === null && item.to === null
        : decimal(item.changePct) && positiveTime(item.from) && positiveTime(item.to));
  })) return false;
  if (![advice.reasons, advice.warnings].every(items => Array.isArray(items) && items.length <= 30 && items.every(text))) return false;
  if (request.input.mode !== 'replay' || request.horizonMs === undefined) return value.replay === null;
  const replay = value.replay;
  return object(replay) && ['stop', 'target1', 'ambiguous', 'unresolved', 'incomplete'].includes(replay.outcome as string)
    && (replay.touchedAt === null || positiveTime(replay.touchedAt)) && natural(replay.observedTo) && natural(replay.bars) && text(replay.reason);
}

/** One active computation and one replaceable queued input; never moves heavy work back to the UI thread. */
export function createStructureComputationClient(factory: () => StructureComputationWorker = () => {
  if (typeof Worker === 'undefined') throw new Error('当前浏览器不支持后台计算，结构验证暂不可用；市场与正式提醒不受影响。');
  return new Worker(new URL('./structure.worker.ts', import.meta.url), { type: 'module' });
}): StructureComputationClient {
  let worker: StructureComputationWorker | null = null, active: Job | null = null, queued: Job | null = null;
  let sequence = 0, closed = false, failure: Error | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  const clearWatchdog = () => { if (watchdog !== null) clearTimeout(watchdog); watchdog = null; };
  const detach = () => {
    clearWatchdog();
    if (!worker) return;
    worker.removeEventListener('message', onMessage); worker.removeEventListener('error', onError); worker.removeEventListener('messageerror', onMessageError);
    worker.terminate(); worker = null;
  };
  const fail = (error: Error) => {
    failure = error; detach();
    active?.reject(error); queued?.reject(error); active = null; queued = null;
  };
  const dispatch = (job: Job) => {
    active = job;
    try {
      if (!worker) {
        worker = factory(); worker.addEventListener('message', onMessage); worker.addEventListener('error', onError); worker.addEventListener('messageerror', onMessageError);
      }
      watchdog = setTimeout(() => fail(new Error('结构计算超时，已停止本次分析；请重新打开结构验证后重试。')), 30_000);
      worker.postMessage(job.request);
    } catch (error) { fail(error instanceof Error ? error : new Error('后台计算无法启动，结构验证暂不可用。')); }
  };
  const onMessage = (event: Event) => {
    if (closed || failure) return;
    const value: unknown = (event as MessageEvent).data;
    if (!object(value) || value.schemaVersion !== 1 || !positiveTime(value.id) || !['result', 'error'].includes(value.type as string)) {
      fail(new Error('后台计算返回格式无效，候选方案未更新。')); return;
    }
    if (!active || value.id !== active.request.id) {
      if (value.id > sequence) fail(new Error('后台计算返回未知请求，候选方案未更新。'));
      return; // Late or duplicate responses must not settle another request.
    }
    if (value.type === 'error') { fail(new Error(text(value.message) ? value.message : '结构计算失败，候选方案未更新。')); return; }
    let valid = false;
    try { valid = validOutput(value.output, active.request); } catch { /* Untrusted wire input must never leave a request hanging. */ }
    if (!valid) { fail(new Error('后台计算结果无法校验，候选方案未更新。')); return; }
    const completed = active; active = null; clearWatchdog();
    completed.resolve(value.output as StructureComputationOutput);
    const next = queued; queued = null;
    if (next) dispatch(next);
  };
  const onError = () => fail(new Error('后台计算进程异常，结构验证已暂停；请重新打开后重试。'));
  const onMessageError = () => fail(new Error('后台计算结果传输失败，结构验证已暂停。'));
  return {
    analyze(input, horizonMs) {
      if (closed) return Promise.reject(abort());
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        let request: StructureComputationRequest;
        try {
          if (sequence >= Number.MAX_SAFE_INTEGER) throw new Error('结构分析请求序号已耗尽，请重新打开验证页。');
          // Freeze queued data at invocation, not when it eventually reaches the worker.
          request = { schemaVersion: 1, type: 'analyze', id: ++sequence, input: structuredClone(input), ...(horizonMs === undefined ? {} : { horizonMs }) };
        } catch { reject(new Error('结构分析输入无法复制，未启动计算。')); return; }
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
