'use strict';

/*
 * Build the final competition result now, then exit. plan.md §8.
 * Runs a fresh refresh first so the result is built from current numbers.
 *   node scripts/finalize-once.js
 *   MOCK_ELEFIN=1 node scripts/finalize-once.js
 */

const { refreshLeaderboard } = require('../jobs/refreshLeaderboard');
const { finalizeResult } = require('../jobs/finalizeResult');
const { ensureIndexes, close } = require('../db/mongo');

(async () => {
  await ensureIndexes();

  const r = await refreshLeaderboard({ trigger: 'final' });
  if (!r.ok && !r.skipped) console.error(`  (refresh warning: ${r.error})`);

  const res = await finalizeResult({ trigger: 'cli' });
  if (!res.ok) {
    console.error(`\n  finalize failed: ${res.error}\n`);
    process.exitCode = 1;
    await close();
    return;
  }

  const { winner, runners_up, excluded_from_winner, standings } = res.result;
  console.log('\n  Competition finalized');
  console.log('  ---------------------');
  console.log(`  standings: ${standings.length} · excluded from prize: ${excluded_from_winner.length}`);
  if (winner) {
    console.log(`\n  WINNER  ${winner.name}  ${winner.return_pct >= 0 ? '+' : ''}${winner.return_pct}%`);
    console.log(`          net_profit_window $${winner.net_profit_window} on base $${winner.base_start} · ${winner.trades_window} trades`);
    console.log(`          deposits_window $${winner.deposits_window} · withdrawals_window $${winner.withdrawals_window}`);
  } else {
    console.log('\n  WINNER  none winner-eligible');
  }
  runners_up.forEach((e) => console.log(`  #${e.rank}      ${e.name}  ${e.return_pct >= 0 ? '+' : ''}${e.return_pct}%`));
  if (excluded_from_winner.length) {
    console.log('\n  excluded from prize:');
    excluded_from_winner.forEach((e) =>
      console.log(`   #${e.rank} ${e.name} — ${e.reason} (deposits_window $${e.deposits_window})`)
    );
  }
  console.log('');

  await close();
})().catch(async (err) => {
  console.error(err);
  await close();
  process.exit(1);
});
