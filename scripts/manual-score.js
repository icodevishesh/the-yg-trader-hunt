'use strict';

/*
 * Manage the `lb_manual_scores` collection — hand-set scores for traders whose
 * numbers should NOT come from Elefin. The scorer reads this collection first
 * (falls back to data/manual-scores.<cohort>.json only if it's empty).
 *
 *   node scripts/manual-score.js                       # sync the JSON file -> collection, then list
 *   node scripts/manual-score.js --list                # print the collection
 *   node scripts/manual-score.js --sync                # upsert every entry from the JSON file
 *   node scripts/manual-score.js --set 67352 closed_pnl=25.5 closed_trades=3 open_pnl=0
 *   node scripts/manual-score.js --disable 67352       # keep the doc but score this trader from Elefin again
 *   node scripts/manual-score.js --enable 67352
 *   node scripts/manual-score.js --rm 67352            # delete the doc
 *
 * Doc shape (one per trader, _id = String(client_id)):
 *   { _id, cohort, client_id, email, name, logins[], status, currency, country,
 *     gross_deposits, window_deposits, window_withdrawals,
 *     closed_pnl, closed_trades, open_pnl, open_positions,
 *     enabled, updated_at, note }
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { connect, close, ensureIndexes, COLLECTIONS } = require('../db/mongo');

const ARGV = process.argv.slice(2);
const HAS = (n) => ARGV.includes(n);
const NUM_FIELDS = new Set([
  'client_id', 'gross_deposits', 'window_deposits', 'window_withdrawals',
  'closed_pnl', 'closed_trades', 'open_pnl', 'open_positions',
]);
const COHORT = config.competition.cohort;

function coerce(field, val) {
  if (NUM_FIELDS.has(field)) {
    const n = Number(val);
    return Number.isFinite(n) ? n : val;
  }
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (field === 'logins') return String(val).split(/[|,]/).map((s) => s.trim()).filter(Boolean);
  return val;
}

function normalize(rec, clientId) {
  const cid = rec.client_id != null ? Number(rec.client_id) : Number(clientId);
  return {
    _id: String(cid),
    cohort: COHORT,
    client_id: cid,
    email: rec.email ? String(rec.email).toLowerCase() : null,
    name: rec.name || null,
    logins: Array.isArray(rec.logins) ? rec.logins.map(String) : [],
    status: (rec.status || 'active').toLowerCase(),
    currency: (rec.currency || 'USD').toUpperCase(),
    country: rec.country || '',
    gross_deposits: Number(rec.gross_deposits ?? rec.base ?? rec.deposits ?? 0) || 0,
    window_deposits: Number(rec.window_deposits ?? 0) || 0,
    window_withdrawals: Number(rec.window_withdrawals ?? 0) || 0,
    closed_pnl: Number(rec.closed_pnl ?? 0) || 0,
    closed_trades: Number(rec.closed_trades ?? 0) || 0,
    open_pnl: Number(rec.open_pnl ?? 0) || 0,
    open_positions: Number(rec.open_positions ?? 0) || 0,
    enabled: rec.enabled !== false,
    updated_at: new Date(),
    note: rec.note || 'hardcoded — not from Elefin',
  };
}

async function list(col) {
  const docs = await col.find({ cohort: COHORT }).sort({ _id: 1 }).toArray();
  if (!docs.length) {
    console.log(`  (lb_manual_scores has no docs for cohort "${COHORT}")`);
    return;
  }
  console.log(`  lb_manual_scores — cohort "${COHORT}"  ·  ${docs.length} doc(s)\n`);
  for (const d of docs) {
    const score = Number((d.closed_pnl + d.open_pnl).toFixed(2));
    const pct = d.gross_deposits > 0 ? Number(((score / d.gross_deposits) * 100).toFixed(2)) : null;
    console.log(
      `  ${d._id}  ${(d.name || d.email || '').padEnd(16)}  ${d.enabled ? 'ENABLED ' : 'disabled'}` +
        `  closed ${d.closed_pnl}/${d.closed_trades}tr  open ${d.open_pnl}/${d.open_positions}` +
        `  base ${d.gross_deposits}  ->  score ${score}  return ${pct}%`
    );
  }
}

async function main() {
  await ensureIndexes();
  const db = await connect();
  const col = db.collection(COLLECTIONS.manualScores);

  const idx = (n) => ARGV.indexOf(n);

  if (HAS('--rm')) {
    const id = String(ARGV[idx('--rm') + 1]);
    const r = await col.deleteOne({ _id: id });
    console.log(r.deletedCount ? `  deleted ${id}` : `  ${id} not found`);
  } else if (HAS('--enable') || HAS('--disable')) {
    const on = HAS('--enable');
    const id = String(ARGV[idx(on ? '--enable' : '--disable') + 1]);
    const r = await col.updateOne({ _id: id }, { $set: { enabled: on, updated_at: new Date() } });
    console.log(r.matchedCount ? `  ${id} -> enabled=${on}` : `  ${id} not found`);
  } else if (HAS('--set')) {
    const id = String(ARGV[idx('--set') + 1]);
    const patch = {};
    for (const tok of ARGV.slice(idx('--set') + 2)) {
      const m = tok.match(/^([a-z_]+)=(.*)$/i);
      if (m) patch[m[1]] = coerce(m[1], m[2]);
    }
    if (!Object.keys(patch).length) {
      console.error('  --set needs field=value pairs');
      process.exitCode = 1;
    } else {
      patch.updated_at = new Date();
      const existing = await col.findOne({ _id: id });
      if (!existing) {
        // create from scratch — client_id from the id, plus whatever was passed
        await col.replaceOne({ _id: id }, normalize({ ...patch, client_id: patch.client_id ?? id }, id), { upsert: true });
        console.log(`  created ${id} with`, patch);
      } else {
        await col.updateOne({ _id: id }, { $set: patch });
        console.log(`  patched ${id} with`, patch);
      }
    }
  } else {
    // default OR --sync OR --list
    if (!HAS('--list')) {
      const file = path.resolve(__dirname, `../data/manual-scores.${COHORT}.json`);
      if (fs.existsSync(file)) {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        const entries = [
          ...Object.entries(j.by_client_id || {}).map(([k, v]) => normalize(v, k)),
          ...Object.entries(j.by_email || {}).map(([, v]) => normalize(v, v.client_id)),
        ].filter((d) => d.client_id && Number.isFinite(d.client_id));
        for (const d of entries) {
          await col.replaceOne({ _id: d._id }, d, { upsert: true });
        }
        console.log(`  synced ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} from ${path.relative(process.cwd(), file)}\n`);
      } else {
        console.log(`  no ${path.relative(process.cwd(), file)} to sync from\n`);
      }
    }
    await list(col);
  }

  await close();
}

main().catch(async (err) => {
  console.error(err);
  await close();
  process.exit(1);
});
