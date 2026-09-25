import { describe, expect, it } from 'vitest';
import { DEFAULT_DIRECTION_CONFIG, DIRECTION_PRESETS, directionPreset, directionSellThreshold,
  isDirectionConfig, type DirectionConfig } from '../src/shared/directionConfig';

describe('direction configuration and presets', () => {
  it('exports the approved independent deeply frozen presets and standard default', () => {
    expect(DIRECTION_PRESETS).toEqual({
      sensitive: { oiPct: 1, pricePct: 0.2, flowSharePct: 55, requireSpot: false },
      standard: { oiPct: 5, pricePct: 0.5, flowSharePct: 60, requireSpot: false },
      strict: { oiPct: 10, pricePct: 1, flowSharePct: 65, requireSpot: true },
    });
    expect(DEFAULT_DIRECTION_CONFIG).toBe(DIRECTION_PRESETS.standard);
    expect(Object.isFrozen(DIRECTION_PRESETS)).toBe(true);
    for (const preset of Object.values(DIRECTION_PRESETS)) {
      expect(Object.isFrozen(preset)).toBe(true);
      expect(isDirectionConfig(preset)).toBe(true);
    }
  });

  it('accepts inclusive range endpoints and non-integer parameters', () => {
    expect(isDirectionConfig({ oiPct: 0.1, pricePct: 0.05, flowSharePct: 51, requireSpot: false })).toBe(true);
    expect(isDirectionConfig({ oiPct: 100, pricePct: 20, flowSharePct: 90, requireSpot: true })).toBe(true);
    expect(isDirectionConfig({ oiPct: 1.123, pricePct: 0.201, flowSharePct: 55.2, requireSpot: false })).toBe(true);
  });

  it.each([null, undefined, true, false, 0, '', 'standard', [], [DEFAULT_DIRECTION_CONFIG], {}])
    ('rejects non-configuration input %j', config => expect(isDirectionConfig(config)).toBe(false));

  it.each([null, undefined, NaN, Infinity, -Infinity, '5', true, false, -1])
    ('rejects missing, nonnumeric or nonfinite numeric fields %s', value => {
      for (const key of ['oiPct', 'pricePct', 'flowSharePct'])
        expect(isDirectionConfig({ ...DEFAULT_DIRECTION_CONFIG, [key]: value }), key).toBe(false);
    });

  it.each([
    ['oiPct', 0.099999999999], ['oiPct', 100.000000001],
    ['pricePct', 0.049999999999], ['pricePct', 20.000000001],
    ['flowSharePct', 50.999999999999], ['flowSharePct', 90.000000001],
  ])('rejects out-of-range %s=%s', (key, value) => {
    expect(isDirectionConfig({ ...DEFAULT_DIRECTION_CONFIG, [key]: value })).toBe(false);
  });

  it.each([null, undefined, 0, 1, 'true', 'false', {}, []])('requires a real boolean spot setting %j', requireSpot => {
    expect(isDirectionConfig({ ...DEFAULT_DIRECTION_CONFIG, requireSpot })).toBe(false);
  });

  it('derives preset names from all four values, not an enum or object identity', () => {
    for (const key of ['sensitive', 'standard', 'strict'] as const)
      expect(directionPreset({ ...DIRECTION_PRESETS[key] })).toBe(key);
    expect(directionPreset({ ...DEFAULT_DIRECTION_CONFIG, pricePct: 0.500001 })).toBe('custom');
    expect(directionPreset({ ...DEFAULT_DIRECTION_CONFIG, requireSpot: true })).toBe('custom');
    expect(directionPreset({ ...DEFAULT_DIRECTION_CONFIG, flowSharePct: 55, preset: 'standard' } as DirectionConfig)).toBe('custom');
    expect(directionPreset(null as unknown as DirectionConfig)).toBe('custom');
  });

  it('exposes exact decimal short-side complements for both decision and display', () => {
    expect(100 - 65.1).not.toBe(34.9);
    expect(directionSellThreshold(55.2)).toBe(44.8);
    expect(directionSellThreshold(65.1)).toBe(34.9);
    expect(directionSellThreshold(51)).toBe(49);
    expect(directionSellThreshold(90)).toBe(10);
    expect(directionSellThreshold(60)).toBe(40);
    expect(directionSellThreshold(65)).toBe(35);
    expect(directionSellThreshold(55.12345678901234)).toBe(44.87654321098766);
  });

  it.each([50, 90.1, NaN, Infinity, -Infinity, null, undefined])('does not supply a plausible threshold for invalid input %s', value => {
    expect(Number.isNaN(directionSellThreshold(value as number))).toBe(true);
  });
});
