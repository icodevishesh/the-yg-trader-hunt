'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildConfig } = require('../src/config');
const { createRounds, challengeResult } = require('../src/jobs/rounds');
const { runSafely } = require('../src/jobs/scheduler');
const { createAdminService } = require('../src/admin/service');
const { createApp } = require('../src/api/app');
const { rankByCategory } = require('../src/domain/scoring');

const ENV = {
  COMPETITION_START: '2026-11-09T09:00:00+05:30',
  COMPETITION_END: '2026-11-14T23:59:59+05:30',
  WINNER_ANNOUNCE: '2026-11-15T12:00:00+05:30',
  WEEK2_START: '2026-11-16T09:00:00+05:30',
  WEEK2_END: '2026-11-22T23:59:59+05:30',
};
const cfg = buildConfig(ENV);
const cfgNoW2 = buildConfig({ ...ENV, WEEK2_START: '', WEEK2_END: '' });
const T0 = cfg.competition.startMs;
const W2 = cfg.week2.startMs;
const iso = (ms) => new Date(ms).toISOString();

/** One in-memory store for scoring, rounds and the admin repo; everything is keyed by cohort. */
function memStore(traders) {
  const s = {
    traders: new Map(traders.map((t) => [`${t.cohort}:${t.email}`, { ...t }])),
    baselines: new Map(), entries: new Map(), current: new Map(), rounds: new Map(), manual: new Map(), locks: new Set(), log: [], wins: [], runs: [],
    calls: { accounts: [] },
    loadCurrent: async (c) => s.current.get(c) || null,
    loadTraders: async (c) => [...s.traders.values()].filter((t) => t.cohort === c && t.status === 'active'),
    loadBaselines: async (c) => new Map([...s.baselines].filter(([k]) => k.startsWith(`${c}:`)).map(([k, v]) => [k.slice(c.length + 1), v])),
    loadEntries: async (c) => new Map([...s.entries].filter(([k]) => k.startsWith(`${c}:`)).map(([k, v]) => [k.slice(c.length + 1), v])),
    loadManual: async (c) => new Map([...s.manual.values()].filter((m) => m.cohort === c && m.enabled).map((m) => [m.wallet_id, m])),
    saveBaseline: async (c, e, d) => { s.baselines.set(`${c}:${e}`, { ...d, email: e }); },
    saveEntries: async (c, rows) => rows.forEach((r) => s.entries.set(`${c}:${r.email}`, r)),
    publish: async (c, d) => { s.current.set(c, d); },
    acquireLock: async (n) => (s.locks.has(n) ? false : (s.locks.add(n), true)),
    releaseLock: async (n) => { s.locks.delete(n); },
    logRun: async (e) => { s.runs.push(e); },
    loadRound: async (c, r) => s.rounds.get(`${c}:${r}`) || null,
    claimRound: async (c, r, admin, at) => {
      const cur = s.rounds.get(`${c}:${r}`);
      if (cur && ['finalizing', 'finalized'].includes(cur.status)) return false;
      s.rounds.set(`${c}:${r}`, { round: r, status: 'finalizing', started_by: admin, started_at: at });
      return true;
    },
    finishRound: async (c, r, f) => { Object.assign(s.rounds.get(`${c}:${r}`), f, { status: 'finalized' }); },
    failRound: async (c, r, error) => { Object.assign(s.rounds.get(`${c}:${r}`), { status: 'failed', error }); },
    markWinners: async (c, r, w, at) => { s.wins.push([r, w, at]); },
    patchCurrentCategories: async (c, patch) => {
      const cur = s.current.get(c);
      for (const [catId, board] of Object.entries(patch)) Object.assign(cur.categories[catId], board);
    },
    patchRoundWinners: async (c, r, winners, standings) => { Object.assign(s.rounds.get(`${c}:${r}`), { winners, standings, winners_corrected_at: 'now' }); },
    // admin repo surface
    getTrader: async (c, e) => s.traders.get(`${c}:${e}`) || null,
    getTraderByWallet: async (c, w) => [...s.traders.values()].find((t) => t.cohort === c && t.wallet_id === w) || null,
    insertTrader: async (c, row) => {
      if (s.traders.has(`${c}:${row.email}`)) return 'email';
      if ([...s.traders.values()].some((t) => t.cohort === c && t.wallet_id === row.wallet_id && t.status !== 'withdrawn')) return 'wallet';
      s.traders.set(`${c}:${row.email}`, { ...row });
      return true;
    },
    updateTrader: async (c, e, v, set) => { Object.assign(s.traders.get(`${c}:${e}`), set); return true; },
    listTraders: async (c, { status }) => { const rows = [...s.traders.values()].filter((t) => t.cohort === c && (!status || t.status === status)); return { rows, total: rows.length, counts: {} }; },
    getManual: async (c, w) => s.manual.get(`${c}:${w}`) || null,
    putManual: async (c, doc, expected) => {
      const cur = s.manual.get(doc._id);
      if ((cur ? cur.version : null) !== expected) return false;
      s.manual.set(doc._id, doc);
      return true;
    },
    getBaseline: async (c, e) => s.baselines.get(`${c}:${e}`) || null,
    getEntry: async (c, e) => s.entries.get(`${c}:${e}`) || null,
    audit: async (e) => { s.log.push(e); },
    listAudit: async (c, { target }) => s.log.filter((l) => l.cohort === c && (!target || l.target === target)),
  };
  return s;
}

