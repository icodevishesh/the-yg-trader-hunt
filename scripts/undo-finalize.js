'use strict';

/*
 * Undo an accidental `npm run finalize`.
 *
 *   node scripts/undo-finalize.js
 *
 * It:
 *   - backs up, then deletes, lb_result for the cohort
 *   - clears competition_over / finalized_at on lb_current
 *
 * It does NOT touch lb_baseline or lb_snapshots history.
 *
 * After this, so the scheduler doesn't immediately re-finalize:
 *   1. set COMPETITION_END in .env to a future date
 *   2. node scripts/restore-baseline.js     (rebuild the real 7 Sep start line)
 *   3. restart the server
 *   4. npm run finalize  — only when the competition genuinely ends
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { connect, close, COLLECTIONS } = require('../db/mongo');

(async () => {
  const db = await connect();
  const cohort = config.competition.cohort;

  const result = await db.collection(COLLECTIONS.result).findOne({ _id: cohort });
  if (result) {
    const bak = path.resolve(
      __dirname,
      `../data/lb_result-undo-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    );
    fs.writeFileSync(bak, JSON.stringify(result, null, 2));
    await db.collection(COLLECTIONS.result).deleteOne({ _id: cohort });
    console.log(`  deleted lb_result "${cohort}"   backup -> ${path.relative(process.cwd(), bak)}`);
  } else {
    console.log(`  no lb_result "${cohort}" found — nothing to delete`);
  }

  const upd = await db
    .collection(COLLECTIONS.current)
    .updateOne({ _id: 'current' }, { $set: { competition_over: false }, $unset: { finalized_at: '' } });
  console.log(`  lb_current: competition_over -> false, finalized_at unset (matched ${upd.matchedCount})`);

  console.log('\n  Now do, in order:');
  console.log('   1. .env  COMPETITION_END -> a future date  (stops the scheduler auto-finalising)');
  console.log('   2. node scripts/restore-baseline.js         (rebuild the 7 Sep start line)');
  console.log('   3. restart the server                       (cron resumes)');
  console.log('   4. npm run finalize  — only at the real end of the competition\n');

  await close();
})().catch(async (e) => {
  console.error(e);
  await close();
  process.exit(1);
});
