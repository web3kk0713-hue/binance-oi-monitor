import Decimal from 'decimal.js';

export interface DirectionConfig {
  oiPct: number;
  pricePct: number;
  flowSharePct: number;
  requireSpot: boolean;
}

export const DIRECTION_PRESETS = Object.freeze({
  sensitive: Object.freeze({ oiPct: 1, pricePct: 0.2, flowSharePct: 55, requireSpot: false }),
  standard: Object.freeze({ oiPct: 5, pricePct: 0.5, flowSharePct: 60, requireSpot: false }),
  strict: Object.freeze({ oiPct: 10, pricePct: 1, flowSharePct: 65, requireSpot: true }),
});
export const DEFAULT_DIRECTION_CONFIG: DirectionConfig = DIRECTION_PRESETS.standard;

const within = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;

export function isDirectionConfig(value: unknown): value is DirectionConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const config = value as Partial<DirectionConfig>;
  return within(config.oiPct, 0.1, 100) && within(config.pricePct, 0.05, 20)
    && within(config.flowSharePct, 51, 90) && typeof config.requireSpot === 'boolean';
}

/** The preset label is derived from values, never trusted as persisted state. */
export function directionPreset(config: DirectionConfig): 'sensitive' | 'standard' | 'strict' | 'custom' {
  if (!isDirectionConfig(config)) return 'custom';
  for (const key of ['sensitive', 'standard', 'strict'] as const) {
    const preset = DIRECTION_PRESETS[key];
    if (config.oiPct === preset.oiPct && config.pricePct === preset.pricePct
      && config.flowSharePct === preset.flowSharePct && config.requireSpot === preset.requireSpot) return key;
  }
  return 'custom';
}

const ExactDecimal = Decimal.clone({ precision: 80 });

/** Shared by the evaluator and rule labels; avoids e.g. 100 - 65.1 becoming 34.900000000000006. */
export function directionSellThreshold(flowSharePct: number): number {
  return within(flowSharePct, 51, 90) ? new ExactDecimal(100).minus(flowSharePct).toNumber() : NaN;
}
