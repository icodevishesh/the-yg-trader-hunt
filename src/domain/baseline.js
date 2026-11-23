'use strict';

const { categoryFor, round2, tradePnl, ledgerSum } = require('./scoring');

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

class BaselineError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const ms = (v) => (v ? Date.parse(v) : NaN);

/**
 * Category of an admin-set start line:
 *   pinned category   wins
 *   explicit capital  derives the band from that capital (the reason to set it)
 *   otherwise         keeps the previous frozen baseline's band, or derives one
 */
function adminCategory({ pinned, startCapital, explicitCapital, previous, categories }) {
  if (pinned) return pinned;
  if (explicitCapital) return categoryFor(startCapital, categories);
  if (previous && previous.status === 'frozen' && previous.category) return previous.category;
  return categoryFor(startCapital, categories);
}

/**
 * Rebuilds a trader's start line at a past moment `atMs` from today's account and the history
 * since then (Elefin has no historical equity). Pure.
 *
 *   balance at T = balance now - (deposits - withdrawals since T) - P/L of every trade closed since T
 *
 * Every trade closed after T counts here, including ones opened before T, because the balance
 * only moves when a trade closes. Floating P/L of positions open at T cannot be recovered, so the
 * start capital is the balance at T and those trades are reported (scoring flags open_at_entry).
 */
function rebuildBaseline({ account, trades, ledger, atMs, nowMs, competition, scoring, startCapital = null, category = null, previous = null }) {
  const currency = String(account.currency || 'USD').toUpperCase();
  if (currency !== 'USD') throw new BaselineError('unsupported_currency', `Account currency is ${currency}; only USD accounts can be re-baselined.`);

  const login = String(account.login);
  const seen = new Set();
  let pnl = 0;
  let straddling = 0;
  const unpriceable = [];
  for (const tr of trades) {
    const id = tr.trade_ticket_id ?? tr.ticket ?? tr.id;
    if (id !== undefined) {
      if (seen.has(String(id))) continue;
      seen.add(String(id));
    }
    const closed = ms(tr.close_time);
    if (!(closed >= atMs && closed <= nowMs)) continue;
    if (tr.open_time && ms(tr.open_time) < atMs) straddling += 1;
    const p = tradePnl(tr, scoring.contractSize);
    if (p === null) {
      const inst = String(tr.instrument || 'unknown').toUpperCase();
      if (!unpriceable.includes(inst)) unpriceable.push(inst);
      continue;
    }
    pnl += p;
  }
  if (unpriceable.length) {
    throw new BaselineError('pnl_unpriceable', `Cannot rebuild the start line: no contract size for ${unpriceable.join(', ')}. Enter it from an MT5 statement in Manual data instead.`);
  }

  const range = { login, from: new Date(atMs).toISOString(), to: new Date(nowMs).toISOString() };
  const dep = ledgerSum(ledger, { ...range, type: 'deposit' });
  const wdr = ledgerSum(ledger, { ...range, type: 'withdrawal' });
  const balanceStart = round2(Number(account.balance) - dep + wdr - pnl);
  if (!(balanceStart > 0)) throw new BaselineError('invalid_balance', `The rebuilt balance at that time is $${balanceStart}; pick a later start time or set the start line by hand.`);

  const explicit = startCapital !== null && startCapital !== undefined;
  const capital = explicit ? round2(startCapital) : balanceStart;
  const doc = {
    wallet_id: login,
    currency,
    status: 'frozen',
    source: 'admin',
    captured_at: new Date(atMs).toISOString(),
    start_capital: capital,
    start_capital_usd: capital,
    balance_start: balanceStart,
    total_deposit_start: round2((Number(account.total_deposit) || 0) - dep),
    total_withdrawal_start: round2((Number(account.total_withdrawal) || 0) - wdr),
    category: adminCategory({ pinned: category, startCapital: capital, explicitCapital: explicit, previous, categories: scoring.categories }),
    late_entry: atMs - competition.startMs > 3600 * 1000,
    equity_seen: round2(Number(account.equity)),
    seen_at: new Date(nowMs).toISOString(),
  };

  const warnings = [];
  if (straddling) warnings.push(`${straddling} trade(s) were already open at the start time. Their profit or loss before it cannot be separated, so the board will flag open_at_entry (and may flag pnl_mismatch).`);
  if (Math.abs(Number(account.equity) - Number(account.balance)) > 0.01) warnings.push('The account has open positions right now; they only count once closed.');
  return { doc, rebuilt: { balance_now: round2(Number(account.balance)), deposits_since: round2(dep), withdrawals_since: round2(wdr), closed_pnl_since: round2(pnl) }, warnings };
}

/** Changes only the start capital (and category) of an existing frozen baseline. Pure. */
function adjustCapital({ previous, startCapital = null, category = null, scoring, nowMs }) {
  if (!previous || previous.status !== 'frozen') throw new BaselineError('no_baseline', 'This trader has no frozen start line yet. Give a start time to build one.');
  const explicit = startCapital !== null && startCapital !== undefined;
  if (!explicit && !category) throw new BaselineError('nothing_to_change', 'Give a start time, a start capital or a category.');
  const capital = explicit ? round2(startCapital) : previous.start_capital_usd;
  const { _id, history, rev, ...rest } = previous;
  return {
    doc: {
      ...rest,
      source: 'admin',
      start_capital: capital,
      start_capital_usd: capital,
      category: adminCategory({ pinned: category, startCapital: capital, explicitCapital: explicit, previous, categories: scoring.categories }),
      seen_at: new Date(nowMs).toISOString(),
    },
    rebuilt: null,
    warnings: [],
  };
}

module.exports = { decideBaseline, rebuildBaseline, adjustCapital, BaselineError };
