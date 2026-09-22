import Decimal from 'decimal.js';
import type { AssetRow, Collector, CollectorOptions, ContractEvidence, Snapshot, SourceStamp, SupplyEvidence } from '../shared/types';
import { IDENTITY_OVERRIDES, UNIT_ALIASES } from './aliases';
import { createSourceClient } from './http';

const BINANCE = 'https://fapi.binance.com';
const CG = 'https://api.coingecko.com/api/v3';
const CMC = 'https://pro-api.coinmarketcap.com';
const EXCHANGE_URL = `${BINANCE}/fapi/v1/exchangeInfo`;
const PRICE_URL = `${BINANCE}/fapi/v1/premiumIndex`;
const FX_URL = `${BINANCE}/fapi/v1/assetIndex`;
const CG_MAPPING_URL = `${CG}/derivatives/exchanges/binance_futures?include_tickers=all`;
const MINUTE = 60_000;
const SUPPLY_REFRESH = 60 * MINUTE;
const SUPPLY_MAX_AGE = 2 * SUPPLY_REFRESH;
const MARKET_MAX_AGE = 90_000;
const MAX_PROVIDER_PRICE_DEVIATION = new Decimal('0.30');
const STABLE_MARGIN = new Set(['USDT', 'USDC', 'USD1', 'U']);

interface Contract { symbol: string; baseAsset: string; quoteAsset: string; marginAsset: string; status: string; contractType: string; underlyingType: string; }
interface Premium { symbol: string; markPrice: string; indexPrice: string; time: number; }
interface Fx { symbol: string; index: string; time: number; }
interface Oi { symbol: string; openInterest: string; time: number; }
interface GeckoTicker { symbol: string; base: string; target: string; coin_id: string | null; contract_type: string; }
interface CmcPrice { id?: number; symbol?: string; price?: number | null; }
interface CmcQuote { id: number; symbol: string; name: string; circulating_supply: number | null; total_supply: number | null; max_supply: number | null; infinite_supply?: boolean; last_updated?: string; quote?: CmcPrice[] | Record<string, CmcPrice>; }
interface GeckoMarket { id: string; symbol: string; name: string; circulating_supply: number | null; total_supply: number | null; max_supply: number | null; last_updated?: string; current_price?: number | null; }
interface Envelope<T> { data: T; status?: { error_code?: number | string | null; error_message?: string | null }; }
interface Identity { symbol: string; geckoId?: string; cmcId?: number; multiplier: number; mapping: string; url: string; }
interface Supply { evidence: SupplyEvidence; symbol: string; name: string; }
interface Cached<T> { value: T; fetchedAt: number; }
type RoundOptions = Parameters<Collector['collect']>[0];

