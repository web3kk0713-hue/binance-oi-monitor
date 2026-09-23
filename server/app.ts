import { randomUUID } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import type { Collector, Thresholds } from '../src/shared/types';
import { validThresholds } from '../src/shared/alerts';
import type { ServerConfig } from './config';
import { BrowserPushSender, hashSecret, newDeleteToken, tokenMatches, validPushSubscription, type PushSender } from './push';
import { MonitorScheduler } from './scheduler';
import { MonitorStore } from './store';
import { FlowRuntime, type FlowFeedFactory } from './flow-runtime';
import { FLOW_RETENTION_MS, type FlowStore } from './flow-store';

const thresholdsSchema = { type: 'object', additionalProperties: false, required: ['warning', 'danger', 'critical', 'cooldownMinutes'],
  properties: { warning: { type: 'number', exclusiveMinimum: 0, maximum: 10000 }, danger: { type: 'number', exclusiveMinimum: 0, maximum: 10000 },
    critical: { type: 'number', exclusiveMinimum: 0, maximum: 10000 }, cooldownMinutes: { type: 'number', minimum: 1, maximum: 1440 } } };
function bearer(authorization: string | undefined) { return authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined; }

export interface AppOptions { store: MonitorStore; collector: Collector; config: ServerConfig; pushSender?: PushSender; startJobs?: boolean; logger?: boolean; now?: () => number;
  flowStore?: FlowStore; flowFeedFactory?: FlowFeedFactory; flowEnabled?: boolean; }
