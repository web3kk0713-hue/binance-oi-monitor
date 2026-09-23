import type { FlowCandle, FlowDepth, FlowEvent, FlowHistory, FlowMarket, FlowOi, FlowOutcome, FlowSnapshot, FlowUpdate } from '../src/shared/flowTypes';
import type { Database, SqlSession, SqlValue } from './database';

export const FLOW_RETENTION_MS = 7 * 86_400_000;
export const FLOW_LEASE_MS = 45_000;
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const integerTime = (value: number) => Number.isSafeInteger(value) && value >= 0;
const finite = (value: number) => Number.isFinite(value);

/** Public observations only. This module creates no tables used by the original OI monitor. */
export class FlowStore {
  constructor(private db: Database) {}

  async initialize() {
    const statements = [
      'CREATE TABLE IF NOT EXISTS flow_markets (market_key TEXT PRIMARY KEY, updated_at BIGINT NOT NULL, payload TEXT NOT NULL)',
      `CREATE TABLE IF NOT EXISTS flow_candles (market_key TEXT NOT NULL, open_time BIGINT NOT NULL, source_time BIGINT NOT NULL,
        received_at BIGINT NOT NULL, closed INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(market_key,open_time))`,
      'CREATE INDEX IF NOT EXISTS flow_candles_time ON flow_candles(open_time)',
      `CREATE TABLE IF NOT EXISTS flow_events (id TEXT PRIMARY KEY, market_key TEXT NOT NULL, event_time BIGINT NOT NULL,
        detected_at BIGINT NOT NULL, payload TEXT NOT NULL)`,
      'CREATE INDEX IF NOT EXISTS flow_events_market_time ON flow_events(market_key,detected_at)',
      'CREATE INDEX IF NOT EXISTS flow_events_time ON flow_events(detected_at)',
      `CREATE TABLE IF NOT EXISTS flow_outcomes (event_id TEXT NOT NULL REFERENCES flow_events(id) ON DELETE CASCADE,
        minutes INTEGER NOT NULL, available_at BIGINT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(event_id,minutes))`,
      `CREATE TABLE IF NOT EXISTS flow_depth (market_key TEXT NOT NULL, source_time BIGINT NOT NULL, received_at BIGINT NOT NULL,
        payload TEXT NOT NULL, PRIMARY KEY(market_key,source_time))`,
      'CREATE INDEX IF NOT EXISTS flow_depth_time ON flow_depth(source_time)',
      `CREATE TABLE IF NOT EXISTS flow_oi (market_key TEXT NOT NULL, source_time BIGINT NOT NULL, received_at BIGINT NOT NULL,
        payload TEXT NOT NULL, PRIMARY KEY(market_key,source_time))`,
      'CREATE INDEX IF NOT EXISTS flow_oi_time ON flow_oi(source_time)',
      'CREATE TABLE IF NOT EXISTS flow_latest (id INTEGER PRIMARY KEY CHECK(id=1), as_of BIGINT NOT NULL, payload TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS flow_leases (id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at BIGINT NOT NULL)',
    ];
    await this.db.transaction(async session => { for (const sql of statements) await session.query(sql); });
  }

  async acquireLease(owner: string, now = Date.now()): Promise<boolean> {
    const result = await this.db.query(`INSERT INTO flow_leases(id,owner,expires_at) VALUES('feed',$1,$2)
      ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
      WHERE flow_leases.expires_at<=$3 RETURNING owner`, [owner, now + FLOW_LEASE_MS, now]);
    return result.count === 1;
  }
  async renewLease(owner: string, now = Date.now()): Promise<boolean> {
    const result = await this.db.query("UPDATE flow_leases SET expires_at=$1 WHERE id='feed' AND owner=$2 AND expires_at>$3 RETURNING owner",
      [now + FLOW_LEASE_MS, owner, now]);
    return result.count === 1;
  }
  async releaseLease(owner: string) {
    await this.db.query("UPDATE flow_leases SET owner='',expires_at=0 WHERE id='feed' AND owner=$1", [owner]);
  }
  private async owned(session: SqlSession, owner: string | undefined, now: number): Promise<boolean> {
    if (owner === undefined) return true; // Explicit store tests/imports, never used by the live runtime.
    // Locks the lease in PostgreSQL; an expired or replaced worker cannot write stale updates.
    return (await session.query("UPDATE flow_leases SET expires_at=expires_at WHERE id='feed' AND owner=$1 AND expires_at>$2 RETURNING owner", [owner, now])).count === 1;
  }

