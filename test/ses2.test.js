'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildConfig, defaultEntryCutoff } = require('../src/config');
const S = require('../src/domain/scoring');
const { decideBaseline } = require('../src/domain/baseline');
const { runScoring } = require('../src/jobs/score');
const { createApp } = require('../src/api/app');
const { maskName } = require('../src/api/leaderboard');
const { parseRegistry, validateRows } = require('../src/scripts/import-registry');

const ENV = {
  COMPETITION_START: '2026-11-09T09:00:00+05:30',
  COMPETITION_END: '2026-11-14T23:59:59+05:30',
  WINNER_ANNOUNCE: '2026-11-15T12:00:00+05:30',
};
const cfg = buildConfig(ENV);
const { competition: comp, scoring } = cfg;
const T0 = comp.startMs;
const iso = (ms) => new Date(ms).toISOString();

// ---------- config ----------
test('config: entry cutoff defaults to 23:59:59 IST on start day + 2 (Mon -> Wed), not start+72h', () => {
  assert.equal(iso(comp.cutoffMs), '2026-11-11T18:29:59.000Z'); // 23:59:59 IST on the 11th (start is Mon 9th)
  assert.equal(cfg.errors.length, 0);
});

test('config: out-of-order dates and missing dates are reported', () => {
  assert.ok(buildConfig({ ...ENV, COMPETITION_END: '2026-11-08T00:00:00Z' }).errors.length);
  assert.ok(buildConfig({}).errors.length);
  assert.equal(defaultEntryCutoff(Date.parse('2026-11-09T00:00:00+05:30')), Date.parse('2026-11-11T23:59:59+05:30'));
});

// ---------- categories ----------
test('categoryFor: band edges are lower-inclusive', () => {
  const f = (x) => S.categoryFor(x, scoring.categories);
  assert.equal(f(94.99), null);
  assert.equal(f(95), 'bronze');
  assert.equal(f(299.99), 'bronze');
  assert.equal(f(300), 'silver');
  assert.equal(f(499.99), 'silver');
  assert.equal(f(500), 'gold');
  assert.equal(f(999.99), 'gold');
  assert.equal(f(1000), 'platinum');
  assert.equal(f(NaN), null);
});

// ---------- net capital / return ----------
test('netCapital: plan §1b table', () => {
  const n = (s, d, w) => S.netCapital({ startCapital: s, depW: d, wdrW: w });
  assert.equal(n(100, 0, 0), 100);
  assert.equal(n(100, 0, 100), 100); // profit withdrawal cannot shrink the base
  assert.equal(n(100, 0, 150), 100);
  assert.equal(n(100, 400, 0), 500);
  assert.equal(n(100, 400, 400), 100); // deposit fully reversed
});

test('returnPct: never NaN/Infinity', () => {
  assert.equal(S.returnPct(100, 100), 100);
  assert.equal(S.returnPct(10, 0), null);
  assert.equal(S.returnPct(10, -5), null);
  assert.equal(S.returnPct(NaN, 100), null);
});

// ---------- trade P/L ----------
const trade = (o) => ({ trade_ticket_id: String(Math.random()), instrument: 'XAUUSD', type: 'BUY', lots: 0.1, open_time: iso(T0 + 1000), close_time: iso(T0 + 5000), open_price: 100, close_price: 101, swap: 0, ...o });

test('tradePnl: direction, contract size, swap, out-deal flip, unknown instrument', () => {
  const cs = scoring.contractSize;
  assert.equal(S.tradePnl(trade({}), cs), 10); // 1 * 0.1 * 100
  assert.equal(S.tradePnl(trade({ type: 'SELL' }), cs), -10);
  assert.equal(S.tradePnl(trade({ type: 'SELL', open_time: null }), cs), 10); // MT5 out deal flips
  assert.equal(S.tradePnl(trade({ swap: -2 }), cs), 8);
  assert.equal(S.tradePnl(trade({ instrument: 'EURUSD' }), cs), null);
});

test('closedPnl: window, dedupe, open-at-entry, unpriceable', () => {
  const from = iso(T0);
  const to = iso(T0 + 10000);
  const cs = scoring.contractSize;
  const dup = trade({ trade_ticket_id: 'A' });
  const r = S.closedPnl(
    [
      dup,
      dup, // same ticket twice -> once
      trade({ close_time: iso(T0 + 10001) }), // closed after the end
      trade({ open_time: iso(T0 - 5000), close_time: iso(T0 + 100) }), // open at entry
      trade({ instrument: 'EURUSD' }),
    ],
    { from, to, contractSize: cs },
  );
  assert.equal(r.closedTrades, 1);
  assert.equal(r.pnl, 10);
  assert.equal(r.openAtEntry, 1);
  assert.deepEqual(r.unpriceable, ['EURUSD']);
});

