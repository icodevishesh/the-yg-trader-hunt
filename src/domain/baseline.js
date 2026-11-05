'use strict';

const { categoryFor, round2 } = require('./scoring');

/*
 * First-entry baseline (plan §1a, §3c). Pure: decides what the stored baseline
 * should become given the current account snapshot. Never touches a frozen one.
 *
 *   frozen    equity >= floor inside [start, entryCutoff]; immutable afterwards
 *   pending   seen but not yet funded (or before the start line); re-checked each run
 *   excluded  never funded by the cutoff; kept for audit, never scored
 */
function decideBaseline({ existing, account, nowMs, competition, scoring }) {
  if (existing && (existing.status === 'frozen' || existing.status === 'excluded')) {
    return { changed: false, doc: existing };
  }

  const equity = Number(account.equity);
  const currency = String(account.currency || 'USD').toUpperCase();
  const snapshot = {
    wallet_id: String(account.login),
    currency,
    equity_seen: round2(equity),
    seen_at: new Date(nowMs).toISOString(),
  };

  if (nowMs > competition.cutoffMs) {
    return { changed: true, doc: { ...(existing || {}), ...snapshot, status: 'excluded', reason: 'entry_closed' } };
  }

  const fundable = nowMs >= competition.startMs && Number.isFinite(equity) && equity >= scoring.minCapitalUsd;
  if (!fundable) {
    return { changed: true, doc: { ...(existing || {}), ...snapshot, status: 'pending' } };
  }

  if (currency !== 'USD') {
    // Elefin reports USD; anything else is not frozen with a guessed FX rate.
    return { changed: true, doc: { ...(existing || {}), ...snapshot, status: 'pending', reason: 'unsupported_currency' } };
  }

  return {
    changed: true,
    doc: {
      ...snapshot,
      status: 'frozen',
      captured_at: new Date(nowMs).toISOString(),
      start_capital: round2(equity),
      start_capital_usd: round2(equity),
      balance_start: round2(Number(account.balance)),
      total_deposit_start: round2(Number(account.total_deposit) || 0),
      total_withdrawal_start: round2(Number(account.total_withdrawal) || 0),
      category: categoryFor(equity, scoring.categories),
      late_entry: nowMs - competition.startMs > 3600 * 1000,
    },
  };
}

module.exports = { decideBaseline };
