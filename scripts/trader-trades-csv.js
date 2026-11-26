'use strict';

/*
 * One trader's closed trades since their start line, each with its P/L, to CSV. Read-only:
 * reads Mongo (trader + start line) and Elefin (account, trades, deposits/withdrawals); writes
 * nothing except the CSV files. Run it where Elefin allows the IP (the server).
 *
 *   node scripts/trader-trades-csv.js --email someone@example.com
 *   node scripts/trader-trades-csv.js --login 1134953487
 *   node scripts/trader-trades-csv.js --login 1134953487 --from 2026-11-23T00:00:00+05:30
 *   node scripts/trader-trades-csv.js --login 1134953487 --out data/x.csv
 *
 * Writes two files:
 *   <out>             every trade closed since the start line (or --from), P/L per trade, totals and
 *                     the balance reconciliation at the bottom
 *   <out>-flows.csv   this account's deposits/withdrawals since the start line, with the balance
 *                     estimated at each one (start balance + flows + feed trade P/L so far)
 *
 * P/L per trade is rebuilt exactly as the board does (Elefin trade rows carry no profit):
 *   dir x (close - open) x lots x contract size + swap; commission is not deducted.
 * Times are shown in IST.
 */

const fs = require('fs');
const path = require('path');
const { config } = require('../src/config');
const { connect, close, COLLECTIONS: C } = require('../src/db');
const elefin = require('../src/elefin');
const { pnlCheck } = require('../src/domain/pnlcheck');
const { round2 } = require('../src/domain/scoring');

const ARGV = process.argv.slice(2);
const arg = (n) => {
  const i = ARGV.indexOf(n);
  return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : null;
};

const IST_MS = 330 * 60000;
const ist = (iso) => (iso ? new Date(Date.parse(iso) + IST_MS).toISOString().replace('T', ' ').slice(0, 19) : '');
const cell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const line = (arr) => arr.map(cell).join(',');
const STATUS = {
  counted: 'yes',
  open_at_start: 'no - already open at the start line (in balance P/L only)',
  unpriceable: 'no - no contract size for this instrument',
};

/** Rows of the trades CSV. Pure. */
function tradesCsv(res, { name, login }) {
  const out = [line(['#', 'ticket', 'instrument', 'type', 'lots', 'open_time_ist', 'close_time_ist', 'open_price', 'close_price', 'swap', 'commission_ib', 'pnl', 'cumulative_pnl', 'in_trade_pnl'])];
  let cum = 0;
  res.trades.forEach((t, i) => {
    cum += t.pnl || 0;
    out.push(line([i + 1, t.ticket, t.instrument, t.type, t.lots, ist(t.open_time), ist(t.close_time), t.open_price, t.close_price, t.swap, t.commission, t.pnl, round2(cum), STATUS[t.status] || t.status]));
  });
  const tt = res.list_totals;
  const a = res.account_activity;
  const summary = [
    ['Trader', name],
    ['Login', login],
    ['Trades listed from (IST)', ist(res.list_from)],
    ['Start line (IST)', ist(res.start_line.captured_at)],
    ['Balance at start line', res.start_line.balance_start],
    ['Balance now', res.balance_now],
    ['Equity now', res.equity_now],
    ['Deposits since start line', res.deposits],
    ['Withdrawals since start line', res.withdrawals],
    ['Trades in this file', res.trades.length],
    ['Sum of P/L in this file', round2(res.trades.reduce((s, t) => s + (t.pnl || 0), 0))],
    ['Trade P/L (counted trades only)', tt.counted.pnl],
    ['Already open at start: count / P/L', `${tt.open_at_start.count} / ${tt.open_at_start.pnl}`],
    ['Balance P/L (balance now - start - deposits + withdrawals)', res.balance_pnl],
    ['Gap (balance P/L - trade P/L)', res.diff],
    ['Elefin trade counter now', a.trades_counter],
    ['Elefin trade counter at start line', a.trades_start === null ? 'not recorded' : a.trades_start],
    ['Elefin last trade (IST)', ist(a.last_trade_at)],
  ];
  out.push('', line(['SUMMARY', 'value']));
  for (const [k, v] of summary) out.push(line([k, v]));
  if (res.causes.length) {
    out.push('', line(['WHY THE GAP']));
    for (const c of res.causes) out.push(line([c]));
  }
  return out.join('\n') + '\n';
}