test('ledgerSum: only success rows for that login inside the per-trader window', () => {
  const rows = [
    { login: '1', type: 'deposit', status: 'success', amount: 50, created_at: iso(T0 + 1000) },
    { login: '1', type: 'deposit', status: 'success', amount: 70, created_at: iso(T0 - 1000) }, // before captured_at
    { login: '2', type: 'deposit', status: 'success', amount: 99, created_at: iso(T0 + 1000) }, // other login
    { login: '1', type: 'deposit', status: 'failed', amount: 11, created_at: iso(T0 + 1000) },
  ];
  assert.equal(S.ledgerSum(rows, { login: '1', type: 'deposit', from: iso(T0), to: iso(T0 + 9999) }), 50);
});

test('reconcile: open positions do not trip it, a missing trade does', () => {
  const base = { balanceStart: 100, depW: 0, wdrW: 0, toleranceUsd: 1 };
  assert.equal(S.reconcile({ ...base, balanceNow: 110, pnl: 10 }).mismatch, false);
  assert.equal(S.reconcile({ ...base, balanceNow: 150, pnl: 10 }).mismatch, true);
});

test('rankByCategory: tie-breaks and ineligible exclusion', () => {
  const row = (email, o) => ({ email, category: 'bronze', eligible: true, winner_eligible: true, return_pct: 10, pnl: 10, closed_trades: 1, captured_at: iso(T0), ...o });
  const out = S.rankByCategory(
    [row('b@x'), row('a@x'), row('c@x', { pnl: 20 }), row('d@x', { eligible: false }), row('e@x', { return_pct: 5, pnl: 99 })],
    scoring.categories,
  );
  assert.deepEqual(out.bronze.entries.map((e) => e.email), ['c@x', 'a@x', 'b@x', 'e@x']);
  assert.equal(out.silver.winner, null);
});

test('rankByCategory: winner skips a flagged leader but the leader stays on the board', () => {
  const rows = [
    { email: 'x@x', category: 'gold', eligible: true, winner_eligible: false, return_pct: 50, pnl: 1, closed_trades: 1, captured_at: iso(T0) },
    { email: 'y@x', category: 'gold', eligible: true, winner_eligible: true, return_pct: 10, pnl: 1, closed_trades: 1, captured_at: iso(T0) },
  ];
  const g = S.rankByCategory(rows, scoring.categories).gold;
  assert.equal(g.leader.email, 'x@x');
  assert.equal(g.winner.email, 'y@x');
});

// ---------- baseline ----------
const acct = (o = {}) => ({ login: '111', client_id: 1, currency: 'USD', balance: 120, equity: 120, total_deposit: 120, total_withdrawal: 0, trades: 0, ...o });
const decide = (existing, account, nowMs) => decideBaseline({ existing, account, nowMs, competition: comp, scoring });

test('baseline: pending below floor, frozen once funded, never changed after', () => {
  const low = decide(null, acct({ equity: 40 }), T0 + 1000);
  assert.equal(low.doc.status, 'pending');
  const funded = decide(low.doc, acct({ equity: 120 }), T0 + 60000);
  assert.equal(funded.doc.status, 'frozen');
  assert.equal(funded.doc.category, 'bronze');
  assert.equal(funded.doc.start_capital_usd, 120);
  const later = decide(funded.doc, acct({ equity: 5000 }), T0 + 120000);
  assert.equal(later.changed, false);
  assert.equal(later.doc.category, 'bronze'); // later deposits never change category
});

test('baseline: pre-start only seeds pending; after cutoff -> excluded; exactly at cutoff still freezes', () => {
  assert.equal(decide(null, acct(), T0 - 1000).doc.status, 'pending');
  assert.equal(decide(null, acct(), comp.cutoffMs).doc.status, 'frozen');
  const late = decide(null, acct(), comp.cutoffMs + 1);
  assert.equal(late.doc.status, 'excluded');
  assert.equal(late.doc.reason, 'entry_closed');
});

test('baseline: non-USD account is not frozen with a guessed rate', () => {
  const r = decide(null, acct({ currency: 'INR' }), T0 + 1000);
  assert.equal(r.doc.status, 'pending');
  assert.equal(r.doc.reason, 'unsupported_currency');
});

