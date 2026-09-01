'use strict';

/*
 * Import form entrants from a tab-separated export into the `participants`
 * collection. Idempotent: re-run whenever a fresh export is dropped in.
 *
 *   node scripts/import-participants.js                 # data/trader.txt
 *   node scripts/import-participants.js --sample        # data/trader.sample.txt
 *   node scripts/import-participants.js path/to/file.tsv
 *
 * Only the form fields are written; the `elefin` sub-document (filled by the
 * refresh job) is never touched here.
 */

const fs = require('fs');
const path = require('path');
const { connect, close, COLLECTIONS } = require('../db/mongo');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
// Reject the common typo TLDs we saw in the real export.
const BAD_TLD_RE = /\.(con|comi|vom|cmo|co1|xom)$/i;

function resolveFile() {
  const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (arg) return path.resolve(arg);
  if (process.argv.includes('--sample')) return path.resolve(__dirname, '../data/trader.sample.txt');
  return path.resolve(__dirname, '../data/trader.txt');
}

function parseCapital(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[,\s]/g, '');
  if (!cleaned || /^n\.?\/?a$/i.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function isDuplicateStatus(status) {
  return /duplicate/i.test(status || '');
}

function parseRows(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];
  // Drop the header if the first line looks like one.
  const first = lines[0].toLowerCase();
  const start = first.includes('email') && first.includes('name') ? 1 : 0;

  return lines.slice(start).map((line) => {
    const c = line.split('\t');
    return {
      timestamp: (c[0] || '').trim(),
      name: (c[1] || '').trim(),
      phone: (c[2] || '').trim(),
      email: (c[3] || '').trim(),
      capital: (c[4] || '').trim(),
      whatsapp_message: (c[5] || '').trim(),
      call_done: (c[6] || '').trim(),
      status: (c[7] || '').trim(),
      remarks: (c[8] || '').trim(),
    };
  });
}

async function main() {
  const file = resolveFile();
  if (!fs.existsSync(file)) {
    console.error(`\n  File not found: ${file}`);
    console.error('  Put the export at data/trader.txt, or pass a path, or use --sample.\n');
    process.exit(1);
  }

  const rows = parseRows(fs.readFileSync(file, 'utf8'));
  const db = await connect();
  const col = db.collection(COLLECTIONS.participants);

  const summary = { rows: rows.length, upserted: 0, updated: 0, skippedDuplicate: 0, invalidEmail: 0, invalidExamples: [] };
  const now = new Date();

  for (const row of rows) {
    if (isDuplicateStatus(row.status)) {
      summary.skippedDuplicate += 1;
      continue;
    }

    const email = row.email.toLowerCase();
    const emailValid = !!email && EMAIL_RE.test(email) && !BAD_TLD_RE.test(email);
    if (!email) {
      summary.invalidEmail += 1;
      continue;
    }
    if (!emailValid) {
      summary.invalidEmail += 1;
      if (summary.invalidExamples.length < 10) summary.invalidExamples.push(email);
    }

    const res = await col.updateOne(
      { _id: email },
      {
        $set: {
          name_form: row.name,
          phone: row.phone,
          capital_stated: parseCapital(row.capital),
          form_status: row.status || null,
          remarks: row.remarks || null,
          call_done: row.call_done || null,
          whatsapp_message: row.whatsapp_message || null,
          form_timestamp: row.timestamp || null,
          email_valid: emailValid,
          source: 'form_sheet',
          imported_at: now,
        },
        $setOnInsert: { first_seen_at: now },
      },
      { upsert: true }
    );

    if (res.upsertedCount) summary.upserted += 1;
    else if (res.matchedCount) summary.updated += 1;
  }

  const total = await col.countDocuments();

  console.log('\n  Participants import');
  console.log('  ------------------');
  console.log(`  source file       ${path.relative(process.cwd(), file)}`);
  console.log(`  rows read         ${summary.rows}`);
  console.log(`  new participants  ${summary.upserted}`);
  console.log(`  updated           ${summary.updated}`);
  console.log(`  skipped duplicate ${summary.skippedDuplicate}`);
  console.log(`  invalid email     ${summary.invalidEmail}${summary.invalidExamples.length ? '  e.g. ' + summary.invalidExamples.join(', ') : ''}`);
  console.log(`  collection total  ${total}\n`);

  await close();
}

main().catch(async (err) => {
  console.error(err);
  await close();
  process.exit(1);
});
