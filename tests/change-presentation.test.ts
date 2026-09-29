import { describe, expect, it } from 'vitest';
import { DEFAULT_CHANGE_RULE, type ChangeResult, type ChangeRule } from '../src/shared/changeMonitor';
import type { AssetRow, HistoryPoint, Snapshot } from '../src/shared/types';
import { changeDataNotice, changeEmptyState } from '../src/web/changePresentation';

// Synthetic presentation fixtures: no market data or strategy performance claim.
const now = Date.UTC(2026, 8, 29, 8);
const rule: ChangeRule = { ...DEFAULT_CHANGE_RULE, windowMinutes: 1 };
const point: HistoryPoint = { assetId: 'synthetic', timestamp: now - 60_000, availableAt: now - 60_000,
  oiUsd: 100, marketCapUsd: 500, fdvUsd: 1000, oiToFdv: 10, oiToMarketCap: 20, complete: true };
const asset = (): AssetRow => ({ id: 'synthetic', symbol: 'TEST', name: 'Synthetic only', contracts: [],
  priceUsd: 1, oiUsd: 100, marketCapUsd: 500, fdvUsd: 1000, oiToFdv: 10, oiToMarketCap: 20,
  circulatingSupply: 500, maxSupply: 1000, updatedAt: now, oiUpdatedAt: now, priceUpdatedAt: now,
  supplyUpdatedAt: now, complete: true, alertEligible: true, issues: [], supplySource: 'CoinGecko', mappingStatus: 'verified',
  evidence: { contracts: [], mapping: 'Synthetic only', supply: { provider: 'CoinGecko', id: 'synthetic', circulating: 500,
    total: 1000, max: 1000, updatedAt: now, fetchedAt: now, url: 'https://example.invalid' } } });
const row = (changes: Partial<ChangeResult> = {}): ChangeResult => ({ assetId: 'synthetic', symbol: 'TEST',
  oiPct: 1, fdvPct: 1, oiMatched: false, fdvMatched: false, matched: false, evaluable: true,
  status: 'below', reason: 'OI：未达阈值；FDV：未达阈值', startAt: point.timestamp, endAt: now,
  baseline: point, latest: { ...point, timestamp: now, availableAt: now }, ...changes });
const snapshot = (changes: Partial<Snapshot> = {}): Snapshot => ({ schemaVersion: 1, mode: 'direct',
  startedAt: now - 1000, asOf: now, durationMs: 1000, universe: { assets: 1, contracts: 1 },
  coverage: { oi: 1, marketCap: 1, fdv: 1, eligible: 1, failedContracts: 0 }, assets: [asset()], errors: [], ...changes });
const noFdv = () => snapshot({ coverage: { oi: 1, marketCap: 0, fdv: 0, eligible: 0, failedContracts: 0 },
  assets: [{ ...asset(), fdvUsd: null, maxSupply: null }],
  errors: ['COINGECKO_SUPPLY: NETWORK_ERROR: api.coingecko.com Failed to fetch'] });
const base = () => ({ snapshot: snapshot(), rule, rows: [row()], scope: 'hit' as const, loading: false, now });

