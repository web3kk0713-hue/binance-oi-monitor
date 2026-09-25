import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DIRECTION_CONFIG, DIRECTION_PRESETS, type DirectionConfig } from '../src/shared/directionConfig';
import { parseDirectionDraft } from '../src/web/DirectionControls';
import { decodeDirectionPreferences, DIRECTION_STORAGE_KEY, readDirectionPreferences, writeDirectionPreferences } from '../src/web/directionPreferences';

const custom: DirectionConfig = { oiPct: 2.25, pricePct: .35, flowSharePct: 57.5, requireSpot: true };
const serialized = (config: unknown, schemaVersion: unknown = 1) => JSON.stringify({ schemaVersion, config });
const draft = { oiPct: '2.25', pricePct: '0.35', flowSharePct: '57.5', requireSpot: true };

function storage(initial?: string) {
  const values = new Map<string, string>(initial === undefined ? [] : [[DIRECTION_STORAGE_KEY, initial]]);
  const api = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
  };
  vi.stubGlobal('localStorage', api);
  return { ...api, values };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('direction preference decoding and persistence', () => {
  it('uses an independent standard config and no warning when nothing was saved', () => {
    const decoded = decodeDirectionPreferences(null);
    expect(decoded).toEqual({ config: DEFAULT_DIRECTION_CONFIG, notice: '' });
    expect(decoded.config).not.toBe(DEFAULT_DIRECTION_CONFIG);
    decoded.config.oiPct = 25;
    expect(DEFAULT_DIRECTION_CONFIG.oiPct).toBe(5);
  });

  it('reads only its own versioned key and does not write defaults on initial read', () => {
    const local = storage();
    expect(readDirectionPreferences()).toEqual({ config: DEFAULT_DIRECTION_CONFIG, notice: '' });
    expect(local.getItem).toHaveBeenCalledExactlyOnceWith(DIRECTION_STORAGE_KEY);
    expect(local.setItem).not.toHaveBeenCalled();
  });

  it.each([
    ['standard', DIRECTION_PRESETS.standard], ['sensitive', DIRECTION_PRESETS.sensitive],
    ['strict', DIRECTION_PRESETS.strict], ['custom', custom],
  ] as const)('round-trips %s without a separate trusted preset label', (_name, config) => {
    const local = storage();
    expect(writeDirectionPreferences(config)).toBe(true);
    expect(local.setItem).toHaveBeenCalledOnce();
    expect(JSON.parse(local.values.get(DIRECTION_STORAGE_KEY)!)).toEqual({ schemaVersion: 1, config });
    expect(readDirectionPreferences()).toEqual({ config, notice: '' });
  });

  it('writes only the schema and the four permitted configuration fields', () => {
    const local = storage();
    const extra = { ...custom, preset: 'sensitive', alertThreshold: 999, windowMinutes: 1 };
    expect(writeDirectionPreferences(extra)).toBe(true);
    const persisted = JSON.parse(local.values.get(DIRECTION_STORAGE_KEY)!);
    expect(persisted).toEqual({ schemaVersion: 1, config: custom });
    expect(Object.keys(persisted)).toEqual(['schemaVersion', 'config']);
    expect(Object.keys(persisted.config).sort()).toEqual(['flowSharePct', 'oiPct', 'pricePct', 'requireSpot']);
  });

  it('discards extra decoded fields instead of copying them into active configuration', () => {
    const result = decodeDirectionPreferences(JSON.stringify({ schemaVersion: 1, preset: 'strict',
      config: { ...custom, nextWindow: 60, preset: 'sensitive' } }));
    expect(result).toEqual({ config: custom, notice: '' });
    expect(Object.keys(result.config).sort()).toEqual(['flowSharePct', 'oiPct', 'pricePct', 'requireSpot']);
  });

  it.each([
    '', ' ', '{bad json', 'null', 'false', '2', '[]', '{}',
    JSON.stringify(custom), serialized(custom, 0), serialized(custom, 2), serialized(custom, '1'),
    serialized(null), serialized([]), serialized({}),
    serialized({ ...custom, oiPct: NaN }), serialized({ ...custom, pricePct: Infinity }),
    serialized({ ...custom, flowSharePct: null }), serialized({ ...custom, oiPct: '2.25' }),
    serialized({ ...custom, requireSpot: 'false' }), serialized({ ...custom, requireSpot: null }),
    serialized({ ...custom, oiPct: 0 }), serialized({ ...custom, oiPct: .099 }),
    serialized({ ...custom, oiPct: 100.01 }), serialized({ ...custom, pricePct: .049 }),
    serialized({ ...custom, pricePct: 20.01 }), serialized({ ...custom, flowSharePct: 50.99 }),
    serialized({ ...custom, flowSharePct: 90.01 }),
  ])('fails closed to standard with a visible notice for corrupt storage: %s', raw => {
    const result = decodeDirectionPreferences(raw);
    expect(result.config).toEqual(DEFAULT_DIRECTION_CONFIG);
    expect(result.notice).toContain('无效');
    expect(result.notice).toContain('标准');
  });

  it('read errors return standard with an explicit notice and do not overwrite storage', () => {
    const local = storage(serialized(custom));
    local.getItem.mockImplementation(() => { throw new Error('access denied'); });
    const result = readDirectionPreferences();
    expect(result.config).toEqual(DEFAULT_DIRECTION_CONFIG);
    expect(result.notice).toContain('不允许读取');
    expect(local.setItem).not.toHaveBeenCalled();
  });

  it('write errors return false while preserving the previous stored configuration', () => {
    const local = storage(serialized(DIRECTION_PRESETS.standard));
    local.setItem.mockImplementation(() => { throw new Error('quota or access denied'); });
    expect(writeDirectionPreferences(custom)).toBe(false);
    expect(local.values.get(DIRECTION_STORAGE_KEY)).toBe(serialized(DIRECTION_PRESETS.standard));
  });

  it.each([
    null, undefined, [], {}, { ...custom, oiPct: NaN }, { ...custom, oiPct: Infinity },
    { ...custom, oiPct: 0 }, { ...custom, pricePct: 0 }, { ...custom, flowSharePct: 50 },
    { ...custom, flowSharePct: 91 }, { ...custom, requireSpot: 1 }, { ...custom, requireSpot: 'true' },
  ])('validates invalid runtime config before accessing storage: %j', input => {
    const local = storage(serialized(custom));
    expect(writeDirectionPreferences(input as DirectionConfig)).toBe(false);
    expect(local.getItem).not.toHaveBeenCalled();
    expect(local.setItem).not.toHaveBeenCalled();
    expect(local.values.get(DIRECTION_STORAGE_KEY)).toBe(serialized(custom));
  });
});

