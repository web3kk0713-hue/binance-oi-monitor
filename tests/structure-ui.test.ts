import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { proposeStructureAdvice } from '../src/shared/structureAdvice';
import { structureFixture, STRUCTURE_TEST_NOW as NOW } from './structure-fixture';
const mock = vi.hoisted(() => ({ runtime: { now: 0, error: '', frames: new Map(), issues: new Map() },
  shadow: { book: { records: [] }, loaded: true, error: '', save: vi.fn(), stop: vi.fn() } }));
vi.mock('../src/web/PrivatePositionsContext', () => ({ usePrivatePositions: () => mock.runtime }));
vi.mock('../src/web/StructureShadowContext', () => ({ useStructureShadow: () => mock.shadow }));
vi.mock('../src/web/FlowMonitorContext', () => ({ useSharedFlowMonitor: () => ({ data: { rows: [] } }) }));
import StructureLab, { StructureDetails, researchAmount } from '../src/web/StructureLab';
import { createPositionRisk } from '../src/shared/positionRisk';
import { structureChartRows } from '../src/web/StructureChart';

function advice(loss = false) {
  const input = structureFixture(); if (loss) input.position.entryPrice = '110';
  const result = proposeStructureAdvice(input); if (result.status !== 'ready') throw new Error(result.reason); return result.advice;
}
describe('structure research presentation and source scope (SSR, not browser layout)', () => {
  it('keeps closed-position records accessible without an analysis or save action', () => {
    const state = { ...createPositionRisk(structureFixture().position), phase: 'closed' as const, closedAt: NOW };
    const html = renderToStaticMarkup(createElement(StructureLab, { state, recordsOnly: true }));
    expect(html).toContain('观察记录 0'); expect(html).toContain('清除浏览器数据会丢失记录');
    expect(html).not.toContain('重新分析'); expect(html).not.toContain('保存并开始观察');
    expect(html).toContain('页内约 5 秒采样'); expect(html).toContain('没有常驻后台');
    expect(mock.shadow.save).not.toHaveBeenCalled();
  });
  it('renders exact price lines, risk denominator and research boundary, no formal-adoption button', () => {
    const html = renderToStaticMarkup(createElement(StructureDetails, { advice: advice() }));
    expect(html).toContain('97.5'); expect(html).toContain('105.5'); expect(html).toContain('109.5');
    expect(html).toContain('25 USDT'); expect(html).toContain('输入保证金');
    expect(html).toContain('不能据此认定风险合适'); expect(html).toContain('不启用正式离场提醒');
    expect(html).not.toContain('采纳建议并开启提醒'); expect(html).toContain('markPriceKlines / 5m');
  });
  it('calls a losing target 减亏, not assured profit', () => {
    const html = renderToStaticMarkup(createElement(StructureDetails, { advice: advice(true) }));
    expect(html).toContain('第一目标 · 减亏'); expect(html).toContain('第二目标 · 减亏');
    expect(html).toContain('未计手续费'); expect(html).toContain('资金费');
  });
  it('does not manufacture a missing second target', () => {
    const a = advice(); a.target2 = null;
    const html = renderToStaticMarkup(createElement(StructureDetails, { advice: a }));
    expect(html).toContain('暂无有效价位'); expect(html).toContain('不为凑目标而外推');
  });
  it('escapes source-derived prose and retains accessible contextual help', () => {
    const a = advice(); a.reasons = ['<script>bad()</script>'];
    const html = renderToStaticMarkup(createElement(StructureDetails, { advice: a }));
    expect(html).not.toContain('<script>'); expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('候选风险'); expect(html).toContain('多周期价格背景');
  });
  it('formats small amounts without rounding a material tiny risk to zero', () => {
    expect(researchAmount('0')).toBe('0'); expect(researchAmount('-0')).toBe('0');
    expect(researchAmount('.00000123')).toBe('0.00000123'); expect(researchAmount('1.256', true)).toBe('+1.26');
  });
  it('live chart never shows later closed bars as known current data', () => {
    const a = advice(), h = structureFixture().history;
    h.candles.push({ openTime: NOW, closeTime: NOW + 299999, open: '100', high: '111', low: '99', close: '110' });
    const rows = structureChartRows(h, a, 24 * 3_600_000);
    expect(rows.every(r => r.closeTime < NOW)).toBe(true);
    expect(rows[0].openTime).toBe(NOW - 12 * 3_600_000);
    a.mode = 'replay'; expect(structureChartRows(h, a, 3_600_000).at(-1)!.closeTime).toBe(NOW + 299999);
    expect(structureChartRows({ ...h, marketKey: 'futures:OTHERUSDT' }, a, 0)).toEqual([]);
  });
});
