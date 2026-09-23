import { randomUUID } from 'node:crypto';
import { evaluateAlerts } from '../src/shared/alerts';
import { COLLECTION_INTERVAL_MS, DEFAULT_THRESHOLDS, type BackendStatus, type Collector, type Snapshot } from '../src/shared/types';
import type { ServerConfig } from './config';
import type { PushSender } from './push';
import { MonitorStore, type SubscriptionEvaluation } from './store';

export class MonitorScheduler {
  private owner = randomUUID();
  private stopped = false;
  private active: Promise<boolean> | null = null;
  private activePush: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private collectionTimer?: ReturnType<typeof setInterval>;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private pushTimer?: ReturnType<typeof setInterval>;
  private lastSuccess: number | null = null;
  private lastError: string | null = null;
  private lastDurationMs: number | null = null;
  constructor(private store: MonitorStore, private collector: Collector, private push: PushSender,
    private config: ServerConfig, private now: () => number = Date.now, private onSnapshot?: (snapshot: Snapshot) => void) {}

  async initialize() {
    const latest = await this.store.latest();
    this.lastSuccess = latest?.asOf ?? null;
    this.lastDurationMs = latest?.durationMs ?? null;
  }
  status(): BackendStatus {
    return { mode: 'server', version: '0.1.0', collecting: this.active !== null, lastSuccess: this.lastSuccess,
      storage: this.store.kind, pushEnabled: this.push.enabled, retentionDays: 30, lastError: this.lastError,
      collectionIntervalMs: COLLECTION_INTERVAL_MS, lastDurationMs: this.lastDurationMs, rawRetentionDays: 7 };
  }
  start() {
    if (this.collectionTimer) return;
    this.stopped = false;
    if (this.config.collectOnStart) void this.runOnce();
    this.collectionTimer = setInterval(() => { void this.runOnce(); }, COLLECTION_INTERVAL_MS);
    this.pushTimer = setInterval(() => { void this.flushPush(); }, 15_000);
    this.cleanupTimer = setInterval(() => { void this.store.cleanup(this.now()).catch(() => { this.lastError = '历史清理暂未完成'; }); }, 3_600_000);
    this.collectionTimer.unref(); this.pushTimer.unref(); this.cleanupTimer.unref();
    void this.store.cleanup(this.now()).catch(() => { this.lastError = '历史清理暂未完成'; });
    void this.flushPush();
  }
  async runOnce(): Promise<boolean> {
    if (this.active || this.stopped) return false;
    const running = this.collect();
    this.active = running;
    try { return await running; } finally { this.active = null; }
  }
  private async collect(): Promise<boolean> {
    let acquired = false;
    let completedAt: number | null = null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let renewal: ReturnType<typeof setInterval> | undefined;
    const start = this.now();
    try {
      acquired = await this.store.acquireLease(this.owner, start);
      if (!acquired) return false;
      const abort = new AbortController();
      this.abort = abort;
      timeout = setTimeout(() => abort.abort(new Error('Collection deadline exceeded')), this.config.collectionTimeoutMs);
      renewal = setInterval(() => {
        void this.store.renewLease(this.owner, this.now()).then(owned => { if (!owned) abort.abort(); }).catch(() => abort.abort());
      }, 30_000);
      const snapshot = await this.collector.collect({ signal: abort.signal });
      if (abort.signal.aborted || this.stopped) throw new Error('Collection interrupted');
      if (!snapshot.assets.length || snapshot.coverage.oi === 0 || !Number.isFinite(snapshot.asOf)) {
        this.lastError = '本轮没有有效 OI 数据，保留上一轮快照';
        return false;
      }
      snapshot.mode = 'server';
      snapshot.collectionIntervalMs = COLLECTION_INTERVAL_MS;
      const global = evaluateAlerts(snapshot, DEFAULT_THRESHOLDS, await this.store.states(), this.now());
      const evaluations: SubscriptionEvaluation[] = [];
      if (this.push.enabled) for (const subscription of await this.store.subscriptions()) {
        const result = evaluateAlerts(snapshot, subscription.thresholds, await this.store.states(subscription.id), this.now());
        evaluations.push({ id: subscription.id, thresholds: subscription.thresholds, ...result });
      }
      await this.store.commitCollection(snapshot, global.states, global.events, evaluations);
      this.lastSuccess = snapshot.asOf;
      this.lastError = snapshot.errors.length ? '部分源数据缺失，详见快照覆盖率' : null;
      completedAt = Math.floor(start / COLLECTION_INTERVAL_MS) * COLLECTION_INTERVAL_MS;
      try { this.onSnapshot?.(snapshot); } catch { /* The independent flow feed retries from the persisted OI snapshot. */ }
      void this.flushPush();
      return true;
    } catch {
      if (!this.stopped) this.lastError = this.abort?.signal.aborted ? '采集超时或中断，等待下一轮重试' : '本轮采集或持久化失败，等待下一轮重试';
      return false;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (renewal) clearInterval(renewal);
      this.abort = null;
      if (acquired) {
        this.lastDurationMs = Math.max(0, this.now() - start);
        await this.store.releaseLease(this.owner, completedAt).catch(() => {});
      }
    }
  }
  async flushPush(): Promise<void> {
    if (!this.push.enabled || this.activePush || this.stopped) return;
    const running = this.drainPush();
    this.activePush = running;
    try { await running; } finally { this.activePush = null; }
  }
  private async drainPush() {
    let acquired = false;
    try {
      acquired = await this.store.acquirePushLease(this.owner, this.now());
      if (!acquired) return;
      const started = Date.now();
      const pending = await this.store.pendingPush(this.now(), 100);
      for (let offset = 0; offset < pending.length && !this.stopped && Date.now() - started < 20_000; offset += 4) {
        await Promise.all(pending.slice(offset, offset + 4).map(async message => {
          const subscription = await this.store.subscription(message.subscriptionId);
          if (!subscription) { await this.store.delivered(message.id); return; }
          try {
            await this.push.send(subscription.subscription, message.event);
            await this.store.delivered(message.id);
          } catch (error) {
            const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 0;
            if (status === 404 || status === 410) await this.store.deleteSubscription(subscription.id);
            else await this.store.retryPush(message.id, message.attempts + 1, this.now());
          }
        }));
      }
    } catch {
      // The persisted outbox is retried on the next tick; no subscription endpoint is logged.
    } finally { if (acquired) await this.store.releasePushLease(this.owner).catch(() => {}); }
  }
  async stop() {
    this.stopped = true;
    if (this.collectionTimer) clearInterval(this.collectionTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    if (this.pushTimer) clearInterval(this.pushTimer);
    this.collectionTimer = this.cleanupTimer = this.pushTimer = undefined;
    this.abort?.abort();
    await Promise.allSettled([this.active, this.activePush].filter(Boolean));
    this.push.close?.();
  }
}
