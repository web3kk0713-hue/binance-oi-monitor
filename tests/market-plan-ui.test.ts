import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DIRECTION_CONFIG } from '../src/shared/directionConfig';
import type { EntryWatch } from '../src/shared/entryWatch';
import type { FlowMarket, FlowMetrics, FlowSnapshot } from '../src/shared/flowTypes';
import type { MarketPlan } from '../src/shared/marketPlanTypes';
import { createPositionRisk } from '../src/shared/positionRisk';
import type { MarkObservation, PositionRiskState } from '../src/shared/positionTypes';

const mock = vi.hoisted(() => ({ flow: null as FlowSnapshot | null, watches: [] as EntryWatch[], loaded: true, error: '', now: 0,
  positions: [] as PositionRiskState[], positionsLoaded: true, positionsError: '',
  mark: null as MarkObservation | null, adopt: vi.fn(), stop: vi.fn(), recordFill: vi.fn(), load: vi.fn(), analyze: vi.fn(), close: vi.fn() }));
vi.mock('../src/web/FlowMonitorContext', () => ({ useSharedFlowMonitor: () => ({ data: mock.flow }) }));
vi.mock('../src/web/DirectionSettingsContext', () => ({ useDirectionSettings: () => ({ config: { oiPct: 5, pricePct: .5, flowSharePct: 60, requireSpot: false } }) }));
vi.mock('../src/web/MarketPlansContext', () => ({ useMarketPlans: () => ({ book: { watches: mock.watches, revision: 1, events: [] }, loaded: mock.loaded,
  error: mock.error, now: mock.now, markFor: () => mock.mark, adopt: mock.adopt, stop: mock.stop, recordFill: mock.recordFill }) }));
vi.mock('../src/web/PrivatePositionsContext', () => ({ usePrivatePositions: () => ({ book: { positions: mock.positions }, loaded: mock.positionsLoaded, error: mock.positionsError }) }));
vi.mock('../src/web/structureResources', () => ({ structureHistoryClient: { load: mock.load } }));
vi.mock('../src/web/marketPlanComputation', () => ({ createMarketPlanComputationClient: () => ({ analyze: mock.analyze, close: mock.close }) }));
import MarketPlanPanel, { freshPlanReference, MarketFillForm, MarketPlanCandidate, MarketPlanPrices, MarketPlanRules, MarketWatchList, selectPlanMarket } from '../src/web/MarketPlanPanel';

