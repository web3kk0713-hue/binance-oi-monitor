/** Read-only, bounded acceptance check. This does not certify persistence, push, or trading signals. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLLECTION_INTERVAL_MS, type AssetRow, type BackendStatus, type Snapshot } from '../src/shared/types';

type Status = 'passed' | 'partial' | 'blocked' | 'unverified';
interface Options { baseUrl: string; rounds: number; intervalMs: number; timeoutMs: number }
interface TransportOptions { timeoutMs: number; maxBytes: number; fetcher?: typeof fetch }
type JsonResult = { ok: true; value: unknown } | { ok: false; code: string };
interface Sample {
  status: Status; checkedAt: number; asOf: number | null; reasons: string[];
  coverage: { assets: number; freshOi: number; positiveOi: number; trustedFiniteMax: number; trustedFdv: number; maxNotAvailable: number; supplyUnverified: number };
  sourceErrors: { coinGecko: number; coinMarketCap: number; binance: number; other: number };
}
const MARKET_MAX_AGE = 90_000, SUPPLY_MAX_AGE = 7_200_000, FUTURE_TOLERANCE = 15_000;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const positive = (value: unknown): value is number => number(value) && value > 0;
const nullableNumber = (value: unknown) => value === null || number(value);
const count = (value: unknown): value is number => number(value) && Number.isInteger(value) && value >= 0;
const fresh = (value: unknown, now: number, age: number) => positive(value) && now - value <= age && value - now <= FUTURE_TOLERANCE;
const close = (a: number, b: number) => Number.isFinite(b) && Math.abs(a - b) <= Math.max(1e-8, Math.abs(b) * 1e-9);

export function parseOptions(args: string[]): Options {
  const invalid = () => new Error('INVALID_ARGUMENTS'); // Never echo user input: it may contain credentials.
  if (!args[0] || args[0].startsWith('--')) throw invalid();
  let base: URL;
  try { base = new URL(args[0]); } catch { throw invalid(); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw invalid();
  const values = new Map<string, string>();
  for (const arg of args.slice(1)) {
    const match = /^(--once|--rounds|--interval-ms|--timeout-ms)(?:=(\d+))?$/.exec(arg);
    if (!match || values.has(match[1]) || (match[1] === '--once' ? !!match[2] : !match[2])) throw invalid();
    values.set(match[1], match[2] ?? '');
  }
  if (values.has('--once') && values.has('--rounds')) throw invalid();
  const rounds = values.has('--once') ? 1 : Number(values.get('--rounds') ?? 3);
  const intervalMs = Number(values.get('--interval-ms') ?? 35_000), timeoutMs = Number(values.get('--timeout-ms') ?? 10_000);
  if (!Number.isSafeInteger(rounds) || (rounds < 2 && !values.has('--once')) || rounds > 10
    || intervalMs < COLLECTION_INTERVAL_MS + 1000 || intervalMs > 60_000 || timeoutMs < 500 || timeoutMs > 30_000) throw invalid();
  return { baseUrl: base.href.replace(/\/$/, ''), rounds, intervalMs, timeoutMs };
}

/** Timeout covers headers AND streaming body; do not parse or print arbitrary error bodies. */
export async function readJson(url: string, options: TransportOptions): Promise<JsonResult> {
  const abort = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fail = (code: string): JsonResult => ({ ok: false, code });
  const timeout = new Promise<JsonResult>(resolveTimeout => {
    timer = setTimeout(() => { abort.abort(); resolveTimeout(fail('TIMEOUT')); }, options.timeoutMs);
  });
  const request = (async (): Promise<JsonResult> => {
    try {
      const response = await (options.fetcher ?? fetch)(url, { method: 'GET', headers: { Accept: 'application/json' },
        credentials: 'omit', redirect: 'error', cache: 'no-store', signal: abort.signal });
      if (!response.ok) { void response.body?.cancel().catch(() => {}); return fail(`HTTP_${response.status}`); }
      if (!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
        void response.body?.cancel().catch(() => {}); return fail('NOT_JSON');
      }
      const advertised = Number(response.headers.get('content-length') ?? 0);
      if (advertised > options.maxBytes) { void response.body?.cancel().catch(() => {}); return fail('BODY_TOO_LARGE'); }
      if (!response.body) return fail('EMPTY_BODY');
      reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > options.maxBytes) return fail('BODY_TOO_LARGE');
        chunks.push(value);
      }
      const body = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      try { return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown }; }
      catch { return fail('INVALID_JSON'); }
    } catch { return fail(abort.signal.aborted ? 'TIMEOUT' : 'REQUEST_FAILED'); }
  })();
  try { return await Promise.race([request, timeout]); }
  finally { if (timer) clearTimeout(timer); abort.abort(); if (reader) void reader.cancel().catch(() => {}); }
}

