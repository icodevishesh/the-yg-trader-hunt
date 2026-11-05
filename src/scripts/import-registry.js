'use strict';

/*
 * Imports the trader registry table (data/competition-traders.ses-2.md) into lb_traders.
 *   node src/scripts/import-registry.js [--file path] [--dry]
 * Refuses on any malformed or duplicate row, and never changes the wallet id of a
 * trader whose baseline is already frozen.
 */

const fs = require('fs');
const path = require('path');

const STATUSES = ['active', 'pending', 'withdrawn', 'disqualified'];

function parseRegistry(text) {
  const m = text.match(/<!-- REGISTRY:BEGIN[^>]*-->([\s\S]*?)<!-- REGISTRY:END -->/);
  if (!m) throw new Error('REGISTRY:BEGIN/END markers not found');
  const lines = m[1].split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|'));
  const cells = (l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const header = cells(lines[0]);
  const rows = lines.slice(2).map((l) => {
    const c = cells(l);
    return Object.fromEntries(header.map((h, i) => [h, c[i] ?? '']));
  });
  return rows;
}

function validateRows(rows) {
  const errors = [];
  const emails = new Set();
  const wallets = new Set();
  const out = rows.map((r, i) => {
    const at = `row ${i + 1} (${r.email || '?'})`;
    const email = String(r.email).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.push(`${at}: invalid email`);
    if (!/^\d+$/.test(r.wallet_id)) errors.push(`${at}: wallet_id must be digits only`);
    if (!STATUSES.includes(r.status)) errors.push(`${at}: status must be one of ${STATUSES.join('|')}`);
    if (emails.has(email)) errors.push(`${at}: duplicate email`);
    if (wallets.has(r.wallet_id)) errors.push(`${at}: duplicate wallet_id`);
    emails.add(email);
    wallets.add(r.wallet_id);
    return {
      email,
      wallet_id: r.wallet_id,
      client_id: r.client_id ? Number(r.client_id) : null,
      name: r.name || null,
      status: r.status,
      notes: r.notes || null,
    };
  });
  return { rows: out, errors };
}

async function main() {
  const argv = process.argv.slice(2);
  const fileArg = argv.indexOf('--file');
  const file = path.resolve(fileArg >= 0 ? argv[fileArg + 1] : path.join(__dirname, '../../data/competition-traders.ses-2.md'));
  const dry = argv.includes('--dry');

  const { rows, errors } = validateRows(parseRegistry(fs.readFileSync(file, 'utf8')));
  if (errors.length) {
    console.error('Registry rejected:\n  - ' + errors.join('\n  - '));
    process.exit(1);
  }

  const { config } = require('./../config');
  const cohort = config.competition.cohort;
  const byStatus = rows.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] || 0) + 1 }), {});
  console.log(`cohort=${cohort} rows=${rows.length}`, byStatus);
  if (dry) return;

  const { connect, ensureIndexes, close, COLLECTIONS: C } = require('../db');
  const db = await connect();
  await ensureIndexes();
  const frozen = new Map(
    (await db.collection(C.baseline).find({ cohort, status: 'frozen' }).toArray()).map((b) => [b.email, b.wallet_id]),
  );

  let written = 0;
  for (const r of rows) {
    if (frozen.has(r.email) && frozen.get(r.email) !== r.wallet_id) {
      console.error(`SKIP ${r.email}: baseline frozen on wallet ${frozen.get(r.email)}; changing it needs a manual re-baseline`);
      continue;
    }
    await db.collection(C.traders).updateOne(
      { _id: `${cohort}:${r.email}` },
      { $set: { ...r, cohort }, $setOnInsert: { added_at: new Date().toISOString() } },
      { upsert: true },
    );
    written += 1;
  }
  console.log(`imported ${written}/${rows.length}`);
  await close();
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { parseRegistry, validateRows };
