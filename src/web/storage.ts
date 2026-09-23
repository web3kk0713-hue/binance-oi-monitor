import { openDB, type DBSchema } from 'idb';
import { toHistoryPoint } from '../shared/history';
import { validThresholds } from '../shared/alerts';
import { BASELINE_TOLERANCE_MS, selectChangeBaselines } from '../shared/changeMonitor';
import { DEFAULT_THRESHOLDS, type AlertEvent, type AlertState, type HistoryPoint, type Snapshot, type Thresholds } from '../shared/types';
import { appendSample, compactSampleHour, unpackSamples, type SampleHour } from './historyCodec';

export interface Settings {
  mode: 'direct' | 'server'; backendUrl: string; thresholds: Thresholds;
  notifications: boolean; favorites: string[];
}
export const DEFAULT_SETTINGS: Settings = { mode: 'direct', backendUrl: '', thresholds: DEFAULT_THRESHOLDS, notifications: false, favorites: [] };
export const HOUR = 3_600_000;
const RETENTION = 30 * 24 * HOUR;
const RAW_RETENTION = 7 * 24 * HOUR;
const PREFIX = 'oi-monitor:v1:';

export function readLocal<T>(key: string, fallback: T): T {
  try { const value = localStorage.getItem(PREFIX + key); return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}
export function writeLocal(key: string, value: unknown): boolean {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); return true; } catch { return false; }
}
export function readSettings(): Settings {
  const raw = readLocal<unknown>('settings', {});
  const saved = raw && typeof raw === 'object' ? raw as Partial<Settings> : {};
  const thresholds = { ...DEFAULT_THRESHOLDS, ...saved.thresholds };
  const valid = validThresholds(thresholds);
  return { ...DEFAULT_SETTINGS, ...saved, mode: saved.mode === 'server' && saved.backendUrl ? 'server' : 'direct',
    backendUrl: typeof saved.backendUrl === 'string' ? saved.backendUrl : '', thresholds: valid ? thresholds : DEFAULT_THRESHOLDS, notifications: saved.notifications === true,
    favorites: Array.isArray(saved.favorites) ? saved.favorites.filter((id): id is string => typeof id === 'string') : [] };
}
export function readAlertStates(): Record<string, AlertState> { return readLocal('alert-states', {}); }
export function readAlerts(): AlertEvent[] {
  const saved = readLocal<unknown>('alerts', []);
  return Array.isArray(saved) ? saved.filter((a): a is AlertEvent => a && typeof a.id === 'string' && typeof a.assetId === 'string' && typeof a.symbol === 'string' && Number.isFinite(a.ratio) && Number.isFinite(a.timestamp) && ['warning', 'danger', 'critical'].includes(a.level)).slice(0, 150) : [];
}

interface HourRecord {
  assetId: string; hour: number;
  /** Three USD amounts for each minute. NaN is an absent value, never zero. */
  values: Float64Array; present: Uint8Array; complete: Uint8Array;
  /** Missing in older records, whose supply freshness cannot be reconstructed. */
  validated?: Uint8Array;
}
export interface PushRegistration { id: string; deleteToken: string; backendUrl: string; }
interface MonitorDB extends DBSchema {
  hours: { key: [string, number]; value: HourRecord; indexes: { 'by-hour': number } };
  samples: { key: [string, number]; value: SampleHour; indexes: { 'by-hour': number; 'by-resolution-hour': [number, number] } };
  state: { key: string; value: Snapshot | PushRegistration };
}
let database: ReturnType<typeof openDB<MonitorDB>> | undefined;
function getDB() {
  return database ??= openDB<MonitorDB>('binance-oi-monitor-v1', 2, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) { const store = db.createObjectStore('hours', { keyPath: ['assetId', 'hour'] }); store.createIndex('by-hour', 'hour'); db.createObjectStore('state'); }
      if (oldVersion < 2) { const store = db.createObjectStore('samples', { keyPath: ['assetId', 'hour'] }); store.createIndex('by-hour', 'hour'); store.createIndex('by-resolution-hour', ['samplingIntervalMs', 'hour']); }
    },
    blocking() { void database?.then(db => db.close()); database = undefined; },
    terminated() { database = undefined; },
  });
}
let lastPrunedHour = 0;