// ---------- full scoring pass with fakes ----------
function fakeStore({ traders, baselines = [], current = null }) {
  const s = {
    published: null,
    saved: [],
    entries: new Map(),
    baselines: new Map(baselines.map((b) => [b.email, b])),
    loadCurrent: async () => current,
    loadTraders: async () => traders,
    loadBaselines: async () => s.baselines,
    loadEntries: async () => s.entries,
    saveBaseline: async (c, email, doc) => {
      s.baselines.set(email, { ...doc, email });
      s.saved.push(email);
    },
    saveEntries: async (c, rows) => rows.forEach((r) => s.entries.set(r.email, r)),
    publish: async (c, doc) => {
      s.published = doc;
    },
  };
  return s;
}

function fakeElefin({ accounts, trades = {}, ledger = [], failAccounts = [] }) {
  const calls = { trades: 0, account: 0 };
  return {
    calls,
    getTransactions: async (type) => ({ ok: true, rows: ledger.filter((r) => r.type === type) }),
    getAccount: async (login) => {
      calls.account += 1;
      return failAccounts.includes(login) ? { ok: false, error: 'boom' } : { ok: true, account: accounts[login] };
    },
    getTrades: async (login) => {
      calls.trades += 1;
      return { ok: true, rows: trades[login] || [] };
    },
  };
}

const trader = (n, o = {}) => ({ email: `t${n}@x.com`, wallet_id: String(n), client_id: n, name: `Trader ${n}`, status: 'active', ...o });

test('runScoring: first entry, then a win: frozen at start, categorised, ranked, reconciled', async () => {
  const traders = [trader(1), trader(2)];
  const store = fakeStore({ traders });
  const el1 = fakeElefin({ accounts: { 1: acct({ login: '1', client_id: 1, equity: 200, balance: 200 }), 2: acct({ login: '2', client_id: 2, equity: 600, balance: 600 }) } });

  await runScoring({ store, elefin: el1, cfg, nowMs: T0 + 60000 });
  assert.equal(store.baselines.get('t1@x.com').category, 'bronze');
  assert.equal(store.baselines.get('t2@x.com').category, 'gold');
  assert.equal(store.published.stats.ranked, 0); // nobody has traded yet

  // trader 1 closes a +$10 gold trade after entry; the account balance moves accordingly
  const win = trade({ trade_ticket_id: 'W1', open_time: iso(T0 + 120000), close_time: iso(T0 + 180000) });
  const el2 = fakeElefin({
    accounts: { 1: acct({ login: '1', client_id: 1, equity: 210, balance: 210, trades: 1, total_deposit: 120 }), 2: acct({ login: '2', client_id: 2, equity: 600, balance: 600 }) },
    trades: { 1: [win] },
  });
  // account deposits were 120 at... baseline stored total_deposit_start from the first acct() (120) -> no flow
  const r = await runScoring({ store, elefin: el2, cfg, nowMs: T0 + 240000 });
  assert.equal(r.published, true);
  const bronze = store.published.categories.bronze.entries;
  assert.equal(bronze.length, 1);
  assert.equal(bronze[0].pnl, 10);
  assert.equal(bronze[0].net_capital, 200);
  assert.equal(bronze[0].return_pct, 5);
  assert.equal(bronze[0].winner_eligible, true);
  assert.equal(store.published.categories.gold.entries.length, 0);
});

test('runScoring: an admin re-baseline (captured_at after the cutoff) is exempt from entered_after_cutoff and the late flag', async () => {
  const captured = iso(comp.cutoffMs + 10000); // deliberately after the entry cutoff
  const baseline = {
    status: 'frozen', wallet_id: '1', captured_at: captured,
    start_capital: 200, start_capital_usd: 200, balance_start: 200,
    total_deposit_start: 120, total_withdrawal_start: 0, category: 'bronze',
    late_entry: true, admin_baseline: true,
  };
  const store = fakeStore({ traders: [trader(1)], baselines: [{ email: 't1@x.com', ...baseline }] });
  const win = trade({ trade_ticket_id: 'AB', open_time: iso(comp.cutoffMs + 20000), close_time: iso(comp.cutoffMs + 60000) });
  const el = fakeElefin({ accounts: { 1: acct({ login: '1', client_id: 1, equity: 210, balance: 210, trades: 1, total_deposit: 120 }) }, trades: { 1: [win] } });

  await runScoring({ store, elefin: el, cfg, nowMs: comp.cutoffMs + 300000 });
  const row = store.entries.get('t1@x.com');
  assert.equal(row.eligible, true);
  assert.equal(row.winner_eligible, true);
  assert.ok(!row.reasons.includes('entered_after_cutoff'));
  assert.ok(!row.flags.includes('late_entry'));
  assert.equal(store.published.categories.bronze.entries.length, 1);
});

