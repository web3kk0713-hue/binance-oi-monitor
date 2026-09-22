import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Pool, type PoolClient } from 'pg';

export type SqlValue = string | number | null;
export interface SqlResult { rows: Record<string, unknown>[]; count: number; }
export interface SqlSession { query(sql: string, values?: SqlValue[]): Promise<SqlResult>; }
export interface Database extends SqlSession {
  readonly kind: 'postgresql' | 'sqlite';
  transaction<T>(work: (session: SqlSession) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

class PostgresSession implements SqlSession {
  constructor(private connection: Pool | PoolClient) {}
  async query(sql: string, values: SqlValue[] = []): Promise<SqlResult> {
    const result = await this.connection.query(sql, values);
    return { rows: result.rows, count: result.rowCount ?? 0 };
  }
}

export class PostgresDatabase implements Database {
  readonly kind = 'postgresql' as const;
  private pool: Pool;
  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 6, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000,
      statement_timeout: 20_000, application_name: 'binance-oi-monitor' });
    // Never log connection strings or driver error objects, which can include credentials.
    this.pool.on('error', () => {});
  }
  query(sql: string, values?: SqlValue[]) { return new PostgresSession(this.pool).query(sql, values); }
  async transaction<T>(work: (session: SqlSession) => Promise<T>): Promise<T> {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const result = await work(new PostgresSession(connection));
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { connection.release(); }
  }
  async close() { await this.pool.end(); }
}

/** The queue also protects a transaction from interleaving with HTTP requests. */
export class SqliteDatabase implements Database {
  readonly kind = 'sqlite' as const;
  private db: DatabaseSync;
  private tail: Promise<void> = Promise.resolve();
  private session: SqlSession;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.session = { query: async (sql, values = []) => {
      const ordered: SqlValue[] = [];
      const statement = this.db.prepare(sql.replace(/\$(\d+)/g, (_, index: string) => {
        ordered.push(values[Number(index) - 1]);
        return '?';
      }));
      if (/^\s*(SELECT|PRAGMA)/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
        const rows = statement.all(...ordered) as Record<string, unknown>[];
        return { rows, count: rows.length };
      }
      const result = statement.run(...ordered);
      return { rows: [], count: Number(result.changes) };
    } };
  }
  private async locked<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolveQueue => { release = resolveQueue; });
    await previous;
    try { return await work(); } finally { release(); }
  }
  query(sql: string, values?: SqlValue[]) { return this.locked(() => this.session.query(sql, values)); }
  transaction<T>(work: (session: SqlSession) => Promise<T>): Promise<T> {
    return this.locked(async () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = await work(this.session);
        this.db.exec('COMMIT');
        return result;
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    });
  }
  async close() { await this.locked(async () => { this.db.close(); }); }
}
