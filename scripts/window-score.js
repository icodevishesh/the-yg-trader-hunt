'use strict';

/*
 * Competition scoring — full transparency report. Engine: jobs/windowScore.js.
 *
 *   score = realised P&L of trades CLOSED in the window
 *         + unrealised P&L of positions currently OPEN   (mark-to-market)
 *   return_pct = score / base * 100
 *
 *   node scripts/window-score.js                          # print the breakdown + standings
 *   node scripts/window-score.js --closed-only            # realised P&L only (no open positions)
 *   node scripts/window-score.js --no-positions           # don't even fetch positions (faster)
 *   node scripts/window-score.js --base stated|balance    # change the denominator
 *   node scripts/window-score.js --json data/x.json       # dump full structured detail
 *   node scripts/window-score.js --write                  # also write lb_current
 *   node scripts/window-score.js --from ... --to ...
 *
 * It never writes lb_result or competition_over.
 */

const fs = require('fs');
const config = require('../config');
const { close } = require('../db/mongo');
const { computeStandings, writeCurrent, DEFAULT_FROM, DEFAULT_TO } = require('../jobs/windowScore');
const { maskName } = require('../services/scoring');

const ARGV = process.argv.slice(2);
const argVal = (n, d) => {
  const i = ARGV.indexOf(n);
  return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : d;
};
const HAS = (n) => ARGV.includes(n);

const OPTS = {
  from: argVal('--from', DEFAULT_FROM),
  to: argVal('--to', DEFAULT_TO),
  baseMode: argVal('--base', 'net_deposit'),
  withPositions: !HAS('--no-positions'),
  markToMarket: !HAS('--closed-only') && !HAS('--no-positions'),
  onProgress: (m) => process.stderr.write('   … ' + m + '\r'),
};

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const money = (n) => (n >= 0 ? '+' : '') + r2(n);
const pad = (s, n) => {
  s = s === null || s === undefined ? '—' : String(s);
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
};
const padL = (s, n) => {
  s = s === null || s === undefined ? '—' : String(s);
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
};
const line = () => console.log('  ' + '-'.repeat(112));