const NOW = Date.UTC(2026, 8, 29, 12);
const market: FlowMarket = { key: 'futures:TESTUSDT', symbol: 'TESTUSDT', baseAsset: 'TEST', assetId: 'binance:TEST', quoteAsset: 'USDT', venue: 'futures' };
const mark: MarkObservation = { marketKey: market.key, markPrice: '100', sourceTime: NOW, receivedAt: NOW, source: 'binance-mark-stream' };
function row(selected: FlowMarket = market): FlowMetrics {
  return { market: selected, asOf: NOW, status: 'live', reason: '', price: 100, priceChange5m: .8, volume5m: 10000, buyShare5m: 65,
    delta5m: 3000, volumeMultiple: 2, vwap5m: 100, range5mPct: 1, atr14: 1, oiChange5m: 6, funding: null, depth: null,
    baselineWindows: 20, tradeSamples: 100, largeTradeThreshold: 1000, lastTradeAt: NOW, lastCandleAt: NOW - 1 };
}
function snapshot(rows: FlowMetrics[] = [row()]): FlowSnapshot {
  return { schemaVersion: 1, rows, events: [], marks: [mark], status: { mode: 'direct', startedAt: NOW - 600000, asOf: NOW, connectedStreams: 1, totalStreams: 1,
    markets: 1, readyMarkets: 1, warmingMarkets: 0, staleMarkets: 0, backfilledMarkets: 1, errors: [], retentionDays: 7, scope: 'fixture' } };
}
function plan(): MarketPlan {
  return { version: 'entry-structure-v1', id: 'plan-1', market, side: 'long', generatedAt: NOW, asOf: NOW, referencePrice: '100', tickSize: '.1',
    entryLow: '99.2', entryHigh: '100.1', stopPrice: '97.5', targetPrice: '105.5', netRewardRisk: '1.8', roundTripCostBps: 12,
    waitUntil: NOW + 1800000, holdingLimitMs: 14400000, directionConfig: { ...DEFAULT_DIRECTION_CONFIG }, historyFrom: NOW - 604800000, historyTo: NOW - 1,
    support: { price: '98', confirmedAt: NOW - 900000 }, resistance: { price: '106', confirmedAt: NOW - 900000 }, atr15: '2', buffer: '.5', reasons: ['已确认结构'] };
}
function watch(changes: Partial<EntryWatch> = {}): EntryWatch {
  return { plan: plan(), adoptedAt: NOW, phase: 'watching', lastMark: mark, lastEvaluatedAt: NOW, gap: false, triggeredAt: null,
    filledPositionId: null, reason: '等待新的 5m 方向条件与进场区间。', fillIntent: null, ...changes };
}
function filledPosition(): PositionRiskState {
  return createPositionRisk({ id: 'entry_plan-1', marketKey: market.key, symbol: market.symbol, assetId: market.assetId, side: 'long',
    entryPrice: '100', margin: '10', leverage: '2', createdAt: NOW });
}
beforeEach(() => {
  vi.clearAllMocks(); vi.spyOn(Date, 'now').mockReturnValue(NOW);
  mock.flow = snapshot(); mock.watches = []; mock.loaded = true; mock.error = ''; mock.now = NOW; mock.mark = mark;
  mock.positions = []; mock.positionsLoaded = true; mock.positionsError = '';
});
afterEach(() => vi.restoreAllMocks());

