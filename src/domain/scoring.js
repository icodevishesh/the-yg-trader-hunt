'use strict';

/* Pure scoring functions for Season 2 (ses-2-plan.md §1). No I/O. */

const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const ms = (v) => (v ? Date.parse(v) : NaN);

/** Category id for a start capital in USD; null below the floor. Lower bound inclusive. */
function categoryFor(usd, categories) {
  if (!Number.isFinite(usd)) return null;
  for (const c of categories) {
    if (usd >= c.minUsd && (c.maxUsd === null || usd < c.maxUsd)) return c.id;
  }
  return null;
}

/** Deposits raise the base; withdrawals can only cancel deposits, never shrink the first-entry capital. */
function netCapital({ startCapital, depW, wdrW }) {
  return startCapital + Math.max(0, depW - wdrW);
}

function returnPct(pnl, net) {
  return Number.isFinite(pnl) && Number.isFinite(net) && net > 0 ? (pnl / net) * 100 : null;
}

/**
 * P/L of one closed trade rebuilt from the feed (Elefin rows carry no `profit`).
 * Rows without open_time are MT5 "out" deals whose `type` is the closing direction.
 * Commission is the IB commission and is NOT deducted. Returns null for an unknown instrument.
 */
/**
 * Contract size for a broker symbol. Brokers add account-type tags to the base symbol
 * ("XAUUSD.P", "XAUUSDm", "#XAUUSD", "XAUUSD-ECN"): exact match first, then the longest known
 * base symbol the cleaned name starts with. Unknown instruments still return null (never guessed).
 */
function contractSizeFor(instrument, contractSize) {
  const sym = String(instrument || '').toUpperCase().trim();
  if (!sym) return null;
  if (Number.isFinite(contractSize[sym])) return contractSize[sym];
  const clean = sym.replace(/^[^A-Z0-9]+/, '');
  const base = Object.keys(contractSize)
    .filter((k) => clean.startsWith(k.toUpperCase()))
    .sort((a, b) => b.length - a.length)[0];
  return base && Number.isFinite(contractSize[base]) ? contractSize[base] : null;
}

function tradePnl(t, contractSize) {
  const size = contractSizeFor(t.instrument, contractSize);
  if (!Number.isFinite(size)) return null;
  const dir = (String(t.type).toUpperCase() === 'BUY' ? 1 : -1) * (t.open_time ? 1 : -1);
  return dir * (toNum(t.close_price) - toNum(t.open_price)) * toNum(t.lots) * size + toNum(t.swap);
}

/**
 * Closed-trade P/L for the scoring window [from, to].
 * Counts trades closed inside the window that were not already open at `from`.
 * Deduplicates by ticket. Positions open at entry are excluded and counted.
 */
function closedPnl(trades, { from, to, contractSize }) {
  const f = ms(from);
  const t = ms(to);
  const seen = new Set();
  // unpricedTrades: closed in the window but no contract size -- not in pnl/closedTrades, but they
  // did close, so balance P/L (which includes them) counts them as trades.
  const out = { pnl: 0, closedTrades: 0, openAtEntry: 0, unpriceable: [], unpricedTrades: 0 };
  for (const tr of trades) {
    const id = tr.trade_ticket_id ?? tr.ticket ?? tr.id;
    if (id !== undefined) {
      if (seen.has(String(id))) continue;
      seen.add(String(id));
    }
    const closed = ms(tr.close_time);
    if (!(closed >= f && closed <= t)) continue;
    if (tr.open_time && ms(tr.open_time) < f) {
      out.openAtEntry += 1;
      continue;
    }
    const p = tradePnl(tr, contractSize);
    if (p === null) {
      const inst = String(tr.instrument || 'unknown').toUpperCase();
      if (!out.unpriceable.includes(inst)) out.unpriceable.push(inst);
      out.unpricedTrades += 1;
      continue;
    }
    out.pnl += p;
    out.closedTrades += 1;
  }
  return out;
}

/** Sum successful ledger rows of one type for one login inside [from, to]. */
function ledgerSum(rows, { login, type, from, to }) {
  const f = ms(from);
  const t = ms(to);
  let sum = 0;
  for (const r of rows) {
    if (String(r.login) !== String(login)) continue;
    if (String(r.type).toLowerCase() !== type) continue;
    if (String(r.status || 'success').toLowerCase() !== 'success') continue;
    const at = ms(r.created_at);
    if (at >= f && at <= t) sum += toNum(r.amount);
  }
  return sum;
}

/** balance moves only on closed trades and money flows, so open positions never trip this. */
function reconcile({ balanceNow, balanceStart, depW, wdrW, pnl, toleranceUsd }) {
  const expected = balanceStart + depW - wdrW + pnl;
  const diff = balanceNow - expected;
  return { diff: round2(diff), mismatch: Math.abs(diff) > toleranceUsd };
}

/** Min closed trades for a mismatch to be trusted either way (see applyPnlFix). */

/**
 * Replaces a row's reconstructed pnl (per-trade price legs, no commission) with the
 * ledger-trusted figure. `reconcile_diff` is exactly balanceNow - (balanceStart + depW - wdrW +
 * pnl), so pnl + reconcile_diff is what pnl would have had to be for the account's real balance
 * movement -- the number the reconstruction, which skips commission, was never going to land on.
 */
function applyPnlFix(row) {
  const pnl = round2((row.pnl || 0) + (row.reconcile_diff || 0));
  const flags = (row.flags || []).filter((f) => f !== 'pnl_mismatch');
  const blocking = ['pnl_unpriceable', 'pnl_mismatch', 'flow_mismatch'];
  return {
    ...row,
    pnl,
    return_pct: returnPct(pnl, row.net_capital),
    reconcile_diff: 0,
    flags,
    winner_eligible: row.eligible && !flags.some((f) => blocking.includes(f)),
  };
}

/** Order: return_pct desc, pnl desc, closed trades desc, earlier capture, email. */
function compareRows(a, b) {
  return (
    b.return_pct - a.return_pct ||
    b.pnl - a.pnl ||
    (b.is_host ? 1 : 0) - (a.is_host ? 1 : 0) || // a full tie with the host does not count as beating him
    b.closed_trades - a.closed_trades ||
    ms(a.captured_at) - ms(b.captured_at) ||
    String(a.email).localeCompare(String(b.email))
  );
}

/** Ranks eligible rows per category. Ineligible rows are excluded from boards. */
function rankByCategory(rows, categories) {
  const out = {};
  for (const c of categories) {
    const ranked = rows
      .filter((r) => r.category === c.id && r.eligible)
      .sort(compareRows)
      .map((r, i) => ({ ...r, rank: i + 1 }));
    const winner = ranked.find((r) => r.winner_eligible) || null;
    out[c.id] = { entries: ranked, leader: ranked[0] || null, winner };
  }
  return out;
}

module.exports = { round2, categoryFor, netCapital, returnPct, tradePnl, closedPnl, ledgerSum, reconcile, compareRows, rankByCategory, applyPnlFix, contractSizeFor };
