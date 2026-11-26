'use strict';

const { BLOCKING_FLAGS, round2, categoryFor, netCapital, returnPct, ledgerSum, reconcile, accountActivity } = require('./scoring');

// Inputs an organiser may override from our own database (admin-plan §3b).
const OVERRIDABLE = ['start_capital', 'balance_start', 'captured_at', 'dep_w', 'wdr_w', 'closed_pnl', 'closed_trades'];
const has = (v) => v !== undefined && v !== null;
const finite = (v) => has(v) && v !== '' && Number.isFinite(Number(v));

// Ledger statuses that mean the money will never move. Anything else that is not "success"
// (pending, processing, ...) is still in flight.
const FLOW_DONE = new Set(['success', 'failed', 'rejected', 'cancelled', 'canceled', 'declined', 'expired', 'reversed', 'refunded', 'error']);
// A row still "pending" after this long is treated as abandoned, not in flight.
const PENDING_WINDOW_MS = 48 * 3600 * 1000;

/**
 * Deposit/withdrawal sums for one baseline window (check B: the ledger), plus how many of this
 * login's rows are still in flight (created in the last 48 h, neither successful nor failed).
 */
function ledgerFlows(ledger, baseline, windowEnd) {
  const q = { login: baseline.wallet_id, from: baseline.captured_at, to: windowEnd };
  const toMs = Date.parse(windowEnd);
  const fromMs = Math.max(Date.parse(baseline.captured_at), toMs - PENDING_WINDOW_MS);
  let pending = 0;
  for (const r of ledger) {
    if (String(r.login) !== String(baseline.wallet_id)) continue;
    if (!['deposit', 'withdrawal'].includes(String(r.type).toLowerCase())) continue;
    if (FLOW_DONE.has(String(r.status || 'success').toLowerCase())) continue;
    const at = Date.parse(r.created_at);
    if (at >= fromMs && at <= toMs) pending += 1;
  }
  return { depW: ledgerSum(ledger, { ...q, type: 'deposit' }), wdrW: ledgerSum(ledger, { ...q, type: 'withdrawal' }), pending };
}

/**
 * Deposits/withdrawals since the start line from the account record (check A), or null when the
 * start line carries no account totals. These are read in the same call as the balance, so balance
 * P/L built from them cannot pick up a flow the ledger has not caught up with yet.
 */
function accountFlows(account, baseline) {
  if (!account || !has(baseline.total_deposit_start) || !has(baseline.total_withdrawal_start)) return null;
  if (!finite(account.total_deposit) || !finite(account.total_withdrawal)) return null;
  return { depW: Number(account.total_deposit) - baseline.total_deposit_start, wdrW: Number(account.total_withdrawal) - baseline.total_withdrawal_start };
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

  // Flows come from the account record when the start line has its totals (same snapshot as the
  // balance); the ledger is the check (flow_mismatch). Without totals, the ledger is all there is.
  const handFlows = has(ov.dep_w) || has(ov.wdr_w);
  // A start time typed by an admin no longer matches the totals captured with the start line.
  const acctFlows = has(ov.captured_at) ? null : accountFlows(account, baseline);
  const src = acctFlows || flows;
  const depW = has(ov.dep_w) ? ov.dep_w : src.depW;
  const wdrW = has(ov.wdr_w) ? ov.wdr_w : src.wdrW;
  // P/L source. Default: rebuilt from closed trades. "balance" (set per trader by an admin to fix a
  // pnl_mismatch): the account's real balance movement since the start line, net of deposits and
  // withdrawals -- closed trades only (the balance ignores open positions), including trades that
  // were open at the start line, unpriceable instruments and commission. Re-derived every run.
  // Auto fix (scoring.autoPnlFix): if the trade-rebuilt figure does not reconcile with the balance,
  // switch this row to balance P/L for this run. Checked fresh every run; flagged pnl_auto_fixed.
  const canBalance = !has(ov.closed_pnl) && !!account && has(baseline.balance_start);
  let fromBalance = canBalance && trader.pnl_source === 'balance';
  let autoFixed = false;
  if (canBalance && !fromBalance && scoring.autoPnlFix) {
    const probe = reconcile({ balanceNow: Number(account.balance), balanceStart: baseline.balance_start, depW, wdrW, pnl: summary.pnl, toleranceUsd: scoring.pnlToleranceUsd });
    if (probe.mismatch) fromBalance = autoFixed = true;
  }
  const pnl = has(ov.closed_pnl) ? ov.closed_pnl : fromBalance ? round2(Number(account.balance) - baseline.balance_start - depW + wdrW) : summary.pnl;
  // Balance P/L includes trades open at the start line and unpriceable ones, so they count as trades too.
  // The feed also misses rows, so the account's own trade counter / last_trade_at is the floor.
  const feedCount = summary.closedTrades + (fromBalance ? (summary.openAtEntry || 0) + (summary.unpricedTrades || 0) : 0);
  const activity = fromBalance ? accountActivity(account, baseline) : null;
  const acctCount = activity ? Math.max(activity.since !== null ? activity.since : 0, activity.tradedSince ? 1 : 0) : 0;
  const closedTrades = has(ov.closed_trades) ? ov.closed_trades : Math.max(feedCount, acctCount);

  // Check A (account aggregates since baseline) against check B (ledger). Skipped when the
  // flows themselves were entered by hand, or when there is no live account to compare.
  // Also skipped when the start line carries no account totals (a start line typed in "fields").
  const flowMismatch = !!acctFlows && !handFlows &&
    (Math.abs(acctFlows.depW - flows.depW) > scoring.flowToleranceUsd || Math.abs(acctFlows.wdrW - flows.wdrW) > scoring.flowToleranceUsd);
  // A deposit/withdrawal still in flight: the balance may already have moved for it.
  const flowPending = !handFlows && (flows.pending || 0) > 0;

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
  if (autoFixed) flags.push('pnl_auto_fixed'); // informational: switched by the auto fix this run
  // Informational: the trade feed has fewer trades than the account counter says.
  if (activity && !has(ov.closed_trades) && acctCount > feedCount) flags.push('trade_feed_gap');
  // The balance moved but the account says no trade closed since the start line: a rebate, bonus or
  // adjustment, not trading profit. The trader stays unranked (no_closed_trade) until they trade.
  if (activity && activity.tradedSince === false && feedCount === 0 && Math.abs(pnl) > scoring.pnlToleranceUsd) flags.push('balance_without_trades');
  if (flowMismatch) flags.push('flow_mismatch');
  if (flowPending) flags.push('flow_pending');
  if (summary.openAtEntry) flags.push('open_at_entry');
  if (baseline.late_entry && !adminBaseline) flags.push('late_entry');
  if (adminBaseline) flags.push('admin_baseline'); // informational, never blocks a prize
  if (manual) flags.push(`manual_${manual.mode}`);

  const eligible = reasons.length === 0;
  const blocking = BLOCKING_FLAGS;

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
    // The scoring run keeps the previous row while this is true (see jobs/score.js). Not for a
    // plain flow_mismatch: P/L uses the account's own totals, so a lagging ledger cannot skew it;
    // a pending flow can, if the balance moves before the totals do.
    flows_unsettled: flowPending,
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

module.exports = { scoreTrader, scoreManualFull, applyBaselineOverrides, ledgerFlows, accountFlows, OVERRIDABLE };