  async saveSnapshot(snapshot: FlowSnapshot, owner?: string, now = Date.now()): Promise<boolean> {
    if (!integerTime(snapshot.status.asOf)) throw new Error('Invalid flow snapshot time');
    return this.db.transaction(async session => {
      if (!await this.owned(session, owner, now)) return false;
      await session.query(`INSERT INTO flow_latest(id,as_of,payload) VALUES(1,$1,$2)
        ON CONFLICT(id) DO UPDATE SET as_of=excluded.as_of,payload=excluded.payload WHERE excluded.as_of>=flow_latest.as_of`,
      [snapshot.status.asOf, JSON.stringify(snapshot)]);
      const markets = [...new Map(snapshot.rows.map(row => [row.market.key, row.market])).values()];
      for (let offset = 0; offset < markets.length; offset += 200) {
        const values: SqlValue[] = [];
        const rows = markets.slice(offset, offset + 200).map(market => {
          const first = values.length + 1; values.push(market.key, snapshot.status.asOf, JSON.stringify(market));
          return `($${first},$${first + 1},$${first + 2})`;
        });
        await session.query(`INSERT INTO flow_markets(market_key,updated_at,payload) VALUES ${rows.join(',')}
          ON CONFLICT(market_key) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload
          WHERE excluded.updated_at>=flow_markets.updated_at`, values);
      }
      return true;
    });
  }
  async latest(): Promise<FlowSnapshot | null> {
    const row = (await this.db.query('SELECT payload FROM flow_latest WHERE id=1')).rows[0];
    return row ? parse<FlowSnapshot>(row.payload) : null;
  }

  async writeUpdate(update: FlowUpdate, owner?: string, now = Date.now()): Promise<boolean> {
    return this.db.transaction(async session => {
      if (!await this.owned(session, owner, now)) return false;
      const candles = new Map<string, FlowCandle>();
      for (const candle of update.candles) {
        if (!candle.marketKey || !integerTime(candle.openTime) || !integerTime(candle.receivedAt) || !integerTime(candle.sourceTime)) throw new Error('Invalid flow candle');
        const key = `${candle.marketKey}:${candle.openTime}`; const old = candles.get(key);
        if (!old || candle.receivedAt >= old.receivedAt && (!old.closed || candle.closed)) candles.set(key, candle);
      }
      const candleRows = [...candles.values()];
      for (let offset = 0; offset < candleRows.length; offset += 100) {
        const values: SqlValue[] = [];
        const rows = candleRows.slice(offset, offset + 100).map(candle => {
          const first = values.length + 1;
          values.push(candle.marketKey, candle.openTime, candle.sourceTime, candle.receivedAt, candle.closed ? 1 : 0, JSON.stringify(candle));
          return `(${Array.from({ length: 6 }, (_, index) => `$${first + index}`).join(',')})`;
        });
        await session.query(`INSERT INTO flow_candles(market_key,open_time,source_time,received_at,closed,payload) VALUES ${rows.join(',')}
          ON CONFLICT(market_key,open_time) DO UPDATE SET source_time=excluded.source_time,received_at=excluded.received_at,closed=excluded.closed,payload=excluded.payload
          WHERE flow_candles.closed=0 AND excluded.received_at>=flow_candles.received_at`, values);
      }
      for (const event of update.events) {
        if (!event.id || !event.marketKey || !integerTime(event.timestamp) || !integerTime(event.detectedAt)
          || !finite(event.referencePrice) || event.referencePrice <= 0) throw new Error('Invalid flow event');
        // Event evidence is immutable, including the exact public aggregate-trade decimal strings.
        await session.query(`INSERT INTO flow_events(id,market_key,event_time,detected_at,payload) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(id) DO NOTHING`, [event.id, event.marketKey, event.timestamp, event.detectedAt, JSON.stringify({ ...event, outcomes: [] })]);
        const original = parse<FlowEvent>((await session.query('SELECT payload FROM flow_events WHERE id=$1', [event.id])).rows[0].payload);
        if (original.marketKey !== event.marketKey || original.detectedAt !== event.detectedAt || original.referencePrice !== event.referencePrice) continue;
        for (const outcome of event.outcomes) {
          if (![1, 5, 15].includes(outcome.minutes) || !integerTime(outcome.availableAt) || outcome.availableAt < original.detectedAt
            || !finite(outcome.price) || outcome.price <= 0 || !finite(outcome.changePct)) throw new Error('Invalid flow outcome');
          await session.query(`INSERT INTO flow_outcomes(event_id,minutes,available_at,payload) VALUES($1,$2,$3,$4)
            ON CONFLICT(event_id,minutes) DO NOTHING`, [event.id, outcome.minutes, outcome.availableAt, JSON.stringify(outcome)]);
        }
      }
      await this.insertObserved(session, 'flow_depth', update.depth);
      await this.insertObserved(session, 'flow_oi', update.oi);
      return true;
    });
  }
  private async insertObserved(session: SqlSession, table: 'flow_depth' | 'flow_oi', input: Array<FlowDepth | FlowOi>) {
    const rowsByKey = new Map<string, FlowDepth | FlowOi>();
    for (const observation of input) {
      if (!observation.marketKey || !integerTime(observation.timestamp) || !integerTime(observation.receivedAt)) throw new Error('Invalid flow observation');
      const key = `${observation.marketKey}:${observation.timestamp}`;
      const old = rowsByKey.get(key);
      if (!old || observation.receivedAt < old.receivedAt) rowsByKey.set(key, observation);
    }
    const observations = [...rowsByKey.values()];
    for (let offset = 0; offset < observations.length; offset += 150) {
      const values: SqlValue[] = [];
      const rows = observations.slice(offset, offset + 150).map(observation => {
        const first = values.length + 1;
        values.push(observation.marketKey, observation.timestamp, observation.receivedAt, JSON.stringify(observation));
        return `($${first},$${first + 1},$${first + 2},$${first + 3})`;
      });
      await session.query(`INSERT INTO ${table}(market_key,source_time,received_at,payload) VALUES ${rows.join(',')}
        ON CONFLICT(market_key,source_time) DO NOTHING`, values);
    }
  }