const trader = (n, cohort = 'ses-2', o = {}) => ({ cohort, email: `t${n}@x.com`, wallet_id: String(n), client_id: n, name: `Trader ${n}`, status: 'active', ...o });
const acct = (n, o = {}) => ({ login: String(n), client_id: n, currency: 'USD', balance: 200, equity: 200, total_deposit: 200, total_withdrawal: 0, trades: 0, ...o });
const win = (id, openMs, closeMs) => ({ trade_ticket_id: id, instrument: 'XAUUSD', type: 'BUY', lots: 0.1, open_time: iso(openMs), close_time: iso(closeMs), open_price: 100, close_price: 101, swap: 0 });

/** Fake Elefin: every account has equity 200; accounts in `winners` have a +$10 closed trade after `since`. */
function fakeElefin(store, { winners = [], since = 0, clients = {} } = {}) {
  return {
    getTransactions: async () => ({ ok: true, rows: [] }),
    getAccount: async (login) => {
      store.calls.accounts.push(String(login));
      const w = winners.includes(String(login));
      return { ok: true, account: acct(Number(login), w ? { balance: 210, equity: 210, trades: 1 } : {}) };
    },
    getTrades: async (login) => ({ ok: true, rows: winners.includes(String(login)) ? [win(`W${login}`, since + 1000, since + 5000)] : [] }),
    lookupClient: async (email) => ({ ok: true, data: clients[email] || null }),
  };
}

const roundsFor = (store, el, nowMs, c = cfg) => createRounds({ store, elefin: el, cfg: c, now: () => nowMs });

async function weekOneReady() {
  const store = memStore([trader(1), trader(2)]);
  const entry = fakeElefin(store);
  await runSafely('t', { store, client: entry, cfg, nowMs: T0 + 1000, rounds: roundsFor(store, entry, T0 + 1000) });
  const trading = fakeElefin(store, { winners: ['1'], since: T0 + 2000 });
  await runSafely('t', { store, client: trading, cfg, nowMs: T0 + 20000, rounds: roundsFor(store, trading, T0 + 20000) });
  return store;
}

async function weekOneFinal() {
  const store = await weekOneReady();
  const el = fakeElefin(store, { winners: ['1'], since: T0 + 2000 });
  const rounds = roundsFor(store, el, T0 + 30000);
  await rounds.start('week1', 'elevana', { background: false });
  return { store, rounds };
}

function adminFor(store, rounds, nowMs = W2 - 1000, elefin = {}) {
  return createAdminService({ repo: store, elefin, cfg, trigger: () => {}, rounds, now: () => nowMs });
}
const ctx = { admin: 'elevana', ip: null };
const REASON = 'Week 2 challenge entry by organiser';

