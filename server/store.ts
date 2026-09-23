import { COLLECTION_INTERVAL_MS, type AlertEvent, type AlertState, type HistoryPoint, type RawContractPoint, type Snapshot, type Thresholds } from '../src/shared/types';
import { toHistoryPoint } from '../src/shared/history';
import type { Database, SqlSession, SqlValue } from './database';

export interface StoredSubscription {
  id: string; endpointHash: string; tokenHash: string; subscription: PushSubscriptionJSON;
  thresholds: Thresholds; createdAt: number;
}
export interface PendingPush { id: string; subscriptionId: string; event: AlertEvent; attempts: number; }
export interface SubscriptionEvaluation { id: string; thresholds: Thresholds; states: Record<string, AlertState>; events: AlertEvent[]; }
const DAY = 86_400_000;
function encodeThresholds(t: Thresholds) {
  return JSON.stringify({ warning: t.warning, danger: t.danger, critical: t.critical, cooldownMinutes: t.cooldownMinutes });
}

export class MonitorStore {
  constructor(private db: Database) {}
  get kind() { return this.db.kind; }
  async ping() { await this.db.query('SELECT 1 AS ready'); }
  async initialize() {
    const statements = [
      'CREATE TABLE IF NOT EXISTS monitor_latest (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL, as_of BIGINT NOT NULL)',
      `CREATE TABLE IF NOT EXISTS monitor_history (asset_id TEXT NOT NULL, timestamp BIGINT NOT NULL,
        oi_usd DOUBLE PRECISION, market_cap_usd DOUBLE PRECISION, fdv_usd DOUBLE PRECISION,
        oi_to_fdv DOUBLE PRECISION, oi_to_market_cap DOUBLE PRECISION, complete INTEGER NOT NULL,
        PRIMARY KEY(asset_id,timestamp))`,
      'CREATE INDEX IF NOT EXISTS monitor_history_time ON monitor_history(timestamp)',
      `CREATE TABLE IF NOT EXISTS monitor_contract_history (symbol TEXT NOT NULL, available_at BIGINT NOT NULL,
        open_interest TEXT, mark_price TEXT, index_price TEXT, quote_usd TEXT, unit_multiplier DOUBLE PRECISION NOT NULL,
        oi_time BIGINT, price_time BIGINT, quote_time BIGINT, oi_observed_at BIGINT, price_observed_at BIGINT, quote_observed_at BIGINT,
        PRIMARY KEY(symbol,available_at))`,
      'CREATE INDEX IF NOT EXISTS monitor_contract_history_time ON monitor_contract_history(available_at)',
      'CREATE TABLE IF NOT EXISTS monitor_alerts (id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, timestamp BIGINT NOT NULL, payload TEXT NOT NULL)',
      'CREATE INDEX IF NOT EXISTS monitor_alerts_time ON monitor_alerts(timestamp)',
      'CREATE TABLE IF NOT EXISTS monitor_states (scope TEXT NOT NULL, asset_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(scope,asset_id))',
      `CREATE TABLE IF NOT EXISTS monitor_subscriptions (id TEXT PRIMARY KEY, endpoint_hash TEXT UNIQUE NOT NULL,
        token_hash TEXT NOT NULL, payload TEXT NOT NULL, thresholds TEXT NOT NULL, created_at BIGINT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS monitor_push_outbox (id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL
        REFERENCES monitor_subscriptions(id) ON DELETE CASCADE, payload TEXT NOT NULL, attempts INTEGER NOT NULL,
        next_attempt BIGINT NOT NULL, expires_at BIGINT NOT NULL)`,
      'CREATE INDEX IF NOT EXISTS monitor_outbox_due ON monitor_push_outbox(next_attempt)',
      `CREATE TABLE IF NOT EXISTS monitor_lease (id TEXT PRIMARY KEY, owner TEXT NOT NULL,
        expires_at BIGINT NOT NULL, last_completed_slot BIGINT NOT NULL)`,
    ];
    await this.db.transaction(async session => {
      for (const sql of statements) await session.query(sql);
      // Additive migration: preserve existing minute rows and their unknown availability/quantity.
      const additions: Record<string, Record<string, string>> = {
        monitor_history: { validated: 'INTEGER NOT NULL DEFAULT 0', available_at: 'BIGINT', oi_quantity: 'DOUBLE PRECISION',
          price_usd: 'DOUBLE PRECISION', oi_source_time: 'BIGINT', price_source_time: 'BIGINT', sampling_interval_ms: 'BIGINT',
          contract_set_key: 'TEXT', source_skew_ms: 'BIGINT' },
        monitor_lease: { last_completed_at: 'BIGINT NOT NULL DEFAULT 0' },
      };
      for (const [table, fields] of Object.entries(additions)) {
        const columns = this.db.kind === 'sqlite' ? (await session.query(`PRAGMA table_info(${table})`)).rows : [];
        for (const [name, definition] of Object.entries(fields)) {
          if (this.db.kind === 'postgresql') await session.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${name} ${definition}`);
          else if (!columns.some(column => column.name === name)) await session.query(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
        }
      }
      // Keep the old minute counter usable for a rollback; the new collector uses epoch boundaries.
      await session.query("UPDATE monitor_lease SET last_completed_at=last_completed_slot*60000 WHERE id='collector' AND last_completed_at=0 AND last_completed_slot>=0");
    });
  }
  async latest(): Promise<Snapshot | null> {
    const result = await this.db.query('SELECT payload FROM monitor_latest WHERE id=1');
    return result.rows[0] ? JSON.parse(String(result.rows[0].payload)) : null;
  }
  async states(scope = 'global'): Promise<Record<string, AlertState>> {
    const result = await this.db.query('SELECT asset_id,payload FROM monitor_states WHERE scope=$1', [scope]);
    return Object.fromEntries(result.rows.map(row => [String(row.asset_id), JSON.parse(String(row.payload))]));
  }
  private async saveStates(session: SqlSession, scope: string, states: Record<string, AlertState>) {
    await session.query('DELETE FROM monitor_states WHERE scope=$1', [scope]);
    const entries = Object.entries(states);
    if (!entries.length) return;
    const values: SqlValue[] = [];
    const rows = entries.map(([id, state]) => {
      const first = values.length + 1;
      values.push(scope, id, JSON.stringify(state));
      return `($${first},$${first + 1},$${first + 2})`;
    });
    await session.query(`INSERT INTO monitor_states(scope,asset_id,payload) VALUES ${rows.join(',')}`, values);
  }
  async commitCollection(snapshot: Snapshot, states: Record<string, AlertState>, events: AlertEvent[], subscriptions: SubscriptionEvaluation[] = []) {
    await this.db.transaction(async session => {
      await session.query(`INSERT INTO monitor_latest(id,payload,as_of) VALUES(1,$1,$2)
        ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,as_of=excluded.as_of`, [JSON.stringify(snapshot), snapshot.asOf]);
      // Chunking keeps both PostgreSQL and SQLite below their parameter limits.
      for (let offset = 0; offset < snapshot.assets.length; offset += 200) {
        const values: SqlValue[] = [];
        const rows = snapshot.assets.slice(offset, offset + 200).map(asset => {
          const first = values.length + 1;
          const point = toHistoryPoint(asset, snapshot);
          values.push(point.assetId, point.timestamp, point.oiUsd, point.marketCapUsd, point.fdvUsd, point.oiToFdv, point.oiToMarketCap, point.complete ? 1 : 0, 1,
            point.availableAt ?? null, point.oiQuantity ?? null, point.priceUsd ?? null, point.oiSourceTime ?? null, point.priceSourceTime ?? null,
            point.samplingIntervalMs ?? null, point.contractSetKey ?? null, point.sourceSkewMs ?? null);
          return `(${Array.from({ length: 17 }, (_, i) => `$${first + i}`).join(',')})`;
        });
        await session.query(`INSERT INTO monitor_history(asset_id,timestamp,oi_usd,market_cap_usd,fdv_usd,oi_to_fdv,oi_to_market_cap,complete,validated,
          available_at,oi_quantity,price_usd,oi_source_time,price_source_time,sampling_interval_ms,contract_set_key,source_skew_ms)
          VALUES ${rows.join(',')} ON CONFLICT(asset_id,timestamp) DO UPDATE SET
          oi_usd=excluded.oi_usd,market_cap_usd=excluded.market_cap_usd,fdv_usd=excluded.fdv_usd,
          oi_to_fdv=excluded.oi_to_fdv,oi_to_market_cap=excluded.oi_to_market_cap,complete=excluded.complete,validated=excluded.validated,
          available_at=excluded.available_at,oi_quantity=excluded.oi_quantity,price_usd=excluded.price_usd,oi_source_time=excluded.oi_source_time,
          price_source_time=excluded.price_source_time,sampling_interval_ms=excluded.sampling_interval_ms,contract_set_key=excluded.contract_set_key,source_skew_ms=excluded.source_skew_ms`, values);
      }
      const contracts = snapshot.assets.flatMap(asset => asset.evidence.contracts);
      for (let offset = 0; offset < contracts.length; offset += 100) {
        const values: SqlValue[] = [];
        const rows = contracts.slice(offset, offset + 100).map(contract => {
          const first = values.length + 1;
          values.push(contract.symbol, snapshot.asOf, contract.openInterest, contract.markPrice, contract.indexPrice, contract.quoteUsd,
            contract.unitMultiplier ?? 1, contract.oiTime, contract.priceTime, contract.quoteTime ?? null,
            contract.oiObservedAt ?? null, contract.priceObservedAt ?? null, contract.quoteObservedAt ?? null);
          return `(${Array.from({ length: 13 }, (_, i) => `$${first + i}`).join(',')})`;
        });
        // Original decimal strings are retained; a repeated commit of the same sample is idempotent.
        await session.query(`INSERT INTO monitor_contract_history(symbol,available_at,open_interest,mark_price,index_price,quote_usd,
          unit_multiplier,oi_time,price_time,quote_time,oi_observed_at,price_observed_at,quote_observed_at) VALUES ${rows.join(',')}
          ON CONFLICT(symbol,available_at) DO NOTHING`, values);
      }
      await this.saveStates(session, 'global', states);
      for (const event of events) await session.query(`INSERT INTO monitor_alerts(id,asset_id,timestamp,payload)
        VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`, [event.id, event.assetId, event.timestamp, JSON.stringify(event)]);
      for (const subscription of subscriptions) {
        // A subscription may be removed while its collection is in flight.
        const exists = await session.query('SELECT id,thresholds FROM monitor_subscriptions WHERE id=$1', [subscription.id]);
        if (!exists.count || encodeThresholds(JSON.parse(String(exists.rows[0].thresholds))) !== encodeThresholds(subscription.thresholds)) continue;
        await this.saveStates(session, subscription.id, subscription.states);
        for (const event of subscription.events) await session.query(`INSERT INTO monitor_push_outbox
          (id,subscription_id,payload,attempts,next_attempt,expires_at) VALUES($1,$2,$3,0,$4,$5) ON CONFLICT(id) DO NOTHING`,
        [`${subscription.id}:${event.id}`, subscription.id, JSON.stringify(event), snapshot.asOf, snapshot.asOf + 600_000]);
      }
    });
  }
  async history(assetId: string, hours: number, now = Date.now()): Promise<HistoryPoint[]> {
    const result = await this.db.query(`SELECT * FROM monitor_history WHERE asset_id=$1 AND timestamp>=$2 AND timestamp<=$3
      ORDER BY timestamp ASC LIMIT 86401`, [assetId, now - hours * 3_600_000, now]);
    const numberOrNull = (value: unknown) => value === null ? null : Number(value);
    return result.rows.map(row => ({ assetId: String(row.asset_id), timestamp: Number(row.timestamp),
      oiUsd: Number(row.complete) === 1 ? numberOrNull(row.oi_usd) : null,
      marketCapUsd: Number(row.complete) === 1 && Number(row.validated) === 1 ? numberOrNull(row.market_cap_usd) : null,
      fdvUsd: Number(row.complete) === 1 && Number(row.validated) === 1 ? numberOrNull(row.fdv_usd) : null,
      oiToFdv: Number(row.complete) === 1 && Number(row.validated) === 1 ? numberOrNull(row.oi_to_fdv) : null,
      oiToMarketCap: Number(row.complete) === 1 && Number(row.validated) === 1 ? numberOrNull(row.oi_to_market_cap) : null, complete: Number(row.complete) === 1,
      ...(row.available_at == null ? {} : { availableAt: Number(row.available_at),
        oiQuantity: Number(row.complete) === 1 ? numberOrNull(row.oi_quantity) : null,
        priceUsd: Number(row.complete) === 1 ? numberOrNull(row.price_usd) : null,
        oiSourceTime: numberOrNull(row.oi_source_time), priceSourceTime: numberOrNull(row.price_source_time),
        ...(row.sampling_interval_ms == null ? {} : { samplingIntervalMs: Number(row.sampling_interval_ms) }),
        ...(row.contract_set_key == null ? {} : { contractSetKey: String(row.contract_set_key) }), sourceSkewMs: numberOrNull(row.source_skew_ms) }) }));
  }
  async contractHistory(symbol: string, hours: number, now = Date.now()): Promise<RawContractPoint[]> {
    const result = await this.db.query(`SELECT * FROM monitor_contract_history WHERE symbol=$1 AND available_at>=$2 AND available_at<=$3
      ORDER BY available_at ASC LIMIT 20161`, [symbol, now - Math.min(168, Math.max(1, hours)) * 3_600_000, now]);
    const numberOrNull = (value: unknown) => value == null ? null : Number(value);
    const stringOrNull = (value: unknown) => value == null ? null : String(value);
    return result.rows.map(row => ({ symbol: String(row.symbol), availableAt: Number(row.available_at),
      openInterest: stringOrNull(row.open_interest), markPrice: stringOrNull(row.mark_price), indexPrice: stringOrNull(row.index_price),
      quoteUsd: stringOrNull(row.quote_usd), unitMultiplier: Number(row.unit_multiplier), oiTime: numberOrNull(row.oi_time),
      priceTime: numberOrNull(row.price_time), quoteTime: numberOrNull(row.quote_time), oiObservedAt: numberOrNull(row.oi_observed_at),
      priceObservedAt: numberOrNull(row.price_observed_at), quoteObservedAt: numberOrNull(row.quote_observed_at) }));
  }
  async alerts(limit = 100): Promise<AlertEvent[]> {
    const result = await this.db.query('SELECT payload FROM monitor_alerts ORDER BY timestamp DESC,id ASC LIMIT $1', [limit]);
    return result.rows.map(row => JSON.parse(String(row.payload)));
  }
  private decodeSubscription(row: Record<string, unknown>): StoredSubscription {
    return { id: String(row.id), endpointHash: String(row.endpoint_hash), tokenHash: String(row.token_hash),
      subscription: JSON.parse(String(row.payload)), thresholds: JSON.parse(String(row.thresholds)), createdAt: Number(row.created_at) };
  }
  async subscriptions(): Promise<StoredSubscription[]> {
    const result = await this.db.query('SELECT * FROM monitor_subscriptions ORDER BY created_at ASC');
    return result.rows.map(row => this.decodeSubscription(row));
  }
  async subscription(id: string): Promise<StoredSubscription | null> {
    const result = await this.db.query('SELECT * FROM monitor_subscriptions WHERE id=$1', [id]);
    return result.rows[0] ? this.decodeSubscription(result.rows[0]) : null;
  }
  async subscriptionByEndpoint(hash: string): Promise<StoredSubscription | null> {
    const result = await this.db.query('SELECT * FROM monitor_subscriptions WHERE endpoint_hash=$1', [hash]);
    return result.rows[0] ? this.decodeSubscription(result.rows[0]) : null;
  }
  async saveSubscription(subscription: StoredSubscription, maximum = 1000): Promise<boolean> {
    return this.db.transaction(async session => {
      // Lock a shared row in PostgreSQL; SQLite already has a write transaction.
      await session.query(`INSERT INTO monitor_lease(id,owner,expires_at,last_completed_slot) VALUES('subscriptions','',0,-1) ON CONFLICT(id) DO NOTHING`);
      await session.query("UPDATE monitor_lease SET expires_at=expires_at WHERE id='subscriptions'");
      const existing = await session.query('SELECT id,thresholds FROM monitor_subscriptions WHERE id=$1', [subscription.id]);
      const total = await session.query('SELECT COUNT(*) AS count FROM monitor_subscriptions');
      if (!existing.count && Number(total.rows[0].count) >= maximum) return false;
      await session.query(`INSERT INTO monitor_subscriptions(id,endpoint_hash,token_hash,payload,thresholds,created_at) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,thresholds=excluded.thresholds`,
      [subscription.id, subscription.endpointHash, subscription.tokenHash, JSON.stringify(subscription.subscription), encodeThresholds(subscription.thresholds), subscription.createdAt]);
      if (existing.count && encodeThresholds(JSON.parse(String(existing.rows[0].thresholds))) !== encodeThresholds(subscription.thresholds)) {
        await session.query('DELETE FROM monitor_states WHERE scope=$1', [subscription.id]);
        await session.query('DELETE FROM monitor_push_outbox WHERE subscription_id=$1', [subscription.id]);
      }
      return true;
    });
  }
  async deleteSubscription(id: string) {
    await this.db.transaction(async session => {
      await session.query('DELETE FROM monitor_subscriptions WHERE id=$1', [id]);
      await session.query('DELETE FROM monitor_states WHERE scope=$1', [id]);
    });
  }
  async pendingPush(now = Date.now(), limit = 100): Promise<PendingPush[]> {
    const result = await this.db.query(`SELECT id,subscription_id,payload,attempts FROM monitor_push_outbox
      WHERE next_attempt<=$1 AND expires_at>$2 ORDER BY next_attempt ASC LIMIT $3`, [now, now, limit]);
    return result.rows.map(row => ({ id: String(row.id), subscriptionId: String(row.subscription_id), event: JSON.parse(String(row.payload)), attempts: Number(row.attempts) }));
  }
  async delivered(id: string) { await this.db.query('DELETE FROM monitor_push_outbox WHERE id=$1', [id]); }
  async retryPush(id: string, attempts: number, now = Date.now()) {
    if (attempts >= 5) { await this.delivered(id); return; }
    await this.db.query('UPDATE monitor_push_outbox SET attempts=$1,next_attempt=$2 WHERE id=$3', [attempts, now + Math.min(300_000, 15_000 * 2 ** attempts), id]);
  }
  async acquireLease(owner: string, now = Date.now()): Promise<boolean> {
    const slot = Math.floor(now / COLLECTION_INTERVAL_MS) * COLLECTION_INTERVAL_MS;
    const result = await this.db.query(`INSERT INTO monitor_lease(id,owner,expires_at,last_completed_slot) VALUES('collector',$1,$2,-1)
      ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
      WHERE monitor_lease.expires_at<=$3 AND monitor_lease.last_completed_at<$4 RETURNING owner`, [owner, now + 120_000, now, slot]);
    return result.count === 1;
  }
  async renewLease(owner: string, now = Date.now()): Promise<boolean> {
    const result = await this.db.query("UPDATE monitor_lease SET expires_at=$1 WHERE id='collector' AND owner=$2 RETURNING owner", [now + 120_000, owner]);
    return result.count === 1;
  }
  async releaseLease(owner: string, completedAt: number | null) {
    await this.db.query(`UPDATE monitor_lease SET owner='',expires_at=0,last_completed_at=COALESCE($1,last_completed_at),
      last_completed_slot=COALESCE($2,last_completed_slot) WHERE id='collector' AND owner=$3`,
    [completedAt, completedAt === null ? null : Math.floor(completedAt / 60_000), owner]);
  }
  async acquirePushLease(owner: string, now = Date.now()): Promise<boolean> {
    const result = await this.db.query(`INSERT INTO monitor_lease(id,owner,expires_at,last_completed_slot) VALUES('push',$1,$2,-1)
      ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
      WHERE monitor_lease.expires_at<=$3 RETURNING owner`, [owner, now + 60_000, now]);
    return result.count === 1;
  }
  async releasePushLease(owner: string) {
    await this.db.query("UPDATE monitor_lease SET owner='',expires_at=0 WHERE id='push' AND owner=$1", [owner]);
  }
  async cleanup(now = Date.now()) {
    await this.db.transaction(async session => {
      await session.query('DELETE FROM monitor_history WHERE timestamp<$1', [now - 30 * DAY]);
      await session.query('DELETE FROM monitor_contract_history WHERE available_at<$1', [now - 7 * DAY]);
      await session.query('DELETE FROM monitor_alerts WHERE timestamp<$1', [now - 30 * DAY]);
      await session.query('DELETE FROM monitor_push_outbox WHERE expires_at<=$1', [now]);
    });
  }
  close() { return this.db.close(); }
}