function validHealth(value: unknown): value is BackendStatus {
  return object(value) && value.mode === 'server' && nullableNumber(value.lastSuccess) && typeof value.collecting === 'boolean'
    && typeof value.storage === 'string' && typeof value.pushEnabled === 'boolean' && count(value.retentionDays)
    && (value.lastError === null || typeof value.lastError === 'string');
}
function validAsset(value: unknown): value is AssetRow {
  if (!object(value) || typeof value.id !== 'string' || typeof value.complete !== 'boolean' || typeof value.alertEligible !== 'boolean'
    || ![value.priceUsd, value.oiUsd, value.fdvUsd, value.maxSupply, value.oiUpdatedAt, value.priceUpdatedAt, value.supplyUpdatedAt].every(nullableNumber)
    || !object(value.evidence)) return false;
  const supply = value.evidence.supply;
  return supply === null || object(supply) && typeof supply.provider === 'string' && typeof supply.id === 'string'
    && typeof supply.url === 'string' && nullableNumber(supply.max) && number(supply.updatedAt) && number(supply.fetchedAt);
}
function validSnapshot(value: unknown): value is Snapshot {
  return object(value) && value.schemaVersion === 1 && value.mode === 'server' && positive(value.asOf)
    && object(value.universe) && count(value.universe.assets) && count(value.universe.contracts)
    && object(value.coverage) && ['oi', 'marketCap', 'fdv', 'eligible', 'failedContracts'].every(key => count(value.coverage && (value.coverage as Record<string, unknown>)[key]))
    && Array.isArray(value.assets) && value.assets.length <= 5000 && value.assets.every(validAsset)
    && Array.isArray(value.errors) && value.errors.every(error => typeof error === 'string');
}
function trustedSupply(row: AssetRow, now: number): boolean {
  const supply = row.evidence.supply;
  if (row.mappingStatus !== 'verified' || !supply || !fresh(row.supplyUpdatedAt, now, SUPPLY_MAX_AGE)
    || !fresh(supply.updatedAt, now, SUPPLY_MAX_AGE) || !fresh(supply.fetchedAt, now, SUPPLY_MAX_AGE)
    || !positive(row.priceUsd) || !positive(supply.providerPriceUsd)
    || Math.abs(row.priceUsd - supply.providerPriceUsd) / supply.providerPriceUsd > 0.3) return false;
  try {
    const url = new URL(supply.url);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    return supply.provider === 'CoinGecko' && url.hostname === 'api.coingecko.com' && /^[a-z0-9-]+$/.test(supply.id)
      || supply.provider === 'CoinMarketCap' && url.hostname === 'pro-api.coinmarketcap.com' && /^\d+$/.test(supply.id);
  } catch { return false; }
}
function blank(now: number): Sample {
  return { status: 'blocked', checkedAt: now, asOf: null, reasons: [], coverage: { assets: 0, freshOi: 0, positiveOi: 0,
    trustedFiniteMax: 0, trustedFdv: 0, maxNotAvailable: 0, supplyUnverified: 0 }, sourceErrors: { coinGecko: 0, coinMarketCap: 0, binance: 0, other: 0 } };
}

