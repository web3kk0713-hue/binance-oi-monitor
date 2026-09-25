import { useState, type FormEvent } from 'react';
import { DIRECTION_PRESETS, directionPreset, isDirectionConfig, type DirectionConfig } from '../shared/directionConfig';
import { useDirectionSettings } from './DirectionSettingsContext';
import { MetricHelp } from './MetricHelp';
import './direction.css';

export const DIRECTION_LABELS = { sensitive: '灵敏', standard: '标准', strict: '严格', custom: '自定义' };
type Draft = { oiPct: string; pricePct: string; flowSharePct: string; requireSpot: boolean };
export function parseDirectionDraft(draft: Draft): DirectionConfig | null {
  if (![draft.oiPct, draft.pricePct, draft.flowSharePct].every(value => value.trim() !== '')) return null;
  const config = { oiPct: Number(draft.oiPct), pricePct: Number(draft.pricePct), flowSharePct: Number(draft.flowSharePct), requireSpot: draft.requireSpot };
  return isDirectionConfig(config) ? config : null;
}

function CustomDirectionForm({ config, onApply }: { config: DirectionConfig; onApply: (config: DirectionConfig) => boolean }) {
  const [draft, setDraft] = useState<Draft>(() => ({ oiPct: String(config.oiPct), pricePct: String(config.pricePct),
    flowSharePct: String(config.flowSharePct), requireSpot: config.requireSpot }));
  const [error, setError] = useState('');
  const parsed = parseDirectionDraft(draft);
  const dirty = !parsed || Object.keys(config).some(key => config[key as keyof DirectionConfig] !== parsed[key as keyof DirectionConfig]);
  function apply(event: FormEvent) {
    event.preventDefault();
    const next = parseDirectionDraft(draft);
    if (!next) { setError('OI 填 0.1–100，价格填 0.05–20，主动成交占比填 51–90。'); return; }
    if (onApply(next)) setError('');
  }
  return <form className="direction-custom-form" aria-label="自定义方向参数" onSubmit={apply} noValidate>
    <div className="direction-fields">{([
      { key: 'oiPct', label: 'OI 至少增加', min: .1, max: 100, help: '越小越容易出现候选' },
      { key: 'pricePct', label: '价格涨 / 跌超过', min: .05, max: 20, help: '上涨看多，下跌看空' },
      { key: 'flowSharePct', label: '同方向主动成交至少', min: 51, max: 90, help: '做多看买入，做空看卖出' },
    ] as const).map(field => <label key={field.key}>{field.label}<span className="direction-number"><input type="number" aria-label={field.label} min={field.min} max={field.max} step="any" required value={draft[field.key]} onChange={event => { setDraft(previous => ({ ...previous, [field.key]: event.target.value })); setError(''); }}/><span>%</span></span><small>{field.help}</small></label>)}</div>
    <div className="direction-custom-actions"><label><input type="checkbox" checked={draft.requireSpot} onChange={event => setDraft(previous => ({ ...previous, requireSpot: event.target.checked }))}/>必须现货同向才给候选</label><button className="button primary" type="submit">应用自定义</button></div>
    <p className="direction-custom-state" role="status">{dirty ? '尚未应用修改。' : '当前生效参数。'}现货反向仍会观望，缺现货只列待确认候选。</p>
    {error ? <p className="direction-config-error" role="alert">{error}</p> : null}
  </form>;
}

export function DirectionControls() {
  const { config, apply, notice, revision } = useDirectionSettings();
  const preset = directionPreset(config);
  return <section className="direction-controls" aria-label="多空建议灵敏度">
    <div className="direction-controls-heading"><h2>方向筛选 <span>固定 5m</span><MetricHelp label="方向筛选">灵敏、标准、严格只改变候选门槛，不改变更新速度。按同一合约最近完整 5m 的 OI、价格、主动成交共同判断；所有档位均未经胜率验证，不是自动买卖策略。</MetricHelp></h2>
      <div className="direction-presets" role="group" aria-label="方向预设档位">{([
        ['sensitive', '灵敏', '候选更多'], ['standard', '标准', '当前默认'], ['strict', '严格', '门槛更高'],
      ] as const).map(([key, label, hint]) => <button key={key} type="button" title={hint} aria-pressed={preset === key} onClick={() => apply(DIRECTION_PRESETS[key])}>{label}</button>)}</div>
      <p className="direction-active-rule"><strong>{DIRECTION_LABELS[preset]}</strong><span>OI ≥ +{config.oiPct}%<MetricHelp label="方向 OI 门槛">同一合约 5m 的原始未平仓数量至少增长此比例。排除价格影响，不代表买入资金或新增多仓。</MetricHelp></span><span>价格 ± &gt; {config.pricePct}%<MetricHelp label="方向价格门槛">最近完整 5m 价格上涨超过门槛才考虑偏多，下跌超过门槛才考虑偏空；仍须 OI、成交等其他条件同时满足。</MetricHelp></span><span>主动成交 ≥ {config.flowSharePct}%<MetricHelp label="同向主动成交门槛">偏多看主动买额占比，偏空看主动卖额占比。例如 60% 门槛：做多需买额≥60%，做空需卖额≥60%（买额≤40%）；不是胜率。</MetricHelp></span></p>
      <span className="direction-config-caution">实验性 · 非下单指令</span></div>
    <details className="direction-custom"><summary>自定义参数与说明</summary><CustomDirectionForm key={revision} config={config} onApply={apply}/><p className="direction-config-note">{config.requireSpot ? '必须现货同向。' : '缺现货可列待确认候选。'}灵敏档更易误报，所有档位均未验证胜率；数据过期、缺失或现货反向仍会观望。设置两页共用，保存在当前浏览器；不改变采集速度。</p></details>
    {notice ? <p className="direction-save-state" role="status">{notice}</p> : null}
  </section>;
}