/** Seven-day exact observations; older observations compact to real minute points through day 30. */
export async function saveSnapshot(snapshot: Snapshot): Promise<void> {
  const db = await getDB();
  const hour = Math.floor(snapshot.asOf / HOUR) * HOUR;
  const tx = db.transaction(['hours', 'samples', 'state'], 'readwrite');
  const records = tx.objectStore('samples');
  await Promise.all(snapshot.assets.map(async (asset) => {
    const point = toHistoryPoint(asset, snapshot);
    await records.put(appendSample(await records.get([asset.id, hour]), point));
  }));
  await tx.objectStore('state').put(snapshot, 'latest');
  if (hour !== lastPrunedHour) {
    let cursor = await records.index('by-hour').openCursor(IDBKeyRange.upperBound(hour - RETENTION, true));
    while (cursor) { await cursor.delete(); cursor = await cursor.continue(); }
    let legacy = await tx.objectStore('hours').index('by-hour').openCursor(IDBKeyRange.upperBound(hour - RETENTION, true));
    while (legacy) { await legacy.delete(); legacy = await legacy.continue(); }
    let old = await records.index('by-resolution-hour').openCursor(IDBKeyRange.bound([30_000, 0], [30_000, hour - RAW_RETENTION], false, true));
    while (old) { await old.update(compactSampleHour(old.value)); old = await old.continue(); }
  }
  await tx.done;
  lastPrunedHour = hour;
}

export async function loadLatest(): Promise<Snapshot | undefined> {
  const value = await (await getDB()).get('state', 'latest');
  return value && 'schemaVersion' in value ? value : undefined;
}

export async function readHistory(assetId: string, hours: number, now = Date.now()): Promise<HistoryPoint[]> {
  const start = now - hours * HOUR;
  const db = await getDB();
  const range = IDBKeyRange.bound([assetId, Math.floor(start / HOUR) * HOUR], [assetId, now]);
  const [records, sampleRecords] = await Promise.all([db.getAll('hours', range), db.getAll('samples', range)]);
  const points: HistoryPoint[] = [];
  for (const record of records) {
    for (let minute = 0; minute < 60; minute++) {
      const timestamp = record.hour + minute * 60_000;
      if (!record.present[minute] || timestamp < start || timestamp > now) continue;
      const finite = (n: number) => Number.isFinite(n) ? n : null;
      const oiUsd = record.complete[minute] ? finite(record.values[minute * 3]) : null;
      const marketCapUsd = record.validated?.[minute] && record.complete[minute] ? finite(record.values[minute * 3 + 1]) : null;
      const fdvUsd = record.validated?.[minute] && record.complete[minute] ? finite(record.values[minute * 3 + 2]) : null;
      points.push({ assetId, timestamp, oiUsd, marketCapUsd, fdvUsd,
        oiToFdv: oiUsd !== null && fdvUsd !== null && fdvUsd > 0 ? oiUsd / fdvUsd * 100 : null,
        oiToMarketCap: oiUsd !== null && marketCapUsd !== null && marketCapUsd > 0 ? oiUsd / marketCapUsd * 100 : null,
        complete: Boolean(record.complete[minute]), samplingIntervalMs: 60_000 });
    }
  }
  for (const record of sampleRecords) points.push(...unpackSamples(record).filter(point => point.timestamp >= start && point.timestamp <= now));
  return [...new Map(points.map(point => [point.timestamp, point])).values()].sort((a, b) => a.timestamp - b.timestamp);
}

/** A bounded warm start for 5m observation; old minute history is deliberately ineligible. */
export async function readRecentSamples(now = Date.now()): Promise<HistoryPoint[]> {
  const start = now - 10 * 60_000;
  const records = await (await getDB()).getAllFromIndex('samples', 'by-hour', IDBKeyRange.lowerBound(Math.floor(start / HOUR) * HOUR));
  return records.flatMap(unpackSamples).filter(point => point.timestamp >= start && point.timestamp <= now);
}

/** Read only the one or two raw-sample hours that can contain this comparison baseline. */
export async function readChangeBaselines(at: number): Promise<HistoryPoint[]> {
  if (!Number.isSafeInteger(at) || at <= 0) return [];
  const firstHour = Math.floor((at - BASELINE_TOLERANCE_MS) / HOUR) * HOUR;
  const lastHour = Math.floor(at / HOUR) * HOUR;
  const records = await (await getDB()).getAllFromIndex('samples', 'by-hour', IDBKeyRange.bound(firstHour, lastHour));
  return selectChangeBaselines(records.flatMap(unpackSamples), at);
}

export async function loadPushRegistration(): Promise<PushRegistration | undefined> {
  const value = await (await getDB()).get('state', 'push');
  return value && 'deleteToken' in value ? value : undefined;
}
export async function savePushRegistration(value?: PushRegistration): Promise<void> {
  const db = await getDB();
  if (value) await db.put('state', value, 'push'); else await db.delete('state', 'push');
}
