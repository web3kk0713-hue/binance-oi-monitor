import { latestEndpointIssue, priceChangeIssue, type ChangeResult, type ChangeRule } from '../shared/changeMonitor';
import { toHistoryPoint } from '../shared/history';
import type { Snapshot } from '../shared/types';
import { selectValuation } from '../shared/valuation';

interface ChangeDisplayInput {
  snapshot: Snapshot | null;
  rule: ChangeRule;
  rows: readonly ChangeResult[];
  now: number;
  loading: boolean;
}
export interface ChangeDataNotice {
  title: string;
  detail: string;
  severity: 'warning' | 'info';
  blocksAllMatches: boolean;
  retryAt?: number;
}
interface EmptyInput extends ChangeDisplayInput {
  scope: 'hit' | 'all' | 'unavailable';
  error?: string | null;
  hasQuery?: boolean;
  hasPattern?: boolean;
}

// Derived presentation only: never changes a rule, fills a missing metric, or triggers a request.
export function changeDataNotice({ snapshot, rule, rows, now, loading }: ChangeDisplayInput): ChangeDataNotice | null {
  if (!snapshot) return null;
  if (now - snapshot.asOf > 90_000) return { title: '行情已过期，暂停判断',
    detail: '等待新的有效行情；旧数值只供查看，不参与当前命中。', severity: 'warning', blocksAllMatches: true };
  const supplyErrors = snapshot.errors.filter(issue => /^(?:(COINGECKO|CMC)_(SUPPLY|IDENTITY)|BINANCE_MARKET_CAP):/.test(issue));
  const marketCapBudget = snapshot.errors.some(issue => /^BINANCE_MARKET_CAP_BUDGET:/.test(issue));
  const total = snapshot.universe.assets;
  // Raw coverage can include an expired cached field. Reuse the comparison endpoint's
  // validity checks; do not describe a retained display value as usable evidence.
  const valuations = snapshot.assets.flatMap(asset => {
    const point = toHistoryPoint(asset, snapshot);
    const value = selectValuation(point);
    return value.basis !== null && !latestEndpointIssue(asset.id, point, now) && !priceChangeIssue(point, point, now) ? [value] : [];
  });
  const valuationCount = valuations.length, marketCapCount = valuations.filter(value => value.basis === 'marketCap').length;
  const requiresValuation = rule.fdv.enabled && (!rule.oi.enabled || rule.combine === 'all');
  const blocksAllMatches = requiresValuation && valuationCount === 0 && total > 0;
  const coverage = `估值有效覆盖 ${valuationCount}/${total}（FDV 优先${marketCapCount ? `，${marketCapCount} 个采用流通市值` : ''}）。`;
  const effect = blocksAllMatches ? '当前规则要求估值，因此暂不能确认命中。'
    : rule.fdv.enabled ? '缺失项不当作 0；按当前组合规则判断。' : '估值未参与筛选；OI 数据有效时仍可独立判断。';
  if (supplyErrors.length) {
    const retryTimes = snapshot.errors.filter(issue => /^(?:(COINGECKO|CMC)_(RETRY|SUPPLY|IDENTITY)|BINANCE_MARKET_CAP):/.test(issue))
      .flatMap(issue => {
        const iso = issue.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/)?.[0];
        const at = iso ? Date.parse(iso) : NaN;
        return Number.isFinite(at) && at > now ? [at] : [];
      });
    const denied = supplyErrors.some(issue => /HTTP_(401|403|451)\b/.test(issue));
    const limited = supplyErrors.some(issue => /HTTP_(418|429)\b|RATE_LIMIT/.test(issue));
    const title = valuationCount > 0 ? '供应量更新受阻' : denied ? '供应量服务拒绝访问'
      : limited ? '供应量服务限流中' : '供应量服务暂不可访问';
    const providers = [...new Set(supplyErrors.map(issue => issue.startsWith('BINANCE_MARKET_CAP:') ? 'Binance 转引 CoinMarketCap' : issue.startsWith('COINGECKO_') ? 'CoinGecko' : 'CoinMarketCap'))].join('、');
    return { title, detail: `${coverage}${providers} 更新受阻。${valuationCount > 0 ? '仅使用已核实且仍在有效期内的数值，不代表本轮更新成功。' : ''}${marketCapBudget ? '流通量补取已达本轮预算，缺失项稍后继续，不影响已取得的 OI。' : ''}${effect}系统会退避重试，反复刷新不能解除源端限制。`,
      severity: 'warning', blocksAllMatches,
      ...(retryTimes.length ? { retryAt: Math.max(...retryTimes) } : {}) };
  }
  if (marketCapBudget) return {
    title: '流通市值补取分批进行中',
    detail: `${coverage}流通量补取已达本轮预算，缺失项稍后继续；已取得的 OI 保留，不代表源端拒绝访问。${effect}`,
    severity: 'info', blocksAllMatches,
  };
  if (rule.fdv.enabled && total > 0 && valuationCount < total) return {
    title: valuationCount === 0 ? '估值数据暂不可用' : '部分估值数据不可用',
    detail: `${coverage}FDV 无可靠最大供应量时使用有效流通市值；两者均缺失、身份或价格未核实时留空。${effect}`,
    severity: 'warning', blocksAllMatches,
  };
  if (loading || !rows.length) return null;
  const unknown = rows.filter(row => !row.evaluable);
  if (unknown.length === rows.length) {
    const missingStart = rows.every(row => row.baseline === null);
    return { title: missingStart ? `缺少 ${rule.windowMinutes} 分钟前的有效观测` : '当前数据暂时无法判断',
      detail: missingStart ? '保持页面运行以积累实际观测；关页或采集中断后的缺口不会补造。'
        : '部分端点缺失、过期或合约口径不一致；查看“暂不可判断”中的逐项原因。',
      severity: 'warning', blocksAllMatches: true };
  }
  if (unknown.length) return { title: `${unknown.length} 个标的暂时无法判断`,
    detail: '其余标的继续按已生效条件筛选；无法判断不等于未达标。', severity: 'info', blocksAllMatches: false };
  return null;
}