test('runScoring: ledger vs account-aggregate disagreement blocks the prize, not the board', async () => {
  const store = fakeStore({ traders: [trader(1)] });
  await runScoring({ store, elefin: fakeElefin({ accounts: { 1: acct({ login: '1', client_id: 1, equity: 200, balance: 200, total_deposit: 200 }) } }), cfg, nowMs: T0 + 1000 });
  const win = trade({ trade_ticket_id: 'W', open_time: iso(T0 + 5000), close_time: iso(T0 + 9000) });
  // aggregate shows +50 deposited but the ledger has no such row
  const el = fakeElefin({ accounts: { 1: acct({ login: '1', client_id: 1, equity: 210, balance: 260, trades: 1, total_deposit: 250 }) }, trades: { 1: [win] } });
  await runScoring({ store, elefin: el, cfg, nowMs: T0 + 20000 });
  const e = store.published.categories.bronze.entries[0];
  assert.ok(e.flags.includes('flow_mismatch'));
  assert.equal(e.winner_eligible, false);
});

test('runScoring: mid-session deposit raises net capital and never the category', async () => {
  const store = fakeStore({ traders: [trader(1)] });
  await runScoring({ store, elefin: fakeElefin({ accounts: { 1: acct({ login: '1', client_id: 1, equity: 200, balance: 200, total_deposit: 200 }) } }), cfg, nowMs: T0 + 1000 });
  const win = trade({ trade_ticket_id: 'W', open_time: iso(T0 + 5000), close_time: iso(T0 + 9000) });
  const dep = { login: '1', type: 'deposit', status: 'success', amount: 800, created_at: iso(T0 + 4000) };
  const el = fakeElefin({
    accounts: { 1: acct({ login: '1', client_id: 1, equity: 1010, balance: 1010, trades: 1, total_deposit: 1000 }) },
    trades: { 1: [win] },
    ledger: [dep],
  });
  await runScoring({ store, elefin: el, cfg, nowMs: T0 + 20000 });
  const e = store.published.categories.bronze.entries[0];
  assert.equal(e.category, 'bronze');
  assert.equal(e.net_capital, 1000);
  assert.equal(e.return_pct, 1); // 10 / 1000
  assert.equal(e.winner_eligible, true);
});

test('runScoring: unchanged trades counter reuses the cache (no trades call)', async () => {
  const store = fakeStore({ traders: [trader(1)] });
  const accounts = { 1: acct({ login: '1', client_id: 1, equity: 200, balance: 200, trades: 0 }) };
  await runScoring({ store, elefin: fakeElefin({ accounts }), cfg, nowMs: T0 + 1000 });
  const el = fakeElefin({ accounts });
  await runScoring({ store, elefin: el, cfg, nowMs: T0 + 2000 });
  assert.equal(el.calls.trades, 0);
});

test('runScoring: wrong owner -> account_not_found; too many failures -> refuse to publish', async () => {
  const store = fakeStore({ traders: [trader(1)] });
  await runScoring({ store, elefin: fakeElefin({ accounts: { 1: acct({ login: '1', client_id: 999 }) } }), cfg, nowMs: T0 + 1000 });
  assert.deepEqual(store.entries.get('t1@x.com').reasons, ['account_not_found']);

  const store2 = fakeStore({ traders: [trader(1), trader(2)] });
  await assert.rejects(
    runScoring({ store: store2, elefin: fakeElefin({ accounts: {}, failAccounts: ['1', '2'] }), cfg, nowMs: T0 + 1000 }),
    /partial board refused/,
  );
  assert.equal(store2.published, null);
});

test('runScoring: pre-start and finalized boards are left alone; final run marks competition_over', async () => {
  const store = fakeStore({ traders: [trader(1)] });
  const el = fakeElefin({ accounts: { 1: acct({ login: '1', client_id: 1 }) } });
  assert.deepEqual(await runScoring({ store, elefin: el, cfg, nowMs: T0 - 1 }), { skipped: 'pre_start' });

  const done = fakeStore({ traders: [trader(1)], current: { competition_over: true } });
  assert.deepEqual(await runScoring({ store: done, elefin: el, cfg, nowMs: T0 + 1000 }), { skipped: 'competition_over' });

  const past = await runScoring({ store, elefin: el, cfg, nowMs: comp.endMs + 5000 });
  assert.equal(past.final, false); // reaching the end does not close the board
  assert.equal(store.published.competition_over, false);
  store.loadCurrent = async () => store.published;
  assert.deepEqual(await runScoring({ store, elefin: el, cfg, nowMs: comp.endMs + 9000 }), { skipped: 'awaiting_finalize' });
  const r = await runScoring({ store, elefin: el, cfg, nowMs: comp.endMs + 20000, finalize: true });
  assert.equal(r.final, true);
  assert.equal(store.published.competition_over, true);
  assert.equal(store.published.window_end, comp.end); // window stays capped at the configured end
});

