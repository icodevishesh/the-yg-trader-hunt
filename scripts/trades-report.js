'use strict';

/*
 * Every Elefin referred client — trades closed today and realised P&L — to CSV.
 *
 *   node scripts/trades-report.js                     # today (IST)
 *   node scripts/trades-report.js --date 2026-09-07   # a specific day (IST)
 *   node scripts/trades-report.js --from 2026-09-07T00:00:00+05:30 --to 2026-09-07T23:59:59+05:30
 *   node scripts/trades-report.js --tz +00:00         # use a different day boundary
 *   node scripts/trades-report.js --out data/x.csv    # output path
 *   node scripts/trades-report.js --open              # also include open-position unrealised P&L
 *
 * A trade counts for the day if its close_time falls inside the range. Elefin's
 * from/to truncate to a date, so we fetch a padded range and filter client-side.
 *
 * CSV columns: username, email, login, trades_today, pnl_today[, open_positions, open_pnl]
 */

const fs = require('fs');
const path = require('path');
const elefin = require('../services/elefin');

const ARGV = process.argv.slice(2);
const argVal = (n, d) => {
  const i = ARGV.indexOf(n);
  return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : d;
};
const HAS = (n) => ARGV.includes(n);

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const pnlOf = (row) => {
  for (const k of ['profit', 'profit_usd', 'net_profit', 'pnl', 'result']) {
    if (row && row[k] != null && Number.isFinite(Number(row[k]))) return Number(row[k]);
  }
  return 0;
};

const TZ = argVal('--tz', '+05:30');
function todayInTz() {
  const offMin =
    (TZ === 'Z' ? 0 : (TZ[0] === '-' ? -1 : 1) * (Number(TZ.slice(1, 3)) * 60 + Number(TZ.slice(4, 6)))) * 60000;
  return new Date(Date.now() + offMin).toISOString().slice(0, 10);
}
const DAY = argVal('--date', todayInTz());
const FROM = argVal('--from', `${DAY}T00:00:00${TZ === 'Z' ? 'Z' : TZ}`);
const TO = argVal('--to', `${DAY}T23:59:59${TZ === 'Z' ? 'Z' : TZ}`);
const WITH_OPEN = HAS('--open');
const OUT = argVal('--out', path.resolve(__dirname, `../data/trades-report-${DAY}.csv`));
// Elefin rate limit is ~60/min. One request per ~1.1s keeps us under it.
const SLEEP_MS = Number(argVal('--sleep', '1100'));

const WIN_START = new Date(FROM).getTime();
const WIN_END = new Date(TO).getTime();
const PAD = 3 * 24 * 3600 * 1000;
const FETCH_FROM = new Date(WIN_START - PAD).toISOString();
const FETCH_TO = new Date(WIN_END + PAD).toISOString();
const inRange = (iso) => {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && t >= WIN_START && t <= WIN_END;
};

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const pad = (s, n) => {
  s = s === null || s === undefined ? '' : String(s);
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
};
const padL = (s, n) => {
  s = s === null || s === undefined ? '' : String(s);
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
};

