'use strict';

/*
 * One manual refresh run, then exit. Honours MOCK_ELEFIN.
 *   node scripts/refresh-once.js
 *   MOCK_ELEFIN=1 node scripts/refresh-once.js
 */

const { refreshLeaderboard } = require('../jobs/refreshLeaderboard');
const { ensureIndexes, close } = require('../db/mongo');

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

(async () => {
  await ensureIndexes();
  const res = await refreshLeaderboard({ trigger: 'cli' });

  if (res.skipped) {
    console.log(`\n  skipped: ${res.reason} (another run holds the lock)\n`);
  } else if (!res.ok) {
    console.error(`\n  failed: ${res.error}\n`);
    process.exitCode = 1;
  } else {
    const s = res.snapshot;
    console.log(`\n  Leaderboard refreshed — source: ${s.source}`);
    console.log(`  registered ${s.participants_total} · matched ${s.matched} · eligible ${s.eligible}`);
    console.log(`  formula ${s.formula}\n`);
    console.log(`  ${pad('#', 4)}${pad('trader', 18)}${pad('return %', 12)}${pad('net p/l $', 12)}trades`);
    console.log(`  ${'-'.repeat(52)}`);
    for (const e of s.entries.slice(0, 20)) {
      console.log(
        `  ${pad('#' + e.rank, 4)}${pad(e.name, 18)}${pad((e.return_pct >= 0 ? '+' : '') + e.return_pct, 12)}${pad(e.net_profit, 12)}${e.trades}`
      );
    }
    console.log('');
  }

  await close();
})().catch(async (err) => {
  console.error(err);
  await close();
  process.exit(1);
});