// ---------- API ----------
async function withServer(store, fn, cfgOverride = cfg, nowTrigger = async () => {}) {
  const app = createApp({ store, trigger: nowTrigger, cfg: cfgOverride });
  const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test('API: pending before any board exists; unknown category -> 400; no PII in entries', async () => {
  const store = fakeStore({ traders: [] });
  await withServer(store, async (url) => {
    const pending = await (await fetch(`${url}/api/leaderboard`)).json();
    assert.equal(pending.status, 'pending');
    assert.equal(pending.categories.length, 4);
    assert.equal(pending.categories[0].min_usd, 100); // UI shows 100, never the 95 floor
    assert.equal((await fetch(`${url}/api/leaderboard?category=diamond`)).status, 400);
  });

  store.loadCurrent = async () => ({
    generated_at: 'x', window_end: 'y', competition_over: false,
    stats: { registered: 1, frozen: 1, ranked: 1 },
    categories: { bronze: { stats: {}, entries: [{ rank: 1, email: 'secret@x.com', wallet_id: '999', name: 'yash agarwal', category: 'bronze', return_pct: 12.3456, pnl: 1, start_capital: 100, net_capital: 100, closed_trades: 2, flags: ['flow_mismatch'], reasons: [] }] } },
  });
  await withServer(store, async (url) => {
    const raw = await (await fetch(`${url}/api/leaderboard?category=bronze`)).text();
    assert.ok(!raw.includes('secret@x.com') && !raw.includes('999') && !raw.includes('flow_mismatch'));
    const body = JSON.parse(raw);
    assert.equal(body.boards.bronze.entries[0].name, 'Yash A.');
    assert.equal(body.boards.bronze.entries[0].return_pct, 12.35);
    assert.equal(body.boards.silver, undefined);
  });
});

test('API: refresh needs the exact token; static repo files are not served', async () => {
  let triggered = 0;
  const secured = { ...cfg, refreshToken: 'right-token' };
  await withServer(fakeStore({ traders: [] }), async (url) => {
    assert.equal((await fetch(`${url}/api/leaderboard/refresh`, { method: 'POST', headers: { 'x-refresh-token': 'wrong-token' } })).status, 401);
    assert.equal((await fetch(`${url}/api/leaderboard/refresh`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${url}/api/leaderboard/refresh`, { method: 'POST', headers: { 'x-refresh-token': 'right-token' } })).status, 202);
    assert.equal(triggered, 1);
    const pkg = await fetch(`${url}/package.json`);
    assert.ok((await pkg.text()).includes('<html') || pkg.status === 404); // falls back to the landing page, never the file
  }, secured, async () => { triggered += 1; });
});

test('API: unconfigured dates -> phase unconfigured, still serves', async () => {
  await withServer(fakeStore({ traders: [] }), async (url) => {
    const b = await (await fetch(`${url}/api/leaderboard`)).json();
    assert.equal(b.phase, 'unconfigured');
  }, buildConfig({}));
});

test('maskName', () => {
  assert.equal(maskName('amritpal SINGH'), 'Amritpal S.');
  assert.equal(maskName('Cher'), 'Cher');
  assert.equal(maskName(''), 'Trader');
});

// ---------- registry import ----------
test('registry parsing: rejects duplicates and bad wallet ids', () => {
  const md = `<!-- REGISTRY:BEGIN -->
| email | wallet_id | client_id | name | status | added_at | notes |
| --- | --- | --- | --- | --- | --- | --- |
| a@x.com | 111 | 1 | A | active | d | |
| A@x.com | 222 | 2 | B | active | d | |
| c@x.com | 12ab | 3 | C | bogus | d | |
<!-- REGISTRY:END -->`;
  const { errors } = validateRows(parseRegistry(md));
  assert.ok(errors.some((e) => e.includes('duplicate email')));
  assert.ok(errors.some((e) => e.includes('digits only')));
  assert.ok(errors.some((e) => e.includes('status')));
});
