'use strict';

const { round2, categoryFor, netCapital, returnPct, ledgerSum, reconcile } = require('./scoring');

// Inputs an organiser may override from our own database (admin-plan §3b).
const OVERRIDABLE = ['start_capital', 'balance_start', 'captured_at', 'dep_w', 'wdr_w', 'closed_pnl', 'closed_trades'];
const has = (v) => v !== undefined && v !== null;

/** Deposit/withdrawal sums for one baseline window (check B: the ledger). */
function ledgerFlows(ledger, baseline, windowEnd) {
  const q = { login: baseline.wallet_id, from: baseline.captured_at, to: windowEnd };
  return { depW: ledgerSum(ledger, { ...q, type: 'deposit' }), wdrW: ledgerSum(ledger, { ...q, type: 'withdrawal' }) };
}

/**
 * Applies the start-line overrides (start capital, opening balance, entry time) to a baseline.
 * The category is derived from the resulting start capital unless the admin pins one explicitly
 * (`ov.category`), in which case the pinned band wins -- applied last so it beats the derived value.
 */
function applyBaselineOverrides(baseline, ov, scoring) {
  if (!ov) return baseline;
  const b = { ...baseline };
  if (has(ov.start_capital)) {
    b.start_capital = ov.start_capital;
    b.start_capital_usd = ov.start_capital;
    b.category = categoryFor(ov.start_capital, scoring.categories);
  }
  if (has(ov.balance_start)) b.balance_start = ov.balance_start;
  if (has(ov.captured_at)) b.captured_at = new Date(ov.captured_at).toISOString();
  if (has(ov.category)) b.category = ov.category;
  return b;
}

/**
 * Scores one trader for one run. Pure.
 *
 * @param baseline  frozen baseline (already passed through applyBaselineOverrides)
 * @param account   current GET /accounts/{login} data, or null in manual "full" mode
 * @param summary   closed-trade summary for [captured_at, windowEnd]
 * @param flows     { depW, wdrW } from the ledger
 * @param overrides manual values for dep_w / wdr_w / closed_pnl / closed_trades (or null)
 * @param manual    { mode, ... } when the row comes from our database, for the audit trail
 */