describe('consumer-facing change availability', () => {
  it('does not call a completely unknown comparison a market with no matches', () => {
    const missing = row({ baseline: null, startAt: null, oiPct: null, fdvPct: null, evaluable: false, status: 'unavailable' });
    const result = changeEmptyState({ ...base(), rows: [missing] });
    expect(result.title).toContain('缺少 1 分钟前');
    expect(result.detail).toContain('保持页面运行');
    expect(result.title).not.toContain('没有符合');
  });
  it('reports source access failures without inventing a 403 or a CORS diagnosis from Failed to fetch', () => {
    const result = changeDataNotice({ ...base(), snapshot: noFdv() });
    expect(result?.title).toBe('供应量服务暂不可访问');
    expect(result?.detail).toContain('0/1');
    expect(result?.detail).not.toMatch(/403|CORS|关闭跨域/);
    expect(result?.blocksAllMatches).toBe(true);
  });
  it('explains the AND rule cannot confirm a hit when FDV is missing even if OI already fails', () => {
    const result = changeEmptyState({ ...base(), snapshot: noFdv(), rows: [row({ fdvPct: null, fdvMatched: null })] });
    expect(result.title).toBe('FDV 数据暂不可用');
    expect(result.detail).toContain('要求 FDV');
  });
  it('keeps OI-only screening independent of the supply service', () => {
    const oiOnly = { ...rule, fdv: { ...rule.fdv, enabled: false } };
    const input = { ...base(), rule: oiOnly, snapshot: noFdv(), rows: [row({ fdvPct: null, fdvMatched: null })] };
    expect(changeDataNotice(input)?.blocksAllMatches).toBe(false);
    expect(changeEmptyState(input).title).toBe('当前可判断的标的中，暂无达标');
  });
  it('does not block OR just because one source is absent', () => {
    expect(changeDataNotice({ ...base(), rule: { ...rule, combine: 'any' }, snapshot: noFdv() })?.blocksAllMatches).toBe(false);
  });
  it('does block FDV-only rules, regardless of the unused combination setting', () => {
    expect(changeDataNotice({ ...base(), rule: { ...rule, combine: 'any', oi: { ...rule.oi, enabled: false } }, snapshot: noFdv() })?.blocksAllMatches).toBe(true);
  });
  it('does not call a legitimate unavailable max supply an access failure', () => {
    const input = { ...base(), snapshot: { ...noFdv(), errors: [] } };
    expect(changeDataNotice(input)?.title).toBe('FDV 数据暂不可用');
    expect(changeDataNotice(input)?.detail).toContain('最大供应量');
  });
  it('retains valid cached coverage and reports an update problem without pretending the cache is a new fetch', () => {
    const result = changeDataNotice({ ...base(), snapshot: snapshot({ errors: noFdv().errors }) });
    expect(result?.title).toBe('供应量更新受阻');
    expect(result?.detail).toContain('仍在有效期内');
    expect(result?.blocksAllMatches).toBe(false);
  });
  it('shows HTTP access denial distinctly', () => {
    expect(changeDataNotice({ ...base(), snapshot: { ...noFdv(), errors: ['COINGECKO_SUPPLY: HTTP_403: api.coingecko.com Forbidden'] } })?.title)
      .toBe('供应量服务拒绝访问');
  });
  it('excludes expired cached supply from effective coverage even when the raw FDV field is present', () => {
    const expired = asset();
    expired.supplyUpdatedAt = now - 121 * 60_000;
    expired.evidence.supply!.updatedAt = expired.supplyUpdatedAt;
    expired.evidence.supply!.fetchedAt = expired.supplyUpdatedAt;
    const input = { ...base(), snapshot: snapshot({ assets: [expired], errors: noFdv().errors }) };
    expect(input.snapshot.coverage.fdv).toBe(1);
    expect(changeDataNotice(input)).toMatchObject({ blocksAllMatches: true });
    expect(changeDataNotice(input)?.detail).toContain('0/1');
    expect(changeDataNotice(input)?.detail).not.toContain('仍在有效期内');
    expect(changeEmptyState(input).title).toBe('FDV 数据暂不可用');
  });
  it('explains identity endpoint access denial and its known retry deadline', () => {
    const input = { ...base(), snapshot: { ...noFdv(), errors: ['COINGECKO_IDENTITY: HTTP_403: api.coingecko.com Forbidden',
      `COINGECKO_RETRY: ${new Date(now + 300_000).toISOString()}`] } };
    expect(changeDataNotice(input)).toMatchObject({ title: '供应量服务拒绝访问', retryAt: now + 300_000 });
    expect(changeDataNotice({ ...input, snapshot: { ...input.snapshot, errors: ['COINGECKO_IDENTITY: HTTP_451: api.coingecko.com'] } })?.title)
      .toBe('供应量服务拒绝访问');
  });
  it('does not describe a partial response or unresolved identity as a network refusal', () => {
    for (const source of ['COINGECKO_SUPPLY_PARTIAL', 'COINGECKO_IDENTITY_PARTIAL']) {
      const input = { ...base(), snapshot: { ...noFdv(), errors: [`${source}: 1/1 not verified`] } };
      expect(changeDataNotice(input)?.title).toBe('FDV 数据暂不可用');
      expect(changeDataNotice(input)?.retryAt).toBeUndefined();
    }
  });
  it('applies current endpoint and price source guards even before the snapshot expires', () => {
    for (const [priceTime, evaluatedAt] of [[now - 89_000, now + 2_000], [now + 1000, now]] as const) {
      const item = { ...asset(), priceUpdatedAt: priceTime };
      const input = { ...base(), now: evaluatedAt, snapshot: snapshot({ assets: [item] }) };
      expect(changeDataNotice(input)?.blocksAllMatches).toBe(true);
      expect(changeDataNotice(input)?.detail).toContain('0/1');
    }
  });
  it('shows source retry time only when known and still in the future', () => {
    const input = { ...base(), snapshot: { ...noFdv(), errors: [...noFdv().errors, `COINGECKO_RETRY: ${new Date(now + 60_000).toISOString()}`] } };
    expect(changeDataNotice(input)?.retryAt).toBe(now + 60_000);
    expect(changeDataNotice({ ...input, now: now + 60_000 })?.retryAt).toBeUndefined();
  });
  it('does not use a Binance timestamp as a supply retry timestamp', () => {
    expect(changeDataNotice({ ...base(), snapshot: { ...noFdv(), errors: [...noFdv().errors, `HTTP_429: fapi.binance.com 等待至 ${new Date(now + 60_000).toISOString()}`] } })?.retryAt).toBeUndefined();
  });
  it('does not pretend partial unresolved rows prove the whole market has no hits', () => {
    const unresolved = row({ evaluable: false, status: 'unavailable', oiPct: null, oiMatched: null });
    const result = changeEmptyState({ ...base(), rows: [row(), unresolved] });
    expect(result.title).toBe('当前可判断的标的中，暂无达标');
    expect(result.detail).toContain('1 个标的暂时无法判断');
  });
  it('makes partial FDV availability visible even when AND already yields below-threshold', () => {
    const result = changeDataNotice({ ...base(), snapshot: snapshot({ universe: { assets: 2, contracts: 2 } }), rows: [row(), row({ fdvPct: null, fdvMatched: null })] });
    expect(result?.title).toBe('部分 FDV 数据不可用');
    expect(result?.detail).toContain('1/2');
  });
  it('gives stale data precedence over all other source and baseline messages', () => {
    const input = { ...base(), now: now + 90_001, snapshot: noFdv() };
    expect(changeEmptyState(input).title).toBe('行情已过期，暂停判断');
    expect(changeDataNotice(input)?.title).toBe('行情已过期，暂停判断');
  });
  it('has honest initial, loading, history-error and empty-search states', () => {
    expect(changeEmptyState({ ...base(), snapshot: null, rows: [] }).title).toBe('等待首轮行情');
    expect(changeEmptyState({ ...base(), loading: true }).title).toBe('正在读取 1 分钟比较数据…');
    expect(changeEmptyState({ ...base(), error: 'storage error' }).title).toBe('历史读取失败，暂时无法判断');
    expect(changeEmptyState({ ...base(), rows: [], hasQuery: true }).title).toBe('未找到匹配的币种');
  });
  it('distinguishes a pattern-filter empty result and an empty unknown-only tab', () => {
    expect(changeEmptyState({ ...base(), hasPattern: true }).title).toBe('当前联动筛选下没有标的');
    expect(changeEmptyState({ ...base(), scope: 'unavailable' }).title).toBe('当前没有无法判断的标的');
  });
  it('has no healthy-data warning and leaves passed rules unchanged', () => {
    const input = base(), before = structuredClone(input);
    expect(changeDataNotice(input)).toBeNull();
    changeEmptyState(input);
    expect(input).toEqual(before);
  });
});