/** Rows of the flows CSV: every deposit/withdrawal (any status) with the estimated balance. Pure. */
function flowsCsv({ ledger, trades, login, startLine, toMs }) {
  const startMs = Date.parse(startLine.captured_at);
  const flows = ledger
    .filter((r) => String(r.login) === String(login))
    .filter((r) => {
      const at = Date.parse(r.created_at);
      return at >= startMs && at <= toMs;
    })
    .sort((x, y) => Date.parse(x.created_at) - Date.parse(y.created_at));
  // Trades closed since the start line that move the balance (priced ones only).
  const priced = trades.filter((t) => t.pnl !== null && t.status !== 'unpriceable').map((t) => ({ at: Date.parse(t.close_time), pnl: t.pnl }));
  const out = [line(['created_ist', 'updated_ist', 'id', 'type', 'status', 'amount_usd', 'payment_method', 'paid_amount', 'paid_currency', 'net_flow_so_far', 'feed_trade_pnl_so_far', 'est_balance_after'])];
  let net = 0;
  let peak = Number(startLine.balance_start);
  for (const r of flows) {
    const at = Date.parse(r.created_at);
    const ok = String(r.status || 'success').toLowerCase() === 'success';
    const amt = Number(r.amount) || 0;
    if (ok) net += String(r.type).toLowerCase() === 'deposit' ? amt : -amt;
    const tp = priced.filter((t) => t.at <= at).reduce((s, t) => s + t.pnl, 0);
    const est = round2(Number(startLine.balance_start) + net + tp);
    if (ok && String(r.type).toLowerCase() === 'deposit') peak = Math.max(peak, est);
    out.push(line([ist(r.created_at), ist(r.updated_at), r.id, r.type, r.status, amt, r.payment_method, r.paid_amount, r.paid_currency, round2(net), round2(tp), est]));
  }
  out.push('', line(['Highest estimated balance right after a deposit', round2(peak)]));
  out.push(line(['Note', 'Estimate only: the trade feed misses some trades, and trades between two flows are not split by the minute.']));
  return out.join('\n') + '\n';
}

async function main() {
  const email = arg('--email');
  const login = arg('--login');
  if (!email && !login) throw new Error('give --email or --login');
  const cohort = config.competition.cohort;
  const db = await connect();
  const trader = await db.collection(C.traders).findOne(email ? { cohort, email: email.toLowerCase() } : { cohort, wallet_id: String(login) });
  if (!trader) throw new Error(`no trader in cohort ${cohort} for ${email || login}`);
  const b = await db.collection(C.baseline).findOne({ _id: `${cohort}:${trader.email}` });
  if (!b || b.status !== 'frozen') throw new Error('this trader has no frozen start line yet');

  const nowMs = Math.min(Date.now(), config.competition.endMs || Date.now());
  const nowIso = new Date(nowMs).toISOString();
  const startMs = Date.parse(b.captured_at);
  const listFromMs = arg('--from') ? Date.parse(arg('--from')) : null;
  if (listFromMs !== null && !Number.isFinite(listFromMs)) throw new Error('--from is not a valid date');
  const earliest = Math.min(startMs, listFromMs ?? startMs);

  const acct = await elefin.getAccount(trader.wallet_id);
  if (!acct.ok) throw new Error('Elefin account lookup failed: ' + acct.error);
  // From well before the start: a trade opened before it and closed after it still moves the balance.
  const tr = await elefin.getTrades(trader.wallet_id, { from: new Date(earliest - 30 * 86400000).toISOString(), to: nowIso });
  if (!tr.ok) throw new Error('Elefin trades lookup failed: ' + tr.error);
  const ledger = [];
  for (const type of ['deposit', 'withdrawal']) {
    const r = await elefin.getTransactions(type, { from: new Date(startMs).toISOString(), to: nowIso });
    if (!r.ok) throw new Error(`Elefin ${type} lookup failed: ${r.error}`);
    ledger.push(...r.rows);
  }

  const res = pnlCheck({ account: acct.account, trades: tr.rows, ledger, startLine: b, nowMs, contractSize: config.scoring.contractSize, toleranceUsd: config.scoring.pnlToleranceUsd, listFromMs });
  const stamp = new Date(nowMs + IST_MS).toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const out = arg('--out') || path.resolve(__dirname, `../data/trader-trades-${trader.wallet_id}-${stamp}.csv`);
  const flowsOut = out.replace(/\.csv$/i, '') + '-flows.csv';
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // BOM so Excel opens the file as UTF-8.
  fs.writeFileSync(out, '﻿' + tradesCsv(res, { name: trader.name, login: trader.wallet_id }));
  fs.writeFileSync(flowsOut, '﻿' + flowsCsv({ ledger, trades: res.trades, login: trader.wallet_id, startLine: b, toMs: nowMs }));

  console.log(`${trader.name} (${trader.wallet_id}): ${res.trades.length} trades, trade P/L ${res.trade_pnl}, balance P/L ${res.balance_pnl}, gap ${res.diff}`);
  console.log(`Elefin counter ${res.account_activity.trades_counter}; feed trades since start ${res.account_activity.feed_trades}`);
  console.log('Trades CSV ->', path.relative(process.cwd(), out));
  console.log('Flows CSV  ->', path.relative(process.cwd(), flowsOut));
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error('trader-trades-csv failed:', e.message);
      process.exitCode = 1;
    })
    .finally(() => close().catch(() => {}));
}

module.exports = { tradesCsv, flowsCsv };
