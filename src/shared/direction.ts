import { selectFlowContext, type FlowContextRow } from './flowContext';
import type { FlowSnapshot } from './flowTypes';

/** Transparent experimental filters, not calibrated probabilities or an execution strategy. */
export const DIRECTION_RULES = Object.freeze({
  version: 'direction-v1' as const, windowMinutes: 5, oiPct: 5,
  pricePct: 0.5, futuresBuyPct: 60, futuresSellPct: 40, spotBuyPct: 55, spotSellPct: 45,
});

export interface DirectionAssessment {
  bias: 'long' | 'short' | 'wait';
  label: string;
  confirmation: string;
  reason: string;
  evidence: string[];
  risks: string[];
  invalidation: string;
  marketKey: string | null;
  symbol: string | null;
  asOf: number | null;
  windowStart: number | null;
  windowEnd: number | null;
  ruleVersion: 'direction-v1';
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const signedPct = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
const sameSide = (share: number, delta: number) => share > 50 ? delta > 0 : share < 50 ? delta < 0 : delta === 0;
const hasTrade = (row: FlowContextRow | null): row is FlowContextRow & {
  buyShare5m: number; delta5m: number; priceChange5m: number; windowStart: number; windowEnd: number;
} => row !== null && finite(row.buyShare5m) && finite(row.delta5m) && finite(row.priceChange5m)
  && row.priceChange5m >= -100 && row.buyShare5m >= 0 && row.buyShare5m <= 100
  && Number.isSafeInteger(row.windowStart) && row.windowStart! > 0
  && Number.isSafeInteger(row.windowEnd) && row.windowEnd! - row.windowStart! === 300_000;

/**
 * Current, single-contract, fixed-five-minute bias only. No FDV, user filter window,
 * historical events or future event outcomes participate. Spot confirms or vetoes;
 * funding is separately disclosed risk, never an independent directional vote.
 */
export function assessDirection(snapshot: FlowSnapshot | null, assetId: string | undefined,
  now: number, preferredMarketKey?: string | null): DirectionAssessment {
  const result: DirectionAssessment = {
    bias: 'wait', label: '观望 · 暂不交易', confirmation: '方向条件未齐',
    reason: '', evidence: [],
    risks: ['试验规则，未回测收益或胜率', '未评估盘口深度、滑点、手续费及可执行性'],
    invalidation: '必需条件缺失、冲突或数据过期时维持观望；这不是止损或自动平仓规则',
    marketKey: null, symbol: null, asOf: null, windowStart: null, windowEnd: null,
    ruleVersion: DIRECTION_RULES.version,
  };
  if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.rows)) {
    result.reason = '缺少有效订单流快照，等待同合约5分钟数据';
    return result;
  }
  const { futures } = selectFlowContext(snapshot, assetId, now, preferredMarketKey);
  if (!futures || (preferredMarketKey?.startsWith('futures:') && futures.marketKey !== preferredMarketKey)) {
    result.reason = '所选标的或合约暂无可核验的5分钟数据';
    return result;
  }
  result.marketKey = futures.marketKey;
  result.symbol = futures.symbol;
  result.asOf = futures.asOf > 0 ? futures.asOf : null;
  result.windowStart = futures.windowStart;
  result.windowEnd = futures.windowEnd;

  if (futures.fundingRate === null) result.risks.push('资金费率缺失或过期，持仓成本未核实');
  else {
    const displayedRate = futures.fundingRate * 100;
    const rate = finite(displayedRate) ? `${displayedRate.toFixed(4)}%` : '超出显示范围';
    result.evidence.push(`资金费率 ${rate}${futures.fundingIntervalHours === null ? '（周期未核实）' : ` / ${futures.fundingIntervalHours}h`}`);
    if (futures.fundingIntervalHours === null) result.risks.push('结算周期未核实，不默认8h，不归一化资金费率');
    else result.risks.push('资金费率仅作风险参考；结算周期缓存新鲜度未单独核验，不据此判定拥挤或反转');
    if (futures.nextFundingTime === null) result.risks.push('下次资金费结算时间未核实');
  }
  if (!hasTrade(futures) || !finite(futures.oiChange5m) || futures.oiChange5m < -100) {
    result.reason = `同合约5分钟 OI、价格或主动成交不可用；${futures.reason}`;
    return result;
  }
  result.evidence.unshift(`合约 ${futures.symbol} · 5m OI ${signedPct(futures.oiChange5m)} · 价格 ${signedPct(futures.priceChange5m)}`,
    `合约主动买 ${futures.buyShare5m.toFixed(1)}% · 成交差额 ${futures.delta5m.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${futures.quoteAsset}`);
  if (!sameSide(futures.buyShare5m, futures.delta5m)) {
    result.reason = '合约主动买占比与成交差额不一致，暂不判断方向';
    return result;
  }
  if (futures.oiChange5m < DIRECTION_RULES.oiPct) {
    result.reason = futures.oiChange5m < 0
      ? 'OI 正在减少，无法仅凭减仓区分平仓方向或判定反转'
      : '5分钟 OI 增幅未达 +5%，增仓确认不足';
    return result;
  }
  const long = futures.priceChange5m > DIRECTION_RULES.pricePct && futures.buyShare5m >= DIRECTION_RULES.futuresBuyPct;
  const short = futures.priceChange5m < -DIRECTION_RULES.pricePct && futures.buyShare5m <= DIRECTION_RULES.futuresSellPct;
  if (!long && !short) {
    result.reason = Math.abs(futures.priceChange5m) <= DIRECTION_RULES.pricePct
      ? '增仓但价格仍在 ±0.5% 内，等待明确方向'
      : '价格方向与主动成交未同时满足门槛，暂不追随';
    return result;
  }

  // Prefer the same quote, never silently merge USDT/USDC amounts or confirm a
  // different selected spot market. Unmatched spot coverage is explicitly missing.
  const sameQuoteSnapshot: FlowSnapshot = { ...snapshot, rows: snapshot.rows.filter(row =>
    row?.market?.venue !== 'spot' || row.market.quoteAsset === futures.quoteAsset) };
  const { spot } = selectFlowContext(sameQuoteSnapshot, assetId, now, preferredMarketKey);
  let confirmed = false;
  if (preferredMarketKey?.startsWith('spot:') && spot?.marketKey !== preferredMarketKey)
    result.risks.push('所选现货的身份或计价币不匹配、或数据不可用；不替换其他现货完成确认');
  else if (!spot) result.risks.push(`缺少同标的 ${futures.quoteAsset} 现货确认`);
  else if (spot.windowStart === null || spot.windowEnd === null)
    result.risks.push(`现货确认不可用：${spot.reason}`);
  else if (spot.windowEnd !== futures.windowEnd || spot.windowStart !== futures.windowStart)
    result.risks.push('合约与现货的闭合5分钟窗口不同，暂不确认');
  else {
    const validPrice = finite(spot.priceChange5m);
    const validFlow = finite(spot.buyShare5m) && finite(spot.delta5m) && sameSide(spot.buyShare5m, spot.delta5m);
    result.evidence.push(`现货 ${spot.symbol} · 主动买 ${spot.buyShare5m === null ? '—' : `${spot.buyShare5m.toFixed(1)}%`} · 价格 ${validPrice ? signedPct(spot.priceChange5m!) : '—'}`);
    const contradictory = long
      ? (validFlow && spot.buyShare5m! <= DIRECTION_RULES.spotSellPct) || (validPrice && spot.priceChange5m! < 0)
      : (validFlow && spot.buyShare5m! >= DIRECTION_RULES.spotBuyPct) || (validPrice && spot.priceChange5m! > 0);
    if (contradictory) {
      result.confirmation = '现货与合约冲突';
      result.reason = '现货主动成交或价格明确反向，撤销合约方向候选';
      return result;
    }
    confirmed = validFlow && validPrice && (long ? spot.buyShare5m! >= DIRECTION_RULES.spotBuyPct && spot.priceChange5m! > 0
      : spot.buyShare5m! <= DIRECTION_RULES.spotSellPct && spot.priceChange5m! < 0);
    if (!confirmed) result.risks.push(!validFlow || !validPrice ? '现货部分指标缺失或成交口径不一致，不能完成确认'
      : '现货尚未同时满足主动成交与价格同向条件');
  }
  result.bias = long ? 'long' : 'short';
  result.label = long ? '偏多候选' : '偏空候选';
  result.confirmation = confirmed ? '现货同向 · 仍需入场确认' : '待现货确认 · 不宜直接开仓';
  result.reason = long ? '5分钟增仓上涨且合约主动买入占优，可优先观察做多机会'
    : '5分钟增仓下跌且合约主动卖出占优，可优先观察做空机会';
  result.invalidation = `OI增幅低于5%、价格${long ? '涨幅不再超过0.5%' : '跌幅不再超过0.5%'}、合约主动买${long ? '低于60%' : '高于40%'}、现货明确反向或必需数据过期，即退回观望；不是止损价`;
  return result;
}
