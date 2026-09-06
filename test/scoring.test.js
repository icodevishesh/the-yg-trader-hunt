'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  baselineFromClient, computeWindow, isEligibleWindow, rankCompetitionEntries,
} = require('../services/scoring');

// A normalized Elefin client row, USD, active, with sensible funding defaults.
function client(over = {}) {
  return {
    client_id: 1001,
    name: 'Test Trader',
    email: 'test@example.com',
    country: 'India',
    status: 'active',
    currency: 'USD',
    net_deposit: 200,
    deposits: 200,
    withdrawals: 0,
    balance: 200,
    equity: 200,
    net_profit: 0,
    trades: 0,
    lots: 0,
    last_trade_at: null,
    referred_at: '2026-09-01T00:00:00Z',
    registered_at: '2026-09-01T00:00:00Z',
    ...over,
  };
}

test('plan §4 example A — clean winner: +30.00% and winner-eligible', () => {
  const baseline = { ...baselineFromClient(client({ equity: 200, net_profit: 0, trades: 0 })), late_entry: false };
  const now = client({ equity: 260, net_profit: 60, trades: 20 });

  const win = computeWindow(baseline, now);
  assert.equal(win.base_start, 200);
  assert.equal(win.net_profit_window, 60);
  assert.equal(Math.round(win.return_pct * 100) / 100, 30.0);
  assert.equal(win.added_funds, false);

  const elig = isEligibleWindow(now, win, baseline);
  assert.equal(elig.eligible, true);
  assert.equal(elig.winner_eligible, true);
});

test('plan §4 example B — deposit exploit: score honest to start base, barred from prize', () => {
  const baseline = { ...baselineFromClient(client({ equity: 100, deposits: 100, net_deposit: 100 })), late_entry: false };
  // deposits $900 mid-window, trades to +$120 realized
  const now = client({ equity: 1120, deposits: 1000, net_deposit: 1000, net_profit: 120, trades: 15 });

  const win = computeWindow(baseline, now);
  assert.equal(win.base_start, 100); // frozen — the deposit did not move it
  assert.equal(win.net_profit_window, 120); // realized P/L, untouched by the deposit
  assert.equal(Math.round(win.return_pct), 120);
  assert.equal(win.deposits_window, 900);
  assert.equal(win.added_funds, true);

  const elig = isEligibleWindow(now, win, baseline);
  assert.equal(elig.eligible, true); // still shown on the board
  assert.equal(elig.winner_eligible, false); // but cannot win
});

test('plan §4 example C — withdrawal: not penalised, +18.00%, winner-eligible', () => {
  const baseline = { ...baselineFromClient(client({ equity: 500, balance: 500, net_deposit: 500, deposits: 500, net_profit: 40, trades: 5 })), late_entry: false };
  const now = client({ equity: 390, deposits: 500, withdrawals: 200, net_deposit: 300, net_profit: 130, trades: 12 });

  const win = computeWindow(baseline, now);
  assert.equal(win.base_start, 500); // frozen — withdrawal did not shrink it
  assert.equal(win.net_profit_window, 90);
  assert.equal(Math.round(win.return_pct * 100) / 100, 18.0);
  assert.equal(win.withdrawals_window, 200);
  assert.equal(win.added_funds, false);

  const elig = isEligibleWindow(now, win, baseline);
  assert.equal(elig.winner_eligible, true);
});

test('data anomaly — cumulative trades went backwards => excluded this run', () => {
  const baseline = { ...baselineFromClient(client({ trades: 5, net_profit: 10 })), late_entry: false };
  const now = client({ trades: 3, net_profit: 12 });

  const win = computeWindow(baseline, now);
  assert.equal(win.data_anomaly, true);

  const elig = isEligibleWindow(now, win, baseline);
  assert.equal(elig.eligible, false);
  assert.ok(elig.ineligible_reasons.includes('data_anomaly'));
});

test('late entry — eligible for board, never winner-eligible', () => {
  const baseline = { ...baselineFromClient(client({ equity: 200 })), late_entry: true };
  const now = client({ equity: 250, net_profit: 50, trades: 10 });

  const win = computeWindow(baseline, now);
  const elig = isEligibleWindow(now, win, baseline);
  assert.equal(elig.eligible, true);
  assert.equal(elig.late_entry, true);
  assert.equal(elig.winner_eligible, false);
});

test('below-minimum starting capital — off the board', () => {
  const baseline = { ...baselineFromClient(client({ equity: 60, deposits: 60, net_deposit: 60 })), late_entry: false };
  const now = client({ equity: 90, deposits: 60, net_deposit: 60, net_profit: 30, trades: 8 });

  const win = computeWindow(baseline, now);
  const elig = isEligibleWindow(now, win, baseline);
  assert.equal(elig.eligible, false);
  assert.ok(elig.ineligible_reasons.includes('below_min_deposit'));
});

test('no window trades — off the board even if lifetime trades exist', () => {
  const baseline = { ...baselineFromClient(client({ trades: 12, net_profit: 40 })), late_entry: false };
  const now = client({ trades: 12, net_profit: 40, equity: 240 });

  const win = computeWindow(baseline, now);
  assert.equal(win.trades_window, 0);
  const elig = isEligibleWindow(now, win, baseline);
  assert.equal(elig.eligible, false);
  assert.ok(elig.ineligible_reasons.includes('no_window_trades'));
});

test('ranking + tie-break: equal return_pct falls to larger window net profit', () => {
  const rows = [
    { client_id: 1, return_pct: 20, net_profit_window: 40, trades_window: 10, referred_at: '2026-09-02T00:00:00Z' },
    { client_id: 2, return_pct: 20, net_profit_window: 80, trades_window: 10, referred_at: '2026-09-03T00:00:00Z' },
    { client_id: 3, return_pct: 35, net_profit_window: 35, trades_window: 5, referred_at: '2026-09-01T00:00:00Z' },
  ];
  const ranked = rankCompetitionEntries(rows, { shortlistSize: 2 });
  assert.deepEqual(ranked.map((r) => r.client_id), [3, 2, 1]);
  assert.equal(ranked[0].rank, 1);
  assert.equal(ranked[0].shortlisted, true);
  assert.equal(ranked[2].shortlisted, false);
});

test('INR account — deposit tolerance is FX-normalised, ratio is unit-free', () => {
  const inr = (over) => client({ currency: 'INR', net_deposit: 20000, deposits: 20000, balance: 20000, equity: 20000, ...over });
  const baseline = { ...baselineFromClient(inr({})), late_entry: false };
  // +5000 INR realized (~+25% on 20000), no deposit
  const now = inr({ equity: 25000, net_profit: 5000, trades: 14 });

  const win = computeWindow(baseline, now);
  assert.equal(Math.round(win.return_pct), 25);
  assert.equal(win.added_funds, false);

  // a 500 INR top-up (~$5) still trips the $1 tolerance
  const now2 = inr({ equity: 25500, deposits: 20500, net_deposit: 20500, net_profit: 5000, trades: 14 });
  assert.equal(computeWindow(baseline, now2).added_funds, true);
});