// ---------- config ----------
test('config: week-2 dates come from .env and are validated', () => {
  assert.equal(cfg.errors.length, 0);
  assert.equal(cfg.week2.startMs, Date.parse(ENV.WEEK2_START));
  assert.equal(cfg.week2.rewardMultiplier, 2);
  assert.equal(cfgNoW2.week2, null); // absent = week 2 stays locked, not an error
  assert.equal(cfgNoW2.errors.length, 0);
  assert.ok(buildConfig({ ...ENV, WEEK2_END: '' }).errors.some((e) => e.includes('WEEK2')));
  assert.ok(buildConfig({ ...ENV, WEEK2_START: ENV.WEEK2_END, WEEK2_END: ENV.WEEK2_START }).errors.some((e) => e.includes('before WEEK2_END')));
  assert.ok(buildConfig({ ...ENV, WEEK2_START: '2026-11-10T00:00:00+05:30' }).errors.some((e) => e.includes('COMPETITION_END')));
});

test('config: rewards are the organiser list, in INR', () => {
  const r = Object.fromEntries(cfg.scoring.categories.map((c) => [c.id, c.reward]));
  assert.deepEqual(r.bronze, { currency: 'INR', value: 25000, type: 'cash' });
  assert.deepEqual(r.silver, { currency: 'INR', value: 50000, type: 'cash' });
  assert.deepEqual(r.gold, { currency: 'INR', value: 100000, type: 'cash' });
  assert.deepEqual(r.platinum, { currency: 'INR', value: 150000, type: 'cash' });
});

// ---------- week 1 ----------
test('finalize week 1: runs a last pass, marks one winner per category, closes the board', async () => {
  const store = await weekOneReady();
  const el = fakeElefin(store, { winners: ['1'], since: T0 + 2000 });
  const rounds = roundsFor(store, el, T0 + 30000);

  assert.equal((await rounds.status()).week2.status, 'locked');
  await rounds.start('week1', 'elevana', { background: false });

  const doc = await rounds.state('week1');
  assert.equal(doc.status, 'finalized');
  assert.equal(doc.finalized_by, 'elevana');
  assert.equal(doc.winners.bronze.email, 't1@x.com');
  assert.equal(doc.winners.silver, null); // no eligible trader -> "no winner"
  assert.equal(store.current.get('ses-2').competition_over, true);
  assert.deepEqual(store.wins.map(([r, w]) => [r, w.bronze.email]), [['week1', 't1@x.com']]);
  assert.equal((await rounds.status()).week2.status, 'live');
});

test('after week 1 is finalized its traders are never updated again; finalizing twice is refused', async () => {
  const { store, rounds } = await weekOneFinal();
  const el = fakeElefin(store, { winners: ['1'], since: T0 + 2000 });
  store.calls.accounts.length = 0;
  const tick = await runSafely('cron', { store, client: el, cfg, nowMs: T0 + 90000, rounds });
  assert.equal(tick.skipped, 'competition_over');
  assert.deepEqual(store.calls.accounts, []); // no Elefin account calls for week-1 traders
  await assert.rejects(rounds.start('week1', 'elevana'), (e) => e.code === 'already_finalized');
});

test('a failed finalize leaves the round retryable and the board open', async () => {
  const store = await weekOneReady();
  const broken = { ...fakeElefin(store), getTransactions: async () => ({ ok: false, error: 'elefin down' }) };
  await roundsFor(store, broken, T0 + 30000).start('week1', 'elevana', { background: false });
  const doc = store.rounds.get('ses-2:week1');
  assert.equal(doc.status, 'failed');
  assert.match(doc.error, /ledger unavailable/);
  assert.equal(store.current.get('ses-2').competition_over, false);

  const ok = roundsFor(store, fakeElefin(store, { winners: ['1'], since: T0 + 2000 }), T0 + 31000);
  await ok.start('week1', 'elevana', { background: false });
  assert.equal((await ok.state('week1')).status, 'finalized');
});

