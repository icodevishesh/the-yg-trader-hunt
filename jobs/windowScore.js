'use strict';

/*
 * Competition scoring engine — date-bounded, straight from Elefin, no snapshot
 * baseline. Used by both scripts/window-score.js (CLI + report) and the
 * scheduler (every 15 min -> lb_current).
 *
 *   score_pnl  = realised P&L of trades CLOSED in the window
 *              + unrealised P&L of positions currently OPEN     (mark-to-market)
 *   base       = net deposits at the window start
 *                (net_deposit_now - window_deposits + window_withdrawals),
 *                or a late entrant's declared entry capital
 *   return_pct = score_pnl / base * 100
 *   added_funds = a deposit in the window beyond the entry deposit > tolerance
 *
 * Data sources:
 *   GET /accounts/{login}/trades?from&to     realised, date-bounded (filtered on close_time)
 *   GET /accounts/{login}/positions          open positions + unrealised profit
 *   GET /transactions?type=deposit&from&to   real deposit ledger (filtered on created_at)
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { connect, COLLECTIONS } = require('../db/mongo');
const elefin = require('../services/elefin');
const { maskName, countryLabel, toUsd } = require('../services/scoring');

const DEFAULT_FROM = process.env.SCORING_FROM || '2026-09-07T00:00:00+05:30';
const DEFAULT_TO = process.env.SCORING_TO || '2026-09-11T23:59:59+05:30';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function pnlOf(row) {
  for (const k of ['profit', 'profit_usd', 'net_profit', 'pnl', 'result']) {
    if (row && row[k] != null && Number.isFinite(Number(row[k]))) return Number(row[k]);
  }
  return 0;
}
const txnAmount = (t) => {
  for (const k of ['amount', 'amount_usd', 'value', 'sum']) {
    if (t && t[k] != null && Number.isFinite(Number(t[k]))) return Number(t[k]);
  }
  return 0;
};
const txnWhen = (t) => t.created_at || t.timestamp || t.date || t.at || t.processed_at || null;
const txnLogin = (t) => {
  const v = t.login || t.mt5_login || t.account || t.account_login || (t.account && t.account.login);
  return v == null ? null : String(v);
};
const txnClientId = (t) => {
  const v = t.client_id != null ? t.client_id : t.client && t.client.id;
  return v == null ? null : Number(v);
};
const txnOk = (t) => ['success', 'completed', 'approved', 'done'].includes(String(t.status || 'success').toLowerCase());

// Late entrants: their entry deposit may land inside the window. Their declared
// entry capital (data/baseline-seed.<cohort>.json -> late_add[email].deposit_start)
// counts as base, not as a mid-competition top-up.
function loadLateAdd(cohort) {
  try {
    const j = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../data/baseline-seed.${cohort}.json`), 'utf8'));
    const out = {};
    for (const [email, v] of Object.entries(j.late_add || {})) {
      if (v && v.deposit_start != null) out[email.toLowerCase()] = num(v.deposit_start);
    }
    return out;
  } catch {
    return {};
  }
}

async function computeStandings({
  from = DEFAULT_FROM,
  to = DEFAULT_TO,
  baseMode = 'net_deposit',
  withPositions = true,
  markToMarket = true,
  onProgress = () => {},
} = {}) {
  const COHORT = config.competition.cohort;
  const MIN_USD = config.scoring.minDepositUsd;
  const DEP_TOL = config.scoring.depositToleranceUsd;
  const LATE_ADD = loadLateAdd(COHORT);

  const WIN_START = new Date(from).getTime();
  const WIN_END = new Date(to).getTime();
  const PAD = 3 * 24 * 3600 * 1000;
  const FETCH_FROM = new Date(WIN_START - PAD).toISOString();
  const FETCH_TO = new Date(WIN_END + PAD).toISOString();
  const inWindow = (iso) => {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) && t >= WIN_START && t <= WIN_END;
  };

  const db = await connect();
  const participants = await db
    .collection(COLLECTIONS.participants)
    .find({ in_competition: true, cohort: COHORT })
    .toArray();
  onProgress(`cohort ${participants.length} participants`);

  const me = await elefin.me();
  if (!me.ok) throw new Error('Elefin /me failed: ' + me.error);
  const cRes = await elefin.getAllClients();
  if (!cRes.ok) throw new Error('Elefin /clients failed: ' + cRes.error);

  const byEmail = new Map();
  for (const raw of cRes.clients) {
    const email = String(raw.email || '').trim().toLowerCase();
    if (!email) continue;
    const f = raw.funding || {};
    const a = raw.accounts || {};
    const tr = raw.trading || {};
    byEmail.set(email, {
      client_id: raw.client_id,
      name: (raw.name || '').trim(),
      email,
      country: raw.country || '',
      status: (raw.status || '').toLowerCase(),
      currency: (f.currency || 'USD').toUpperCase(),
      net_deposit: num(f.net_deposit),
      deposits: num(f.deposits),
      withdrawals: num(f.withdrawals),
      deposit_count: num(f.deposit_count),
      first_deposit_at: f.first_deposit_at || null,
      last_deposit_at: f.last_deposit_at || null,
      balance: num(a.balance),
      equity: num(a.equity),
      logins: Array.isArray(a.logins) ? a.logins.map(String) : [],
      lifetime_net_profit: num(tr.net_profit),
      referred_at: raw.referred_at || null,
    });
  }
  onProgress(`elefin /clients ok · ${cRes.clients.length} referred`);

  // --- deposit / withdrawal ledger (padded fetch, exact client-side filter) ---
  const depRes = await elefin.getTransactions({ type: 'deposit', from: FETCH_FROM, to: FETCH_TO });
  const wdrRes = await elefin.getTransactions({ type: 'withdrawal', from: FETCH_FROM, to: FETCH_TO });
  const keep = (t) => txnOk(t) && inWindow(txnWhen(t));
  const depRows = (depRes.ok ? depRes.rows : []).filter(keep);
  const wdrRows = (wdrRes.ok ? wdrRes.rows : []).filter(keep);
  onProgress(`deposits in window: ${depRows.length} · withdrawals: ${wdrRows.length}`);

  const byLoginDep = new Map();
  const byClientDep = new Map();
  const byLoginWdr = new Map();
  const byClientWdr = new Map();
  const idx = (m, k, row) => {
    if (k === null || k === undefined || k === '') return;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(row);
  };
  const mk = (t) => ({ amount: txnAmount(t), at: txnWhen(t), login: txnLogin(t), client_id: txnClientId(t), id: t.id || null });
  for (const t of depRows) {
    const row = mk(t);
    idx(byLoginDep, row.login, row);
    idx(byClientDep, row.client_id, row);
  }
  for (const t of wdrRows) {
    const row = mk(t);
    idx(byLoginWdr, row.login, row);
    idx(byClientWdr, row.client_id, row);
  }

  // --- per-participant ---
  const detail = [];
  let positionsAsOf = null;
  let done = 0;
  for (const p of participants) {
    const email = p._id;
    const c = byEmail.get(email);
    const d = {
      email,
      name_form: p.name_form || '',
      capital_stated: p.capital_stated ?? null,
      matched: !!c,
      client_id: c ? c.client_id : null,
      currency: c ? c.currency : 'USD',
      status: c ? c.status : null,
      logins: c ? c.logins : [],
      closed_pnl: 0,
      closed_trades: 0,
      open_pnl: 0,
      open_positions: 0,
      score_pnl: 0,
      per_login: [],
      window_deposits: 0,
      window_withdrawals: 0,
      deposit_beyond_entry: 0,
      deposit_items: [],
      withdrawal_items: [],
      late_add: false,
      base: null,
      base_usd: null,
      return_pct: null,
      return_pct_closed: null,
      added_funds: false,
      eligible: false,
      winner_eligible: false,
      reasons: [],
      errors: [],
    };

    if (!c) {
      d.reasons.push('not_matched_in_elefin');
      detail.push(d);
      continue;
    }

    for (const login of c.logins) {
      const tr = await elefin.getAccountTrades(login, { from: FETCH_FROM, to: FETCH_TO });
      if (tr.ok) {
        const inWin = tr.rows.filter((t) => inWindow(t.close_time || t.closed_at || t.close_at));
        let pnl = 0;
        for (const t of inWin) pnl += pnlOf(t);
        d.closed_pnl += pnl;
        d.closed_trades += inWin.length;
        d.per_login.push({ login, closed_trades: inWin.length, closed_pnl: r2(pnl), open_positions: 0, open_pnl: 0 });
      } else {
        d.errors.push('trades ' + login + ': ' + tr.error);
      }
      await sleep(200);

      if (withPositions) {
        const po = await elefin.getAccountPositions(login);
        if (po.ok) {
          let opnl = 0;
          for (const x of po.rows) opnl += pnlOf(x);
          d.open_pnl += opnl;
          d.open_positions += po.rows.length;
          if (po.as_of) positionsAsOf = po.as_of;
          const pl = d.per_login.find((x) => x.login === login);
          if (pl) {
            pl.open_positions = po.rows.length;
            pl.open_pnl = r2(opnl);
          }
        } else {
          d.errors.push('positions ' + login + ': ' + po.error);
        }
        await sleep(200);
      }
    }
    d.closed_pnl = r2(d.closed_pnl);
    d.open_pnl = r2(d.open_pnl);
    d.score_pnl = markToMarket ? r2(d.closed_pnl + d.open_pnl) : d.closed_pnl;

    // in-window deposits / withdrawals — match by client_id and by login
    const collect = (byLogin, byClient) => {
      const set = new Set();
      for (const login of c.logins) for (const row of byLogin.get(login) || []) set.add(row);
      for (const row of byClient.get(Number(c.client_id)) || []) set.add(row);
      return [...set];
    };
    d.deposit_items = collect(byLoginDep, byClientDep);
    d.window_deposits = r2(d.deposit_items.reduce((s, x) => s + x.amount, 0));
    d.withdrawal_items = collect(byLoginWdr, byClientWdr);
    d.window_withdrawals = r2(d.withdrawal_items.reduce((s, x) => s + x.amount, 0));

    // base (denominator)
    const lateCap = LATE_ADD[email];
    d.late_add = lateCap != null;
    const netDepAtStart = r2(c.net_deposit - d.window_deposits + d.window_withdrawals);
    if (d.late_add) {
      d.base = lateCap;
      d.deposit_beyond_entry = r2(Math.max(0, d.window_deposits - lateCap));
    } else if (baseMode === 'stated' && p.capital_stated != null) {
      d.base = num(p.capital_stated);
      d.deposit_beyond_entry = d.window_deposits;
    } else if (baseMode === 'balance') {
      d.base = r2(netDepAtStart + (c.lifetime_net_profit - d.closed_pnl));
      d.deposit_beyond_entry = d.window_deposits;
    } else {
      d.base = netDepAtStart;
      d.deposit_beyond_entry = d.window_deposits;
    }
    d.base_usd = r2(toUsd(d.base, c.currency));
    d.return_pct = d.base > 0 ? r2((d.score_pnl / d.base) * 100) : null;
    d.return_pct_closed = d.base > 0 ? r2((d.closed_pnl / d.base) * 100) : null;
    d.added_funds = toUsd(d.deposit_beyond_entry, c.currency) > DEP_TOL;

    if (c.status && c.status !== 'active') d.reasons.push('inactive');
    if (!(d.base > 0)) d.reasons.push('no_base_capital');
    else if (d.base_usd < MIN_USD) d.reasons.push('below_min_deposit');
    if (!(d.closed_trades + d.open_positions > 0)) d.reasons.push('no_window_activity');
    if (d.return_pct === null) d.reasons.push('no_return');

    d.eligible = d.reasons.length === 0;
    d.winner_eligible = d.eligible && !d.added_funds;
    detail.push(d);
    onProgress(`scored ${++done}/${participants.length}`);
  }

  const ranked = detail
    .filter((d) => d.eligible)
    .sort(
      (a, b) =>
        b.return_pct - a.return_pct ||
        b.score_pnl - a.score_pnl ||
        b.closed_trades - a.closed_trades ||
        a.email.localeCompare(b.email)
    )
    .map((d, i) => ({ ...d, rank: i + 1 }));

  const winner = ranked.find((d) => d.winner_eligible) || null;

  return {
    generated_at: new Date().toISOString(),
    cohort: COHORT,
    window: { from, to },
    base_mode: baseMode,
    mark_to_market: markToMarket,
    formula: markToMarket
      ? '(closed_pnl_window + open_position_pnl) / base * 100'
      : 'closed_pnl_window / base * 100',
    min_deposit_usd: MIN_USD,
    deposit_tolerance_usd: DEP_TOL,
    positions_as_of: positionsAsOf,
    rate_limit_remaining: me.rateLimitRemaining ?? null,
    participants_total: participants.length,
    deposits: depRows,
    withdrawals: wdrRows,
    detail,
    ranked,
    winner,
    _byEmail: byEmail,
  };
}

function buildSnapshot(result) {
  const { detail, ranked, winner } = result;
  const entries = ranked.map((d) => {
    const cl = countryLabel((result._byEmail.get(d.email) || {}).country || '');
    return {
      rank: d.rank,
      client_id: d.client_id,
      name: maskName(d.name || d.name_form, d.client_id),
      country: cl.code,
      flag: cl.flag,
      country_name: cl.name,
      return_pct: d.return_pct,
      return_pct_closed: d.return_pct_closed,
      net_profit: r2(toUsd(d.score_pnl, d.currency)),
      closed_pnl: r2(toUsd(d.closed_pnl, d.currency)),
      open_pnl: r2(toUsd(d.open_pnl, d.currency)),
      base_start: d.base_usd,
      currency: d.currency,
      trades: d.closed_trades,
      open_positions: d.open_positions,
      added_funds: d.added_funds,
      winner_eligible: d.winner_eligible,
      shortlisted: d.rank <= config.scoring.shortlistSize,
    };
  });
  const now = new Date();
  return {
    _id: 'current',
    generated_at: now,
    run_id: now.toISOString(),
    trigger: 'window-score',
    source: 'window-score',
    cohort: result.cohort,
    formula: result.formula,
    mark_to_market: result.mark_to_market,
    positions_as_of: result.positions_as_of,
    window: { start: result.window.from, end: result.window.to },
    competition: { start: result.window.from, end: result.window.to },
    competition_over: false,
    announce_at: config.competition.announceAt,
    winner_announced: false,
    winner_provisional: winner
      ? { client_id: winner.client_id, name: maskName(winner.name || winner.name_form, winner.client_id), return_pct: winner.return_pct }
      : null,
    flags: {
      added_funds: detail.filter((d) => d.added_funds).length,
      unmatched: detail.filter((d) => !d.matched).length,
      open_positions: detail.filter((d) => d.open_positions > 0).length,
    },
    stats: {
      cohort_size: result.participants_total,
      matched: detail.filter((d) => d.matched).length,
      participants: ranked.length,
      winner_eligible: ranked.filter((d) => d.winner_eligible).length,
      in_profit: ranked.filter((d) => d.return_pct > 0).length,
      total_trades: ranked.reduce((s, d) => s + d.closed_trades, 0),
    },
    top3: entries.slice(0, 3),
    entries,
    is_stale: false,
    last_error: null,
  };
}

async function writeCurrent(result, { nextRefreshAt = null } = {}) {
  const db = await connect();
  const snap = buildSnapshot(result);
  snap.next_refresh_at = nextRefreshAt;
  const { _id, ...history } = snap;
  await db.collection(COLLECTIONS.snapshots).insertOne(history);
  await db.collection(COLLECTIONS.current).replaceOne({ _id: 'current' }, snap, { upsert: true });
  return snap;
}

async function markStale(message) {
  try {
    const db = await connect();
    await db
      .collection(COLLECTIONS.current)
      .updateOne({ _id: 'current' }, { $set: { is_stale: true, last_error: String(message), last_error_at: new Date() } });
  } catch {
    /* ignore */
  }
}

module.exports = { computeStandings, buildSnapshot, writeCurrent, markStale, DEFAULT_FROM, DEFAULT_TO };
