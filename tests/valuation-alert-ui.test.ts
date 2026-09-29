import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AlertEvent } from '../src/shared/types';

// Select the valuation tab for semantic SSR assertions; this is not a browser interaction test.
vi.mock('react', async importOriginal => ({ ...await importOriginal<typeof import('react')>(), useState: () => ['valuation', vi.fn()] }));
vi.mock('../src/web/PrivatePositionsContext', () => ({ usePrivatePositions: () => ({ book: { events: [] }, error: '' }) }));
vi.mock('../src/web/FlowMonitorContext', () => ({ useSharedFlowMonitor: () => ({ data: { events: [] }, error: '' }) }));
vi.mock('../src/web/MarketPlansContext', () => ({ useMarketPlans: () => ({ book: { watches: [], events: [] } }) }));
import RiskAlertCenter from '../src/web/RiskAlertCenter';

const base: AlertEvent = { id: 'legacy', assetId: 'binance:TEST', symbol: 'TEST', level: 'danger',
  ratio: 25, oiUsd: 250_000, fdvUsd: 1_000_000, timestamp: Date.UTC(2026, 8, 29) };
const render = (alerts: AlertEvent[]) => renderToStaticMarkup(createElement(RiskAlertCenter, {
  alerts, onPosition: vi.fn(), onAsset: vi.fn(), onFlow: vi.fn(), onSettings: vi.fn(),
}));

describe('valuation alert history labels', () => {
  it('uses a valuation-wide tab and empty state', () => {
    const html = render([]);
    expect(html).toContain('OI / 估值 <span>0</span>');
    expect(html).toContain('暂无 OI / 估值提醒记录'); expect(html).not.toContain('FDV');
  });

  it('retains the FDV label for legacy records', () => {
    const html = render([base]);
    expect(html).toContain('TEST · OI / FDV 25%');
    expect(html).toContain('合约持仓与完全稀释估值的规模比较，不单独决定多空。');
  });

  it('does not describe market cap as FDV or fully diluted valuation', () => {
    const html = render([{ ...base, valuationBasis: 'marketCap', valuationUsd: 500_000, fdvUsd: null }]);
    expect(html).toContain('TEST · OI / 流通市值 25%');
    expect(html).toContain('合约持仓与流通市值的规模比较，不单独决定多空。');
    expect(html).not.toContain('FDV'); expect(html).not.toContain('完全稀释估值');
  });

  it('distinguishes an explicit null basis from legacy records', () => {
    const html = render([{ ...base, valuationBasis: null, valuationUsd: null }]);
    expect(html).toContain('TEST · OI / 估值 25%');
    expect(html).toContain('合约持仓与估值的规模比较，不单独决定多空。'); expect(html).not.toContain('FDV');
  });

  it('renders mixed stored records with each original basis', () => {
    const html = render([base, { ...base, id: 'cap', symbol: 'CAP', valuationBasis: 'marketCap', valuationUsd: 500_000, fdvUsd: null }]);
    expect(html).toContain('TEST · OI / FDV'); expect(html).toContain('CAP · OI / 流通市值');
  });
});
