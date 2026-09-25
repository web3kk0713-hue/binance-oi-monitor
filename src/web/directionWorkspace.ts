import { assessDirection, type DirectionAssessment } from '../shared/direction';
import type { DirectionConfig } from '../shared/directionConfig';
import type { FlowMetrics, FlowSnapshot } from '../shared/flowTypes';

/** A render-scoped evaluator: never retain assessments beyond this exact clock/config/snapshot. */
export function createDirectionEvaluator(snapshot: FlowSnapshot | null, now: number, config: DirectionConfig) {
  const rowsByAsset = new Map<string, FlowMetrics[]>();
  if (snapshot && Array.isArray(snapshot.rows)) {
    for (const row of snapshot.rows) {
      const id = row?.market?.assetId;
      if (typeof id !== 'string') continue;
      const group = rowsByAsset.get(id);
      if (group) group.push(row); else rowsByAsset.set(id, [row]);
    }
  }
  const results = new Map<string | undefined, Map<string | null | undefined, DirectionAssessment>>();
  return (assetId: string | undefined, preferredMarketKey?: string | null): DirectionAssessment => {
    let byMarket = results.get(assetId);
    if (!byMarket) { byMarket = new Map(); results.set(assetId, byMarket); }
    const cached = byMarket.get(preferredMarketKey);
    if (cached) return cached;
    const scoped = snapshot && Array.isArray(snapshot.rows)
      ? { ...snapshot, rows: assetId ? rowsByAsset.get(assetId) ?? [] : [] } : snapshot;
    const result = assessDirection(scoped, assetId, now, preferredMarketKey, config);
    byMarket.set(preferredMarketKey, result);
    return result;
  };
}