function scoreTrader({ trader, baseline, account, summary, flows, overrides = null, manual = null, competition, scoring }) {
  const ov = overrides || {};
  const reasons = [];
  const flags = [];

  const depW = has(ov.dep_w) ? ov.dep_w : flows.depW;
  const wdrW = has(ov.wdr_w) ? ov.wdr_w : flows.wdrW;
  // P/L source. Default: rebuilt from closed trades. "balance" (set per trader by an admin to fix a
  // pnl_mismatch): the account's real balance movement since the start line, net of deposits and
  // withdrawals -- closed trades only (the balance ignores open positions), including trades that
  // were open at the start line, unpriceable instruments and commission. Re-derived every run.
  const fromBalance = !has(ov.closed_pnl) && trader.pnl_source === 'balance' && !!account && has(baseline.balance_start);
  const pnl = has(ov.closed_pnl) ? ov.closed_pnl : fromBalance ? round2(Number(account.balance) - baseline.balance_start - depW + wdrW) : summary.pnl;
  const closedTrades = has(ov.closed_trades) ? ov.closed_trades : summary.closedTrades + (fromBalance ? summary.openAtEntry : 0);

  // Check A (account aggregates since baseline) against check B (ledger). Skipped when the
  // flows themselves were entered by hand, or when there is no live account to compare.
  let flowMismatch = false;
  // Also skipped when the start line carries no account totals (a start line typed in "fields").
  if (account && !has(ov.dep_w) && !has(ov.wdr_w) && has(baseline.total_deposit_start) && has(baseline.total_withdrawal_start)) {
    const aggDep = Number(account.total_deposit) - baseline.total_deposit_start;
    const aggWdr = Number(account.total_withdrawal) - baseline.total_withdrawal_start;
    flowMismatch = Math.abs(aggDep - depW) > scoring.flowToleranceUsd || Math.abs(aggWdr - wdrW) > scoring.flowToleranceUsd;
  }

  const net = netCapital({ startCapital: baseline.start_capital_usd, depW, wdrW });
  const ret = returnPct(pnl, net);
  const rec = account
    ? reconcile({ balanceNow: Number(account.balance), balanceStart: baseline.balance_start, depW, wdrW, pnl, toleranceUsd: scoring.pnlToleranceUsd })
    : { diff: null, mismatch: false };

  // Manual (no-Elefin-account) traders are validated against the competition end, not the entry
  // cutoff (admin-plan: there is no live account to protect from backdating), so they must be
  // exempt here too -- otherwise a late but validly-entered manual trader can never be eligible.
  // An admin-set start line -- "Set baseline" (snapshot now) or "Start line" (rebuilt at a chosen
  // time / capital set by hand) -- is a deliberate, audited admin action. Its captured_at is
  // usually after the cutoff, so it is exempt from the cutoff exactly as a manual entry is.
  // Markers: `admin_baseline: true`, `source: 'admin'`, or a manual entry saved with `rebaseline`.
  const adminBaseline = !!baseline.admin_baseline || baseline.source === 'admin' || !!(manual && manual.rebaseline);
  if (trader.account_source !== 'manual' && !adminBaseline && Date.parse(baseline.captured_at) > competition.cutoffMs) reasons.push('entered_after_cutoff');
  if (!baseline.category) reasons.push('no_category');
  if (ret === null) reasons.push('invalid_net_capital');
  if (closedTrades < 1) reasons.push('no_closed_trade');
  if (summary.unpriceable.length && !has(ov.closed_pnl) && !fromBalance) flags.push('pnl_unpriceable');
  if (rec.mismatch) flags.push('pnl_mismatch');
  if (fromBalance) flags.push('pnl_from_balance'); // informational, never blocks a prize
  if (flowMismatch) flags.push('flow_mismatch');
  if (summary.openAtEntry) flags.push('open_at_entry');
  if (baseline.late_entry && !adminBaseline) flags.push('late_entry');
  if (adminBaseline) flags.push('admin_baseline'); // informational, never blocks a prize
  if (manual) flags.push(`manual_${manual.mode}`);

  const eligible = reasons.length === 0;
  const blocking = ['pnl_unpriceable', 'pnl_mismatch', 'flow_mismatch'];

  return {
    email: trader.email,
    client_id: trader.client_id ?? (account && account.client_id) ?? null,
    name: trader.name || null,
    country: trader.country || null,
    wallet_id: baseline.wallet_id,
    is_host: !!trader.is_host,
    category: baseline.category,
    captured_at: baseline.captured_at,
    start_capital: baseline.start_capital_usd,
    dep_w: round2(depW),
    wdr_w: round2(wdrW),
    net_capital: round2(net),
    pnl: round2(pnl),
    return_pct: ret,
    closed_trades: closedTrades,
    reconcile_diff: rec.diff,
    unpriceable: summary.unpriceable,
    eligible,
    winner_eligible: eligible && !flags.some((f) => blocking.includes(f)),
    reasons,
    flags,
    manual: manual ? { mode: manual.mode, fields: manual.mode === 'fields' ? Object.keys(ov).filter((k) => has(ov[k])) : OVERRIDABLE, source: manual.source || null, entered_by: manual.entered_by || null, entered_at: manual.entered_at || null } : null,
  };
}

/** Manual "full" mode: the whole row comes from our database, no Elefin data at all. */
function scoreManualFull({ trader, doc, competition, scoring }) {
  const f = doc.fields;
  const baseline = {
    wallet_id: String(trader.wallet_id),
    captured_at: new Date(f.captured_at).toISOString(),
    start_capital_usd: f.start_capital,
    balance_start: f.balance_start,
    // Pinned category wins: the manual doc's own field first, then the trader-level pin
    // (set from the trader editor), finally the band derived from start capital.
    category: has(f.category) ? f.category : has(trader.category_pin) ? trader.category_pin : categoryFor(f.start_capital, scoring.categories),
  };
  return scoreTrader({
    trader,
    baseline,
    account: null,
    summary: { pnl: f.closed_pnl, closedTrades: f.closed_trades, unpriceable: [], openAtEntry: 0 },
    flows: { depW: f.dep_w, wdrW: f.wdr_w },
    manual: doc,
    competition,
    scoring,
  });
}

module.exports = { scoreTrader, scoreManualFull, applyBaselineOverrides, ledgerFlows, OVERRIDABLE };