function decimal(value: unknown, allowZero = false): Decimal | null {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') return null;
  try {
    const result = new Decimal(value);
    return result.isFinite() && (allowZero ? result.gte(0) : result.gt(0)) ? result : null;
  } catch { return null; }
}
function finite(value: Decimal | null): number | null { const number = value?.toNumber(); return number !== undefined && Number.isFinite(number) ? number : null; }
function supplyNumber(value: unknown): number | null { return finite(decimal(value)); }
function epoch(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null; }
function iso(value: string | undefined): number { const time = Date.parse(value ?? ''); return Number.isFinite(time) ? time : 0; }
function fresh(time: number | null, now: number, maxAge: number): boolean { return time !== null && time > 0 && now - time <= maxAge && time - now <= 15_000; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function unpack<T>(response: Envelope<T>): T {
  const code = response.status?.error_code;
  // The keyless gateway can serialize success as "0", unlike the numeric value in the published schema.
  if (code != null && String(code) !== '0') throw new Error(`CMC_${code}: ${response.status?.error_message?.trim() || '数据源返回应用错误'}`);
  if (!response.data) throw new Error('CMC_RESPONSE_INVALID: 缺少 data');
  return response.data;
}
function chunks<T>(array: T[], size: number): T[][] { return Array.from({ length: Math.ceil(array.length / size) }, (_, i) => array.slice(i * size, (i + 1) * size)); }
function geckoMarketUrl(ids: string[]): string { return `${CG}/coins/markets?vs_currency=usd&ids=${ids.map(encodeURIComponent).join(',')}&per_page=${ids.length}&page=1&sparkline=false`; }
function geckoBatches(ids: string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  for (const id of ids) {
    // Bound both response size and URL length; some browser/network intermediaries reject long URLs.
    if (batch.length && (batch.length >= 100 || geckoMarketUrl([...batch, id]).length > 1800)) { batches.push(batch); batch = []; }
    batch.push(id);
  }
  if (batch.length) batches.push(batch);
  return batches;
}
function dedupe(values: string[]): string[] { return [...new Set(values)]; }
function stamp(url: string, observedAt: number, sourceTime: number | null): SourceStamp { return { provider: 'Binance', url, observedAt, sourceTime }; }
function cmcUsdPrice(quote: CmcQuote['quote']): number | null {
  const usd = Array.isArray(quote) ? quote.find(q => q.symbol === 'USD' || q.id === 2781) : quote?.USD;
  return finite(decimal(usd?.price));
}

export function createCollector(options: CollectorOptions = {}): Collector {
  const mode = options.mode ?? 'direct';
  // CMC's public gateway does not support browser CORS. Neither it nor secret-bearing
  // endpoints may be requested in direct mode, even when a caller supplies a key.
  const useCmc = mode === 'server' && typeof window === 'undefined';
  const key = useCmc ? options.cmcApiKey : undefined;
  const requestedConcurrency = Number.isFinite(options.concurrency) ? Math.floor(options.concurrency!) : 6;
  const request = createSourceClient(options.fetcher ?? fetch, Math.max(1, Math.min(6, requestedConcurrency)));
  let universe: Cached<Contract[]> | undefined;
  let geckoMapping: Cached<GeckoTicker[]> | undefined;
  const supplies = new Map<string, Supply>();
  const identities = new Map<string, Identity>();
  let nextSupplyAttempt = 0;
  let supplyProblems: string[] = [];
  let inFlight: Promise<Snapshot> | undefined;

  // Rehydrate only still-fresh, previously verified evidence. Original provider times are never rewritten.
  for (const row of options.initialSnapshot?.assets ?? []) {
    const evidence = row.evidence.supply;
    if (row.mappingStatus !== 'verified' || !evidence || !decimal(evidence.providerPriceUsd) || !fresh(evidence.updatedAt, Date.now(), SUPPLY_MAX_AGE) || !fresh(evidence.fetchedAt, Date.now(), SUPPLY_MAX_AGE)) continue;
    if (!['CoinMarketCap', 'CoinGecko'].includes(evidence.provider) || !/^[a-zA-Z0-9_-]+$/.test(evidence.id)) continue;
    const isCmc = evidence.provider === 'CoinMarketCap';
    if (isCmc && !useCmc) continue;
    if (isCmc && (!/^\d+$/.test(evidence.id) || Number(evidence.id) <= 0)) continue;
    const override = IDENTITY_OVERRIDES[row.symbol];
    // Earlier builds attempted to bridge providers by slug. Such cached CMC IDs are untrusted.
    if (isCmc && !override) continue;
    if (override && evidence.id !== (isCmc ? String(override.cmcId) : override.geckoId)) continue;
    supplies.set(`${isCmc ? 'cmc' : 'cg'}:${evidence.id}`, { evidence: { ...evidence }, symbol: row.symbol.toUpperCase(), name: row.name });
    for (const contract of row.evidence.contracts) {
      const alias = UNIT_ALIASES[contract.baseAsset];
      if ((alias?.symbol ?? contract.baseAsset).toUpperCase() !== row.symbol.toUpperCase()) continue;
      identities.set(contract.baseAsset, { symbol: row.symbol, ...(isCmc ? { cmcId: Number(evidence.id) } : { geckoId: evidence.id }), multiplier: alias?.multiplier ?? 1, mapping: row.evidence.mapping, url: evidence.mappingUrl ?? evidence.url });
    }
  }

  async function loadSupply(contracts: Contract[], signal: AbortSignal, errors: string[]) {
    if (Date.now() < nextSupplyAttempt) { errors.push(...supplyProblems); return; }
    // A failed provider is retried at most once per minute; successful supply is retained with its real timestamps.
    nextSupplyAttempt = Date.now() + MINUTE;
    const problems: string[] = [];
    const groups = new Map<string, Contract[]>();
    for (const contract of contracts) groups.set(contract.baseAsset, [...groups.get(contract.baseAsset) ?? [], contract]);
    for (const base of groups.keys()) {
      const override = IDENTITY_OVERRIDES[base];
      if (!override) continue;
      identities.set(base, { symbol: override.symbol, geckoId: override.geckoId, cmcId: override.cmcId, multiplier: 1, url: override.sources[0]!, mapping: `${override.address ? '官方合约地址核验' : '官方原生币身份核验'} ${override.chain}:${override.address ?? '原生资产'}; CoinGecko=${override.geckoId}; CMC=${override.cmcId}; ${override.sources.join(' ; ')}` });
    }
    const cachedForAll = [...groups.keys()].map(base => selectSupply(identities.get(base)));
    if (cachedForAll.every(supply => supply && Date.now() - supply.evidence.fetchedAt < SUPPLY_REFRESH)) {
      nextSupplyAttempt = Math.min(...cachedForAll.map(supply => supply!.evidence.fetchedAt + SUPPLY_REFRESH));
      supplyProblems = [];
      return;
    }
    const headers = key ? { 'X-CMC_PRO_API_KEY': key } : undefined;
    const cmcPrefix = key ? CMC : `${CMC}/public-api`;

    try {
      if ([...groups.keys()].some(base => !IDENTITY_OVERRIDES[base])) {
      if (!geckoMapping || Date.now() - geckoMapping.fetchedAt >= 24 * SUPPLY_REFRESH) {
        const result = await request<{ tickers: GeckoTicker[] }>(CG_MAPPING_URL, signal);
        if (!Array.isArray(result.tickers)) throw new Error('COINGECKO_MAPPING_INVALID');
        geckoMapping = { value: result.tickers, fetchedAt: Date.now() };
      }
      for (const [base, group] of groups) {
        if (IDENTITY_OVERRIDES[base]) continue;
        const ticks = geckoMapping.value.filter(t => t.contract_type === 'perpetual' && t.base === base && group.some(c => c.symbol === t.symbol && c.quoteAsset === t.target) && t.coin_id);
        const ids = new Set(ticks.map(t => t.coin_id!));
        if (ids.size !== 1) continue;
        const providerId = [...ids][0]!;
        if (!/^[a-zA-Z0-9_-]+$/.test(providerId)) continue;
        const alias = UNIT_ALIASES[base];
        if (alias && !alias.acceptedGeckoIds.includes(providerId)) continue;
        identities.set(base, { symbol: alias?.symbol ?? base, geckoId: alias?.geckoId ?? providerId, multiplier: alias?.multiplier ?? 1, url: CG_MAPPING_URL, mapping: `CoinGecko Binance 合约 ${ticks.map(t => t.symbol).join(',')} → ${providerId}${alias ? ` → ${alias.geckoId}; 单位倍率 ${alias.multiplier}; ${alias.evidence}` : ''}` });
      }
      }
    } catch (error) { problems.push(`COINGECKO_IDENTITY: ${message(error)}`); }

    // Provider slugs and symbols are not global identities. Only reviewed native-token or
    // contract-address mappings may authorize a CMC ID; all other supply stays within CoinGecko.
    if (useCmc) try {
      const needed = [...new Set([...groups.keys()].flatMap(base => {
        const id = identities.get(base)?.cmcId;
        const cached = id == null ? undefined : supplies.get(`cmc:${id}`);
        return id != null && (!cached || Date.now() - cached.evidence.fetchedAt >= SUPPLY_REFRESH) ? [id] : [];
      }))];
      for (const ids of chunks(needed, 250)) {
        const url = `${cmcPrefix}/v3/cryptocurrency/quotes/latest?id=${ids.join(',')}&convert=USD`;
        const response = unpack(await request<Envelope<CmcQuote[] | Record<string, CmcQuote>>>(url, signal, headers));
        const rows = Array.isArray(response) ? response : Object.values(response);
        for (const row of rows) {
          if (!ids.includes(row.id)) continue;
          supplies.set(`cmc:${row.id}`, { symbol: row.symbol.toUpperCase(), name: row.name, evidence: { provider: 'CoinMarketCap', id: String(row.id), circulating: supplyNumber(row.circulating_supply), total: supplyNumber(row.total_supply), max: row.infinite_supply ? null : supplyNumber(row.max_supply), providerPriceUsd: cmcUsdPrice(row.quote), updatedAt: iso(row.last_updated), fetchedAt: Date.now(), url } });
        }
      }
    } catch (error) { problems.push(`CMC_SUPPLY: ${message(error)}`); }

    // A fallback changes only the supply provider, never the max-supply FDV formula or Binance OI.
    const missing = [...new Set([...groups.keys()].flatMap(base => {
      const identity = identities.get(base);
      const preferred = !useCmc || identity?.cmcId == null ? undefined : supplies.get(`cmc:${identity.cmcId}`);
      const fallback = identity?.geckoId ? supplies.get(`cg:${identity.geckoId}`) : undefined;
      return identity?.geckoId && (!preferred || !supplyFresh(preferred)) && (!fallback || Date.now() - fallback.evidence.fetchedAt >= SUPPLY_REFRESH) ? [identity.geckoId] : [];
    }))];
    for (const ids of geckoBatches(missing)) {
      const url = geckoMarketUrl(ids);
      try {
        const rows = await request<GeckoMarket[]>(url, signal);
        if (!Array.isArray(rows)) throw new Error('COINGECKO_SUPPLY_INVALID');
        for (const row of rows) {
          if (!ids.includes(row.id)) continue;
          supplies.set(`cg:${row.id}`, { symbol: row.symbol.toUpperCase(), name: row.name, evidence: { provider: 'CoinGecko', id: row.id, circulating: supplyNumber(row.circulating_supply), total: supplyNumber(row.total_supply), max: supplyNumber(row.max_supply), providerPriceUsd: finite(decimal(row.current_price)), updatedAt: iso(row.last_updated), fetchedAt: Date.now(), url } });
        }
        const returned = new Set(rows.map(row => row.id));
        const absent = ids.filter(id => !returned.has(id));
        if (absent.length) problems.push(`COINGECKO_SUPPLY_PARTIAL: ${absent.length}/${ids.length} 个请求的资产未返回供应量，下轮仅补取缺失项`);
      } catch (error) { problems.push(`COINGECKO_SUPPLY: ${message(error)}`); break; }
    }
    if (problems.length === 0) nextSupplyAttempt = Date.now() + SUPPLY_REFRESH;
    supplyProblems = dedupe(problems);
    errors.push(...supplyProblems);
  }

  function supplyFresh(supply: Supply): boolean {
    return fresh(supply.evidence.updatedAt, Date.now(), SUPPLY_MAX_AGE) && fresh(supply.evidence.fetchedAt, Date.now(), SUPPLY_MAX_AGE);
  }
  function selectSupply(identity: Identity | undefined): Supply | undefined {
    const primary = !useCmc || identity?.cmcId == null ? undefined : supplies.get(`cmc:${identity.cmcId}`);
    const fallback = identity?.geckoId ? supplies.get(`cg:${identity.geckoId}`) : undefined;
    return primary && supplyFresh(primary) ? primary : fallback && supplyFresh(fallback) ? fallback : primary ?? fallback;
  }

  async function run(roundOptions: RoundOptions = {}): Promise<Snapshot> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const externalAbort = () => controller.abort(roundOptions?.signal?.reason);
    roundOptions?.signal?.addEventListener('abort', externalAbort, { once: true });
    if (roundOptions?.signal?.aborted) controller.abort(roundOptions.signal.reason);
    const timer = setTimeout(() => controller.abort(new Error('ROUND_BUDGET_55S')), 55_000);
    const signal = controller.signal;
    const errors: string[] = [];
    let prices: Premium[] = [];
    let fx: Fx[] = [];
    let priceObservedAt = startedAt;
    let fxObservedAt = startedAt;
    const observations = new Map<string, { data?: Oi; observedAt: number; error?: string }>();
    try {
      roundOptions?.onProgress?.({ stage: '读取 Binance 合约与价格', done: 0, total: 0, failed: 0 });
      await Promise.all([
        (async () => {
          if (universe && Date.now() - universe.fetchedAt < 15 * MINUTE) return;
          try {
            const result = await request<{ symbols: Contract[] }>(EXCHANGE_URL, signal);
            if (!Array.isArray(result.symbols)) throw new Error('BINANCE_UNIVERSE_INVALID');
            const eligible = result.symbols.filter(c => c.status === 'TRADING' && c.contractType === 'PERPETUAL' && c.underlyingType === 'COIN' && STABLE_MARGIN.has(c.marginAsset));
            if (eligible.length === 0) throw new Error('BINANCE_UNIVERSE_EMPTY');
            universe = { value: eligible, fetchedAt: Date.now() };
          } catch (error) { errors.push(`BINANCE_UNIVERSE: ${message(error)}`); }
        })(),
        (async () => { try { const result = await request<Premium[]>(PRICE_URL, signal); if (!Array.isArray(result)) throw new Error('BINANCE_PRICE_INVALID'); prices = result; priceObservedAt = Date.now(); } catch (error) { errors.push(`BINANCE_PRICE: ${message(error)}`); } })(),
        (async () => { try { const result = await request<Fx[]>(FX_URL, signal); if (!Array.isArray(result)) throw new Error('BINANCE_FX_INVALID'); fx = result; fxObservedAt = Date.now(); } catch (error) { errors.push(`BINANCE_FX: ${message(error)}`); } })(),
      ]);
      if (!universe) throw new Error(`无法取得 Binance 合约清单。${errors.join('；')}`);
      const contracts = universe.value;
      let cursor = 0;
      let done = 0;
      let failed = 0;
      const workers = Array.from({ length: Math.min(6, contracts.length) }, async () => {
        while (cursor < contracts.length && !signal.aborted) {
          const contract = contracts[cursor++]!;
          const url = `${BINANCE}/fapi/v1/openInterest?symbol=${encodeURIComponent(contract.symbol)}`;
          try {
            const result = await request<Oi>(url, signal);
            if (result.symbol !== contract.symbol || !decimal(result.openInterest, true) || !epoch(result.time)) throw new Error('BINANCE_OI_INVALID');
            observations.set(contract.symbol, { data: result, observedAt: Date.now() });
          } catch (error) { failed++; observations.set(contract.symbol, { observedAt: Date.now(), error: message(error) }); }
          done++;
          roundOptions?.onProgress?.({ stage: '逐合约采集源头 OI', done, total: contracts.length, failed });
        }
      });
      await Promise.all([...workers, loadSupply(contracts, signal, errors)]);
      if (roundOptions?.signal?.aborted) throw new DOMException('采集已取消', 'AbortError');
      const asOf = Date.now();
      if (signal.aborted) errors.push('ROUND_BUDGET: 本轮超过 55 秒，未取得的数据已标记缺失');
      const priceMap = new Map(prices.map(p => [p.symbol, p]));
      const fxMap = new Map(fx.map(p => [p.symbol, p]));
      const grouped = new Map<string, Contract[]>();
      for (const contract of contracts) {
        const base = UNIT_ALIASES[contract.baseAsset]?.symbol ?? contract.baseAsset;
        grouped.set(base, [...grouped.get(base) ?? [], contract]);
      }
      const assets: AssetRow[] = [];
      for (const [base, group] of grouped) {
        const issues: string[] = [];
        if (asOf - universe.fetchedAt >= 15 * MINUTE) issues.push('合约清单过期，暂停告警');
        const identity = identities.get(group[0]!.baseAsset);
        const supply = selectSupply(identity);
        const identityCandidate = !!identity && !!supply && supply.symbol === identity.symbol.toUpperCase();
        if (!supply) issues.push('供应量源暂不可用');
        else if (!supplyFresh(supply)) issues.push('供应量超过 2 小时或缺少源时间，暂停告警');
        const evidence: ContractEvidence[] = group.map(contract => {
          const oi = observations.get(contract.symbol);
          const price = priceMap.get(contract.symbol);
          const rate = fxMap.get(`${contract.quoteAsset}USD`);
          const quantity = decimal(oi?.data?.openInterest, true);
          const mark = decimal(price?.markPrice);
          const quoteUsd = decimal(rate?.index);
          const value = quantity && mark && quoteUsd ? quantity.mul(mark).mul(quoteUsd) : null;
          const localIssues: string[] = [];
          if (!quantity) localIssues.push(oi?.error ?? 'OI 未取得');
          if (!mark || !decimal(price?.indexPrice)) localIssues.push('价格缺失');
          if (!quoteUsd) localIssues.push('报价币美元汇率缺失');
          if (quantity && !fresh(epoch(oi?.data?.time), asOf, MARKET_MAX_AGE)) localIssues.push('OI 源时间过期');
          if (mark && !fresh(epoch(price?.time), asOf, MARKET_MAX_AGE)) localIssues.push('价格源时间过期');
          if (quoteUsd && !fresh(epoch(rate?.time), asOf, MARKET_MAX_AGE)) localIssues.push('美元汇率源时间过期');
          if (localIssues.length) issues.push(`${contract.symbol}: ${localIssues.join('；')}`);
          const oiUrl = `${BINANCE}/fapi/v1/openInterest?symbol=${encodeURIComponent(contract.symbol)}`;
          return { symbol: contract.symbol, baseAsset: contract.baseAsset, quoteAsset: contract.quoteAsset, openInterest: oi?.data?.openInterest ?? null, markPrice: price?.markPrice ?? null, indexPrice: price?.indexPrice ?? null, quoteUsd: rate?.index ?? null, oiTime: epoch(oi?.data?.time), priceTime: epoch(price?.time), quoteTime: epoch(rate?.time), oiUsd: finite(value), ...(localIssues.length ? { error: localIssues.join('；') } : {}), sources: [stamp(EXCHANGE_URL, universe!.fetchedAt, null), stamp(oiUrl, oi?.observedAt ?? asOf, epoch(oi?.data?.time)), stamp(PRICE_URL, priceObservedAt, epoch(price?.time)), stamp(FX_URL, fxObservedAt, epoch(rate?.time))] };
        });
        const ordered = [...evidence].sort((a, b) => (a.quoteAsset === 'USDT' ? -1 : b.quoteAsset === 'USDT' ? 1 : a.symbol.localeCompare(b.symbol)));
        const reference = ordered.find(c => decimal(c.indexPrice) && decimal(c.quoteUsd) && fresh(c.priceTime, asOf, MARKET_MAX_AGE) && fresh(c.quoteTime ?? null, asOf, MARKET_MAX_AGE));
        const multiplier = reference ? UNIT_ALIASES[reference.baseAsset]?.multiplier ?? 1 : 1;
        // Native OI × native mark price already cancels contract-unit multipliers. Only per-token price is divided.
        const tokenPrice = reference ? decimal(reference.indexPrice)!.mul(reference.quoteUsd!).div(multiplier) : null;
        // Price agreement is a negative sanity check, not identity proof. Exact market mapping (or an
        // address-verified override), symbol, and unit normalization are independently required above.
        const providerPrice = decimal(supply?.evidence.providerPriceUsd);
        const priceDeviation = tokenPrice && providerPrice ? tokenPrice.div(providerPrice).sub(1).abs() : null;
        const priceConsistent = !!priceDeviation && priceDeviation.lte(MAX_PROVIDER_PRICE_DEVIATION);
        const mappingVerified = identityCandidate && priceConsistent;
        if (!identityCandidate) issues.push('资产身份或供应量映射尚未核实');
        if (identityCandidate && !providerPrice) issues.push('供应源缺少独立美元价格，无法核验身份与单位');
        else if (identityCandidate && !priceConsistent) issues.push(`供应源与 Binance 标准化价格不一致${priceDeviation ? `（偏差 ${priceDeviation.mul(100).toFixed(1)}% > 30%）` : ''}，映射待核实`);
        const oiSum = evidence.every(c => c.oiUsd !== null) ? evidence.reduce((sum, c) => sum.add(new Decimal(c.openInterest!).mul(c.markPrice!).mul(c.quoteUsd!)), new Decimal(0)) : null;
        const circulation = mappingVerified ? supply!.evidence.circulating : null;
        const max = mappingVerified ? supply!.evidence.max : null;
        if (max === null) issues.push('没有已核实的最大供应量，FDV 不可用');
        if (circulation === null) issues.push('流通供应量不可用');
        const cap = tokenPrice && circulation !== null ? tokenPrice.mul(circulation) : null;
        const fdv = tokenPrice && max !== null ? tokenPrice.mul(max) : null;
        // OI-history completeness is independent of supply availability. FDV needs max, not circulating supply.
        const complete = asOf - universe.fetchedAt < 15 * MINUTE && evidence.every(c => !c.error) && oiSum !== null && tokenPrice !== null;
        const alertEligible = complete && mappingVerified && !!supply && supplyFresh(supply) && !!fdv?.gt(0);
        const oldestOi = evidence.every(c => c.oiTime !== null) ? Math.min(...evidence.map(c => c.oiTime!)) : null;
        assets.push({ id: `binance:${base}`, symbol: base, name: mappingVerified ? supply!.name : base, contracts: group.map(c => c.symbol), priceUsd: finite(tokenPrice), oiUsd: finite(oiSum), marketCapUsd: finite(cap), fdvUsd: finite(fdv), oiToFdv: oiSum && fdv?.gt(0) ? finite(oiSum.div(fdv).mul(100)) : null, oiToMarketCap: oiSum && cap?.gt(0) ? finite(oiSum.div(cap).mul(100)) : null, circulatingSupply: circulation, maxSupply: max, updatedAt: asOf, oiUpdatedAt: oldestOi, priceUpdatedAt: reference?.priceTime ?? null, supplyUpdatedAt: supply?.evidence.updatedAt || null, complete, alertEligible, issues: dedupe(issues), supplySource: supply?.evidence.provider ?? null, mappingStatus: mappingVerified ? 'verified' : 'unmapped', evidence: { contracts: evidence, supply: supply ? { ...supply.evidence, mappingUrl: identity?.url } : null, mapping: identity?.mapping ?? '未找到与 Binance 合约相符的可靠资产标识；不按重名或市值猜测。' } });
      }
      assets.sort((a, b) => (b.oiUsd ?? -1) - (a.oiUsd ?? -1));
      const failedContracts = assets.reduce((sum, a) => sum + a.evidence.contracts.filter(c => c.error).length, 0);
      if (failedContracts) errors.push(`BINANCE_PARTIAL: ${failedContracts}/${contracts.length} 个合约存在缺失或过期数据`);
      return { schemaVersion: 1, mode, startedAt, asOf, durationMs: asOf - startedAt, universe: { contracts: contracts.length, assets: assets.length }, coverage: { oi: assets.filter(a => a.oiUsd !== null).length, marketCap: assets.filter(a => a.marketCapUsd !== null).length, fdv: assets.filter(a => a.fdvUsd !== null).length, eligible: assets.filter(a => a.alertEligible).length, failedContracts }, assets, errors: dedupe(errors) };
    } finally {
      clearTimeout(timer);
      roundOptions?.signal?.removeEventListener('abort', externalAbort);
    }
  }
  return { collect(roundOptions) { if (!inFlight) inFlight = run(roundOptions).finally(() => { inFlight = undefined; }); return inFlight; } };
}
