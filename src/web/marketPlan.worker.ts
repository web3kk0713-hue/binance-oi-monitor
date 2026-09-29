import { proposeMarketPlan } from '../shared/marketPlan';
import type { MarketPlanComputationRequest, MarketPlanComputationResponse } from './marketPlanComputation';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Pure structured-clone computation only: no subscriptions, persistence, requests or exchange orders. */
export function computeMarketPlanRequest(value: unknown): MarketPlanComputationResponse | null {
  if (!object(value) || !Number.isSafeInteger(value.id) || (value.id as number) <= 0) return null;
  const id = value.id as number;
  if (value.schemaVersion !== 1 || value.type !== 'analyze' || !Object.hasOwn(value, 'input'))
    return { schemaVersion: 1, type: 'error', id, message: '进场计划计算请求格式无效。' };
  try {
    const output = proposeMarketPlan((value as unknown as MarketPlanComputationRequest).input);
    return { schemaVersion: 1, type: 'result', id, output };
  } catch { return { schemaVersion: 1, type: 'error', id, message: '进场计划计算失败，未生成候选计划。' }; }
}

if (typeof self !== 'undefined') {
  const scope = self as unknown as { addEventListener(type: 'message', listener: (event: MessageEvent) => void): void; postMessage(message: MarketPlanComputationResponse): void };
  scope.addEventListener('message', event => { const response = computeMarketPlanRequest(event.data); if (response) scope.postMessage(response); });
}
