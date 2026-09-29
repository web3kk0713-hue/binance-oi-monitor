import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DIRECTION_CONFIG } from '../src/shared/directionConfig';
import { toHistoryPoint } from '../src/shared/history';
import { emptyMarket } from '../src/shared/liveMarket';
import { analyzePosition } from '../src/shared/positionContext';
import type { AlertEvent, AssetRow, HistoryPoint, Snapshot } from '../src/shared/types';

const mock = vi.hoisted(() => ({ snapshot: null as Snapshot | null, points: [] as HistoryPoint[], network: vi.fn(), notification: vi.fn() }));
vi.mock('../src/web/useMonitor', () => ({
  useMonitor: () => ({ snapshot: mock.snapshot, progress: null, collecting: false, nextRun: 0, retryAt: 0,
    error: null, storageError: null, backend: null, historyVersion: 0, shortline: {}, refresh: vi.fn() }),
  useHistory: () => ({ points: mock.points, loading: false, error: null }), backendGet: mock.network,
}));
vi.mock('../src/web/useLiveMarket', () => ({ useLiveMarket: () => ({ futures: emptyMarket('SSR fixture'), spot: emptyMarket('SSR fixture') }) }));
vi.mock('../src/web/notifications', () => ({ notificationSupport: () => false, registerNotifications: mock.notification,
  requestNotifications: mock.notification, showAlertNotification: mock.notification, connectPush: mock.notification, disconnectPush: mock.notification }));
