'use strict';

/*
 * Freeze every cohort participant's Elefin state at the competition start line
 * into the `lb_baseline` collection. plan.md §3.
 *
 *   node scripts/capture-baseline.js                 # real Elefin (honours MOCK_ELEFIN=1)
 *   MOCK_ELEFIN=1 node scripts/capture-baseline.js   # dry seed against fixtures
 *   node scripts/capture-baseline.js --force         # overwrite even a frozen baseline (audited)
 *
 * Run it now to seed, then again at 2026-09-07 00:00 IST to lock the true start
 * values. Within BASELINE_GRACE_HOURS of the start it will still overwrite; after
 * that a frozen baseline is protected unless --force. The scheduler also re-runs
 * this automatically on the first cron tick at/after the start if the collection
 * is empty.
 */

const config = require('../config');
const { ensureIndexes, close } = require('../db/mongo');
const { captureBaseline } = require('../jobs/captureBaseline');

const FORCE = process.argv.includes('--force');

function pad(s, n) {
  s = s === null || s === undefined ? '—' : String(s);
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

(async () => {
  await ensureIndexes();
  const res = await captureBaseline({ force: FORCE });

  if (!res.ok) {
    console.error(`\n  Baseline capture failed: ${res.error}\n`);
    process.exitCode = 1;
    await close();
    return;
  }

  console.log(`\n  Baseline capture — cohort "${res.cohort}"  (${config.mockElefin ? 'MOCK' : 'live'} Elefin)`);
  console.log(`  start line ${config.competition.start}  ·  grace ${config.competition.baselineGraceHours}h`);
  console.log(`  ${res.afterStart ? 'AFTER start → frozen:true' : 'BEFORE start → frozen:false (seed)'}`);
  if (res.afterGrace && !FORCE) console.log('  past grace → frozen baselines KEPT (use --force to override)');
  console.log('');
  console.log(`  ${pad('email', 34)}${pad('m', 3)}${pad('equity_start', 14)}${pad('np_start', 12)}${pad('trades', 8)}action`);
  console.log(`  ${'-'.repeat(84)}`);
  for (const r of res.rows) {
    console.log(`  ${pad(r.email, 34)}${pad(r.matched ? 'Y' : 'N', 3)}${pad(r.equity_start, 14)}${pad(r.net_profit_start, 12)}${pad(r.trades_start, 8)}${r.action}`);
  }
  console.log(`\n  created ${res.created} · updated ${res.updated} · kept ${res.kept} · unmatched ${res.unmatched} · total ${res.total}`);
  if (res.unmatched) {
    console.log(`  ${res.unmatched} participant(s) have no Elefin client yet — they get a real baseline on first sighting (late_entry:true).`);
  }
  console.log('');

  await close();
})().catch(async (err) => {
  console.error(err);
  await close();
  process.exit(1);
});