export function assessSample(health: unknown, snapshot: unknown, now: number): Sample {
  const result = blank(now), blocked: string[] = [], partial: string[] = [];
  if (!validHealth(health) || !validSnapshot(snapshot)) { result.reasons = ['INVALID_API_CONTRACT']; return result; }
  result.asOf = snapshot.asOf;
  if (!fresh(snapshot.asOf, now, MARKET_MAX_AGE)) blocked.push('SNAPSHOT_NOT_FRESH');
  if (!fresh(health.lastSuccess, now, MARKET_MAX_AGE)) blocked.push('NO_RECENT_SUCCESS');
  if (health.lastError) partial.push('BACKEND_REPORTED_ERROR');
  if (health.collectionIntervalMs !== COLLECTION_INTERVAL_MS || snapshot.collectionIntervalMs !== COLLECTION_INTERVAL_MS) partial.push('COLLECTION_CADENCE_NOT_30_SECONDS');
  if (health.retentionDays < 7 || (health.rawRetentionDays ?? 0) < 7) partial.push('RETENTION_CONFIGURATION_BELOW_7_DAYS');
  if (snapshot.universe.assets !== snapshot.assets.length || new Set(snapshot.assets.map(row => row.id)).size !== snapshot.assets.length) blocked.push('INVALID_ASSET_UNIVERSE');
  const coverage = result.coverage; coverage.assets = snapshot.assets.length;
  for (const row of snapshot.assets) {
    const marketFresh = row.complete && number(row.oiUsd) && row.oiUsd >= 0 && positive(row.priceUsd)
      && fresh(row.oiUpdatedAt, now, MARKET_MAX_AGE) && fresh(row.priceUpdatedAt, now, MARKET_MAX_AGE);
    if (marketFresh) { coverage.freshOi++; if (positive(row.oiUsd)) coverage.positiveOi++; }
    if (!trustedSupply(row, now)) { coverage.supplyUnverified++; continue; }
    const max = row.evidence.supply!.max;
    if (max === null && row.maxSupply === null && row.fdvUsd === null) { coverage.maxNotAvailable++; continue; }
    if (!positive(max)) { coverage.supplyUnverified++; continue; }
    coverage.trustedFiniteMax++;
    if (marketFresh && row.alertEligible && positive(row.maxSupply) && close(row.maxSupply, max)
      && positive(row.fdvUsd) && close(row.fdvUsd, row.priceUsd! * max)) coverage.trustedFdv++;
  }
  for (const error of snapshot.errors) {
    // Only fixed category counts escape this function. Source messages may contain URLs or keys.
    if (/^COINGECKO(?:_|:)/.test(error)) result.sourceErrors.coinGecko++;
    else if (/^CMC(?:_|:)/.test(error)) result.sourceErrors.coinMarketCap++;
    else if (/^BINANCE(?:_|:)/.test(error)) result.sourceErrors.binance++;
    else result.sourceErrors.other++;
  }
  if (!coverage.positiveOi) blocked.push('NO_POSITIVE_FRESH_OI');
  if (!coverage.trustedFdv) blocked.push('NO_TRUSTED_FDV');
  if (coverage.freshOi < coverage.assets || snapshot.coverage.failedContracts > 0) partial.push('OI_COVERAGE_PARTIAL');
  if (coverage.supplyUnverified > 0 || coverage.trustedFdv < coverage.trustedFiniteMax) partial.push('FDV_COVERAGE_PARTIAL');
  if (snapshot.errors.length) partial.push('UPSTREAM_REPORTED_ERRORS');
  result.reasons = [...blocked, ...partial];
  result.status = blocked.length ? 'blocked' : partial.length ? 'partial' : 'passed';
  return result;
}