vi.mock('../src/web/FlowMonitorContext', () => ({ FlowMonitorProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('../src/web/DirectionSettingsContext', () => ({
  DirectionSettingsProvider: ({ children }: { children: ReactNode }) => children,
  useDirectionSettings: () => ({ config: DEFAULT_DIRECTION_CONFIG, apply: vi.fn(), notice: '', revision: 0 }),
}));
vi.mock('../src/web/PrivatePositionsContext', () => ({ PrivatePositionsProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('../src/web/StructureShadowContext', () => ({ StructureShadowProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('../src/web/MarketPlansContext', () => ({ MarketPlansProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('../src/web/MarketPlanPanel', () => ({ default: () => null }));
vi.mock('../src/web/Charts', () => ({ HistoryCharts: () => null, ScatterChart: () => null }));

import App, { AlertDialog, SourceDialog } from '../src/web/App';
import { PositionPanel } from '../src/web/PositionPanel';

const NOW = Date.UTC(2026, 8, 29, 10);
function asset(patch: Partial<AssetRow> = {}): AssetRow {
  return { id: 'binance:CAP', symbol: 'CAP', name: 'Synthetic cap fixture', contracts: ['CAPUSDT'], priceUsd: 10,
    oiUsd: 750_000, oiQuantity: 75_000, marketCapUsd: 1_000_000, fdvUsd: null, oiToFdv: null, oiToMarketCap: 75,
    circulatingSupply: 100_000, maxSupply: null, updatedAt: NOW, oiUpdatedAt: NOW, priceUpdatedAt: NOW,
    supplyUpdatedAt: NOW, complete: true, alertEligible: true, issues: [], supplySource: null, mappingStatus: 'unmapped',
    evidence: { mapping: 'CoinGecko ID 尚未核实', supply: null,
      contracts: [{ symbol: 'CAPUSDT', baseAsset: 'CAP', quoteAsset: 'USDT', openInterest: '75000', markPrice: '10',
        indexPrice: '10', quoteUsd: '1', oiTime: NOW, priceTime: NOW, quoteTime: NOW, oiUsd: 750_000, unitMultiplier: 1 }],
      marketCap: { provider: 'Binance', upstream: 'CoinMarketCap', contractSymbol: 'CAPUSDT', circulatingSupply: 100_000,
        unitMultiplier: 1, sourceTime: NOW - 300_000, fetchedAt: NOW,
        url: 'https://fapi.binance.com/futures/data/openInterestHist?symbol=CAPUSDT&period=5m&limit=1' } }, ...patch };
}
function snapshot(row = asset()): Snapshot {
  return { schemaVersion: 1, mode: 'direct', startedAt: NOW - 1000, asOf: NOW, durationMs: 1000,
    universe: { assets: 1, contracts: 1 }, coverage: { oi: 1, marketCap: 1, fdv: row.fdvUsd === null ? 0 : 1, eligible: 1, failedContracts: 0 },
    assets: [row], errors: [] };
}
function selectedMetrics(html: string) {
  return html.split('<div class="selected-metrics">')[1]?.split('<section class="shortline-observation"')[0] ?? '';
}

beforeEach(() => {
  mock.snapshot = snapshot(); mock.points = []; mock.network.mockClear(); mock.notification.mockClear();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.stubGlobal('location', { search: '?view=valuation&asset=binance%3ACAP', href: 'https://example.test/?view=valuation&asset=binance%3ACAP' });
  vi.stubGlobal('localStorage', { getItem: () => null });
  vi.stubGlobal('fetch', mock.network);
});
afterEach(() => {
  expect(mock.network).not.toHaveBeenCalled(); expect(mock.notification).not.toHaveBeenCalled();
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

// Semantic server-rendered output only: no browser, permissions, network, or end-user click acceptance.
describe('valuation dashboard basis semantics', () => {
  it('shows the market-cap ratio in the App while leaving original FDV empty', () => {
    const html = renderToStaticMarkup(createElement(App)), metrics = selectedMetrics(html);
    expect(metrics).toContain('OI / 流通市值'); expect(metrics).toContain('>75%</strong>');
    expect(metrics).toMatch(/legend-dot fdv-dot[^]*?<strong>—<\/strong>/);
    expect([...metrics.matchAll(/<strong[^>]*>(.*?)<\/strong>/g)].map(match => match[1]))
      .toEqual(['$750.0K', '$1.00M', '—', '75%']);
    const table = html.split('<tbody>')[1]?.split('</tbody>')[0] ?? '';
    expect(table).toContain('>75%</span>'); expect(table).toContain('class="change-unit">流通市值</small>');
    expect(mock.snapshot!.assets[0].fdvUsd).toBeNull(); expect(mock.snapshot!.assets[0].oiToFdv).toBeNull();
  });

  it('keeps FDV preferred when both valuation fields are available', () => {
    mock.snapshot = snapshot(asset({ fdvUsd: 2_000_000, oiToFdv: 37.5 }));
    const metrics = selectedMetrics(renderToStaticMarkup(createElement(App)));
    expect(metrics).toContain('OI / FDV'); expect(metrics).toContain('>37.5%</strong>');
    expect([...metrics.matchAll(/<strong[^>]*>(.*?)<\/strong>/g)].map(match => match[1]))
      .toEqual(['$750.0K', '$1.00M', '$2.00M', '37.5%']);
  });

  it('uses market-cap history for changes and sample coverage without filling raw FDV', () => {
    const baseline = toHistoryPoint(asset(), snapshot());
    const latestRow = asset({ oiUsd: 880_000, oiQuantity: 88_000, marketCapUsd: 1_100_000,
      oiToMarketCap: 80, circulatingSupply: 110_000 });
    latestRow.evidence.contracts = latestRow.evidence.contracts.map(contract => ({ ...contract, openInterest: '88000', oiUsd: 880_000 }));
    latestRow.evidence.marketCap = { ...latestRow.evidence.marketCap!, circulatingSupply: 110_000 };
    mock.snapshot = snapshot(latestRow);
    mock.points = [{ ...baseline, timestamp: NOW - 300_000, availableAt: NOW - 300_000,
      oiSourceTime: NOW - 300_000, priceSourceTime: NOW - 300_000 }, toHistoryPoint(latestRow, mock.snapshot)];
    const original = structuredClone(mock.points);
    expect(mock.points.map(point => point.priceUsd)).toEqual([10, 10]);
    expect(mock.points.map(point => point.fdvUsd)).toEqual([null, null]);

    const html = renderToStaticMarkup(createElement(App));
    const summary = html.split('aria-label="已采集区间变化">')[1]?.split('class="history-coverage"')[0] ?? '';
    expect(summary).toContain('流通市值 变化'); expect(summary).toMatch(/OI \/ 流通市值\s*变化/);
    expect([...summary.matchAll(/<strong class="value">(.*?)<\/strong>/g)].map(match => match[1]))
      .toEqual(['+17.33%', '+10%', '+5 pp']);
    expect(summary).not.toContain('>FDV 变化'); expect(summary).not.toContain('>OI / FDV 变化');
    expect(html).toContain('OI 与流通市值有效样本 2');
    expect([...selectedMetrics(html).matchAll(/<strong[^>]*>(.*?)<\/strong>/g)].map(match => match[1]))
      .toEqual(['$880.0K', '$1.10M', '—', '80%']);
    expect(mock.points).toEqual(original); expect(mock.snapshot.assets[0].fdvUsd).toBeNull();
  });

  it('labels a real computed PositionPanel context as market cap', () => {
    const row = asset(), latest = toHistoryPoint(row, snapshot(row));
    const baseline: HistoryPoint = { ...latest, timestamp: NOW - 300_000, availableAt: NOW - 300_000,
      oiSourceTime: NOW - 300_000, priceSourceTime: NOW - 300_000, oiUsd: 700_000, oiQuantity: 70_000 };
    const value = analyzePosition(row, latest, baseline, 5, NOW);
    expect(value.valuationBasis).toBe('marketCap'); expect(value.oiToFdvPct).toBe(75);
    const html = renderToStaticMarkup(createElement(PositionPanel, { value, flow: null, now: NOW }));
    expect(html).toContain('OI / 流通市值 占比'); expect(html).toContain('>流通市值变化');
    expect(html).not.toContain('>OI / FDV 占比'); expect(html).not.toContain('>FDV变化');
    expect(html).toContain('<strong>75%</strong>');
  });

  it('does not interpret an AlertDialog explicit null basis as legacy FDV', () => {
    const alert: AlertEvent = { id: 'null-basis', assetId: 'binance:CAP', symbol: 'CAP', level: 'critical',
      ratio: 110, oiUsd: 750_000, fdvUsd: 2_000_000, valuationBasis: null, valuationUsd: null, timestamp: NOW };
    const html = renderToStaticMarkup(createElement(AlertDialog, { alert, test: false, onClose: vi.fn(), onSelect: vi.fn() }));
    expect(html).toContain('OI / 估值'); expect(html).toContain('合约 OI $750.0K，估值 —。');
    expect(html).not.toContain('FDV'); expect(html).not.toContain('$2.00M');
  });

  it('keeps contract-bound market-cap evidence visible despite unverified CoinGecko mapping', () => {
    const row = asset();
    const html = renderToStaticMarkup(createElement(SourceDialog, { row, snapshot: snapshot(row), onClose: vi.fn() }));
    expect(row.mappingStatus).toBe('unmapped'); expect(row.evidence.supply).toBeNull();
    expect(html).toContain('CoinGecko ID 尚未核实');
    expect(html).toContain('FDV 供应源映射'); expect(html).toContain('待核对');
    expect(html).toContain('FDV 供应源映射不决定独立流通市值是否可用；后者按 Binance 合约身份与流通量证据单独核验。');
    expect(html).toContain('流通市值补充来源'); expect(html).toContain('Binance 转引 CoinMarketCap');
    expect(html).toContain('symbol=CAPUSDT&amp;period=5m&amp;limit=1');
    expect(html).toContain('&quot;contractSymbol&quot;: &quot;CAPUSDT&quot;');
    expect(html).toContain('原始 FDV 不补造');
    expect(html).toContain('统计时间不是 CoinMarketCap 原始供应量更新时间。');
  });
});
