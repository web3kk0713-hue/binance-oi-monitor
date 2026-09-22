import { createCollector } from '../src/data/collector';
import { buildApp } from './app';
import { loadConfig } from './config';
import { PostgresDatabase, SqliteDatabase } from './database';
import { MonitorStore } from './store';

async function main() {
  const config = loadConfig();
  const store = new MonitorStore(config.databaseUrl ? new PostgresDatabase(config.databaseUrl) : new SqliteDatabase(config.sqlitePath));
  await store.initialize();
  const initialSnapshot = await store.latest() ?? undefined;
  const { app } = await buildApp({ store, config, logger: true,
    collector: createCollector({ mode: 'server', concurrency: 8, cmcApiKey: config.cmcApiKey, initialSnapshot }) });
  const shutdown = async () => { await app.close(); };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  await app.listen({ host: config.host, port: config.port });
}
main().catch(() => {
  // Printing original startup errors could expose database URLs or VAPID keys.
  process.stderr.write('后台启动失败：请检查数据库连接、端口和环境变量配置。\n');
  process.exitCode = 1;
});