describe('market plan presentation and identity (SSR, not browser interaction acceptance)', () => {
  it('matches only the exact requested market without spot or quote substitution', () => {
    const spot = { ...market, key: 'spot:TESTUSDT', venue: 'spot' as const };
    const usdc = { ...market, key: 'futures:TESTUSDC', symbol: 'TESTUSDC', quoteAsset: 'USDC' };
    const flow = snapshot([row(), row(spot), row(usdc)]);
    expect(selectPlanMarket(flow, market.key, market.assetId)).toEqual(market);
    expect(selectPlanMarket(flow, spot.key, market.assetId)).toBeNull();
    expect(selectPlanMarket(flow, usdc.key, market.assetId)).toBeNull();
    expect(selectPlanMarket(flow, 'futures:UNKNOWNUSDT', market.assetId)).toBeNull();
    expect(selectPlanMarket(flow, market.key, 'other')).toBeNull();
    expect(selectPlanMarket(snapshot([row(), row()]), market.key, market.assetId)).toBeNull();
    expect(selectPlanMarket(flow)).toBeNull();
  });
  it('requires a fresh exact-market mark and valid source-receipt order', () => {
    expect(freshPlanReference(mark, market.key, NOW)).toBe(true);
    expect(freshPlanReference(mark, market.key, NOW + 15001)).toBe(false);
    expect(freshPlanReference(mark, 'futures:OTHERUSDT', NOW)).toBe(false);
    expect(freshPlanReference({ ...mark, receivedAt: NOW - 1 }, market.key, NOW)).toBe(false);
  });
  it('renders a compact exact-decimal price plan and explicitly frozen confirmation rule', () => {
    const html = renderToStaticMarkup(createElement(MarketPlanPrices, { plan: plan() })) + renderToStaticMarkup(createElement(MarketPlanRules, { plan: plan() }));
    expect(html).toContain('99.2 – 100.1'); expect(html).toContain('97.5'); expect(html).toContain('105.5');
    expect(html).toContain('结束时间晚于采纳时刻的新 5m 窗口'); expect(html).toContain('不是仅触价提醒');
    expect(html).toContain('往返 12 bps'); expect(html).toContain('成本假设不保证');
  });
  it('does not fetch or compute before an explicit analysis action; defaults holding to 240 minutes', () => {
    const html = renderToStaticMarkup(createElement(MarketPlanPanel, { marketKey: market.key, assetId: market.assetId }));
    expect(html).toContain('分析进场计划'); expect(html).toContain('点击后才读取本合约历史');
    expect(html).toMatch(/<option value="240" selected="">240 分钟<\/option>/);
    expect(html).toContain('未验证收益'); expect(html).toContain('非自动交易'); expect(html).toContain('关页 / 休眠会暂停');
    expect(mock.load).not.toHaveBeenCalled(); expect(mock.analyze).not.toHaveBeenCalled();
  });
  it('makes historical event viewing read-only, including saved watch actions', () => {
    mock.watches = [watch()];
    const html = renderToStaticMarkup(createElement(MarketPlanPanel, { marketKey: market.key, assetId: market.assetId, replay: true }));
    expect(html).toContain('历史事件回看仅供查看'); expect(html).not.toContain('>分析进场计划</button>');
    expect(html).not.toContain('>记录实际成交</button>'); expect(html).not.toContain('>停止观察</button>');
    expect(mock.load).not.toHaveBeenCalled(); expect(mock.adopt).not.toHaveBeenCalled();
  });
  it('requires an explicit side while direction is wait', () => {
    mock.flow!.rows[0].oiChange5m = 0;
    const html = renderToStaticMarkup(createElement(MarketPlanPanel, { marketKey: market.key }));
    expect(html).toContain('当前方向未确认'); expect(html).toContain('仍须等待新的 5m 确认');
    expect(html).toMatch(/<option value="" selected="">选择做多或做空<\/option>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>分析进场计划<\/button>/);
  });
  it('starts all actual-fill inputs blank and warns that reminders remain unarmed', () => {
    const html = renderToStaticMarkup(createElement(MarketFillForm, { watch: watch(), onCancel: vi.fn(), onSaved: vi.fn() }));
    expect((html.match(/value=""/g) ?? [])).toHaveLength(4);
    expect(html).toContain('实际开仓价'); expect(html).toContain('实际成交时间'); expect(html).toContain('不会下单或自动启用离场提醒');
    expect(html).toContain('可迟录观察有效期间的成交'); expect(mock.recordFill).not.toHaveBeenCalled();
  });
  it('shows data pause, storage failure, and interrupted-observation limits visibly', () => {
    mock.watches = [watch({ gap: true })]; mock.mark = null; mock.error = '本机记录不可用';
    const html = renderToStaticMarkup(createElement(MarketWatchList));
    expect(html).toContain('role="alert">本机记录不可用'); expect(html).toContain('观察暂停');
    expect(html).toContain('不推断离线期间条件'); expect(html).toContain('最多 5 个活跃观察、100 份历史');
  });
  it('keeps an interrupted fill intent recoverable without offering duplicate fill action', () => {
    mock.watches = [watch({ fillIntent: { entryPrice: '100', margin: '10', leverage: '2', openedAt: NOW } })];
    const html = renderToStaticMarkup(createElement(MarketWatchList));
    expect(html).toContain('实际成交记录正在恢复'); expect(html).not.toContain('>记录实际成交</button>');
  });
  it('routes a filled watch to unarmed-position protection review instead of claiming auto execution', () => {
    mock.watches = [watch({ phase: 'filled', filledPositionId: 'entry_plan-1', fillIntent: { entryPrice: '100', margin: '10', leverage: '2', openedAt: NOW } })];
    mock.positions = [filledPosition()];
    const html = renderToStaticMarkup(createElement(MarketWatchList));
    expect(html).toContain('去我的持仓核对并采纳结构保护'); expect(html).toContain('离场提醒未启用');
    expect(html).not.toContain('>记录实际成交</button>');
  });
  it('keeps active watches and the latest completion visible without mounting all historical detail rows', () => {
    mock.watches = [watch(), ...Array.from({ length: 20 }, (_, index) => watch({ phase: 'stopped', plan: { ...plan(), id: `old-${index}` }, reason: `历史原因${index}` }))];
    const html = renderToStaticMarkup(createElement(MarketWatchList));
    expect(html).toContain('等待新的 5m'); expect(html).toContain('历史原因0'); expect(html).not.toContain('历史原因19');
    expect(html).toContain('查看较早观察记录 19'); expect(html).toContain('aria-expanded="false"');
  });
  it('allows an immediately returned candidate despite a provider timestamp from the previous tick', () => {
    mock.now = NOW - 5000;
    const html = renderToStaticMarkup(createElement(MarketPlanCandidate, { plan: plan(), adopting: false, onAdopt: vi.fn() }));
    expect(html).not.toContain('候选已过期');
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>采纳并开始条件观察<\/button>/);
  });
  it('uses current render time for direction and fresh mark status, not provider publication time', () => {
    mock.now = NOW - 5000; mock.watches = [watch()];
    const html = renderToStaticMarkup(createElement(MarketPlanPanel, { marketKey: market.key, assetId: market.assetId }));
    expect(html).toMatch(/<option value="long" selected="">/);
    expect(html).not.toContain('观察暂停');
  });
  it('still expires genuinely old candidates and detects a real clock rollback', () => {
    for (const generatedAt of [NOW - 60001, NOW + 1]) {
      const html = renderToStaticMarkup(createElement(MarketPlanCandidate, { plan: { ...plan(), generatedAt }, adopting: false, onAdopt: vi.fn() }));
      expect(html).toContain('候选已过期'); expect(html).toMatch(/<button[^>]*disabled=""[^>]*>采纳并开始条件观察<\/button>/);
    }
  });
  it('shows saved prices only in the watch, not a second candidate card', () => {
    mock.watches = [watch()];
    const html = renderToStaticMarkup(createElement(MarketPlanCandidate, { plan: plan(), adopting: false, onAdopt: vi.fn() }))
      + renderToStaticMarkup(createElement(MarketWatchList));
    expect((html.match(/99.2 – 100.1/g) ?? [])).toHaveLength(1);
    expect(html).not.toContain('>已采纳观察</button>');
  });
  it('shows the latest linked protection revision instead of an outdated fill receipt', () => {
    mock.watches = [watch({ phase: 'filled', filledPositionId: 'entry_plan-1', reason: '旧回执：离场提醒尚未自动启用', fillIntent: { entryPrice: '100', margin: '10', leverage: '2', openedAt: NOW } })];
    mock.positions = [{ ...filledPosition(), phase: 'armed', plan: { revision: 3 } as PositionRiskState['plan'] }];
    const html = renderToStaticMarkup(createElement(MarketWatchList));
    expect(html).toContain('离场提醒已启用 · v3'); expect(html).not.toContain('尚未自动启用'); expect(html).not.toContain('去我的持仓核对并采纳结构保护');
    expect(mock.watches[0].reason).toBe('旧回执：离场提醒尚未自动启用');
  });
  it('shows a manually closed linked position and does not ask to enable its protection', () => {
    mock.watches = [watch({ phase: 'filled', filledPositionId: 'entry_plan-1', fillIntent: { entryPrice: '100', margin: '10', leverage: '2', openedAt: NOW } })];
    mock.positions = [{ ...filledPosition(), phase: 'closed', closedAt: NOW, plan: { revision: 3 } as PositionRiskState['plan'] }];
    const html = renderToStaticMarkup(createElement(MarketWatchList));
    expect(html).toContain('实际仓位已登记离场'); expect(html).not.toContain('离场提醒未启用'); expect(html).not.toContain('采纳结构保护');
  });
  it('asks to verify a missing linked position instead of claiming its protection is unarmed', () => {
    mock.watches = [watch({ phase: 'filled', filledPositionId: 'entry_plan-1', fillIntent: { entryPrice: '100', margin: '10', leverage: '2', openedAt: NOW } })];
    const html = renderToStaticMarkup(createElement(MarketWatchList));
    expect(html).toContain('未找到关联实际仓位，请核查'); expect(html).not.toContain('尚未自动启用');
  });
});
