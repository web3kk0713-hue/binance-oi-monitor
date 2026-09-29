/** Read-only live acceptance: production collector, no orders or notifications. */
import { createCollector } from '../src/data/collector';
import { toHistoryPoint } from '../src/shared/history';
import { selectValuation } from '../src/shared/valuation';

const rounds = Number(process.argv[2] ?? 2);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error('Rounds must be 1..10');
const collector = createCollector();
for (let round = 1; round <= rounds; round++) {
  const started = Date.now();
  const snapshot = await collector.collect();
  const valuations = snapshot.assets.map(row => selectValuation(toHistoryPoint(row, snapshot)));
  console.log(JSON.stringify({ round, at: new Date(snapshot.asOf).toISOString(), durationMs: snapshot.durationMs,
    universe: snapshot.universe, coverage: snapshot.coverage,
    validated: { fdv: valuations.filter(value => value.basis === 'fdv').length,
      marketCap: valuations.filter(value => value.basis === 'marketCap').length },
    errors: snapshot.errors, retryAt: snapshot.retryAt ?? null }));
  if (!valuations.some(value => value.basis !== null)) process.exitCode = 1;
  if (round < rounds) {
    const nextAt = Math.max(started + 30_000, snapshot.retryAt ?? 0, collector.retryAt?.() ?? 0);
    const delay = Math.max(0, nextAt - Date.now());
    // Do not hide a long upstream restriction behind an unattended probe.
    if (delay > 60_000) { console.log(JSON.stringify({ stopped: 'upstream cooldown', nextAt })); break; }
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}
