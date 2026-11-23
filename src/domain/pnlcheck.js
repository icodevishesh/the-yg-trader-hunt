'use strict';

const { round2, tradePnl, ledgerSum } = require('./scoring');

/*
 * P/L check for one trader (admin "Check closed trades"). Pure.
 *
 * Explains a pnl_mismatch: the scorer's trade P/L only counts trades opened AND closed after the
 * start line, while the balance moves for every trade that closes after it. The gap between the
 * two is broken down into its usual causes so an admin can decide which P/L to trust.
 */

const ms = (v) => (v ? Date.parse(v) : NaN);
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);

/**
 * Every trade closed inside [fromMs, toMs], each with its rebuilt P/L and how scoring treats it:
 *   counted        opened after the start line (or an MT5 "out" deal): in the trade P/L
 *   open_at_start  already open at the start line: NOT in the trade P/L, but in the balance
 *   unpriceable    no contract size for the instrument: P/L unknown
 */
function tradeBreakdown(trades, { fromMs, toMs, contractSize }) {
  const seen = new Set();
  const rows = [];
  for (const tr of trades) {
    const id = tr.trade_ticket_id ?? tr.ticket ?? tr.id;
    if (id !== undefined) {
      if (seen.has(String(id))) continue;
      seen.add(String(id));
    }
    const closed = ms(tr.close_time);
    if (!(closed >= fromMs && closed <= toMs)) continue;
    const pnl = tradePnl(tr, contractSize);
    const status = pnl === null ? 'unpriceable' : tr.open_time && ms(tr.open_time) < fromMs ? 'open_at_start' : 'counted';
    rows.push({
      ticket: id === undefined ? null : String(id),
      instrument: String(tr.instrument || '').toUpperCase() || null,
      type: tr.type || null,
      lots: num(tr.lots),
      open_time: tr.open_time || null,
      close_time: tr.close_time,
      open_price: tr.open_price ?? null,
      close_price: tr.close_price ?? null,
      swap: round2(num(tr.swap)),
      commission: round2(num(tr.broker_commission) + num(tr.commission)),
      pnl: pnl === null ? null : round2(pnl),
      status,
    });
  }
  rows.sort((a, b) => ms(a.close_time) - ms(b.close_time));
  const sum = (st) => round2(rows.filter((r) => r.status === st).reduce((s, r) => s + (r.pnl || 0), 0));
  return {
    trades: rows,
    totals: {
      counted: { count: rows.filter((r) => r.status === 'counted').length, pnl: sum('counted') },
      open_at_start: { count: rows.filter((r) => r.status === 'open_at_start').length, pnl: sum('open_at_start') },
      unpriceable: { count: rows.filter((r) => r.status === 'unpriceable').length, instruments: [...new Set(rows.filter((r) => r.status === 'unpriceable').map((r) => r.instrument))] },
      commission: round2(rows.reduce((s, r) => s + r.commission, 0)),
      swap: round2(rows.reduce((s, r) => s + r.swap, 0)),
    },
  };
}

/**
 * Reconciles the trade P/L with the balance since the start line and names the causes of the gap.
 *   balance P/L = balance now - balance at start - deposits + withdrawals (closed trades only:
 *                 the balance does not move with open positions)
 */
function pnlCheck({ account, trades, ledger, startLine, nowMs, contractSize, toleranceUsd, listFromMs = null }) {
  const startMs = ms(startLine.captured_at);
  const atStart = tradeBreakdown(trades, { fromMs: startMs, toMs: nowMs, contractSize });
  const range = { login: String(account.login), from: new Date(startMs).toISOString(), to: new Date(nowMs).toISOString() };
  const deposits = round2(ledgerSum(ledger, { ...range, type: 'deposit' }));
  const withdrawals = round2(ledgerSum(ledger, { ...range, type: 'withdrawal' }));
  const balanceNow = round2(Number(account.balance));
  const balancePnl = round2(balanceNow - Number(startLine.balance_start) - deposits + withdrawals);
  const tradePnlTotal = atStart.totals.counted.pnl;
  const diff = round2(balancePnl - tradePnlTotal);
  const residual = round2(diff - atStart.totals.open_at_start.pnl);

  const causes = [];
  const t = atStart.totals;
  if (t.open_at_start.count) causes.push(`${t.open_at_start.count} trade(s) were already open at the start line and closed after it: ${t.open_at_start.pnl >= 0 ? '+' : ''}${t.open_at_start.pnl} is in the balance but not in the trade P/L.`);
  if (t.unpriceable.count) causes.push(`${t.unpriceable.count} trade(s) on ${t.unpriceable.instruments.join(', ')} cannot be priced (no contract size), so the trade P/L misses them.`);
  if (t.commission) causes.push(`Commission on these trades totals ${t.commission}; the trade P/L does not deduct commission.`);
  if (Math.abs(residual) > toleranceUsd && !t.unpriceable.count) causes.push(`${residual >= 0 ? '+' : ''}${residual} is not explained by the trades (fees, adjustments, or a ledger entry outside the deposit/withdrawal feed).`);
  if (Math.abs(diff) > toleranceUsd && account && Math.abs(Number(account.equity) - Number(account.balance)) > 0.01) causes.push('The account has open positions now; they are in neither figure until they close.');

  const list = listFromMs !== null && listFromMs !== startMs ? tradeBreakdown(trades, { fromMs: listFromMs, toMs: nowMs, contractSize }) : atStart;
  return {
    start_line: { captured_at: startLine.captured_at, balance_start: round2(Number(startLine.balance_start)) },
    balance_now: balanceNow,
    equity_now: round2(Number(account.equity)),
    deposits,
    withdrawals,
    trade_pnl: tradePnlTotal,
    balance_pnl: balancePnl,
    diff,
    mismatch: Math.abs(diff) > toleranceUsd,
    residual,
    causes,
    totals: atStart.totals,
    list_from: new Date(listFromMs ?? startMs).toISOString(),
    trades: list.trades,
    list_totals: list.totals,
  };
}

module.exports = { tradeBreakdown, pnlCheck };
