import { randomUUID } from 'node:crypto';
import type { FlowEvent, FlowFeedOptions, FlowHistory, FlowSnapshot, FlowUpdate } from '../src/shared/flowTypes';
import type { Snapshot } from '../src/shared/types';
import { FlowStore } from './flow-store';
import type { MonitorStore } from './store';

export interface BackendFlowFeed {
  start(): Promise<void>; stop(): void | Promise<void>; updateSnapshot(snapshot: Snapshot): void; selectMarket(key: string | null): void;
  snapshot(): FlowSnapshot; history(key: string, from: number, to: number): FlowHistory;
  hydrateEvents?(events: FlowEvent[]): void;
}
export type FlowFeedFactory = (options: FlowFeedOptions) => BackendFlowFeed | Promise<BackendFlowFeed>;

/** Only the lease holder opens sockets. Other HTTP workers serve the same persisted snapshots. */
export class FlowRuntime {
  private readonly owner = randomUUID();
  private readonly startedAt: number;
  private timer?: ReturnType<typeof setInterval>;
  private active: Promise<void> | null = null;
  private feed: BackendFlowFeed | null = null;
  private token: string | null = null;
  private stopped = true;
  private writes: Promise<void> = Promise.resolve();
  private lastError: string | null = null;
  private lastOiTime = 0;
  private lastCleanup = 0;
  constructor(private store: FlowStore, private oiStore: MonitorStore, private factory: FlowFeedFactory,
    private now: () => number = Date.now) { this.startedAt = now(); }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.tick(); }, 5_000);
    this.timer.unref();
    void this.tick();
  }
  async tick(): Promise<void> {
    if (this.stopped || this.active) return;
    const active = this.runTick(); this.active = active;
    try { await active; } finally { this.active = null; }
  }
  private async runTick() {
    try {
      if (this.feed) {
        if (!await this.store.renewLease(this.owner, this.now())) {
          this.lastError = null;
          this.token = null; const former = this.feed; this.feed = null; await former.stop();
          return;
        }
      } else {
        if (!await this.store.acquireLease(this.owner, this.now())) return;
        const token = randomUUID(); this.token = token;
        const feed = await this.factory({ mode: 'server', now: this.now,
          onUpdate: update => this.persist(update, token) });
        if (this.stopped || this.token !== token) { await feed.stop(); await this.store.releaseLease(this.owner); return; }
        this.feed = feed; this.lastOiTime = 0;
        const recent = await this.store.events(undefined, 500, this.now() + 1, this.now() - 16 * 60_000);
        feed.hydrateEvents?.(recent.filter(event => event.outcomes.length < 3));
        feed.selectMarket('futures:BTCUSDT');
        // start may backfill many markets; it must not block lease heartbeats or HTTP startup.
        void feed.start().catch(async () => {
          if (this.feed !== feed || this.stopped) return;
          this.lastError = '订单流连接启动失败，后台将自动重试';
          this.token = null; this.feed = null;
          try { await feed.stop(); } catch { /* Failed startup retains no network ownership. */ }
          await this.store.releaseLease(this.owner).catch(() => {});
        });
      }
      if (this.stopped || !this.feed) return;
      const latest = await this.oiStore.latest();
      if (latest) this.updateSnapshot(latest);
      const saved = await this.store.saveSnapshot(this.feed.snapshot(), this.owner, this.now());
      if (!saved) throw new Error('Lease lost');
      if (this.now() - this.lastCleanup >= 3_600_000) {
        await this.store.cleanup(this.now()); this.lastCleanup = this.now();
      }
    } catch {
      this.lastError = '订单流采集或持久化暂不可用，已停止网络采集并等待重试';
      this.token = null; const former = this.feed; this.feed = null;
      try { await former?.stop(); } catch { /* Lease release still runs if a feed shutdown reports failure. */ }
      await this.store.releaseLease(this.owner).catch(() => {});
    }
  }
  private persist(update: FlowUpdate, token: string): Promise<void> {
    const write = this.writes.then(async () => {
      if (this.token !== token) throw new Error('采集租约已失效');
      if (!await this.store.writeUpdate(update, this.owner, this.now())) throw new Error('采集租约已失效');
      this.lastError = null;
    });
    this.writes = write.catch(() => { this.lastError = '订单流历史写入失败，正在重试；缺口不补造'; });
    return write;
  }
  updateSnapshot(snapshot: Snapshot) {
    if (!this.feed || this.stopped || snapshot.asOf <= this.lastOiTime) return;
    this.feed.updateSnapshot(snapshot); this.lastOiTime = snapshot.asOf;
  }
  async snapshot(): Promise<FlowSnapshot> {
    const latest = await this.store.latest();
    const events = await this.store.events(undefined, 100, this.now() + 1);
    if (!latest) return { schemaVersion: 1, rows: [], events, status: {
      mode: 'server', startedAt: this.startedAt, asOf: this.now(), connectedStreams: 0, totalStreams: 0,
      markets: 0, readyMarkets: 0, warmingMarkets: 0, staleMarkets: 0, backfilledMarkets: 0,
      errors: [this.lastError ?? '等待后台首批实际订单流观测'], retentionDays: 7,
      scope: '全市场永续；后台仅默认 BTCUSDT 深度及核实的对应现货，其他标的深度暂不可用；系统 Web Push 尚未接入订单流事件',
    } };
    const stale = this.now() - latest.status.asOf > 15_000;
    const rows = stale ? latest.rows.map(row => ({ ...row, status: 'disconnected' as const, reason: '共享后台快照超过 15 秒，暂停实时事件判断' })) : latest.rows;
    return { ...latest, rows, events, status: { ...latest.status, mode: 'server', retentionDays: 7,
      ...(stale ? { connectedStreams: 0, readyMarkets: 0, warmingMarkets: 0, staleMarkets: rows.length } : {}),
      scope: `${latest.status.scope}；后台仅默认 BTCUSDT 深度与对应核实现货；深度历史为每分钟末次实际观测；订单流事件未接入系统 Web Push`,
      errors: [...latest.status.errors, ...(stale ? ['后台快照已过期，保留的是历史值'] : []), ...(this.lastError ? [this.lastError] : [])] } };
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer); this.timer = undefined;
    // Keep the token until the feed's asynchronous final flush and all database writes settle.
    const feed = this.feed;
    try { await feed?.stop(); }
    catch { this.lastError = '订单流关闭时最后批次未能确认，已保留此前落库数据'; }
    await this.active?.catch(() => {});
    await this.writes;
    if (feed && this.feed === feed && this.token !== null) {
      const latest = feed.snapshot();
      const stopped: FlowSnapshot = { ...latest, rows: latest.rows.map(row => ({ ...row, status: 'disconnected', reason: '后台采集已停止，保留最后实际观测' })),
        status: { ...latest.status, connectedStreams: 0, readyMarkets: 0, warmingMarkets: 0, staleMarkets: latest.rows.length } };
      await this.store.saveSnapshot(stopped, this.owner, this.now()).catch(() => {});
    }
    this.token = null; this.feed = null;
    await this.store.releaseLease(this.owner).catch(() => {});
  }
}