// ---------- fix pnl mismatch ----------
function entryRow(email, o = {}) {
  return {
    email, name: email, client_id: null, wallet_id: email, is_host: false, category: 'bronze', captured_at: iso(T0),
    start_capital: 100, dep_w: 0, wdr_w: 0, net_capital: 100, pnl: 0, return_pct: 0, closed_trades: 0,
    reconcile_diff: 0, unpriceable: [], eligible: true, winner_eligible: false, reasons: [], flags: [], manual: null,
    ...o,
  };
}

/** a: mismatched but tradeable (5 closed trades) -- the fix should flip it to prize-eligible and on top.
 *  b: mismatched but only 1 closed trade -- too thin a sample, the fix must leave it alone.
 *  c: already clean and winning, pre-fix. */
function seedPnlFixBoard(store) {
  const a = entryRow('a@x.com', { pnl: 10, return_pct: 10, closed_trades: 5, reconcile_diff: 15, flags: ['pnl_mismatch'] });
  const b = entryRow('b@x.com', { pnl: 5, return_pct: 5, closed_trades: 1, reconcile_diff: 50, flags: ['pnl_mismatch'] });
  const c = entryRow('c@x.com', { pnl: 20, return_pct: 20, closed_trades: 5, winner_eligible: true });
  for (const r of [a, b, c]) store.entries.set(`ses-2:${r.email}`, { ...r, _id: `ses-2:${r.email}`, cohort: 'ses-2', checked_at: 'x' });
  store.current.set('ses-2', {
    cohort: 'ses-2',
    categories: { bronze: { entries: [{ ...c, rank: 1 }, { ...a, rank: 2 }, { ...b, rank: 3 }], entered: [], stats: { ranked: 3, entered: 0, flagged: 2 } } },
  });
  return { a, b, c };
}

test('fixPnlMismatch: trusts pnl + reconcile_diff for rows with >=2 closed trades, re-ranks the category, leaves thin samples alone', async () => {
  const store = memStore([]);
  seedPnlFixBoard(store);
  const res = await roundsFor(store, {}, T0 + 60000).fixPnlMismatch();

  assert.equal(res.fixed, 1); // b@x.com has only 1 closed trade -- not touched
  assert.equal(res.changes[0].email, 'a@x.com');
  assert.equal(res.changes[0].pnl.from, 10);
  assert.equal(res.changes[0].pnl.to, 25);
  assert.equal(res.changes[0].winner_eligible.from, false);
  assert.equal(res.changes[0].winner_eligible.to, true);
  assert.equal(res.finalized, false);
  assert.equal(res.winners, null);

  const fixedA = store.entries.get('ses-2:a@x.com');
  assert.equal(fixedA.pnl, 25);
  assert.equal(fixedA.return_pct, 25);
  assert.deepEqual(fixedA.flags, []);
  assert.deepEqual(store.entries.get('ses-2:b@x.com').flags, ['pnl_mismatch']); // untouched

  const board = store.current.get('ses-2').categories.bronze;
  assert.deepEqual(board.entries.map((e) => e.email), ['a@x.com', 'c@x.com', 'b@x.com']); // a now outranks c
  assert.equal(board.stats.flagged, 1); // only b still carries a flag
});

test('fixPnlMismatch: also corrects an already-finalized round\'s winners/standings without reopening it', async () => {
  const store = memStore([]);
  const { a, c } = seedPnlFixBoard(store);
  store.rounds.set('ses-2:week1', {
    round: 'week1', status: 'finalized', finalized_by: 'elevana',
    winners: { bronze: { email: c.email, name: c.name, return_pct: c.return_pct, pnl: c.pnl } },
    standings: { bronze: [c, a].map((e) => ({ email: e.email, return_pct: e.return_pct, pnl: e.pnl })) },
  });

  const res = await roundsFor(store, {}, T0 + 60000).fixPnlMismatch();
  assert.equal(res.finalized, true);
  assert.equal(res.winners.bronze.email, 'a@x.com');
  assert.equal(res.winners.bronze.return_pct, 25);

  const round = store.rounds.get('ses-2:week1');
  assert.equal(round.status, 'finalized'); // never reopened
  assert.equal(round.winners.bronze.email, 'a@x.com');
  assert.equal(round.standings.bronze[0].email, 'a@x.com');
});

