'use strict';

/*
 * Import entrants from a tab-separated sheet export into the `participants`
 * collection. Idempotent: re-run whenever a fresh export is dropped in.
 *
 * Lead list (default):
 *   node scripts/import-participants.js                       # data/trader.txt
 *   node scripts/import-participants.js --sample              # data/trader.sample.txt
 *   node scripts/import-participants.js path/to/file.tsv
 *
 * Competition cohort (marks `in_competition` + `cohort`, and de-flags anyone
 * with that cohort who is NOT in the file, so the cohort matches the file exactly):
 *   node scripts/import-participants.js --competition         # data/participants.<cohort>.txt
 *   node scripts/import-participants.js --competition --sample # data/participants.sample.txt
 *   node scripts/import-participants.js --competition --cohort=sep-2026 path/to/file.tsv
 *
 * Add --prune to make `participants` (and `lb_baseline`) contain *only* the emails
 * in the file — every other doc is exported to data/participants.pruned-<ts>.json
 * then deleted. Destructive; the export is the undo.
 *   node scripts/import-participants.js --competition --prune
 *
 * Column layouts accepted (header row optional, auto-detected):
 *   lead:        Timestamp, Name, Phone, Email, Capital, Whatsapp, Call Done, Status, Remarks
 *   competition: Timestamp, Name, Phone, Email, Capital
 *
 * Only the sheet fields are written; the `elefin` sub-document (filled by the
 * refresh job) and the `lb_baseline` collection are never touched here.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { connect, close, COLLECTIONS } = require('../db/mongo');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
// Reject the common typo TLDs we saw in the real exports.
const BAD_TLD_RE = /\.(con|comi|vom|cmo|co1|xom)$/i;

const ARGV = process.argv.slice(2);
const COMPETITION = ARGV.includes('--competition');
const SAMPLE = ARGV.includes('--sample');
const PRUNE = ARGV.includes('--prune');
const cohortArg = ARGV.find((a) => a.startsWith('--cohort='));
const COHORT = cohortArg ? cohortArg.split('=')[1] : config.competition.cohort;

function resolveFile() {
  const arg = ARGV.find((a) => !a.startsWith('--'));
  if (arg) return path.resolve(arg);
  if (COMPETITION) {
    return SAMPLE
      ? path.resolve(__dirname, '../data/participants.sample.txt')
      : path.resolve(__dirname, `../data/participants.${COHORT}.txt`);
  }
  if (SAMPLE) return path.resolve(__dirname, '../data/trader.sample.txt');
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
    console.error(
      COMPETITION
        ? `  Put the cohort export at data/participants.${COHORT}.txt, or pass a path, or use --sample.\n`
        : '  Put the export at data/trader.txt, or pass a path, or use --sample.\n'
    );
    process.exit(1);
  }

  const rows = parseRows(fs.readFileSync(file, 'utf8'));
  const db = await connect();
  const col = db.collection(COLLECTIONS.participants);

  const summary = {
    rows: rows.length, upserted: 0, updated: 0,
    skippedDuplicate: 0, invalidEmail: 0, invalidExamples: [], deFlagged: 0,
  };
  const now = new Date();
  const seen = new Set();
  const cohortEmails = new Set();

  for (const row of rows) {
    if (isDuplicateStatus(row.status)) {
      summary.skippedDuplicate += 1;
      continue;
    }

    const email = row.email.toLowerCase();
    if (!email) {
      summary.invalidEmail += 1;
      continue;
    }
    if (seen.has(email)) {
      // A literal repeat of the same address in the sheet (no "Duplicate" marker).
      summary.skippedDuplicate += 1;
      continue;
    }
    seen.add(email);

    const emailValid = EMAIL_RE.test(email) && !BAD_TLD_RE.test(email);
    if (!emailValid) {
      summary.invalidEmail += 1;
      if (summary.invalidExamples.length < 10) summary.invalidExamples.push(email);
    }

    const set = {
      name_form: row.name,
      phone: row.phone,
      capital_stated: parseCapital(row.capital),
      form_status: row.status || null,
      remarks: row.remarks || null,
      call_done: row.call_done || null,
      whatsapp_message: row.whatsapp_message || null,
      form_timestamp: row.timestamp || null,
      email_valid: emailValid,
      source: COMPETITION ? 'competition_sheet' : 'form_sheet',
      imported_at: now,
    };
    if (COMPETITION) {
      set.cohort = COHORT;
      // Only a *valid* email can be matched into Elefin, so only it enters the cohort.
      set.in_competition = emailValid;
      if (emailValid) cohortEmails.add(email);
    }

    const res = await col.updateOne(
      { _id: email },
      { $set: set, $setOnInsert: { first_seen_at: now } },
      { upsert: true }
    );

    if (res.upsertedCount) summary.upserted += 1;
    else if (res.matchedCount) summary.updated += 1;
  }

  // Keep the cohort exactly equal to the file: anyone previously flagged for this
  // cohort but no longer present drops out of the competition (lead data untouched).
  if (COMPETITION) {
    const stale = await col.updateMany(
      { cohort: COHORT, in_competition: true, _id: { $nin: [...cohortEmails] } },
      { $set: { in_competition: false, decohorted_at: now } }
    );
    summary.deFlagged = stale.modifiedCount || 0;
  }

  // --prune: participants + lb_baseline keep ONLY the emails in this file
  // (valid or not — so a to-be-corrected address is not lost). Everything else
  // is dumped to a JSON backup, then deleted.
  if (COMPETITION && PRUNE) {
    const keep = [...seen];
    const doomed = await col.find({ _id: { $nin: keep } }).toArray();
    const doomedBaselines = await db
      .collection(COLLECTIONS.baseline)
      .find({ _id: { $nin: keep } })
      .toArray();

    if (doomed.length || doomedBaselines.length) {
      const stamp = now.toISOString().replace(/[:.]/g, '-');
      const backup = path.resolve(__dirname, `../data/participants.pruned-${stamp}.json`);
      fs.writeFileSync(
        backup,
        JSON.stringify({ pruned_at: now, cohort: COHORT, kept: keep, participants: doomed, lb_baseline: doomedBaselines }, null, 2)
      );
      const delP = await col.deleteMany({ _id: { $nin: keep } });
      const delB = await db.collection(COLLECTIONS.baseline).deleteMany({ _id: { $nin: keep } });
      summary.pruned = delP.deletedCount || 0;
      summary.prunedBaselines = delB.deletedCount || 0;
      summary.backup = path.relative(process.cwd(), backup);
    } else {
      summary.pruned = 0;
      summary.prunedBaselines = 0;
    }
  }

  const total = await col.countDocuments();
  const inCohort = COMPETITION
    ? await col.countDocuments({ cohort: COHORT, in_competition: true })
    : null;

  console.log(`\n  Participants import${COMPETITION ? ` — cohort "${COHORT}"` : ''}`);
  console.log('  ------------------');
  console.log(`  source file       ${path.relative(process.cwd(), file)}`);
  console.log(`  rows read         ${summary.rows}`);
  console.log(`  new participants  ${summary.upserted}`);
  console.log(`  updated           ${summary.updated}`);
  console.log(`  skipped duplicate ${summary.skippedDuplicate}`);
  console.log(
    `  invalid email     ${summary.invalidEmail}` +
      (summary.invalidExamples.length ? '  e.g. ' + summary.invalidExamples.join(', ') : '')
  );
  if (COMPETITION) {
    console.log(`  de-flagged        ${summary.deFlagged}  (were in cohort, not in this file)`);
    console.log(`  in competition    ${inCohort}`);
  }
  if (COMPETITION && PRUNE) {
    console.log(`  pruned            ${summary.pruned} participants + ${summary.prunedBaselines} baselines (not in file)`);
    if (summary.backup) console.log(`  backup            ${summary.backup}`);
  }
  console.log(`  collection total  ${total}\n`);

  await close();
}

main().catch(async (err) => {
  console.error(err);
  await close();
  process.exit(1);
});