export async function runReadiness(options: Options, dependencies: {
  fetcher?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void>; onSample?: (sample: Sample, round: number) => void;
} = {}) {
  const now = dependencies.now ?? Date.now, sleep = dependencies.sleep ?? (ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)));
  const samples: Sample[] = [];
  // Keep identifiers internal: output only counts, never untrusted upstream identifiers or messages.
  const observations: { lastSuccess: number | null; oiTimes: Map<string, number> }[] = [];
  for (let round = 0; round < options.rounds; round++) {
    if (round) await sleep(options.intervalMs);
    const [health, snapshot] = await Promise.all([
      readJson(`${options.baseUrl}/api/v1/health`, { timeoutMs: options.timeoutMs, maxBytes: 64 * 1024, fetcher: dependencies.fetcher }),
      readJson(`${options.baseUrl}/api/v1/snapshot`, { timeoutMs: options.timeoutMs, maxBytes: 8 * 1024 * 1024, fetcher: dependencies.fetcher }),
    ]);
    const sample = health.ok && snapshot.ok ? assessSample(health.value, snapshot.value, now()) : blank(now());
    if (!health.ok) sample.reasons.push(`HEALTH_${health.code}`);
    if (!snapshot.ok) sample.reasons.push(`SNAPSHOT_${snapshot.code}`);
    const oiTimes = new Map<string, number>();
    if (snapshot.ok && validSnapshot(snapshot.value)) for (const row of snapshot.value.assets) {
      if (row.complete && number(row.oiUsd) && row.oiUsd >= 0 && fresh(row.oiUpdatedAt, sample.checkedAt, MARKET_MAX_AGE)) oiTimes.set(row.id, row.oiUpdatedAt!);
    }
    observations.push({ lastSuccess: health.ok && validHealth(health.value) ? health.value.lastSuccess : null, oiTimes });
    samples.push(sample); dependencies.onSample?.(sample, round + 1);
  }
  const reasons: string[] = [];
  const sampling = { successAdvanced: null as boolean | null, comparedAssets: 0, advancingAssets: 0, stalledAssets: 0, missingAssets: 0 };
  let continuity: Status = 'unverified';
  if (samples.length > 1) {
    if (!samples.every((sample, index) => sample.asOf !== null && (!index || samples[index - 1].asOf !== null && sample.asOf > samples[index - 1].asOf!))) reasons.push('SNAPSHOT_NOT_ADVANCING');
    // Success and source clocks may repeat for a round, but must never regress and must advance over the entire probe.
    const advancing = (times: (number | null | undefined)[]) => times.every((time, index) => positive(time) && (!index || time >= times[index - 1]!))
      && times[times.length - 1]! > times[0]!;
    sampling.successAdvanced = advancing(observations.map(observation => observation.lastSuccess));
    if (!sampling.successAdvanced) reasons.push('COLLECTION_SUCCESS_NOT_ADVANCING');
    const ids = new Set(observations.flatMap(observation => [...observation.oiTimes.keys()]));
    for (const id of ids) {
      const times = observations.map(observation => observation.oiTimes.get(id));
      if (times.some(time => time === undefined)) { sampling.missingAssets++; continue; }
      sampling.comparedAssets++;
      if (advancing(times)) sampling.advancingAssets++; else sampling.stalledAssets++;
    }
    if (!sampling.advancingAssets) reasons.push('OI_SAMPLES_NOT_ADVANCING');
    continuity = reasons.length ? 'blocked' : sampling.stalledAssets || sampling.missingAssets ? 'partial' : 'passed';
    if (continuity === 'partial') reasons.push('OI_SAMPLE_ADVANCEMENT_PARTIAL');
  }
  const status: Status = samples.some(sample => sample.status === 'blocked') || continuity === 'blocked' ? 'blocked'
    : samples.some(sample => sample.status === 'partial') || continuity === 'partial' ? 'partial' : continuity === 'unverified' ? 'unverified' : 'passed';
  return { scope: 'bounded-market-data-readiness', status, continuity, sampling, reasons,
    requested: { rounds: options.rounds, intervalMs: options.intervalMs, timeoutMs: options.timeoutMs }, samples,
    unverified: ['historicalRetention', 'restartRecovery', 'pushDelivery', 'browserCors', 'orderFlowCoverage', 'longTermAvailability', 'commercialDataLicense'] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const usage = 'node --import tsx scripts/backend-readiness.ts <http(s)-api-base> [--once | --rounds=2..10] [--interval-ms=31000..60000] [--timeout-ms=500..30000]';
  try {
    const options = parseOptions(process.argv.slice(2));
    console.error(JSON.stringify({ event: 'readiness_started', rounds: options.rounds, intervalMs: options.intervalMs, timeoutMs: options.timeoutMs }));
    const report = await runReadiness(options, { onSample: (sample, round) => console.error(JSON.stringify({ event: 'sample', round, ...sample })) });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === 'passed' ? 0 : report.status === 'blocked' ? 1 : 2;
  } catch {
    console.error(JSON.stringify({ status: 'blocked', code: 'READINESS_ARGUMENT_OR_RUNTIME_ERROR', usage }));
    process.exitCode = 1;
  }
}