(async () => {
  console.log(`\n  Elefin trades report — ${DAY}`);
  console.log(`  range  ${FROM}  ->  ${TO}`);

  let me = await elefin.me();
  if (!me.ok && /rate limit/i.test(me.error || '')) {
    console.log('  /me rate limited — waiting 65s …');
    await sleep(65000);
    me = await elefin.me();
  }
  if (!me.ok) throw new Error('Elefin /me failed: ' + me.error);
  console.log(`  /me ok · rate limit remaining ${me.rateLimitRemaining ?? 'n/a'}`);

  const cRes = await elefin.getAllClients();
  if (!cRes.ok) throw new Error('Elefin /clients failed: ' + cRes.error);
  console.log(`  /clients ok · ${cRes.clients.length} referred clients\n`);

  const HEADER = WITH_OPEN
    ? ['username', 'email', 'login', 'trades_today', 'pnl_today', 'open_positions', 'open_pnl']
    : ['username', 'email', 'login', 'trades_today', 'pnl_today'];

  function writeCsv(list) {
    const sorted = [...list].sort((a, b) => b.pnl_today - a.pnl_today || b.trades_today - a.trades_today);
    const lines = [HEADER.join(',')];
    for (const r of sorted) lines.push(HEADER.map((h) => csvCell(r[h])).join(','));
    const tT = sorted.reduce((s, r) => s + r.trades_today, 0);
    const tP = r2(sorted.reduce((s, r) => s + r.pnl_today, 0));
    lines.push(HEADER.map((h) => (h === 'username' ? 'TOTAL' : h === 'trades_today' ? tT : h === 'pnl_today' ? tP : '')).join(','));
    fs.writeFileSync(OUT, lines.join('\n') + '\n');
  }

  // --resume: keep rows already in the CSV, skip those clients
  const rows = [];
  const doneEmails = new Set();
  if (HAS('--resume') && fs.existsSync(OUT)) {
    const prev = fs.readFileSync(OUT, 'utf8').split(/\r?\n/).slice(1).filter(Boolean);
    for (const ln of prev) {
      const m = ln.match(/^("(?:[^"]|"")*"|[^,]*),("(?:[^"]|"")*"|[^,]*),([^,]*),([^,]*),([^,]*)/);
      if (!m) continue;
      const email = m[2].replace(/^"|"$/g, '').replace(/""/g, '"');
      if (email === 'email' || m[1].replace(/"/g, '') === 'TOTAL') continue;
      rows.push({ username: m[1].replace(/^"|"$/g, '').replace(/""/g, '"'), email, login: m[3], trades_today: num(m[4]), pnl_today: num(m[5]), open_positions: 0, open_pnl: 0, errors: [] });
      doneEmails.add(email);
    }
    console.log(`  --resume: ${doneEmails.size} clients already done, skipping them\n`);
  }

  let idxN = 0;
  for (const c of cRes.clients) {
    idxN += 1;
    const cEmail = String(c.email || '').trim().toLowerCase();
    if (doneEmails.has(cEmail)) continue;
    const logins = Array.isArray(c.accounts && c.accounts.logins) ? c.accounts.logins.map(String) : [];
    let trades = 0;
    let pnl = 0;
    let openPos = 0;
    let openPnl = 0;
    const errors = [];

    for (const login of logins) {
      let tr = await elefin.getAccountTrades(login, { from: FETCH_FROM, to: FETCH_TO });
      if (!tr.ok && /rate limit/i.test(tr.error || '')) {
        process.stderr.write('   rate limited — waiting 65s …\n');
        await sleep(65000);
        tr = await elefin.getAccountTrades(login, { from: FETCH_FROM, to: FETCH_TO });
      }
      if (tr.ok) {
        const inWin = tr.rows.filter((t) => inRange(t.close_time || t.closed_at || t.close_at));
        trades += inWin.length;
        for (const t of inWin) pnl += pnlOf(t);
      } else {
        errors.push('trades ' + login + ': ' + tr.error);
      }
      await sleep(SLEEP_MS);

      if (WITH_OPEN) {
        const po = await elefin.getAccountPositions(login);
        if (po.ok) {
          openPos += po.rows.length;
          for (const x of po.rows) openPnl += pnlOf(x);
        } else {
          errors.push('positions ' + login + ': ' + po.error);
        }
        await sleep(SLEEP_MS);
      }
    }

    rows.push({
      username: (c.name || '').trim(),
      email: cEmail,
      login: logins.join('|'),
      client_id: c.client_id,
      trades_today: trades,
      pnl_today: r2(pnl),
      open_positions: openPos,
      open_pnl: r2(openPnl),
      errors,
    });

    if (idxN % 10 === 0) {
      writeCsv(rows); // checkpoint — safe to kill / --resume
      process.stderr.write(`   … ${idxN}/${cRes.clients.length} (checkpointed)\n`);
    }
  }
  writeCsv(rows);

  const totalTrades = rows.reduce((s, r) => s + r.trades_today, 0);
  const totalPnl = r2(rows.reduce((s, r) => s + r.pnl_today, 0));

  // ---- console summary ----
  const active = rows
    .filter((r) => r.trades_today > 0)
    .sort((a, b) => b.pnl_today - a.pnl_today || b.trades_today - a.trades_today);
  console.log(`  ${active.length} clients traded today · ${totalTrades} trades · net P&L ${totalPnl >= 0 ? '+' : ''}${totalPnl}\n`);
  console.log('  ' + pad('username', 26) + pad('email', 34) + padL('trades', 8) + padL('pnl', 12));
  console.log('  ' + '-'.repeat(80));
  for (const r of active.slice(0, 30)) {
    console.log('  ' + pad(r.username, 26) + pad(r.email, 34) + padL(r.trades_today, 8) + padL((r.pnl_today >= 0 ? '+' : '') + r.pnl_today, 12));
  }
  if (active.length > 30) console.log(`  … and ${active.length - 30} more (see CSV)`);
  const errd = rows.filter((r) => r.errors.length);
  if (errd.length) {
    console.log(`\n  ${errd.length} client(s) had fetch errors:`);
    errd.slice(0, 10).forEach((r) => console.log('   ' + r.email + ' — ' + r.errors.join('; ')));
  }
  console.log(`\n  CSV -> ${path.relative(process.cwd(), OUT)}\n`);
})().catch((err) => {
  console.error('\n  trades-report failed:', err && err.stack ? err.stack : err, '\n');
  process.exit(1);
});
