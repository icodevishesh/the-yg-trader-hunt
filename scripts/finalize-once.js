'use strict';

/*
 * Build the FINAL competition result, bounded to the real event window, and
 * freeze it. Runs a closed-only window-score (no live mark-to-market against
 * today) capped at COMPETITION_END, with deposits reconstructed as of that
 * same cutoff so post-event reloads don't inflate anyone's cumulative
 * capital, then writes lb_current + lb_result. plan.md §8.
 *
 *   node scripts/finalize-once.js
 *   MOCK_ELEFIN=1 node scripts/finalize-once.js
 */

const config = require('../config');
const { computeStandings, writeCurrent } = require('../jobs/windowScore');
const { finalizeResult } = require('../jobs/finalizeResult');
const { ensureIndexes, close } = require('../db/mongo');

const CUTOFF = config.competition.end;

(async () => {
  await ensureIndexes();

  console.log(`\n  Finalizing cohort ${config.competition.cohort} — bounded to ${CUTOFF}\n`);

  const R = await computeStandings({
    to: CUTOFF,
    markToMarket: false,
    depositsAsOf: CUTOFF,
    onProgress: (m) => process.stderr.write('   … ' + m + '\r'),
  });
  process.stderr.write('\n');

  await writeCurrent(R);
  console.log('  lb_current written (closed-only, capped at ' + CUTOFF + ').');

  const res = await finalizeResult({ trigger: 'cli' });
  if (!res.ok) {
    console.error(`\n  finalize failed: ${res.error}\n`);
    process.exitCode = 1;
    await close();
    return;
  }

  const { winner, runners_up, standings } = res.result;
  console.log('\n  Competition finalized');
  console.log('  ---------------------');
  console.log(`  standings: ${standings.length}`);
  if (winner) {
    console.log(`\n  WINNER  ${winner.name}  ${winner.return_pct >= 0 ? '+' : ''}${winner.return_pct}%`);
    console.log(`          score_pnl $${winner.score_pnl} (closed $${winner.closed_pnl} + open $${winner.open_pnl}) on cumulative_capital $${winner.cumulative_capital} · ${winner.trades} trades`);
  } else {
    console.log('\n  WINNER  none winner-eligible');
  }
  runners_up.forEach((e) => console.log(`  #${e.rank}      ${e.name}  ${e.return_pct >= 0 ? '+' : ''}${e.return_pct}%  score_pnl $${e.score_pnl} on $${e.cumulative_capital}`));
  console.log('');

  await close();
})().catch(async (err) => {
  console.error(err);
  await close();
  process.exit(1);
});
