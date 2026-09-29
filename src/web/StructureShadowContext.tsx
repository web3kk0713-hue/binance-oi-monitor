import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { startStructureShadow, stepStructureShadow } from '../shared/structureReplay';
import type { StructureAdvice, StructureShadowBook } from '../shared/structureTypes';
import { usePrivatePositions } from './PrivatePositionsContext';
import { emptyStructureBook, readStructureBook, updateStructureBook } from './structureStorage';

function useShadowRuntime() {
  const positions = usePrivatePositions();
  const [book, setBook] = useState(emptyStructureBook), [error, setError] = useState(''), [loaded, setLoaded] = useState(false);
  const current = useRef(positions); current.current = positions;
  const busy = useRef(false), sessionStarted = useRef(false);
  const accept = useCallback((next: StructureShadowBook) => {
    setBook(old => next.revision >= old.revision ? next : old); setError(''); setLoaded(true);
  }, []);
  useEffect(() => {
    let disposed = false, loading = false, done = false;
    const load = async () => {
      if (disposed || loading || done) return; loading = true;
      try { const value = await readStructureBook(); if (!disposed) { accept(value); done = true; } }
      catch (e) { if (!disposed) setError(e instanceof Error ? e.message : '本机验证记录读取失败，正在重试。'); }
      finally { loading = false; }
    };
    void load(); const timer = setInterval(() => void load(), 5000);
    return () => { disposed = true; clearInterval(timer); };
  }, [accept]);
  useEffect(() => {
    if (!loaded || !positions.loaded || busy.current) return;
    busy.current = true;
    const at = Date.now(), first = !sessionStarted.current;
    void updateStructureBook(previous => ({ ...previous, records: previous.records.map(record => {
      if (record.stoppedAt !== null) return record;
      const state = current.current.book.positions.find(s => s.position.id === record.advice.position.id);
      // Another tab may have just added this position. Absence in a lagging local snapshot is not closure.
      if (!state) return { ...record, gap: true };
      if (state.phase === 'closed') return { ...record, stoppedAt: at, gap: true };
      // Opening a new page is never proof of continuous coverage while the prior page was closed.
      const resume = first ? { ...record, gap: true } : record;
      const mark = current.current.error || current.current.issues.get(state.position.id) ? null
        : current.current.frames.get(state.position.id)?.mark ?? null;
      return stepStructureShadow(resume, mark, at);
    }) }), at).then(next => { sessionStarted.current = true; accept(next); })
      .catch(e => setError(e instanceof Error ? e.message : '验证记录保存失败，观察暂停。'))
      .finally(() => { busy.current = false; });
  }, [loaded, positions.loaded, positions.now, positions.frames, accept]);
  const save = useCallback(async (advice: StructureAdvice) => {
    const at = Date.now(), live = current.current;
    const state = live.book.positions.find(p => p.position.id === advice.position.id && p.phase !== 'closed');
    if (!live.loaded || live.error || !state || JSON.stringify(state.position) !== JSON.stringify(advice.position)) throw new Error('持仓已变化或不可用，请重新分析。');
    const mark = live.issues.get(state.position.id) ? null : live.frames.get(state.position.id)?.mark;
    if (!mark) throw new Error('当前标记价不可用，不能开始观察。');
    const record = startStructureShadow(crypto.randomUUID(), advice, mark, at);
    accept(await updateStructureBook(previous => {
      if (previous.records.some(r => r.stoppedAt === null && r.advice.position.id === advice.position.id)) throw new Error('该仓位已有观察方案；先停止原观察，原价位不会被覆盖。');
      if (previous.records.length >= 100) throw new Error('已保存 100 份验证方案，停止新增；旧记录不会自动删除。');
      return { ...previous, records: [record, ...previous.records] };
    }, at));
  }, [accept]);
  const stop = useCallback(async (id: string) => {
    const at = Date.now();
    accept(await updateStructureBook(previous => ({ ...previous, records: previous.records.map(record => record.id === id && record.stoppedAt === null
      ? { ...record, stoppedAt: at } : record) }), at));
  }, [accept]);
  return { book, loaded, error, save, stop };
}
type ShadowRuntime = ReturnType<typeof useShadowRuntime>;
const Context = createContext<ShadowRuntime | null>(null);
export function StructureShadowProvider({ children }: { children: ReactNode }) {
  const value = useShadowRuntime();
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useStructureShadow() {
  const value = useContext(Context); if (!value) throw new Error('StructureShadowProvider is required'); return value;
}
