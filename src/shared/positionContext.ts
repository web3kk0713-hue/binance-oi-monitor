import Decimal from 'decimal.js';
import { changeWindowIssue, compareMetric, latestEndpointIssue, oiChangeIssue, priceChangeIssue,
  type ChangeCondition } from './changeMonitor';
import type { AssetRow, HistoryPoint } from './types';

export const POSITION_THRESHOLDS = { oiPct: 5, flatPricePct: 0.5 } as const;
export type PositionPattern = 'build_flat' | 'build_up' | 'build_down'
  | 'unwind_up' | 'unwind_down' | 'unwind_flat' | 'quiet' | 'unavailable';
export interface PositionContext {
  assetId: string;
  symbol: string;
  windowMinutes: number;
  startAt: number | null;
  endAt: number;
  oiQuantityPct: number | null;
  oiUsdPct: number | null;
  pricePct: number | null;
  fdvPct: number | null;
  oiToFdvPct: number | null;
  oiToFdvChangePct: number | null;
  oiToFdvDeltaPp: number | null;
  pattern: PositionPattern;
  label: string;
  reason: string;
  issues: string[];
  supplyChanged: boolean;
}

const ExactDecimal = Decimal.clone({ precision: 80 });
const finiteNonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const positive = (value: unknown): value is number => finiteNonnegative(value) && value > 0;
const asFinite = (value: Decimal): number | null => {
  const number = value.toNumber();
  return Number.isFinite(number) ? Object.is(number, -0) ? 0 : number : null;
};
const OBSERVATION_LIMIT = '仅比较区间端点，不保证区间连续；不是多空指令，也不代表资金净流入或实际杠杆';
const labels: Record<PositionPattern, string> = {
  build_flat: '增仓横盘', build_up: '增仓上涨', build_down: '增仓下跌',
  unwind_up: '减仓上涨', unwind_down: '减仓下跌', unwind_flat: '减仓横盘',
  quiet: '持仓变化未达观察线', unavailable: '联动数据不足',
};

function alignmentIssue(point: HistoryPoint): string | null {
  return Math.abs(point.oiSourceTime! - point.priceSourceTime!) > 30_000 ? 'OI 与价格源时间偏差超过 30 秒' : null;
}

function ratioValue(point: HistoryPoint): { value: Decimal | null; issue: string | null } {
  if (!finiteNonnegative(point.oiUsd)) return { value: null, issue: 'OI 美元值缺失或无效' };
  if (!positive(point.fdvUsd)) return { value: null, issue: 'FDV 缺失或不大于零' };
  if (!positive(point.priceUsd)) return { value: null, issue: '价格缺失或不大于零' };
  // The archived skew covers all contracts. Check the aggregate source stamps too so malformed
  // metadata cannot pair an otherwise fresh OI with a different price observation.
  const misalignment = alignmentIssue(point);
  if (misalignment) return { value: null, issue: misalignment };
  const value = new ExactDecimal(point.oiUsd).div(point.fdvUsd).times(100);
  return asFinite(value) === null ? { value: null, issue: '占比超出可表示范围' } : { value, issue: null };
}

/**
 * Descriptive, source-aligned endpoint context, never a trading-performance claim.
 * FDV is the already validated historical value; current supply is never backfilled into history.
 */
