import { COLLECTION_INTERVAL_MS } from '../src/shared/types';

export interface ServerConfig {
  host: string; port: number; allowedOrigins: string[];
  databaseUrl?: string; sqlitePath: string; cmcApiKey?: string;
  vapidPublicKey?: string; vapidPrivateKey?: string; vapidSubject?: string;
  notificationUrl: string; collectOnStart: boolean; collectionTimeoutMs: number;
  maxSubscriptions: number;
}

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const number = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error('Invalid server numeric configuration');
  return number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  for (const origin of allowedOrigins) {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) {
      throw new Error('ALLOWED_ORIGINS must contain exact origins without paths');
    }
  }
  const notificationUrl = env.NOTIFICATION_URL || allowedOrigins[0] || 'http://127.0.0.1:5178';
  const notificationTarget = new URL(notificationUrl);
  if (!allowedOrigins.includes(notificationTarget.origin) && allowedOrigins.length) {
    throw new Error('NOTIFICATION_URL must use an allowed frontend origin');
  }
  if (!['http:', 'https:'].includes(notificationTarget.protocol) || notificationTarget.username || notificationTarget.password) {
    throw new Error('Invalid NOTIFICATION_URL');
  }
  return {
    host: env.HOST || '127.0.0.1', port: integer(env.PORT, 8787, 1, 65535), allowedOrigins,
    databaseUrl: env.DATABASE_URL || undefined, sqlitePath: env.SQLITE_PATH || './data/monitor.sqlite',
    cmcApiKey: env.CMC_API_KEY || undefined,
    vapidPublicKey: env.VAPID_PUBLIC_KEY || undefined, vapidPrivateKey: env.VAPID_PRIVATE_KEY || undefined,
    vapidSubject: env.VAPID_SUBJECT || undefined, notificationUrl,
    collectOnStart: env.COLLECT_ON_START !== 'false',
    // Existing 55s configurations remain readable, but cannot extend a 30s round.
    collectionTimeoutMs: Math.min(COLLECTION_INTERVAL_MS - 1_000, integer(env.COLLECTION_TIMEOUT_MS, 29_000, 1000, 110_000)),
    maxSubscriptions: integer(env.MAX_SUBSCRIPTIONS, 1000, 1, 10_000),
  };
}