test('fixPnlMismatch: no-op when nothing is flagged', async () => {
  const store = memStore([]);
  const res = await roundsFor(store, {}, T0 + 60000).fixPnlMismatch();
  assert.deepEqual(res, { fixed: 0, changes: [], winners: null, finalized: false });
});

test('finalizeRound (admin service): needs confirmation and a reason, then audits', async () => {
  const store = await weekOneReady();
  const rounds = roundsFor(store, fakeElefin(store, { winners: ['1'], since: T0 + 2000 }), T0 + 30000);
  const admin = adminFor(store, rounds);

  await assert.rejects(admin.finalizeRound(ctx, 'week1', { reason: REASON }), (e) => e.code === 'confirm_required');
  await assert.rejects(admin.finalizeRound(ctx, 'week1', { confirm: true, reason: 'no' }), (e) => e.code === 'reason_required');
  assert.equal(store.log.length, 0);

  assert.equal((await admin.finalizeRound(ctx, 'week1', { confirm: true, reason: REASON })).started, true);
  await new Promise((r) => setTimeout(r, 30)); // background job
  assert.equal((await rounds.state('week1')).status, 'finalized');
  assert.equal(store.log.filter((l) => l.action === 'round.finalize').length, 1);
  await assert.rejects(admin.finalizeRound(ctx, 'week1', { confirm: true, reason: REASON }), (e) => e.status === 409 && e.code === 'already_finalized');
  await assert.rejects(admin.finalizeRound(ctx, 'week9', { confirm: true, reason: REASON }), (e) => e.status === 404);
});

// ---------- week 2: Beat YG Sir ----------
test('week 2 stays locked: until week 1 is finalized, and while its dates are not set', async () => {
  const store = await weekOneReady();
  const rounds = roundsFor(store, fakeElefin(store), T0 + 30000);
  assert.equal((await rounds.status()).week2.reason, 'week1_not_finalized');
  assert.equal(await rounds.scoreCfg('week2'), null);
  await assert.rejects(rounds.start('week2', 'elevana'), (e) => e.code === 'week1_not_finalized');
  await assert.rejects(adminFor(store, rounds).addWeek2Entrant(ctx, { email: 't1@x.com', reason: REASON }), (e) => e.code === 'week2_locked');

  await rounds.start('week1', 'elevana', { background: false });
  assert.equal((await rounds.status()).week2.status, 'live');
  const noDates = roundsFor(store, fakeElefin(store), T0 + 30000, cfgNoW2);
  assert.equal((await noDates.status()).week2.reason, 'dates_not_set');
  await assert.rejects(noDates.start('week2', 'elevana'), (e) => e.code === 'dates_not_set');
  await assert.rejects(rounds.start('week3', 'elevana'), (e) => e.status === 404);
});

test('week 2 entrants: only week-1 category winners, plus exactly one YG Sir; all by admin', async () => {
  const { store, rounds } = await weekOneFinal();
  const admin = adminFor(store, rounds);

  await assert.rejects(admin.addWeek2Entrant(ctx, { email: 't2@x.com', reason: REASON }), (e) => e.code === 'not_a_winner');
  await assert.rejects(admin.addWeek2Entrant(ctx, { email: 't1@x.com', reason: 'short' }), (e) => e.code === 'reason_required');
  const row = await admin.addWeek2Entrant(ctx, { email: 'T1@x.com', reason: REASON });
  assert.equal(row.cohort, 'ses-2-w2');
  assert.equal(row.week1_winner_of, 'bronze');
  assert.equal(row.added_by, 'elevana');
  await assert.rejects(admin.addWeek2Entrant(ctx, { email: 't1@x.com', reason: REASON }), (e) => e.code === 'already_entered');

  // finalizing needs YG Sir on the board
  await assert.rejects(rounds.start('week2', 'elevana'), (e) => e.code === 'host_missing');

  const manual = await admin.setWeek2Host(ctx, { mode: 'manual', reason: REASON });
  assert.equal(manual.is_host, true);
  assert.equal(manual.wallet_id, 'YGSIR');
  const replaced = await admin.setWeek2Host(ctx, { mode: 'manual', name: 'YG Sir', reason: REASON });
  assert.equal(replaced.is_host, true);
  assert.equal([...store.traders.values()].filter((t) => t.cohort === 'ses-2-w2' && t.is_host && t.status === 'active').length, 1);
});

