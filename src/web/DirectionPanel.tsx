import type { DirectionAssessment } from '../shared/direction';
import { directionPreset, directionSellThreshold } from '../shared/directionConfig';
import { DIRECTION_LABELS } from './DirectionControls';
import { MetricHelp } from './MetricHelp';
import { clockTime } from './format';
import './direction.css';

export function DirectionBadge({ value, detail = false }: { value: DirectionAssessment; detail?: boolean }) {
  return <span className="direction-summary" title={`${value.reason} ${value.confirmation}`}>
    <span className={`direction-badge ${value.bias}`}>{value.bias === 'long' ? '↗ ' : value.bias === 'short' ? '↘ ' : '— '}{value.label}</span>
    {detail ? <small>{value.confirmation}</small> : null}
  </span>;
}

/** Current assessment only; historical events/outcomes are deliberately not inputs. */
export function DirectionPanel({ value, replay = false }: { value: DirectionAssessment; replay?: boolean }) {
  const config = value.config;
  return <section className={`direction-panel ${value.bias}`} aria-label="当前5分钟多空建议">
    <div className="direction-heading"><div><span>固定 5m · {config ? DIRECTION_LABELS[directionPreset(config)] : '参数无效'}</span><h3>{value.bias === 'long' ? '↗ ' : value.bias === 'short' ? '↘ ' : ''}{value.label}<MetricHelp label="多空候选">偏多或偏空表示实验性筛选条件暂时同时满足，不代表胜率或立即开仓。观望表示条件、确认或数据质量不足；数据过期会撤销候选。</MetricHelp></h3></div>
      <div className="direction-meta"><strong>{value.confirmation}</strong><small>{value.symbol ?? '等待合约'} · 更新 {clockTime(value.asOf)}</small></div></div>
    <p className="direction-reason">{value.reason}</p>
    <div className="direction-guardrails"><p><strong>撤销条件</strong>{value.invalidation}</p></div>
    <p className="direction-disclaimer">未回测盈利能力，候选不等于开仓。{replay ? '这是当前建议，不是历史事件发生时的建议。' : ''}</p>
    <details className="direction-method"><summary>证据、风险与规则</summary>
      {value.evidence.length ? <ul className="direction-evidence">{value.evidence.map((item, index) => <li key={index}>{item}</li>)}</ul> : null}
      {value.risks.length ? <p><strong>风险 / 待确认：</strong>{value.risks.join('；')}</p> : null}
      {config ? <p>偏多：单合约 OI 数量 ≥ +{config.oiPct}%、价格 &gt; +{config.pricePct}%、主动买占比 ≥{config.flowSharePct}% 且净主动成交为正。偏空：OI 数量 ≥ +{config.oiPct}%、价格 &lt; −{config.pricePct}%、主动买占比 ≤{directionSellThreshold(config.flowSharePct)}% 且净主动成交为负。{config.requireSpot ? '必须现货同向才给候选。' : '缺现货可列待确认候选，不能直接视为入场确认。'}这些是经验筛选线，不是经过收益验证的交易策略。</p> : <p>方向参数无效，请在上方重新选择档位。</p>}
      <p>使用同一合约最近 5 根已闭合 1m K 线，OI 取闭合分钟边界附近连续实测值；不拼接自定义变化窗口，也不把 FDV、价格、OI/FDV 当作独立投票。主动占比和净主动成交是同一项证据的一致性校验。</p>
      <p>现货须同币种、同报价币、同一闭合窗口：主动买 ≥55% 且价格上涨，或主动买 ≤45% 且价格下跌才算同向；明确反向退回观望。未覆盖或中性标为待确认。费率仅提示持仓成本，周期未知不默认 8 小时，不据此反向交易。</p>
      <p>{value.windowStart && value.windowEnd ? `K线窗口：${clockTime(value.windowStart)} → ${clockTime(value.windowEnd)}（右端不含）。` : '尚无有效的闭合 5m 窗口。'}规则 {value.ruleVersion}。未评估仓位、账户风险、手续费和可成交价格；撤销候选不是止损价或自动平仓。</p>
      <p><a href="https://www.cmegroup.com/education/lessons/open-interest" target="_blank" rel="noreferrer">OI 定义 · CME</a><a href="https://www.binance.com/en/support/faq/detail/360033525031" target="_blank" rel="noreferrer">资金费率 · Binance</a></p>
    </details>
  </section>;
}
