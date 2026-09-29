import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { activeEntry, adoptEntryPlan, entryMarketMark, sameEntryMarket, stepEntryWatch, validEntryFill,
  type EntryBook, type EntryEvent, type EntryFillInput, type EntryWatch } from '../shared/entryWatch';
import type { MarketPlan } from '../shared/marketPlanTypes';
import { useSharedFlowMonitor } from './FlowMonitorContext';
import { usePrivatePositions } from './PrivatePositionsContext';
import { claimEntryNotifications, emptyEntryBook, finishEntryNotification, readEntryBook, updateEntryBook } from './entryBook';
import { notificationSupport, registerNotifications } from './notifications';
import { readSettings } from './storage';

const text = (error: unknown) => error instanceof Error ? error.message : '进场观察暂不可用，请重试。';
function useEntryRuntime() {
  const flow = useSharedFlowMonitor(), positions = usePrivatePositions();
  const source = useRef(flow.data); source.current = flow.data;
  const [book, setBook] = useState<EntryBook>(emptyEntryBook), [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(Date.now), [error, setError] = useState(''), [popups, setPopups] = useState<EntryEvent[]>([]);
  const owner = useRef(crypto.randomUUID()), ticking = useRef(false), notifying = useRef(false), recovering = useRef(false);
  const accept = useCallback((next: EntryBook) => { setBook(old => next.revision >= old.revision ? next : old); setLoaded(true); setError(''); }, []);
  const markFor = useCallback((key: string) => entryMarketMark(source.current, key, Date.now()), []);
  const deliver = useCallback(async () => {
    if (notifying.current) return; notifying.current = true;
    try {
      for (const event of await claimEntryNotifications(owner.current)) {
        setPopups(old => [...old.filter(e => e.id !== event.id), event].slice(-5));
        let completed = true;
        if (readSettings().notifications && notificationSupport() && Notification.permission === 'granted') {
          try {
            const worker = await registerNotifications();
            await worker.showNotification(`${event.symbol} · ${event.kind === 'ready' ? '进场条件已齐' : event.kind === 'expired' ? '进场等待截止' : '进场方案失效'}`,
              { body: `观测于 ${new Date(event.timestamp).toLocaleTimeString()}；操作前请重新核对当前条件。${event.message}`, tag: `entry:${event.id}`, requireInteraction: event.kind === 'ready',
                data: { url: new URL('?view=risks&risk=entry', document.baseURI).href } });
          } catch { completed = false; setError('进场系统通知发送失败，页内和历史记录已保留，将重试。'); }
        }
        await finishEntryNotification(event.id, owner.current, completed);
      }
    } catch (e) { setError(text(e)); } finally { notifying.current = false; }
  }, []);
  useEffect(() => {
    let disposed = false, reading = false, succeeded = false;
    const load = async () => {
      if (disposed || reading || succeeded) return; reading = true;
      try { const next = await readEntryBook(); if (!disposed) { accept(next); succeeded = true; } }
      catch (e) { if (!disposed) setError(text(e)); } finally { reading = false; }
    };
    void load();
    const timer = setInterval(() => { setNow(Date.now()); void load(); }, 5000);
    return () => { disposed = true; clearInterval(timer); };
  }, [accept]);
  useEffect(() => {
    if (!loaded || ticking.current) return; ticking.current = true;
    const at = Date.now();
    void updateEntryBook(current => {
      const events: EntryEvent[] = [];
      const watches = current.watches.map(watch => {
        const next = stepEntryWatch(watch, source.current, at); events.push(...next.events); return next.watch;
      });
      return { ...current, watches, events: [...events, ...current.events].slice(0, 500) };
    }, at).then(next => { accept(next); void deliver(); }).catch(e => setError(text(e))).finally(() => { ticking.current = false; });
  }, [now, flow.data, loaded, accept, deliver]);
  const adopt = useCallback(async (plan: MarketPlan) => {
    const at = Date.now(), rows = source.current?.rows.filter(row => row.market.key === plan.market.key) ?? [];
    if (rows.length !== 1 || !sameEntryMarket(rows[0].market, plan.market)) throw new Error('合约目录身份不匹配，未采纳。');
    accept(await updateEntryBook(current => {
      const existing = current.watches.find(w => w.plan.id === plan.id);
      if (existing) {
        if (JSON.stringify(existing.plan) !== JSON.stringify(plan)) throw new Error('方案编号对应不同内容，未覆盖。');
        return current;
      }
      if (current.watches.some(w => activeEntry(w) && w.plan.market.key === plan.market.key)) throw new Error('此合约已有进场观察；请先停止旧观察再采纳新方案。');
      if (current.watches.filter(activeEntry).length >= 5 || current.watches.length >= 100) throw new Error('最多同时观察 5 个计划，本机最多保留 100 条记录。');
      return { ...current, watches: [adoptEntryPlan(plan, entryMarketMark(source.current, plan.market.key, at), at), ...current.watches] };
    }, at));
  }, [accept]);
  const stop = useCallback(async (id: string) => {
    const at = Date.now();
    accept(await updateEntryBook(current => ({ ...current, watches: current.watches.map(watch => {
      if (watch.plan.id !== id || !activeEntry(watch)) return watch;
      if (watch.fillIntent) throw new Error('实际成交登记尚在恢复，不能丢弃；请检查我的持仓。');
      return { ...watch, phase: 'stopped' as const, lastEvaluatedAt: at, reason: '已手动停止入场观察，不影响任何真实仓位。' };
    }) }), at));
  }, [accept]);
  const completeFill = useCallback(async (watch: EntryWatch) => {
    const input = watch.fillIntent;
    if (!input) throw new Error('缺少实际成交登记信息。');
    const { market, side, id } = watch.plan;
    const positionId = await positions.addFromEntry(id, { ...input, marketKey: market.key, symbol: market.symbol, assetId: market.assetId, side,
      suggestedHoldingLimitMs: watch.plan.holdingLimitMs });
    const at = Date.now();
    accept(await updateEntryBook(current => ({ ...current, watches: current.watches.map(item => {
      if (item.plan.id !== id) return item;
      if (JSON.stringify(item.fillIntent) !== JSON.stringify(input)) throw new Error('成交登记意向已改变，请检查持仓。');
      return { ...item, phase: 'filled' as const, filledPositionId: positionId, lastEvaluatedAt: at,
        reason: '实际成交已登记。请到“我的持仓”采纳结构保护；止盈止损提醒尚未自动启用。' };
    }) }), at));
    return positionId;
  }, [positions.addFromEntry, accept]);
  const recordFill = useCallback(async (id: string, input: EntryFillInput) => {
    const at = Date.now();
    if (!validEntryFill(input, at)) throw new Error('实际成交价、保证金、杠杆或开仓时间无效。');
    const next = await updateEntryBook(current => ({ ...current, watches: current.watches.map(watch => {
      if (watch.plan.id !== id) return watch;
      if (watch.fillIntent) {
        if (JSON.stringify(watch.fillIntent) !== JSON.stringify(input)) throw new Error('已有不同实际成交登记，请查看我的持仓。');
        return watch;
      }
      if (input.openedAt < watch.adoptedAt) throw new Error('开仓早于此观察，请在我的持仓直接录入已有仓位。');
      const latestFill = Math.min(watch.plan.waitUntil, activeEntry(watch) ? at : watch.lastEvaluatedAt);
      if (input.openedAt > latestFill) throw new Error('开仓晚于此观察有效期，请在我的持仓直接录入实际仓位。');
      return { ...watch, fillIntent: { ...input }, lastEvaluatedAt: at, reason: '正在保存你确认的实际成交；尚未启用退出提醒。' };
    }) }), at);
    const watch = next.watches.find(item => item.plan.id === id); if (!watch) throw new Error('未找到该进场观察。');
    accept(next);
    if (watch.phase === 'filled') return watch.filledPositionId!;
    return completeFill(watch);
  }, [accept, completeFill]);
  useEffect(() => {
    if (!loaded || recovering.current) return;
    const pending = book.watches.find(watch => watch.fillIntent && watch.phase !== 'filled');
    if (!pending) return; recovering.current = true;
    void completeFill(pending).catch(e => setError(`成交登记未完成：${text(e)} 原登记已保留，将重试。`)).finally(() => { recovering.current = false; });
  }, [now, loaded, book.watches, completeFill]);
  // A source response can arrive between timer ticks; never compare its timestamp to the older UI clock.
  return { book, loaded, error, now: Date.now(), markFor, adopt, stop, recordFill, popups,
    dismiss: (id: string) => setPopups(old => old.filter(e => e.id !== id)) };
}
type Runtime = ReturnType<typeof useEntryRuntime>;
const Context = createContext<Runtime | null>(null);
export function MarketPlansProvider({ children }: { children: ReactNode }) {
  const runtime = useEntryRuntime();
  const visiblePopups = runtime.popups.filter(event => event.kind !== 'ready' || runtime.book.watches.some(watch => watch.plan.id === event.planId
    && watch.phase === 'ready' && !watch.fillIntent && watch.triggeredAt === event.timestamp
    && runtime.now - watch.lastEvaluatedAt <= 15_000 && runtime.markFor(watch.plan.market.key)));
  return <Context.Provider value={runtime}>{children}<aside className="position-popup-stack entry-popup-stack" aria-label="进场计划提醒" aria-live="assertive">
    {visiblePopups.map(event => <div className="position-popup" key={event.id} role="alert"><div><strong>{event.symbol} · {event.kind === 'ready' ? '进场条件已齐' : event.kind === 'expired' ? '等待截止' : '方案失效'}</strong><button aria-label={`关闭 ${event.symbol} 进场提醒`} onClick={() => runtime.dismiss(event.id)}>×</button></div><p>{event.message}</p><small>观测 {new Date(event.timestamp).toLocaleTimeString()} · 条件计划未验证收益 · 通知不是成交</small></div>)}
  </aside></Context.Provider>;
}
export function useMarketPlans(): Runtime { const context = useContext(Context); if (!context) throw new Error('MarketPlansProvider is required'); return context; }
