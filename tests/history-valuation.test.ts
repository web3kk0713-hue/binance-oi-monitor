import { describe, expect, it } from 'vitest';
import { analyzeHistory, historySeries } from '../src/shared/history';
import type { HistoryPoint } from '../src/shared/types';

const NOW = Date.UTC(2026, 8, 29, 10), MINUTE = 60_000;
function point(minutesAgo: number, oiUsd: number | null, marketCapUsd: number | null, fdvUsd: number | null = null): HistoryPoint {
  return { assetId: 'synthetic', timestamp: NOW - minutesAgo * MINUTE, availableAt: NOW - minutesAgo * MINUTE,
    oiUsd, marketCapUsd, fdvUsd, oiToFdv: null, oiToMarketCap: null, complete: true, samplingIntervalMs: 30_000 };
}
const analyze = (points: HistoryPoint[], now = NOW) => analyzeHistory(points, 'synthetic', 5 / 60, now);

describe('selected-valuation history summaries', () => {
  it('uses market cap without repurposing any raw FDV metric or series', () => {
    const input = [point(5, 750_000, 1_000_000), point(0, 880_000, 1_100_000)], before = structuredClone(input);
    const result = analyze(input);
    expect(result.baseline?.timestamp).toBe(NOW - 5 * MINUTE);
    expect(result.oiChange).toBeCloseTo(17.3333333333);
    expect(result.valuationSummary).toMatchObject({ basis: 'marketCap', label: '流通市值', diff: 100_000, ratioPp: 5, validPoints: 2, issue: null });
    expect(result.valuationSummary.pct).toBeCloseTo(10);
    expect(result.fdvChange).toBeNull(); expect(result.fdvDifference).toBeNull(); expect(result.ratioDifference).toBeNull();
    expect(result.validPoints).toBe(0); expect(result.coversWindow).toBe(true);
    const series = historySeries(result.points, result.baseline, 'change');
    expect(series.every(item => item.fdvUsd === null && item.oiToFdv === null)).toBe(true);
    expect(series.at(-1)?.marketCapUsd).toBeCloseTo(10);
    expect(input).toEqual(before);
  });

  it('starts OI, valuation and all raw curves together when market cap arrives after OI', () => {
    const result = analyze([point(5, 100, null), point(3, 750_000, 1_000_000), point(0, 880_000, 1_100_000)]);
    expect(result.baseline?.timestamp).toBe(NOW - 3 * MINUTE); expect(result.coversWindow).toBe(false);
    expect(result.oiChange).toBeCloseTo(17.3333333333); expect(result.oiDifference).toBe(130_000);
    expect(result.valuationSummary.pct).toBeCloseTo(10); expect(result.valuationSummary.validPoints).toBe(2);
    const series = historySeries(result.points, result.baseline, 'change');
    expect(series[0].oiUsd).toBeNull();
    expect(series.find(item => item.timestamp === result.baseline!.timestamp)).toMatchObject({ oiUsd: 0, marketCapUsd: 0, fdvUsd: null });
  });

  it('keeps conventional FDV results unchanged and ignores earlier market-cap-only points for that baseline', () => {
    const result = analyze([point(5, 500_000, 1_000_000), point(3, 750_000, 1_000_000, 2_000_000), point(0, 880_000, 1_100_000, 2_200_000)]);
    expect(result.baseline?.timestamp).toBe(NOW - 3 * MINUTE);
    expect(result.valuationSummary).toMatchObject({ basis: 'fdv', label: 'FDV', validPoints: 2, issue: null });
    expect(result.valuationSummary.pct).toBe(result.fdvChange);
    expect(result.valuationSummary.diff).toBe(result.fdvDifference);
    expect(result.valuationSummary.ratioPp).toBe(result.ratioDifference);
    expect(result.validPoints).toBe(2);
  });

  it('does not compare a lone new market-cap sample against preceding FDV samples', () => {
    const result = analyze([point(5, 500_000, 1_000_000, 2_000_000), point(0, 880_000, 1_100_000)]);
    expect(result.baseline?.timestamp).toBe(NOW);
    expect(result.oiChange).toBeNull(); expect(result.valuationSummary.pct).toBeNull();
    expect(result.valuationSummary.diff).toBeNull(); expect(result.valuationSummary.ratioPp).toBeNull();
    expect(result.valuationSummary.validPoints).toBe(1); expect(result.coversWindow).toBe(false);
  });

  it('blocks cross-basis change if the old fallback baseline is the only OI-valid point', () => {
    const result = analyze([point(5, 750_000, 1_000_000), point(0, null, 1_100_000, 2_200_000)]);
    expect(result.baseline?.timestamp).toBe(NOW - 5 * MINUTE);
    expect(result.valuationSummary.issue).toContain('估值口径切换');
    expect(result.valuationSummary.pct).toBeNull(); expect(result.valuationSummary.diff).toBeNull(); expect(result.valuationSummary.ratioPp).toBeNull();
  });

  it('keeps missing, single-sample and stale valuations out of change outputs', () => {
    for (const result of [analyze([]), analyze([point(0, 750_000, 1_000_000)]), analyze([point(5, 750_000, 1_000_000), point(3, 880_000, 1_100_000)])]) {
      expect(result.valuationSummary.pct).toBeNull(); expect(result.valuationSummary.diff).toBeNull(); expect(result.valuationSummary.ratioPp).toBeNull();
    }
  });
});