test('YG Sir from Elefin: the account id must belong to that email', async () => {
  const { store, rounds } = await weekOneFinal();
  const clients = { 'yg@x.com': { client_id: 77, country: 'India', accounts: { logins: ['555555555'], items: [] } } };
  const admin = adminFor(store, rounds, W2 - 1000, fakeElefin(store, { clients }));
  await assert.rejects(admin.setWeek2Host(ctx, { mode: 'elefin', email: 'yg@x.com', wallet_id: '999999999', reason: REASON }), (e) => e.code === 'wallet_not_on_client');
  await assert.rejects(admin.setWeek2Host(ctx, { mode: 'elefin', email: 'nobody@x.com', wallet_id: '555555555', reason: REASON }), (e) => e.code === 'wallet_not_on_client');
  await assert.rejects(admin.setWeek2Host(ctx, { mode: 'elefin', email: 'bad', wallet_id: '555555555', reason: REASON }), (e) => e.code === 'invalid_field');
  const host = await admin.setWeek2Host(ctx, { mode: 'elefin', email: 'yg@x.com', wallet_id: '555555555', reason: REASON });
  assert.equal(host.account_source, 'elefin');
  assert.equal(host.client_id, 77);
});

const FULL = (pnl, capital = 200) => ({ start_capital: capital, balance_start: capital, captured_at: iso(W2 + 3600000), dep_w: 0, wdr_w: 0, closed_pnl: pnl, closed_trades: 3 });

test('week 2 end to end: manual YG Sir vs a winner; reward doubled; everything frozen after finalize', async () => {
  const { store, rounds } = await weekOneFinal();
  const admin = adminFor(store, rounds);
  await admin.addWeek2Entrant(ctx, { email: 't1@x.com', reason: REASON });
  await admin.setWeek2Host(ctx, { mode: 'manual', reason: REASON });

  // Before any manual numbers exist, YG Sir is just "awaiting" and Elefin is never asked about him.
  const trading = fakeElefin(store, { winners: ['1'], since: W2 + 2000 });
  store.calls.accounts.length = 0;
  await runSafely('cron', { store, client: fakeElefin(store), cfg, nowMs: W2 + 1000, rounds });
  assert.deepEqual(store.calls.accounts, ['1']); // t2 is not an entrant, YGSIR has no data yet
  assert.deepEqual(store.entries.get('ses-2-w2:yg-sir@host.internal').reasons, ['awaiting_manual_data']);

  // Admin enters YG Sir's data (a full manual entry) and previews it.
  const pv = await admin.preview('YGSIR', { mode: 'full', fields: FULL(4) }, 'week2');
  assert.equal(pv.return_pct, 2);
  await admin.setManual(ctx, 'YGSIR', { mode: 'full', fields: FULL(4), source: 'organiser', reason: REASON }, 'week2');

  await runSafely('cron', { store, client: trading, cfg, nowMs: W2 + 20000, rounds });
  const board = store.current.get('ses-2-w2').categories.challenge.entries;
  assert.deepEqual(board.map((e) => [e.rank, e.is_host]), [[1, false], [2, true]]); // t1 5% vs YG Sir 2%

  const r2 = roundsFor(store, trading, W2 + 30000);
  await r2.start('week2', 'elevana', { background: false });
  const d2 = await r2.state('week2');
  assert.equal(d2.status, 'finalized');
  assert.equal(d2.challenge.host_won, false);
  assert.equal(d2.challenge.winner.email, 't1@x.com');
  assert.equal(d2.challenge.winner.category, 'bronze');
  assert.equal(d2.challenge.winner.stay_with_yg, true);
  assert.deepEqual(d2.challenge.winner.base_reward, { currency: 'INR', value: 25000, type: 'cash' });
  assert.deepEqual(d2.challenge.winner.final_reward, { currency: 'INR', value: 50000, type: 'cash' }); // doubled
  assert.equal(d2.challenge.standings.length, 2);
  assert.equal(store.current.get('ses-2-w2').competition_over, true);

  // frozen: no more scoring, no more entrants, no more manual edits
  store.calls.accounts.length = 0;
  await runSafely('cron', { store, client: trading, cfg, nowMs: W2 + 99000, rounds: r2 });
  assert.deepEqual(store.calls.accounts, []);
  const late = adminFor(store, r2, W2 + 100000);
  await assert.rejects(late.setWeek2Host(ctx, { mode: 'manual', reason: REASON }), (e) => e.code === 'week2_closed');
  await assert.rejects(late.setManual(ctx, 'YGSIR', { mode: 'full', fields: FULL(9), source: 'organiser', reason: REASON, version: 1 }, 'week2'), (e) => e.code === 'week2_closed');
});