  private async addOutcomes(events: FlowEvent[], to: number): Promise<FlowEvent[]> {
    const byEvent = new Map<string, FlowOutcome[]>();
    for (let offset = 0; offset < events.length; offset += 200) {
      const ids = events.slice(offset, offset + 200).map(event => event.id);
      const rows = await this.db.query(`SELECT event_id,payload FROM flow_outcomes WHERE event_id IN (${ids.map((_, index) => `$${index + 1}`).join(',')})
        AND available_at<=$${ids.length + 1} ORDER BY minutes ASC`, [...ids, to]);
      for (const row of rows.rows) {
        const id = String(row.event_id); const list = byEvent.get(id) ?? [];
        list.push(parse<FlowOutcome>(row.payload)); byEvent.set(id, list);
      }
    }
    return events.map(event => ({ ...event, outcomes: byEvent.get(event.id) ?? [] }));
  }
  async events(marketKey?: string, limit = 100, before = Date.now() + 1, from = before - FLOW_RETENTION_MS, asOf = before - 1): Promise<FlowEvent[]> {
    const values: SqlValue[] = [before, from, Math.min(500, Math.max(1, Math.floor(limit)))];
    if (marketKey) values.push(marketKey);
    const result = await this.db.query(`SELECT payload FROM flow_events WHERE detected_at<$1 AND detected_at>=$2
      ${marketKey ? 'AND market_key=$4' : ''} ORDER BY detected_at DESC,id ASC LIMIT $3`, values);
    // A pagination cursor is not a replay clock: the API passes its current observation time separately.
    return this.addOutcomes(result.rows.map(row => parse<FlowEvent>(row.payload)), asOf);
  }
  async history(marketKey: string, hours = 24, to = Date.now()): Promise<FlowHistory> {
    const from = to - Math.round(Math.min(168, Math.max(1 / 60, hours)) * 3_600_000);
    const marketRow = (await this.db.query('SELECT payload FROM flow_markets WHERE market_key=$1', [marketKey])).rows[0];
    const [candles, eventRows, depth, oi] = await Promise.all([
      this.db.query(`SELECT payload FROM flow_candles WHERE market_key=$1 AND open_time>=$2 AND open_time<=$3
        AND source_time<=$3 AND received_at<=$3 ORDER BY open_time ASC LIMIT 10081`, [marketKey, from, to]),
      this.db.query(`SELECT payload FROM flow_events WHERE market_key=$1 AND detected_at>=$2 AND detected_at<=$3
        ORDER BY detected_at DESC,id ASC LIMIT 5000`, [marketKey, from, to]),
      // Keep seven days of minute evidence bounded without fabricating minute timestamps or clipping to the latest day.
      this.db.query(`SELECT payload FROM (SELECT payload,source_time,ROW_NUMBER() OVER
        (PARTITION BY CAST(source_time/60000 AS BIGINT) ORDER BY source_time DESC) AS ordinal FROM flow_depth
        WHERE market_key=$1 AND source_time>=$2 AND source_time<=$3 AND received_at<=$3) AS minutes
        WHERE ordinal=1 ORDER BY source_time ASC LIMIT 10081`, [marketKey, from, to]),
      this.db.query(`SELECT payload FROM flow_oi WHERE market_key=$1 AND source_time>=$2 AND source_time<=$3
        AND received_at<=$3 ORDER BY source_time ASC LIMIT 20161`, [marketKey, from, to]),
    ]);
    return { market: marketRow ? parse<FlowMarket>(marketRow.payload) : null, from, to,
      candles: candles.rows.map(row => parse<FlowCandle>(row.payload)),
      events: await this.addOutcomes(eventRows.rows.map(row => parse<FlowEvent>(row.payload)), to),
      depth: depth.rows.map(row => parse<FlowDepth>(row.payload)), oi: oi.rows.map(row => parse<FlowOi>(row.payload)) };
  }
  async cleanup(now = Date.now()) {
    const cutoff = now - FLOW_RETENTION_MS;
    await this.db.transaction(async session => {
      await session.query('DELETE FROM flow_candles WHERE open_time<$1', [cutoff]);
      await session.query('DELETE FROM flow_events WHERE detected_at<$1', [cutoff]);
      await session.query('DELETE FROM flow_depth WHERE source_time<$1', [cutoff]);
      await session.query('DELETE FROM flow_oi WHERE source_time<$1', [cutoff]);
    });
  }
}
