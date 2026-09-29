import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DIRECTION_CONFIG } from '../src/shared/directionConfig';
import * as entry from '../src/shared/entryWatch';
import type { EntryBook, EntryFillInput } from '../src/shared/entryWatch';
import { positionMarketFrame } from '../src/shared/positionFrame';
import { createPositionRisk, stepPositionRisk, validPositionState } from '../src/shared/positionRisk';
import type { PositionBook, RiskPlanDraft } from '../src/shared/positionTypes';
import { emptyPositionBook, validPositionBook } from '../src/web/positionBook';
import { emptyEntryBook } from '../src/web/entryBook';
import type { usePrivatePositions } from '../src/web/PrivatePositionsContext';
import type { useMarketPlans } from '../src/web/MarketPlansContext';
import { entryFlow, entryPlan, ENTRY_NOW } from './entry-fixture';

/**
 * Executes the actual Context callback source without exporting private production hooks.
 * Hooks/effects and serialized transactions are test doubles: this proves callback ordering,
 * recovery and idempotency, NOT native IndexedDB locking, React lifecycle or browser delivery.
 * Those remain separate real-browser acceptance paths.
 */
type PositionsRuntime = ReturnType<typeof usePrivatePositions>;
type EntryRuntime = ReturnType<typeof useMarketPlans>;
const nodeRequire = createRequire(import.meta.url);
const hooks = {
  createContext: () => ({}), useCallback: (callback: unknown) => callback, useContext: () => null,
  useEffect: () => {}, useMemo: (calculate: () => unknown) => calculate(), useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => {}],
};
function compileRuntime<T>(path: string, exportName: string, stubs: Record<string, unknown>): (...args: unknown[]) => T {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8') + `\nexport { ${exportName} as runtimeUnderTest };`;
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(output, { module, exports: module.exports,
    require: (id: string) => id === 'react' ? hooks : Object.hasOwn(stubs, id) ? stubs[id] : nodeRequire(id),
    crypto: globalThis.crypto, Date, Map, Set, Number, Error, JSON, structuredClone,
  });
  return module.exports.runtimeUnderTest as (...args: unknown[]) => T;
}

let clock: number, positionBook: PositionBook, entryBook: EntryBook;
let failCompletion: boolean, failPositionWrite: boolean, marketDataAvailable: boolean;
let positionTail: Promise<void>, entryTail: Promise<void>;
let positions: PositionsRuntime, runtime: EntryRuntime;
const input: EntryFillInput = { entryPrice: '100', margin: '100', leverage: '5', openedAt: ENTRY_NOW + 60_000 };
function serial<T>(kind: 'position' | 'entry', mutate: () => T): Promise<T> {
  const previous = kind === 'position' ? positionTail : entryTail;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  if (kind === 'position') positionTail = gate; else entryTail = gate;
  return previous.then(() => { try { return mutate(); } finally { release(); } });
}
function buildRuntimes() {
  const shared = { './FlowMonitorContext': { useSharedFlowMonitor: () => ({ data: marketDataAvailable ? entryFlow(clock) : null }) }, './notifications': {}, './storage': {} };
  positions = compileRuntime<PositionsRuntime>('../src/web/PrivatePositionsContext.tsx', 'usePositionBookRuntime', {
    ...shared, '../shared/positionRisk': { createPositionRisk, stepPositionRisk }, '../shared/positionFrame': { positionMarketFrame },
    '../shared/entryWatch': entry, './DirectionSettingsContext': { useDirectionSettings: () => ({ config: DEFAULT_DIRECTION_CONFIG }) },
    './positionBook': {
      emptyPositionBook, readPositionBook: async () => structuredClone(positionBook),
      claimPositionNotifications: async () => [], finishPositionNotification: async () => {},
      updatePositionBook: (change: (book: PositionBook) => PositionBook) => serial('position', () => {
        const next = change(structuredClone(positionBook)); next.revision++; next.updatedAt = clock;
        if (!validPositionBook(next)) throw new Error('position fixture failed validation');
        if (failPositionWrite) { failPositionWrite = false; throw new Error('simulated position commit failure'); }
        positionBook = next; return structuredClone(next);
      }),
    },
  })(null, {});
  runtime = compileRuntime<EntryRuntime>('../src/web/MarketPlansContext.tsx', 'useEntryRuntime', {
    ...shared, '../shared/entryWatch': entry, './PrivatePositionsContext': { usePrivatePositions: () => positions },
    './entryBook': {
      emptyEntryBook, readEntryBook: async () => structuredClone(entryBook),
      claimEntryNotifications: async () => [], finishEntryNotification: async () => {},
      updateEntryBook: (change: (book: EntryBook) => EntryBook) => serial('entry', () => {
        const next = change(structuredClone(entryBook)); next.revision++; next.updatedAt = clock;
        if (!entry.validEntryBook(next)) throw new Error('entry fixture failed validation');
        if (failCompletion && next.watches.some(watch => watch.phase === 'filled')) {
          failCompletion = false; throw new Error('simulated second database commit failure');
        }
        entryBook = next; return structuredClone(next);
      }),
    },
  })();
}
beforeEach(() => {
  clock = ENTRY_NOW + 300_000; vi.spyOn(Date, 'now').mockImplementation(() => clock);
  positionBook = emptyPositionBook(); positionTail = Promise.resolve(); entryTail = Promise.resolve();
  failCompletion = false; failPositionWrite = false; marketDataAvailable = true;
  const plan = entryPlan(), watch = entry.adoptEntryPlan(plan, entryFlow(ENTRY_NOW).marks![0], ENTRY_NOW);
  entryBook = { ...emptyEntryBook(), watches: [watch], updatedAt: ENTRY_NOW };
  buildRuntimes();
});
afterEach(() => vi.restoreAllMocks());

