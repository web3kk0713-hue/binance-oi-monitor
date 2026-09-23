import type { HistoryPoint } from '../shared/types';

export const HISTORY_HOUR = 3_600_000;
const STRIDE = 11;
/** Packed per-hour observations retain exact availability times, not fabricated bucket times. */
export interface SampleHour {
  assetId: string; hour: number; samplingIntervalMs: number;
  values: Float64Array; contractSets: string[];
}
const numeric = (value: number | null | undefined) => value != null && Number.isFinite(value) ? value : NaN;
const nullable = (value: number) => Number.isFinite(value) ? value : null;

export function appendSample(record: SampleHour | undefined, point: HistoryPoint): SampleHour {
  if (!Number.isFinite(point.timestamp) || point.availableAt !== point.timestamp) throw new Error('历史样本必须保留实际可用时间');
  const hour = Math.floor(point.timestamp / HISTORY_HOUR) * HISTORY_HOUR;
  if (record && (record.assetId !== point.assetId || record.hour !== hour)) throw new Error('历史小时分组不一致');
  if (record && record.samplingIntervalMs !== (point.samplingIntervalMs ?? 30_000)) throw new Error('不能混合不同采样间隔的历史');
  const result: SampleHour = record ?? { assetId: point.assetId, hour, samplingIntervalMs: point.samplingIntervalMs ?? 30_000,
    values: new Float64Array(0), contractSets: [] };
  const key = point.contractSetKey ?? '';
  let contractIndex = result.contractSets.indexOf(key);
  if (contractIndex < 0) { contractIndex = result.contractSets.length; result.contractSets.push(key); }
  let offset = -1;
  for (let i = 0; i < result.values.length; i += STRIDE) if (result.values[i] === point.timestamp) { offset = i; break; }
  if (offset < 0) {
    offset = result.values.length;
    const next = new Float64Array(offset + STRIDE); next.set(result.values); result.values = next;
  }
  result.values.set([point.timestamp, numeric(point.oiUsd), numeric(point.marketCapUsd), numeric(point.fdvUsd),
    numeric(point.oiQuantity), numeric(point.priceUsd), numeric(point.oiSourceTime), numeric(point.priceSourceTime),
    numeric(point.sourceSkewMs), Number(point.complete), contractIndex], offset);
  return result;
}

export function unpackSamples(record: SampleHour): HistoryPoint[] {
  const points: HistoryPoint[] = [];
  for (let offset = 0; offset + STRIDE <= record.values.length; offset += STRIDE) {
    const row = record.values.subarray(offset, offset + STRIDE);
    const complete = row[9] === 1;
    const oiUsd = complete ? nullable(row[1]) : null;
    const marketCapUsd = complete ? nullable(row[2]) : null;
    const fdvUsd = complete ? nullable(row[3]) : null;
    points.push({ assetId: record.assetId, timestamp: row[0], availableAt: row[0], oiUsd, marketCapUsd, fdvUsd, complete,
      oiQuantity: complete ? nullable(row[4]) : null, priceUsd: complete ? nullable(row[5]) : null,
      oiSourceTime: nullable(row[6]), priceSourceTime: nullable(row[7]), sourceSkewMs: nullable(row[8]),
      contractSetKey: record.contractSets[row[10]] ?? '', samplingIntervalMs: record.samplingIntervalMs,
      oiToFdv: oiUsd !== null && fdvUsd !== null && fdvUsd > 0 ? oiUsd / fdvUsd * 100 : null,
      oiToMarketCap: oiUsd !== null && marketCapUsd !== null && marketCapUsd > 0 ? oiUsd / marketCapUsd * 100 : null,
    });
  }
  return points.sort((a, b) => a.timestamp - b.timestamp);
}

/** After seven days keep the last real observation per minute; timestamps never move backwards. */
export function compactSampleHour(record: SampleHour): SampleHour {
  const minutePoints = new Map<number, HistoryPoint>();
  for (const point of unpackSamples(record)) minutePoints.set(Math.floor(point.timestamp / 60_000), point);
  let compacted: SampleHour = { assetId: record.assetId, hour: record.hour, samplingIntervalMs: 60_000,
    values: new Float64Array(0), contractSets: [] };
  for (const point of minutePoints.values()) compacted = appendSample(compacted, { ...point, samplingIntervalMs: 60_000 });
  return compacted;
}
