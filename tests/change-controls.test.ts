import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CHANGE_RULE } from '../src/shared/changeMonitor';
import { changeSourceCooldown, parseChangeDraft, readChangeRule } from '../src/web/ChangeDashboard';
import type { Snapshot } from '../src/shared/types';

const draft = () => ({ window: '5', oiBasis: 'quantity' as const, combine: 'all' as const,
  oi: { enabled: true, direction: 'either' as const, threshold: '5' }, fdv: { enabled: true, direction: 'either' as const, threshold: '3' } });
afterEach(() => vi.unstubAllGlobals());
describe('change-monitor controls', () => {
  it('parses default and decimal thresholds without rounding', () => {
    expect(parseChangeDraft(draft())).toEqual(DEFAULT_CHANGE_RULE);
    expect(parseChangeDraft({ ...draft(), oi: { ...draft().oi, threshold: '0.0005' } })?.oi.threshold).toBe(0.0005);
  });
  it('rejects empty/negative/invalid inputs rather than treating them as zero', () => {
    for (const threshold of ['', ' ', '-1', 'NaN', 'Infinity']) expect(parseChangeDraft({ ...draft(), oi: { ...draft().oi, threshold } })).toBeNull();
    for (const window of ['', '0', '1.5', '10081']) expect(parseChangeDraft({ ...draft(), window })).toBeNull();
  });
  it('allows real zero and disabled empty values but requires an active condition', () => {
    expect(parseChangeDraft({ ...draft(), oi: { ...draft().oi, threshold: '0' } })?.oi.threshold).toBe(0);
    expect(parseChangeDraft({ ...draft(), fdv: { ...draft().fdv, enabled: false, threshold: '' } })?.fdv.enabled).toBe(false);
    expect(parseChangeDraft({ ...draft(), oi: { ...draft().oi, enabled: false }, fdv: { ...draft().fdv, enabled: false } })).toBeNull();
  });
  it('validates saved parameters and survives unavailable browser storage', () => {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ ...DEFAULT_CHANGE_RULE, windowMinutes: 60 }) });
    expect(readChangeRule().windowMinutes).toBe(60);
    vi.stubGlobal('localStorage', { getItem: () => '{broken' }); expect(readChangeRule()).toEqual(DEFAULT_CHANGE_RULE);
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ oi: null }) }); expect(readChangeRule()).toEqual(DEFAULT_CHANGE_RULE);
  });
  it('keeps an existing one-minute rule and its thresholds without writing or resetting it', () => {
    const saved = { ...DEFAULT_CHANGE_RULE, windowMinutes: 1, combine: 'any' as const,
      oi: { ...DEFAULT_CHANGE_RULE.oi, threshold: 0.25 }, fdv: { ...DEFAULT_CHANGE_RULE.fdv, threshold: 0.1 } };
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(saved), setItem });
    expect(readChangeRule()).toEqual(saved);
    expect(parseChangeDraft({ ...draft(), window: '1' })?.windowMinutes).toBe(1);
    expect(setItem).not.toHaveBeenCalled();
  });
  it('shows a real source cooldown only until its known deadline', () => {
    const until = Date.UTC(2026, 8, 23, 11);
    const snapshot = { errors: [`BINANCE_PRICE: RATE_LIMIT_COOLDOWN: fapi.binance.com 等待至 ${new Date(until).toISOString()}`] } as Snapshot;
    expect(changeSourceCooldown(snapshot, until - 10_001)).toBe(11);
    expect(changeSourceCooldown(snapshot, until)).toBe(0);
    expect(changeSourceCooldown({ errors: ['RATE_LIMIT_BUDGET', 'RATE_LIMIT_COOLDOWN: invalid'] } as Snapshot, until)).toBe(0);
  });
  it('does not disable Binance refresh for an independent supply-provider cooldown', () => {
    const now = Date.UTC(2026, 8, 29, 8);
    const supplyUntil = new Date(now + 300_000).toISOString();
    const errors = [
      `COINGECKO_SUPPLY: RATE_LIMIT_COOLDOWN: api.coingecko.com 等待至 ${supplyUntil}`,
      `COINGECKO_RETRY: 下次尝试不早于 ${supplyUntil}；Binance OI 采集继续`,
      `CMC_SUPPLY: RATE_LIMIT_COOLDOWN: pro-api.coinmarketcap.com 等待至 ${supplyUntil}`,
    ];
    expect(changeSourceCooldown({ errors } as Snapshot, now)).toBe(0);
    expect(changeSourceCooldown({ errors, retryAt: now + 10_000 } as Snapshot, now)).toBe(10);
    expect(changeSourceCooldown({ errors: [...errors,
      `BINANCE_PRICE: RATE_LIMIT_COOLDOWN: fapi.binance.com 等待至 ${new Date(now + 20_000).toISOString()}`] } as Snapshot, now)).toBe(20);
  });
});
