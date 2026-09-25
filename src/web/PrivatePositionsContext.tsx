import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPositionRisk, stepPositionRisk } from '../shared/positionRisk';
import { positionMarketFrame } from '../shared/positionFrame';
import type { ManualPosition, PositionBook, PositionMarketFrame, PositionRiskEvent, RiskPlanDraft } from '../shared/positionTypes';
import type { Snapshot } from '../shared/types';
import { useDirectionSettings } from './DirectionSettingsContext';
import { useSharedFlowMonitor } from './FlowMonitorContext';
import { claimPositionNotifications, emptyPositionBook, finishPositionNotification, readPositionBook, updatePositionBook } from './positionBook';
import { notificationSupport, registerNotifications } from './notifications';
import { readSettings, type Settings } from './storage';

function usePositionBookRuntime(snapshot: Snapshot | null, settings: Settings) {
  const flow = useSharedFlowMonitor(), { config } = useDirectionSettings();
  const [book, setBook] = useState<PositionBook>(emptyPositionBook), [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false), [now, setNow] = useState(Date.now);
  const [popups, setPopups] = useState<PositionRiskEvent[]>([]);
  const owner = useRef(crypto.randomUUID()), ticking = useRef(false), notifying = useRef(false);
  const source = useRef({ flow: flow.data, snapshot, config, settings }); source.current = { flow: flow.data, snapshot, config, settings };
  const frameFor = useCallback((state: PositionBook['positions'][number], at: number) => positionMarketFrame(state.position,
    source.current.flow, source.current.snapshot, at, state.plan?.directionConfig ?? source.current.config), []);
  const accept = useCallback((next: PositionBook) => { setBook(old => next.revision >= old.revision ? next : old); setLoaded(true); setError(''); }, []);
  const deliver = useCallback(async () => {
    if (notifying.current) return; notifying.current = true;
    try {
      const events = await claimPositionNotifications(owner.current);
      for (const event of events) {
        setPopups(previous => [...previous.filter(e => e.id !== event.id), event].slice(-5));
        let delivered = true;
        // Read the shared preference at delivery time; an older tab must not swallow a newly enabled notification.
        if (readSettings().notifications && notificationSupport() && Notification.permission === 'granted') {
          try {
            const worker = await registerNotifications();
            await worker.showNotification(`${event.symbol} · ${event.title}`, { body: `${event.message}；提醒不等于已平仓`,
              tag: event.id, requireInteraction: event.rule !== 'signal-weakening', data: { url: new URL('?view=positions', document.baseURI).href } });
          } catch { delivered = false; setError('系统通知发送失败，风险记录与页内提醒已保留；将重试。'); }
        }
        await finishPositionNotification(event.id, owner.current, delivered);
      }
    } catch { setError('持仓提醒存储暂不可用；请直接检查交易所仓位。'); }
    finally { notifying.current = false; }
  }, []);
  useEffect(() => {
    let disposed = false;
    let reading = false, readSucceeded = false;
    const load = async () => {
      if (reading || readSucceeded || disposed) return; reading = true;
      try { const next = await readPositionBook(); if (!disposed) { accept(next); readSucceeded = true; } }
      catch (e) { if (!disposed) setError(e instanceof Error ? e.message : '无法读取本机持仓，监控暂停并自动重试。'); }
      finally { reading = false; }
    };
    void load();
    const retry = setInterval(() => void load(), 5000);
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => { disposed = true; clearInterval(timer); clearInterval(retry); };
  }, [accept]);
  useEffect(() => {
    if (!loaded || ticking.current) return;
    ticking.current = true;
    const at = Date.now();
    void updatePositionBook(current => {
      const events: PositionRiskEvent[] = [];
      const positions = current.positions.map(state => {
        if (state.phase === 'closed' || state.phase === 'draft') return state;
        const result = stepPositionRisk(state, { type: 'tick', frame: frameFor(state, at), now: at });
        events.push(...result.events); return result.state;
      });
      return { ...current, positions, events: [...events, ...current.events].slice(0, 1000) };
    }, at).then(next => { accept(next); void deliver(); }).catch(e => setError(e instanceof Error ? e.message : '持仓状态保存失败，提醒已暂停。'))
      .finally(() => { ticking.current = false; });
  }, [now, flow.data, snapshot, loaded, frameFor, accept, deliver]);
  const add = useCallback(async (input: Omit<ManualPosition, 'id' | 'createdAt'>) => {
    const position = { ...input, id: crypto.randomUUID(), createdAt: Date.now() }, state = createPositionRisk(position);
    // Resolve only the exact currently known USDT futures contract. User text is never trusted as identity.
    const known = source.current.flow?.rows.some(row => row.market.key === input.marketKey && row.market.symbol === input.symbol
      && row.market.assetId === input.assetId && row.market.venue === 'futures' && row.market.quoteAsset === 'USDT');
    if (!known) throw new Error('请选择目录中的 USDT 永续合约；暂不支持其他保证金合约。');
    accept(await updatePositionBook(current => {
      if (current.positions.filter(p => p.phase !== 'closed').length >= 50 || current.positions.length >= 100) throw new Error('本机最多保留 50 个未关闭仓位、100 条仓位记录。');
      return { ...current, positions: [state, ...current.positions] };
    })); return position.id;
  }, [accept]);
  const confirm = useCallback(async (id: string, plan: RiskPlanDraft, expectedPlanRevision: number) => {
    const at = Date.now();
    accept(await updatePositionBook(current => {
      const state = current.positions.find(p => p.position.id === id); if (!state) throw new Error('仓位不存在，请重新打开。');
      const result = stepPositionRisk(state, { type: 'confirm', plan, expectedPlanRevision, frame: positionMarketFrame(state.position,
        source.current.flow, source.current.snapshot, at, plan.directionConfig), now: at });
      if (result.error) throw new Error(result.error);
      return { ...current, positions: current.positions.map(p => p.position.id === id ? result.state : p) };
    }, at));
  }, [accept]);
  const close = useCallback(async (id: string) => {
    const at = Date.now();
    accept(await updatePositionBook(current => ({ ...current, positions: current.positions.map(state => state.position.id === id
      ? stepPositionRisk(state, { type: 'close', now: at }).state : state) }), at));
  }, [accept]);
  const observed = useMemo(() => {
    const at = Date.now();
    const frames = new Map<string, PositionMarketFrame>(book.positions.map(state => [state.position.id, frameFor(state, at)]));
    const issues = new Map(book.positions.map(state => [state.position.id, state.phase === 'closed' ? null
      : stepPositionRisk(state, { type: 'tick', frame: frames.get(state.position.id)!, now: at }).error]));
    return { at, frames, issues };
  }, [book.positions, now, flow.data, snapshot, frameFor]);
  const markets = useMemo(() => (flow.data?.rows ?? []).filter(row => row.market.venue === 'futures' && row.market.quoteAsset === 'USDT').map(row => row.market).sort((a, b) => a.symbol.localeCompare(b.symbol)), [flow.data]);
  return { book, loaded, error, now: observed.at, frames: observed.frames, issues: observed.issues, markets, config, add, confirm, close, popups,
    dismiss: (id: string) => setPopups(previous => previous.filter(event => event.id !== id)) };
}
type Runtime = ReturnType<typeof usePositionBookRuntime>;
const Context = createContext<Runtime | null>(null);
export function PrivatePositionsProvider({ snapshot, settings, children }: { snapshot: Snapshot | null; settings: Settings; children: ReactNode }) {
  const runtime = usePositionBookRuntime(snapshot, settings);
  return <Context.Provider value={runtime}>{children}<aside className="position-popup-stack" aria-label="持仓触线提醒" aria-live="assertive">
    {runtime.popups.map(event => <div className="position-popup" key={event.id} role="alert"><div><strong>{event.symbol} · {event.title}</strong><button aria-label={`关闭 ${event.symbol} 提醒`} onClick={() => runtime.dismiss(event.id)}>×</button></div><p>{event.message}</p><small>提醒不等于已平仓，请检查交易所仓位。</small></div>)}
  </aside></Context.Provider>;
}
export function usePrivatePositions(): Runtime { const value = useContext(Context); if (!value) throw new Error('PrivatePositionsProvider is required'); return value; }