describe('actual fill Context callbacks with serialized transaction doubles', () => {
  it('serializes identical concurrent fills into one draft position with deterministic identity', async () => {
    const ids = await Promise.all([runtime.recordFill('watch-one', input), runtime.recordFill('watch-one', { ...input })]);
    expect(ids).toEqual(['entry_watch-one', 'entry_watch-one']); expect(positionBook.positions).toHaveLength(1);
    expect(positionBook.positions[0]).toMatchObject({ phase: 'draft', plan: null, position: {
      id: 'entry_watch-one', openedAt: input.openedAt, suggestedHoldingLimitMs: entryBook.watches[0].plan.holdingLimitMs,
    } });
    expect(entryBook.watches[0]).toMatchObject({ phase: 'filled', filledPositionId: 'entry_watch-one', fillIntent: input });
  });
  it('preserves intent across a second-database failure and restores it after reconstructing the runtimes', async () => {
    failCompletion = true;
    await expect(runtime.recordFill('watch-one', input)).rejects.toThrow('second database');
    expect(positionBook.positions).toHaveLength(1);
    expect(entryBook.watches[0]).toMatchObject({ phase: 'watching', filledPositionId: null, fillIntent: input });
    const persisted = structuredClone(positionBook.positions[0]);
    buildRuntimes(); await expect(runtime.recordFill('watch-one', input)).resolves.toBe('entry_watch-one');
    expect(positionBook.positions).toEqual([persisted]); expect(entryBook.watches[0].phase).toBe('filled');
  });
  it('keeps intent when the position commit fails and retries without needing market data or a new fill', async () => {
    failPositionWrite = true;
    await expect(runtime.recordFill('watch-one', input)).rejects.toThrow('position commit');
    expect(positionBook.positions).toHaveLength(0); expect(entryBook.watches[0].fillIntent).toEqual(input);
    marketDataAvailable = false; buildRuntimes();
    await runtime.recordFill('watch-one', input);
    expect(positionBook.positions).toHaveLength(1); expect(entryBook.watches[0].phase).toBe('filled');
  });
  it('rejects conflicting actual-fill details without changing the existing position', async () => {
    await runtime.recordFill('watch-one', input); const previous = structuredClone(positionBook);
    await expect(runtime.recordFill('watch-one', { ...input, margin: '200' })).rejects.toThrow('不同实际成交');
    expect(positionBook).toEqual(previous); expect(entryBook.watches[0].fillIntent).toEqual(input);
  });
  it('accepts a late report of a real fill before stop, but rejects a fill timestamp after stop', async () => {
    await runtime.stop('watch-one'); const stoppedAt = clock; clock += 5000;
    await expect(runtime.recordFill('watch-one', { ...input, openedAt: stoppedAt + 1 })).rejects.toThrow('晚于');
    expect(entryBook.watches[0].fillIntent).toBeNull(); expect(positionBook.positions).toHaveLength(0);
    await runtime.recordFill('watch-one', input);
    expect(positionBook.positions[0].position.openedAt).toBe(input.openedAt); expect(entryBook.watches[0].phase).toBe('filled');
  });
  it('does not let stop discard a durable pending fill intent', async () => {
    failCompletion = true; await expect(runtime.recordFill('watch-one', input)).rejects.toThrow('second database');
    await expect(runtime.stop('watch-one')).rejects.toThrow('登记尚在恢复');
    expect(entryBook.watches[0].fillIntent).toEqual(input); expect(positionBook.positions).toHaveLength(1);
  });
  it('does not overwrite an already armed position with a draft when finalizing a recovered fill', async () => {
    failCompletion = true; await expect(runtime.recordFill('watch-one', input)).rejects.toThrow('second database');
    const existing = positionBook.positions[0];
    const plan: RiskPlanDraft = { stopPrice: '95', takeProfitPrice: '110', trailing: null, signalWeakening: false,
      directionConfig: { ...DEFAULT_DIRECTION_CONFIG }, method: 'manual', generatedAt: clock };
    const confirmed = stepPositionRisk(existing, { type: 'confirm', plan, expectedPlanRevision: 0, now: clock,
      frame: { mark: entryFlow(clock).marks![0], atr: null, signal: null } });
    expect(confirmed.error).toBeNull(); expect(validPositionState(confirmed.state)).toBe(true);
    positionBook.positions = [confirmed.state]; const armed = structuredClone(confirmed.state);
    clock += 5000; buildRuntimes(); await runtime.recordFill('watch-one', input);
    expect(positionBook.positions).toEqual([armed]); expect(positionBook.positions[0].phase).toBe('armed');
    expect(positionBook.positions[0].plan).toMatchObject({ revision: 1, stopPrice: '95', confirmedAt: clock - 5000 });
    expect(entryBook.watches[0].phase).toBe('filled');
  });
});
