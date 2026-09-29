import { proposeStructureAdvice } from '../shared/structureAdvice';
import { replayStructureAdvice } from '../shared/structureReplay';
import type { StructureComputationRequest, StructureComputationResponse } from './structureComputation';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** This module only calculates on structured-cloned data. No fetching, persistence, subscriptions or trading. */
export function computeStructureRequest(value: unknown): StructureComputationResponse | null {
  if (!object(value) || !Number.isSafeInteger(value.id) || (value.id as number) <= 0) return null;
  const id = value.id as number;
  if (value.schemaVersion !== 1 || value.type !== 'analyze' || !Object.hasOwn(value, 'input'))
    return { schemaVersion: 1, type: 'error', id, message: '结构计算请求格式无效。' };
  try {
    const request = value as unknown as StructureComputationRequest;
    const result = proposeStructureAdvice(request.input);
    const replay = result.status === 'ready' && request.input.mode === 'replay' && request.horizonMs !== undefined
      ? replayStructureAdvice(result.advice, request.input.history, request.horizonMs) : null;
    return { schemaVersion: 1, type: 'result', id, output: { result, replay } };
  } catch { return { schemaVersion: 1, type: 'error', id, message: '结构计算失败，未生成候选方案。' }; }
}

if (typeof self !== 'undefined') {
  const scope = self as unknown as { addEventListener(type: 'message', listener: (event: MessageEvent) => void): void; postMessage(message: StructureComputationResponse): void };
  scope.addEventListener('message', event => {
    const response = computeStructureRequest(event.data);
    if (response) scope.postMessage(response);
  });
}