test('week 2: if YG Sir finishes #1 the winners keep their normal reward (no doubling, no week with him)', async () => {
  const { store, rounds } = await weekOneFinal();
  const admin = adminFor(store, rounds);
  await admin.addWeek2Entrant(ctx, { email: 't1@x.com', reason: REASON });
  await admin.setWeek2Host(ctx, { mode: 'manual', reason: REASON });
  await admin.setManual(ctx, 'YGSIR', { mode: 'full', fields: FULL(30), source: 'organiser', reason: REASON }, 'week2'); // 15%

  const trading = fakeElefin(store, { winners: ['1'], since: W2 + 2000 }); // t1 makes 5%
  await runSafely('cron', { store, client: fakeElefin(store), cfg, nowMs: W2 + 1000, rounds });
  await runSafely('cron', { store, client: trading, cfg, nowMs: W2 + 20000, rounds });
  await roundsFor(store, trading, W2 + 30000).start('week2', 'elevana', { background: false });

  const d2 = await rounds.state('week2');
  assert.equal(d2.challenge.host_won, true);
  assert.equal(d2.challenge.winner, null);
  assert.deepEqual(store.wins.filter(([r]) => r === 'week2').map(([, w]) => w.challenge), [null]); // nobody marked
});

test('challengeResult: reward doubling, host ties, no eligible entrant', () => {
  const entries = (list) => list.map((e, i) => ({ rank: i + 1, winner_eligible: true, flags: [], return_pct: 1, pnl: 1, start_capital: 100, net_capital: 100, ...e }));
  const entrants = new Map([['gold@x.com', { week1_winner_of: 'gold' }]]);
  const c = { ...cfg, scoring: { ...cfg.scoring, categories_week1: cfg.scoring.categories } };

  const won = challengeResult(entries([{ email: 'gold@x.com' }, { email: 'yg', is_host: true }]), entrants, c);
  assert.deepEqual(won.winner.final_reward, { currency: 'INR', value: 200000, type: 'cash' });
  assert.deepEqual(won.winner.base_reward, { currency: 'INR', value: 100000, type: 'cash' });

  assert.equal(challengeResult(entries([{ email: 'yg', is_host: true }, { email: 'gold@x.com' }]), entrants, c).host_won, true);
  assert.equal(challengeResult([], entrants, c).reason, 'no_eligible_entrant');
  // a flagged leader is skipped; YG Sir is then the first eligible
  const flagged = challengeResult(entries([{ email: 'gold@x.com', winner_eligible: false }, { email: 'yg', is_host: true }]), entrants, c);
  assert.equal(flagged.host_won, true);
});

test('ranking: a full tie with YG Sir ranks him first; a lower P/L at equal % ranks below him', () => {
  const row = (email, o) => ({ email, category: 'challenge', eligible: true, winner_eligible: true, return_pct: 5, pnl: 10, closed_trades: 1, captured_at: iso(W2), ...o });
  const cats = [{ id: 'challenge' }];
  const tie = rankByCategory([row('a@x.com'), row('yg', { is_host: true })], cats).challenge.entries;
  assert.equal(tie[0].email, 'yg');
  const lower = rankByCategory([row('a@x.com', { pnl: 5 }), row('yg', { is_host: true })], cats).challenge.entries;
  assert.equal(lower[0].email, 'yg');
  const higher = rankByCategory([row('a@x.com', { pnl: 15 }), row('yg', { is_host: true })], cats).challenge.entries;
  assert.equal(higher[0].email, 'a@x.com');
});