export function analyzePosition(asset: AssetRow, latest: HistoryPoint, baseline: HistoryPoint | null,
  windowMinutes: number, now: number): PositionContext {
  const result: PositionContext = { assetId: asset.id, symbol: asset.symbol, windowMinutes,
    startAt: baseline?.timestamp ?? null, endAt: latest.timestamp,
    oiQuantityPct: null, oiUsdPct: null, pricePct: null, fdvPct: null,
    oiToFdvPct: null, oiToFdvChangePct: null, oiToFdvDeltaPp: null,
    pattern: 'unavailable', label: labels.unavailable, reason: '', issues: [], supplyChanged: false };
  const issue = (label: string, detail: string | null) => {
    if (detail) result.issues.push(`${label}：${detail}`);
  };
  const finish = (description: string): PositionContext => {
    result.issues = [...new Set(result.issues)];
    result.label = labels[result.pattern];
    result.reason = `${description}；${OBSERVATION_LIMIT}`;
    return result;
  };
  if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 10_080) {
    issue('窗口', '监控参数无效');
    return finish('监控参数无效');
  }

  // A trustworthy current ratio is useful even while the comparison window is warming up.
  const latestIssue = latestEndpointIssue(asset.id, latest, now);
  const currentIssue = latestIssue ?? oiChangeIssue(latest, latest, now, 'usd');
  const currentRatio = currentIssue ? { value: null, issue: currentIssue } : ratioValue(latest);
  result.oiToFdvPct = currentRatio.value === null ? null : asFinite(currentRatio.value);
  issue('当前 OI/FDV', currentRatio.issue);

  const windowIssue = changeWindowIssue(asset.id, latest, baseline, windowMinutes, now);
  if (windowIssue || !baseline) {
    issue('窗口', windowIssue ?? '窗口起点附近尚无已知可用观测');
    return finish(windowIssue ?? '窗口起点附近尚无已知可用观测');
  }

  const quantityIssue = oiChangeIssue(latest, baseline, now, 'quantity');
  const usdIssue = oiChangeIssue(latest, baseline, now, 'usd');
  const priceIssue = priceChangeIssue(latest, baseline, now);
  const observation: ChangeCondition = { enabled: true, direction: 'either', threshold: POSITION_THRESHOLDS.oiPct };
  const displayOnly: ChangeCondition = { enabled: false, direction: 'either', threshold: 0 };
  const quantity = compareMetric(latest.oiQuantity, baseline.oiQuantity, observation, quantityIssue);
  const usd = compareMetric(latest.oiUsd, baseline.oiUsd, displayOnly, usdIssue);
  const price = compareMetric(latest.priceUsd, baseline.priceUsd, displayOnly, priceIssue);
  const fdv = compareMetric(latest.fdvUsd, baseline.fdvUsd, displayOnly, priceIssue);
  result.oiQuantityPct = quantity.pct;
  result.oiUsdPct = usd.pct;
  result.pricePct = price.pct;
  result.fdvPct = fdv.pct;
  issue('OI 数量', quantity.issue);
  issue('OI 美元值', usd.issue);
  issue('价格', price.issue);
  issue('FDV', fdv.issue);

  const baselineRatio = usdIssue ? { value: null, issue: usdIssue } : ratioValue(baseline);
  if (currentRatio.value !== null && baselineRatio.value !== null) {
    result.oiToFdvDeltaPp = asFinite(currentRatio.value.minus(baselineRatio.value));
    if (baselineRatio.value.greaterThan(0)) {
      // Relative change of the levels, not a division of their percentage changes.
      result.oiToFdvChangePct = asFinite(currentRatio.value.div(baselineRatio.value).minus(1).times(100));
      if (result.oiToFdvChangePct === null) issue('OI/FDV 变化', '相对变化超出可表示范围');
    } else issue('OI/FDV 变化', '起点占比为零，无法计算相对变化');
    if (result.oiToFdvDeltaPp === null) issue('OI/FDV 变化', '百分点变化超出可表示范围');
  } else issue('OI/FDV 变化', baselineRatio.issue ?? currentRatio.issue);

  if (price.pct !== null && fdv.pct !== null && positive(latest.priceUsd) && positive(baseline.priceUsd)
    && positive(latest.fdvUsd) && positive(baseline.fdvUsd)) {
    // FDV / price is the implied supply. Flag a > 0.01% revision (strictly greater,
    // compared before rounding); ordinary representation noise should not generate a warning.
    const currentCross = new ExactDecimal(latest.fdvUsd).times(baseline.priceUsd);
    const baselineCross = new ExactDecimal(baseline.fdvUsd).times(latest.priceUsd);
    result.supplyChanged = currentCross.minus(baselineCross).abs().times(100)
      .greaterThan(baselineCross.times('0.01'));
    if (result.supplyChanged) issue('供给口径', '隐含供应量变化超过 0.01%，FDV 不再仅反映价格，占比变化可能含供给修订');
  }

  if (quantity.pct === null || price.pct === null)
    return finish([quantity.issue ? `OI 数量：${quantity.issue}` : '', price.issue ? `价格：${price.issue}` : ''].filter(Boolean).join('；'));
  // Valid individual changes do not by themselves establish a source-aligned linkage.
  const currentAlignment = alignmentIssue(latest), baselineAlignment = alignmentIssue(baseline);
  const linkageIssue = currentAlignment ? `最新${currentAlignment}` : baselineAlignment ? `起点${baselineAlignment}` : null;
  if (linkageIssue) {
    issue('持仓与价格联动', linkageIssue);
    return finish(linkageIssue);
  }
  if (!quantity.matched) {
    result.pattern = 'quiet';
    return finish(`OI 数量涨跌幅未达 ±${POSITION_THRESHOLDS.oiPct}% 的观察线`);
  }
  // Use exact numerators to prevent a displayed +0.50% from masking an actual breakout.
  const priceNumerator = new ExactDecimal(latest.priceUsd!).minus(baseline.priceUsd!).times(100);
  const flatPrice = priceNumerator.abs().lessThanOrEqualTo(new ExactDecimal(baseline.priceUsd!).times(POSITION_THRESHOLDS.flatPricePct));
  const priceState = flatPrice ? 'flat' : priceNumerator.greaterThan(0) ? 'up' : 'down';
  const positionState = new ExactDecimal(latest.oiQuantity!).greaterThan(baseline.oiQuantity!) ? 'build' : 'unwind';
  result.pattern = `${positionState}_${priceState}` as PositionPattern;
  const positionDescription = positionState === 'build' ? `OI 数量增加至少 ${POSITION_THRESHOLDS.oiPct}%` : `OI 数量减少至少 ${POSITION_THRESHOLDS.oiPct}%`;
  const priceDescription = flatPrice ? `价格在 ±${POSITION_THRESHOLDS.flatPricePct}% 内`
    : `价格${priceState === 'up' ? '上涨' : '下跌'}超过 ${POSITION_THRESHOLDS.flatPricePct}%`;
  return finish(`${positionDescription}，${priceDescription}${result.supplyChanged ? '；隐含供应量有修订' : ''}`);
}