describe('direction custom draft validation', () => {
  it('accepts finite decimals without rounding them to a preset', () => {
    expect(parseDirectionDraft(draft)).toEqual(custom);
  });

  it('accepts the inclusive lower and upper contract limits', () => {
    expect(parseDirectionDraft({ oiPct: '.1', pricePct: '.05', flowSharePct: '51', requireSpot: false }))
      .toEqual({ oiPct: .1, pricePct: .05, flowSharePct: 51, requireSpot: false });
    expect(parseDirectionDraft({ oiPct: '100', pricePct: '20', flowSharePct: '90', requireSpot: true }))
      .toEqual({ oiPct: 100, pricePct: 20, flowSharePct: 90, requireSpot: true });
  });

  it.each(['oiPct', 'pricePct', 'flowSharePct'] as const)('rejects blank, zero, negative and non-finite %s', key => {
    for (const value of ['', ' ', '\t\n', '0', '-1', 'NaN', 'Infinity', '-Infinity', 'not a number']) {
      expect(parseDirectionDraft({ ...draft, [key]: value }), `${key}=${JSON.stringify(value)}`).toBeNull();
    }
  });

  it.each([
    ['oiPct', '.099999'], ['oiPct', '100.0001'], ['pricePct', '.049999'], ['pricePct', '20.0001'],
    ['flowSharePct', '50.9999'], ['flowSharePct', '90.0001'],
  ] as const)('rejects %s outside its contract: %s', (key, value) => {
    expect(parseDirectionDraft({ ...draft, [key]: value })).toBeNull();
  });

  it.each([undefined, null, 0, 1, 'false', 'true', [], {}])('rejects nonboolean requireSpot at runtime: %j', requireSpot => {
    expect(parseDirectionDraft({ ...draft, requireSpot } as unknown as Parameters<typeof parseDirectionDraft>[0])).toBeNull();
  });

  it('does not mutate a valid draft while parsing it', () => {
    const original = { ...draft };
    parseDirectionDraft(original);
    expect(original).toEqual(draft);
  });
});
