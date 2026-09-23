import { mkdir, writeFile } from 'node:fs/promises';
import Decimal from 'decimal.js';
import { createCollector } from '../src/data/collector';
import { COLLECTION_INTERVAL_MS, type Snapshot } from '../src/shared/types';

const countArgument = process.argv.find(arg => arg.startsWith('--rounds='))?.split('=')[1];
const rounds = Math.min(3, Math.max(1, Number(countArgument ?? 1)));
const collector = createCollector({ mode: 'server', cmcApiKey: process.env.CMC_API_KEY });
const summaries: unknown[] = [];
for (let round = 1; round <= rounds; round++) {
  const start = Date.now();
  let lastDone = -1;
  const snapshot: Snapshot = await collector.collect({ onProgress: p => {
    if (p.done !== lastDone && (p.done === 0 || p.done % 100 === 0 || p.done === p.total)) {
      console.log(JSON.stringify({ round, progress: p })); lastDone = p.done;
    }
  } });
  const formulaFailures = snapshot.assets.filter(asset => {
    if (asset.oiUsd === null) return false;
    const sum = asset.evidence.contracts.reduce((total, contract) => {
      if (contract.openInterest === null || contract.markPrice === null || contract.quoteUsd === null) return total;
      return total.plus(new Decimal(contract.openInterest).mul(contract.markPrice).mul(contract.quoteUsd));
    }, new Decimal(0));
    return sum.minus(asset.oiUsd).abs().gt(Decimal.max(1e-8, sum.abs().mul(1e-12)));
  }).map(asset => asset.symbol);
  const summary = {
    round, observedAt: new Date(snapshot.asOf).toISOString(), durationMs: snapshot.durationMs,
    universe: snapshot.universe, coverage: snapshot.coverage, errors: snapshot.errors,
    formulaFailures, supplyProviders: [...new Set(snapshot.assets.map(a => a.supplySource).filter(Boolean))],
    samples: snapshot.assets.filter(a => ['BTC', 'ETH', 'PEPE', 'BONK', 'SHIB', 'RATS'].includes(a.symbol)).map(a => ({
      symbol: a.symbol, contracts: a.contracts, oiUsd: a.oiUsd, marketCapUsd: a.marketCapUsd, fdvUsd: a.fdvUsd,
      oiToFdv: a.oiToFdv, source: a.supplySource, supplyUpdatedAt: a.supplyUpdatedAt, issues: a.issues,
    })),
  };
  console.log(JSON.stringify(summary, null, 2)); summaries.push(summary);
  await mkdir('output', { recursive: true });
  await writeFile(`output/live-round-${round}.json`, JSON.stringify(snapshot));
  await writeFile('output/live-probe-summary.json', JSON.stringify(summaries, null, 2));
  if (formulaFailures.length || snapshot.coverage.oi === 0) process.exitCode = 1;
  if (round < rounds) await new Promise(resolve => setTimeout(resolve, Math.max(2_000, COLLECTION_INTERVAL_MS - (Date.now() - start))));
}