export async function buildApp(options: AppOptions) {
  const { store, collector, config } = options;
  const now = options.now ?? Date.now;
  const flowStore = options.flowStore ?? store.createFlowStore();
  await flowStore.initialize();
  const flow = new FlowRuntime(flowStore, store, options.flowFeedFactory ?? (async settings => {
    const module = await import('../src/data/flowFeed'); return module.createFlowFeed(settings);
  }), now);
  const push = options.pushSender ?? new BrowserPushSender(config);
  const scheduler = new MonitorScheduler(store, collector, push, config, now, snapshot => flow.updateSnapshot(snapshot));
  await scheduler.initialize();
  const app = Fastify({ logger: options.logger ? { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie', 'body.subscription', 'body.deleteToken'] } : false,
    logController: new LogController({ disableRequestLogging: true }), bodyLimit: 8192, requestTimeout: 15_000, connectionTimeout: 15_000, trustProxy: false,
    ajv: { customOptions: { removeAdditional: false } } });
  await app.register(cors, { origin: config.allowedOrigins, methods: ['GET', 'POST', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'], maxAge: 600 });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute', errorResponseBuilder: (_request, context) => ({ statusCode: context.statusCode, error: 'rate_limited', message: '请求过于频繁，请稍后重试' }) });
  app.addHook('onRequest', async (_request, reply) => { reply.header('X-Content-Type-Options', 'nosniff'); reply.header('Cache-Control', 'no-store'); });
  app.setErrorHandler((error, _request, reply) => {
    const details = error as { validation?: unknown; statusCode?: number };
    if (details.validation || details.statusCode === 400) { void reply.status(400).send({ error: 'invalid_request', message: '请求参数无效' }); return; }
    if (details.statusCode === 413) { void reply.status(413).send({ error: 'body_too_large', message: '请求内容过大' }); return; }
    if (details.statusCode === 429) { void reply.status(429).send({ error: 'rate_limited', message: '请求过于频繁，请稍后重试' }); return; }
    // Driver and push errors may contain credentials or capability URLs: never serialize them.
    app.log.error({ event: 'request_failed' }, 'Request failed');
    void reply.status(500).send({ error: 'internal_error', message: '服务暂时不可用' });
  });
  app.get('/api/v1/health', async (_request, reply) => {
    try { await store.ping(); return scheduler.status(); }
    catch { return reply.status(503).send({ ...scheduler.status(), lastError: '数据库暂时不可用' }); }
  });
  app.get('/api/v1/snapshot', async (_request, reply) => {
    const snapshot = await store.latest();
    return snapshot ?? reply.status(503).send({ error: 'snapshot_unavailable', message: '正在等待首轮有效数据' });
  });
  app.get<{ Querystring: { assetId: string; hours?: number } }>('/api/v1/history', {
    schema: { querystring: { type: 'object', additionalProperties: false, required: ['assetId'], properties: {
      assetId: { type: 'string', minLength: 1, maxLength: 120, pattern: '^[\\p{L}\\p{N}:_-]+$' }, hours: { type: 'integer', minimum: 1, maximum: 720, default: 24 },
    } } }, config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async request => store.history(request.query.assetId, request.query.hours ?? 24, now()));
  app.get<{ Params: { symbol: string }; Querystring: { hours?: number } }>('/api/v1/contracts/:symbol/history', {
    schema: {
      params: { type: 'object', additionalProperties: false, required: ['symbol'], properties: {
        symbol: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[\\p{L}\\p{N}_-]+$' },
      } },
      querystring: { type: 'object', additionalProperties: false, properties: {
        hours: { type: 'integer', minimum: 1, maximum: 168, default: 24 },
      } },
    }, config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async request => store.contractHistory(request.params.symbol, request.query.hours ?? 24, now()));
  const marketKeySchema = { type: 'string', minLength: 6, maxLength: 120, pattern: '^(futures|spot):[\\p{L}\\p{N}_]+$' };
  const timeSchema = { type: 'integer', minimum: 1, maximum: 8_640_000_000_000_000 };
  app.get('/api/v1/flow/snapshot', async () => flow.snapshot());
  app.get<{ Querystring: { marketKey?: string; limit?: number; before?: number } }>('/api/v1/flow/events', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      marketKey: marketKeySchema, limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 }, before: timeSchema,
    } } }, config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const clock = now(), before = request.query.before ?? clock + 1;
    if (before > clock + 1) return reply.status(400).send({ error: 'invalid_request', message: '事件游标不能在未来' });
    return flowStore.events(request.query.marketKey, request.query.limit ?? 100, before, Math.max(0, clock - FLOW_RETENTION_MS), clock);
  });
  app.get<{ Querystring: { marketKey: string; hours?: number; to?: number } }>('/api/v1/flow/history', {
    schema: { querystring: { type: 'object', additionalProperties: false, required: ['marketKey'], properties: {
      marketKey: marketKeySchema, hours: { type: 'number', minimum: 1 / 60, maximum: 168, default: 24 }, to: timeSchema,
    } } }, config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const to = request.query.to ?? now();
    if (to > now()) return reply.status(400).send({ error: 'invalid_request', message: '历史查询时间不能在未来' });
    return flowStore.history(request.query.marketKey, request.query.hours ?? 24, to);
  });
  app.get<{ Querystring: { limit?: number } }>('/api/v1/alerts', { schema: { querystring: { type: 'object', additionalProperties: false,
    properties: { limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 } } } } }, async request => store.alerts(request.query.limit));
  app.get('/api/v1/push/key', async () => ({ publicKey: push.publicKey }));
  app.post<{ Body: { subscription: PushSubscriptionJSON; thresholds: Thresholds } }>('/api/v1/push/subscriptions', {
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    schema: { body: { type: 'object', additionalProperties: false, required: ['subscription', 'thresholds'], properties: {
      subscription: { type: 'object', additionalProperties: false, required: ['endpoint', 'keys'], properties: {
        endpoint: { type: 'string', maxLength: 2048 }, expirationTime: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        keys: { type: 'object', additionalProperties: false, required: ['p256dh', 'auth'], properties: {
          p256dh: { type: 'string', maxLength: 100 }, auth: { type: 'string', maxLength: 32 },
        } },
      } }, thresholds: thresholdsSchema,
    } } },
  }, async (request, reply) => {
    if (!push.enabled) return reply.status(503).send({ error: 'push_unavailable', message: '后台尚未配置系统推送' });
    if (!request.headers.origin || !config.allowedOrigins.includes(request.headers.origin)) return reply.status(403).send({ error: 'origin_denied', message: '此来源不可注册推送' });
    const { subscription, thresholds } = request.body;
    if (!validPushSubscription(subscription) || !validThresholds(thresholds)) return reply.status(400).send({ error: 'invalid_subscription', message: '推送订阅或阈值无效' });
    const endpointHash = hashSecret(subscription.endpoint!);
    const existing = await store.subscriptionByEndpoint(endpointHash);
    const suppliedToken = bearer(request.headers.authorization);
    if (existing && !tokenMatches(suppliedToken, existing.tokenHash)) return reply.status(409).send({ error: 'subscription_exists', message: '更新此订阅需要原订阅令牌' });
    const id = existing?.id ?? randomUUID();
    const deleteToken = existing ? suppliedToken! : newDeleteToken();
    const saved = await store.saveSubscription({ id, endpointHash, tokenHash: hashSecret(deleteToken), subscription, thresholds, createdAt: existing?.createdAt ?? now() }, config.maxSubscriptions);
    if (!saved) return reply.status(503).send({ error: 'subscription_capacity', message: '推送订阅已达到容量上限' });
    return reply.status(existing ? 200 : 201).send({ id, deleteToken });
  });
  app.delete<{ Params: { id: string } }>('/api/v1/push/subscriptions/:id', {
    schema: { params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: '^[a-f0-9-]{36}$' } } } },
    config: { rateLimit: { max: 30, timeWindow: '1 hour' } },
  }, async (request, reply) => {
    if (request.headers.origin && !config.allowedOrigins.includes(request.headers.origin)) return reply.status(403).send({ error: 'origin_denied', message: '此来源不可管理推送' });
    const existing = await store.subscription(request.params.id);
    if (!existing || !tokenMatches(bearer(request.headers.authorization), existing.tokenHash)) return reply.status(403).send({ error: 'invalid_token', message: '订阅令牌无效' });
    await store.deleteSubscription(existing.id);
    return reply.status(204).send();
  });
  app.addHook('onReady', async () => { if (options.startJobs !== false) { scheduler.start(); if (options.flowEnabled !== false) flow.start(); } });
  app.addHook('onClose', async () => { await scheduler.stop(); await flow.stop(); await store.close(); });
  return { app, scheduler, flow, flowStore };
}
