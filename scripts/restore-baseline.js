'use strict';

/*
 * Rebuild lb_baseline for the cohort from the 6 Sep seed (data/baseline-seed.<cohort>.json)
 * after the 2026-09-11 capture-baseline run overwrote the un-frozen seed with
 * current numbers.
 *
 *   node scripts/restore-baseline.js            # writes the restored, frozen baseline
 *   node scripts/restore-baseline.js --dry      # print what it would write, touch nothing
 *
 * What it does:
 *   - net_profit_start / trades_start / equity_start  <- the seed JSON (the real 7 Sep start line)
 *   - deposits_start / withdrawals_start              <- CURRENT Elefin minus window_flows in the seed JSON
 *   - everything else (currency, client_id, status)   <- current Elefin
 *   - frozen: true, captured_at: COMPETITION_START
 *   - the 8 not-on-Elefin emails  -> { matched:false, late_entry:true }
 *   - paras.babbar25 (late add)   -> from late_add[...][mode] in the seed JSON
 *
 * The current (wrong) lb_baseline is dumped to data/baseline-backup-<ts>.json first.
 * After this, run:  npm run finalize   (or scripts/finalize-once.js)
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { connect, close, ensureIndexes, COLLECTIONS } = require('../db/mongo');
const elefin = require('../services/elefin');
const { normalizeClient, round2 } = require('../services/scoring');

const DRY = process.argv.includes('--dry');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pad = (s, n) => {
  s = s === null || s === undefined ? '—' : String(s);
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
};

async function main() {
  const cohort = config.competition.cohort;
  const seedPath = path.resolve(__dirname, `../data/baseline-seed.${cohort}.json`);
  if (!fs.existsSync(seedPath)) {
    console.error(`\n  Seed file not found: ${seedPath}\n`);
    process.exit(1);
  }
  const SEED = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

  await ensureIndexes();
  const db = await connect();

  const meRes = await elefin.me();
  if (!meRes.ok) { console.error(`\n  Elefin /me failed: ${meRes.error}\n`); process.exit(1); }
  const clientsRes = await elefin.getAllClients();
  if (!clientsRes.ok) { console.error(`\n  Elefin /clients failed: ${clientsRes.error}\n`); process.exit(1); }

  const byEmail = new Map();
  for (const raw of clientsRes.clients) {
    const c = normalizeClient(raw);
    if (c.email) byEmail.set(c.email, c);
  }

  const participants = await db
    .collection(COLLECTIONS.participants)
    .find({ in_competition: true, cohort })
    .toArray();

  // Back up whatever lb_baseline currently holds.
  const current = await db.collection(COLLECTIONS.baseline).find({ cohort }).toArray();
  if (!DRY && current.length) {
    const backup = path.resolve(__dirname, `../data/baseline-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(backup, JSON.stringify(current, null, 2));
    console.log(`\n  backed up ${current.length} current baseline docs -> ${path.relative(process.cwd(), backup)}`);
  }

  const startIso = config.competition.start;
  const unmatchedSet = new Set(SEED.unmatched || []);
  const flows = SEED.window_flows || {};
  const rows = [];
  let restored = 0;
  let stubs = 0;

  for (const p of participants) {
    const email = p._id;
    const c = byEmail.get(email);

    let s = SEED.seed[email];             // { equity_start, net_profit_start, trades_start }
    let capturedAt = new Date(startIso);  // most rows: the 7 Sep start line
    let depOverride = null;               // forced { deposit_start, withdrawal_start }
    let act = 'restore';

    const la = SEED.late_add && SEED.late_add[email];
    if (!s && la) {
      if (la.mode === 'current') {
        // Late add: current Elefin state IS the baseline (window starts now).
        if (c) {
          s = {
            equity_start: num(c.equity),
            net_profit_start: num(c.net_profit),
            trades_start: num(c.trades),
          };
          capturedAt = new Date();
          depOverride = {
            deposit_start: la.deposit_start != null ? num(la.deposit_start) : num(c.deposits),
            withdrawal_start: num(c.withdrawals),
          };
          act = 'restore (current)';
        }
      } else {
        s = la[la.mode];                  // 'credit-window' | 'no-window' preset
        act = 'restore (' + la.mode + ')';
      }
    }

    if (!s) {
      // no seed row -> the 8 not-on-Elefin emails, or a late add not yet on Elefin
      const doc = {
        _id: email, cohort, matched: false, client_id: c ? c.client_id : null,
        captured_at: new Date(startIso), competition_start: startIso,
        source: 'restore', frozen: true, late_entry: true,
      };
      stubs += 1;
      rows.push({ email, m: c ? 'Y*' : 'N', np: '—', tr: '—', eq: '—', dep: '—', act: 'stub' });
      if (!DRY) await db.collection(COLLECTIONS.baseline).replaceOne({ _id: email }, doc, { upsert: true });
      continue;
    }

    const flow = flows[email] || { deposit: 0, withdrawal: 0 };
    const depositsNow = c ? num(c.deposits) : 0;
    const withdrawalsNow = c ? num(c.withdrawals) : 0;
    const depositsStart = depOverride ? round2(num(depOverride.deposit_start)) : round2(depositsNow - num(flow.deposit));
    const withdrawalsStart = depOverride ? round2(num(depOverride.withdrawal_start)) : round2(withdrawalsNow - num(flow.withdrawal));
    const equityStart = round2(num(s.equity_start));

    const doc = {
      _id: email,
      cohort,
      matched: true,
      client_id: c ? c.client_id : null,
      captured_at: capturedAt,
      competition_start: startIso,
      currency: c ? c.currency : 'USD',
      status: c ? c.status : 'active',
      equity_start: equityStart,
      balance_start: equityStart,
      net_deposit_start: round2(depositsStart - withdrawalsStart),
      deposits_start: depositsStart,
      withdrawals_start: withdrawalsStart,
      net_profit_start: round2(num(s.net_profit_start)),
      trades_start: num(s.trades_start),
      lots_start: 0,
      base_start: equityStart > 0 ? equityStart : null,
      source: 'restore',
      frozen: true,
      late_entry: false,
    };

    restored += 1;
    rows.push({
      email, m: c ? 'Y' : 'seed',
      np: doc.net_profit_start, tr: doc.trades_start, eq: doc.equity_start,
      dep: doc.deposits_start,
      act,
    });
    if (!DRY) await db.collection(COLLECTIONS.baseline).replaceOne({ _id: email }, doc, { upsert: true });
  }

  console.log(`\n  Baseline restore — cohort "${cohort}"  ${DRY ? '(DRY RUN — nothing written)' : ''}`);
  console.log(`  start line ${startIso}  ·  frozen:true  ·  source:restore\n`);
  console.log(`  ${pad('email', 34)}${pad('m', 5)}${pad('np_start', 12)}${pad('tr', 5)}${pad('eq_start', 11)}${pad('dep_start', 11)}action`);
  console.log(`  ${'-'.repeat(92)}`);
  for (const r of rows) {
    console.log(`  ${pad(r.email, 34)}${pad(r.m, 5)}${pad(r.np, 12)}${pad(r.tr, 5)}${pad(r.eq, 11)}${pad(r.dep, 11)}${r.act}`);
  }
  console.log(`\n  restored ${restored} · stubs ${stubs} · total ${participants.length}`);

  // Preview the window standings this baseline will produce.
  console.log('\n  --- window preview (net_profit_now − net_profit_start) / equity_start ---');
  const preview = [];
  for (const p of participants) {
    const c = byEmail.get(p._id);
    const la = SEED.late_add && SEED.late_add[p._id];
    let s = SEED.seed[p._id];
    if (!s && la) {
      s = la.mode === 'current'
        ? (c ? { equity_start: num(c.equity), net_profit_start: num(c.net_profit), trades_start: num(c.trades) } : null)
        : la[la.mode];
    }
    if (!c || !s) continue;
    const npStart = num(s.net_profit_start);
    const trStart = num(s.trades_start);
    const eqStart = num(s.equity_start);
    const npWin = round2(num(c.net_profit) - npStart);
    const trWin = num(c.trades) - trStart;
    const flow = flows[p._id] || { deposit: 0 };
    const ret = eqStart > 0 ? round2((npWin / eqStart) * 100) : null;
    if (trWin > 0 && eqStart >= 100) {
      preview.push({ email: p._id, ret, npWin, eqStart, trWin, added: num(flow.deposit) > 1 });
    }
  }
  preview.sort((a, b) => (b.ret ?? -1e9) - (a.ret ?? -1e9));
  preview.forEach((e, i) => {
    console.log(`  ${pad('#' + (i + 1), 4)}${pad(e.email, 32)}${pad((e.ret >= 0 ? '+' : '') + e.ret + '%', 10)}${pad('np ' + e.npWin, 12)}${pad('base ' + e.eqStart, 12)}${pad(e.trWin + ' tr', 7)}${e.added ? 'ADDED FUNDS — no prize' : 'prize-eligible'}`);
  });

  console.log('\n  In-window deposits (deposits_start = deposits_now − this):');
  Object.keys(flows).filter((k) => k[0] !== '_').forEach((k) => {
    const f = flows[k];
    const tag = f.verified ? `verified — ${f.verified}` : `INFERRED $${f.deposit} — confirm on Elefin's deposit ledger`;
    console.log(`   - ${k}: $${f.deposit}  (${tag})`);
  });
  if (SEED.late_add) {
    Object.keys(SEED.late_add).forEach((k) => {
      console.log(`   - ${k}: mode "${SEED.late_add[k].mode}" — confirm last_trade_at is inside 7–11 Sep`);
    });
  }
  console.log(`\n  Next:  ${DRY ? 'drop --dry, re-run, then' : ''} npm run finalize\n`);

  await close();
}

main().catch(async (err) => {
  console.error(err);
  await close();
  process.exit(1);
});