(async () => {
  console.log('\n  ============================================================');
  console.log('   WINDOW SCORE  ·  cohort ' + config.competition.cohort);
  console.log('  ============================================================');
  console.log('   window   ' + OPTS.from + '  ->  ' + OPTS.to);
  console.log('   base     ' + OPTS.baseMode);
  console.log('   scoring  ' + (OPTS.markToMarket ? 'mark-to-market  (closed realised + open unrealised)' : 'closed realised only'));

  const R = await computeStandings(OPTS);
  process.stderr.write('\n');

  console.log('   formula  ' + R.formula);
  console.log('   min base $' + R.min_deposit_usd + '   deposit tolerance $' + R.deposit_tolerance_usd);
  console.log('   rate limit remaining ' + R.rate_limit_remaining + '   ·   positions as_of ' + (R.positions_as_of || 'n/a'));
  if (R.data_errors) console.log('   ⚠ trades calls failed: ' + R.data_errors + '  ·  carried forward from last board: ' + R.carried_forward);

  const nameOf = (d) => maskName(d.name || d.name_form, d.client_id);
  const whoIs = (t) => {
    const cid = t.client_id != null ? Number(t.client_id) : null;
    const hit = R.detail.find((d) => Number(d.client_id) === cid || d.logins.map(String).includes(String(t.login)));
    return hit ? hit.email : 'not in cohort';
  };
  const amtOf = (t) => Number(t.amount ?? t.amount_usd ?? t.value ?? 0);
  const txnLine = (t) =>
    '     ' + pad(String(t.login || 'client ' + t.client_id), 16) + padL('$' + amtOf(t), 11) + '   ' + pad(t.created_at || '?', 22) + '  ' + whoIs(t);

  console.log('\n\n  A. RELOADS IN WINDOW  (deposits after Day 1 — allowed; added to cumulative capital)  ·  ' + R.deposits.length);
  line();
  if (!R.deposits.length) console.log('     (none)');
  R.deposits.forEach((t) => console.log(txnLine(t)));

  console.log('\n  B. IN-WINDOW WITHDRAWALS  ·  ' + R.withdrawals.length);
  line();
  if (!R.withdrawals.length) console.log('     (none)');
  R.withdrawals.forEach((t) => console.log(txnLine(t)));

  console.log('\n  C. OPEN POSITIONS  (unrealised P&L, counted in the score)');
  line();
  const withOpen = R.detail.filter((d) => d.open_positions > 0);
  if (!withOpen.length) console.log('     (none — every account is flat)');
  withOpen.forEach((d) =>
    console.log('     ' + pad(d.email, 34) + pad(d.open_positions + ' open', 10) + 'unrealised ' + padL(money(d.open_pnl), 10) + '   as_of ' + (R.positions_as_of || '?'))
  );

  console.log('\n  D. PER-PARTICIPANT DETAIL');
  line();
  console.log('     ' + pad('email', 34) + pad('login', 13) + padL('closed', 9) + padL('open', 9) + padL('score', 9) + padL('base', 9) + padL('return%', 10) + '  flags');
  line();
  for (const d of R.detail) {
    const flags = [];
    if (d.manual) flags.push('MANUAL (hardcoded, not from Elefin)');
    if (!d.matched && !d.manual) flags.push('UNMATCHED');
    if (d.late_add) flags.push('LATE-ADD');
    if (d.reloaded) flags.push('reloaded $' + d.window_deposits + ' (in base)');
    if (d.window_withdrawals) flags.push('WDR $' + d.window_withdrawals);
    if (d.carried_forward) flags.push('CARRIED-FORWARD (trades call failed)');
    else if (d.data_error) flags.push('DATA-ERROR (dropped)');
    if (d.open_error) flags.push('positions call failed');
    if (!d.eligible && d.matched && !d.carried_forward) flags.push('OUT:' + d.reasons.join(','));
    if (d.errors.length) flags.push('ERR:' + d.errors.length);
    console.log(
      '     ' + pad(d.email, 34) + pad(d.logins[0] || '—', 13) +
        padL(d.matched ? money(d.closed_pnl) : '—', 9) +
        padL(d.matched ? money(d.open_pnl) : '—', 9) +
        padL(d.matched ? money(d.score_pnl) : '—', 9) +
        padL(d.base != null ? r2(d.base) : '—', 9) +
        padL(d.return_pct != null ? money(d.return_pct) + '%' : '—', 10) +
        '  ' + flags.join(' · ')
    );
    d.errors.forEach((e) => console.log('        ! ' + e));
  }

  console.log('\n  E. STANDINGS  (eligible = matched · active · cumulative capital >= $' + R.min_deposit_usd + ' · traded in window)');
  line();
  console.log('     ' + pad('#', 4) + pad('trader', 20) + padL('return%', 10) + padL('score $', 10) + padL('(closed', 10) + padL('open)', 9) + padL('capital $', 10) + padL('trades', 7) + '  reload');
  line();
  for (const d of R.ranked) {
    console.log(
      '     ' + pad('#' + d.rank, 4) + pad(nameOf(d), 20) +
        padL(money(d.return_pct) + '%', 10) + padL(money(d.score_pnl), 10) +
        padL(money(d.closed_pnl), 10) + padL(money(d.open_pnl), 9) +
        padL(r2(d.base), 10) + padL(d.closed_trades + (d.open_positions ? '+' + d.open_positions : ''), 7) +
        '  ' + (d.reloaded ? '+$' + d.window_deposits : '')
    );
  }
  if (!R.ranked.length) console.log('     (nobody eligible)');

  console.log('\n  F. WINNER  (highest % return on cumulative capital)');
  line();
  if (R.winner) {
    const w = R.winner;
    console.log('     ' + nameOf(w) + '   ' + money(w.return_pct) + '%');
    console.log('        score ' + money(w.score_pnl) + '  (closed ' + money(w.closed_pnl) + ' + open ' + money(w.open_pnl) + ')  on cumulative capital ' + r2(w.base) + '   ·   ' + w.closed_trades + ' closed / ' + w.open_positions + ' open');
    console.log('        ' + w.email + '   login ' + (w.logins[0] || '—') + '   client_id ' + w.client_id + (w.reloaded ? '   ·   reloaded $' + w.window_deposits + ' in the window' : ''));
  } else {
    console.log('     none eligible');
  }
  console.log('');

  const JSON_OUT = argVal('--json', null);
  if (JSON_OUT) {
    const { _byEmail, ...clean } = R;
    fs.writeFileSync(JSON_OUT, JSON.stringify(clean, null, 2));
    console.log('  full detail -> ' + JSON_OUT + '\n');
  }
  if (HAS('--write')) {
    await writeCurrent(R);
    console.log('  lb_current written (source: window-score). lb_result NOT touched.\n');
  }

  await close();
})().catch(async (err) => {
  console.error('\n  window-score failed:', err && err.stack ? err.stack : err, '\n');
  await close();
  process.exit(1);
});
