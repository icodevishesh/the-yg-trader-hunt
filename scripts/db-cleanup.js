'use strict';

/*
 * Wipes every lb_* collection (all cohorts, all seasons). Irreversible.
 *
 *   node scripts/db-cleanup.js            dry run: prints the target DB and doc counts, deletes nothing
 *   node scripts/db-cleanup.js --yes       deletes everything, after you type the DB name to confirm
 *   node scripts/db-cleanup.js --yes --force   skips the interactive confirmation (for CI/non-TTY use)
 */

const readline = require('readline');
const { config } = require('../src/config');
const { connect, close, COLLECTIONS } = require('../src/db');

const argv = process.argv.slice(2);
const doIt = argv.includes('--yes');
const force = argv.includes('--force');

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(a); });
  });
}

async function main() {
  if (config.errors.length) throw new Error('Config invalid:\n  - ' + config.errors.join('\n  - '));

  const db = await connect();
  const names = Object.values(COLLECTIONS);

  const counts = await Promise.all(names.map((n) => db.collection(n).countDocuments()));
  console.log(`Target DB: ${config.mongo.dbName}`);
  for (let i = 0; i < names.length; i += 1) console.log(`  ${names[i].padEnd(20)} ${counts[i]} docs`);
  const total = counts.reduce((a, b) => a + b, 0);

  if (!doIt) {
    console.log(`\nDry run only (no deletion). Re-run with --yes to delete all ${total} docs above.`);
    return;
  }
  if (total === 0) {
    console.log('\nNothing to delete.');
    return;
  }

  if (!force) {
    const answer = await ask(`\nThis permanently deletes ALL ${total} docs across every cohort in "${config.mongo.dbName}".\nType the database name to confirm: `);
    if (answer !== config.mongo.dbName) {
      console.log('Confirmation did not match. Aborting.');
      process.exitCode = 1;
      return;
    }
  }

  for (const n of names) {
    const res = await db.collection(n).deleteMany({});
    console.log(`  ${n.padEnd(20)} deleted ${res.deletedCount}`);
  }
  console.log('\nDone.');
}

main()
  .catch((err) => {
    console.error(err.code ? `[${err.code}] ${err.message}` : err.message);
    process.exitCode = 1;
  })
  .finally(() => close());