/** Called for an empty visible list. Source availability and rule outcome remain separate. */
export function changeEmptyState(input: EmptyInput): { title: string; detail: string } {
  const { snapshot, rule, rows, scope, loading, error, hasQuery, hasPattern, now } = input;
  if (loading) return { title: `正在读取 ${rule.windowMinutes} 分钟比较数据…`, detail: '读取真实起点，不沿用其他时间窗口的旧结果。' };
  if (error) return { title: '历史读取失败，暂时无法判断', detail: '可点击刷新重试；仍失败时查看上方历史读取提示。' };
  if (!snapshot) return { title: '等待首轮行情', detail: '取得当前行情和比较起点后才开始判断。' };
  if (now - snapshot.asOf > 90_000) return { title: '行情已过期，暂停判断', detail: '等待采集恢复；旧行情不会当作当前信号。' };
  if (hasQuery && rows.length === 0) return { title: '未找到匹配的币种', detail: '检查币种名称或清空搜索。' };
  if (hasPattern) return { title: '当前联动筛选下没有标的', detail: '可切换“全部联动”；变化条件和多空参考是独立判断。' };
  if (scope === 'unavailable') return { title: '当前没有无法判断的标的', detail: '仅表示组合条件已有结论，不代表每个字段都完整。' };
  if (scope === 'all') return { title: '当前范围没有标的', detail: '检查搜索条件或等待市场目录更新。' };
  const notice = changeDataNotice(input);
  if (notice?.blocksAllMatches) return { title: /供应量|估值/.test(notice.title) ? '估值数据暂不可用' : notice.title, detail: notice.detail };
  const unknown = rows.filter(row => !row.evaluable).length;
  const missingEnabled = rows.filter(row => rule.oi.enabled && row.oiPct === null || rule.fdv.enabled && row.fdvPct === null).length;
  if (!rows.length) return { title: '等待可比较的标的', detail: '取得有效行情后展示筛选结果。' };
  return { title: '当前可判断的标的中，暂无达标',
    detail: unknown ? `另有 ${unknown} 个标的暂时无法判断；可切换“全部”查看变化，或查看缺失原因。`
      : missingEnabled ? `${missingEnabled} 个标的仍有筛选字段缺失；当前已知条件未达标，不代表所有数据完整。`
        : `按已生效的过去 ${rule.windowMinutes} 分钟条件判断；可切换“全部”查看实际变化。` };
}