// ---------- public API ----------
test('public API: winners appear only after finalize, names masked; week 2 locked until then', async () => {
  const store = await weekOneReady();
  const el = fakeElefin(store, { winners: ['1'], since: T0 + 2000 });
  const rounds = roundsFor(store, el, T0 + 30000);
  const app = createApp({ store, trigger: async () => {}, cfg, rounds });
  const server = await new Promise((r) => { const sv = app.listen(0, () => r(sv)); });
  const get = async (q) => (await fetch(`http://127.0.0.1:${server.address().port}/api/leaderboard${q}`)).json();
  try {
    const before = await get('');
    assert.equal(before.winners, null);
    assert.notEqual(before.phase, 'finalized');
    assert.equal((await get('?round=week2')).phase, 'locked');

    await rounds.start('week1', 'elevana', { background: false });
    const after = await get('');
    assert.equal(after.phase, 'finalized');
    assert.equal(after.winners.categories.bronze.name, 'Trader 1.'); // masked like the board
    assert.equal(after.winners.categories.silver, null);
    assert.ok(!JSON.stringify(after).includes('t1@x.com'));
    // category rewards are served to the UI as data (INR)
    assert.deepEqual(after.categories.find((c) => c.id === 'bronze').reward, { currency: 'INR', value: 25000, type: 'cash' });

    const w2 = await get('?round=week2');
    assert.equal(w2.status, 'pending'); // week 2 is open now, but has no board until entrants are scored
    assert.notEqual(w2.phase, 'locked');
  } finally { server.close(); }
});

test('public API: week-2 result is hidden until finalize, then shows the doubled reward and YG Sir by name', async () => {
  const { store, rounds } = await weekOneFinal();
  const admin = adminFor(store, rounds);
  await admin.addWeek2Entrant(ctx, { email: 't1@x.com', reason: REASON });
  await admin.setWeek2Host(ctx, { mode: 'manual', name: 'YG Sir', reason: REASON });
  await admin.setManual(ctx, 'YGSIR', { mode: 'full', fields: FULL(4), source: 'organiser', reason: REASON }, 'week2');
  const trading = fakeElefin(store, { winners: ['1'], since: W2 + 2000 });
  await runSafely('cron', { store, client: fakeElefin(store), cfg, nowMs: W2 + 1000, rounds });
  await runSafely('cron', { store, client: trading, cfg, nowMs: W2 + 20000, rounds });

  const app = createApp({ store, trigger: async () => {}, cfg, rounds });
  const server = await new Promise((r) => { const sv = app.listen(0, () => r(sv)); });
  const get = async () => (await fetch(`http://127.0.0.1:${server.address().port}/api/leaderboard?round=week2`)).json();
  try {
    const live = await get();
    assert.equal(live.winners, null);
    assert.equal(live.boards.challenge.entries.find((e) => e.is_host).name, 'YG Sir');
    assert.ok(!JSON.stringify(live).includes('t1@x.com') && !JSON.stringify(live).includes('host.internal'));

    await roundsFor(store, trading, W2 + 30000).start('week2', 'elevana', { background: false });
    const done = await get();
    assert.equal(done.phase, 'finalized');
    assert.equal(done.winners.challenge.host_won, false);
    assert.equal(done.winners.challenge.winner.name, 'Trader 1.');
    assert.deepEqual(done.winners.challenge.winner.final_reward, { currency: 'INR', value: 50000, type: 'cash' });
    assert.equal(done.winners.challenge.winner.stay_with_yg, true);
    assert.deepEqual(done.winners.challenge.standings.map((e) => e.name), ['Trader 1.', 'YG Sir']);
  } finally { server.close(); }
});
