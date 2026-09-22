import { openDB, type DBSchema } from 'idb';
import { toHistoryPoint } from '../shared/history';
import { validThresholds } from '../shared/alerts';
import { DEFAULT_THRESHOLDS, type AlertEvent, type AlertState, type HistoryPoint, type Snapshot, type Thresholds } from '../shared/types';

export interface Settings {
  mode: 'direct' | 'server'; backendUrl: string; thresholds: Thresholds;
  notifications: boolean; favorites: string[];
}
export const DEFAULT_SETTINGS: Settings = { mode: 'direct', backendUrl: '', thresholds: DEFAULT_THRESHOLDS, notifications: false, favorites: [] };
export const HOUR = 3_600_000;
const RETENTION = 30 * 24 * HOUR;
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
  state: { key: string; value: Snapshot | PushRegistration };
}
let database: ReturnType<typeof openDB<MonitorDB>> | undefined;
function getDB() {
  return database ??= openDB<MonitorDB>('binance-oi-monitor-v1', 1, {
    upgrade(db) { const store = db.createObjectStore('hours', { keyPath: ['assetId', 'hour'] }); store.createIndex('by-hour', 'hour'); db.createObjectStore('state'); },
  });
}
let lastPrunedHour = 0;

/** Bounded hourly binary blocks keep 30-day history much smaller than per-point objects. */
export async function saveSnapshot(snapshot: Snapshot): Promise<void> {
  const db = await getDB();
  const minuteAt = Math.floor(snapshot.startedAt / 60_000) * 60_000;
  const hour = Math.floor(minuteAt / HOUR) * HOUR;
  const minute = (minuteAt - hour) / 60_000;
  const tx = db.transaction(['hours', 'state'], 'readwrite');
  const records = tx.objectStore('hours');
  await Promise.all(snapshot.assets.map(async (asset) => {
    const record = await records.get([asset.id, hour]) ?? { assetId: asset.id, hour, values: new Float64Array(180).fill(NaN), present: new Uint8Array(60), complete: new Uint8Array(60) };
    const point = toHistoryPoint(asset, snapshot);
    record.validated ??= new Uint8Array(60);
    record.values[minute * 3] = point.oiUsd ?? NaN;
    record.values[minute * 3 + 1] = point.marketCapUsd ?? NaN;
    record.values[minute * 3 + 2] = point.fdvUsd ?? NaN;
    record.present[minute] = 1; record.complete[minute] = Number(point.complete);
    record.validated[minute] = 1;
    await records.put(record);
  }));
  await tx.objectStore('state').put(snapshot, 'latest');
  if (hour !== lastPrunedHour) {
    let cursor = await records.index('by-hour').openCursor(IDBKeyRange.upperBound(hour - RETENTION, true));
    while (cursor) { await cursor.delete(); cursor = await cursor.continue(); }
    lastPrunedHour = hour;
  }
  await tx.done;
}

export async function loadLatest(): Promise<Snapshot | undefined> {
  const value = await (await getDB()).get('state', 'latest');
  return value && 'schemaVersion' in value ? value : undefined;
}

export async function readHistory(assetId: string, hours: number, now = Date.now()): Promise<HistoryPoint[]> {
  const start = Math.floor(now / 60_000) * 60_000 - hours * HOUR;
  const records = await (await getDB()).getAll('hours', IDBKeyRange.bound([assetId, Math.floor(start / HOUR) * HOUR], [assetId, now]));
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
        complete: Boolean(record.complete[minute]) });
    }
  }
  return points.sort((a, b) => a.timestamp - b.timestamp);
}

export async function loadPushRegistration(): Promise<PushRegistration | undefined> {
  const value = await (await getDB()).get('state', 'push');
  return value && 'deleteToken' in value ? value : undefined;
}
export async function savePushRegistration(value?: PushRegistration): Promise<void> {
  const db = await getDB();
  if (value) await db.put('state', value, 'push'); else await db.delete('state', 'push');
}
