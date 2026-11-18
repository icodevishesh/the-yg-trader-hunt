'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildConfig } = require('../src/config');
const auth = require('../src/admin/auth');
const { createAdminService } = require('../src/admin/service');
const { createAdminRouter, adminEnabled } = require('../src/admin/routes');
const { createApp } = require('../src/api/app');
const { runScoring } = require('../src/jobs/score');

const ENV = {
  COMPETITION_START: '2026-11-09T09:00:00+05:30',
  COMPETITION_END: '2026-11-14T23:59:59+05:30',
  WINNER_ANNOUNCE: '2026-11-15T12:00:00+05:30',
};
const cfg = buildConfig(ENV);
const comp = cfg.competition;
const T0 = comp.startMs;
const iso = (ms) => new Date(ms).toISOString();
const REASON = 'Statement checked against MT5 report';

// ---------- in-memory repo ----------
function memRepo() {
  const r = {
    traders: new Map(), manual: new Map(), log: [], baselines: new Map(), entries: new Map(), current: null,
    loadCurrent: async () => r.current,
    getTrader: async (c, email) => r.traders.get(email) || null,
    getTraderByWallet: async (c, w) => [...r.traders.values()].find((t) => t.wallet_id === w) || null,
    listTraders: async () => ({ rows: [...r.traders.values()], total: r.traders.size, counts: {} }),
    insertTrader: async (c, row) => {
      if (r.traders.has(row.email)) return 'email';
      if ([...r.traders.values()].some((t) => t.wallet_id === row.wallet_id)) return 'wallet';
      r.traders.set(row.email, { ...row });
      return true;
    },
    updateTrader: async (c, email, expected, set) => {
      const t = r.traders.get(email);
      if ((t.version || 1) !== expected) return false;
      if (set.wallet_id && [...r.traders.values()].some((x) => x !== t && x.wallet_id === set.wallet_id)) return 'wallet';
      Object.assign(t, set);
      return true;
    },
    setTraderCheck: async (c, email, check) => { r.traders.get(email).elefin_check = check; },
    getBaseline: async (c, email) => r.baselines.get(email) || null,
    forceSaveBaseline: async (c, email, doc) => { r.baselines.set(email, { ...doc, cohort: c, email }); },
    getEntry: async (c, email) => r.entries.get(email) || null,
    getManual: async (c, w) => r.manual.get(w) || null,
    putManual: async (c, doc, expected) => {
      const cur = r.manual.get(doc.wallet_id);
      if ((cur ? cur.version : null) !== expected) return false;
      r.manual.set(doc.wallet_id, doc);
      return true;
    },
    audit: async (e) => { r.log.push(e); },
    listAudit: async (c, { target }) => r.log.filter((a) => !target || a.target === target),
  };
  return r;
}

function setup({ nowMs = T0 + 1000, elefin = {}, configOverride = cfg } = {}) {
  const repo = memRepo();
  const triggered = [];
  let t = nowMs;
  const service = createAdminService({ repo, elefin, cfg: configOverride, trigger: (x) => triggered.push(x), now: () => t });
  return { repo, service, triggered, ctx: { admin: 'vipin', ip: '1.2.3.4' }, setNow: (v) => { t = v; } };
}

const NEW = { email: 'Amrit@X.com', wallet_id: '12345992151', name: 'Amrit Singh', reason: REASON };

// ---------- service: validation, locks, audit ----------
test('addTrader: validates, normalises, audits exactly once, rejects duplicates', async () => {
  const { service, repo, ctx } = setup();
  const t = await service.addTrader(ctx, NEW);
  assert.equal(t.email, 'amrit@x.com');
  assert.equal(t.status, 'pending');
  assert.equal(repo.log.length, 1);
  assert.equal(repo.log[0].action, 'trader.create');
  assert.equal(repo.log[0].admin, 'vipin');

  const rejects = (input, code) => assert.rejects(service.addTrader(ctx, input), (e) => e.code === code);
  await rejects({ ...NEW, email: 'other@x.com' }, 'duplicate_wallet');
  await rejects({ ...NEW, wallet_id: '999999999' }, 'duplicate_email');
  await rejects({ ...NEW, email: 'n@x.com', wallet_id: '12ab' }, 'invalid_field');
  await rejects({ ...NEW, email: 'n@x.com', wallet_id: '123456789', reason: 'short' }, 'reason_required');
  await rejects({ ...NEW, email: 'n@x.com', wallet_id: '123456789', hack: 1 }, 'unknown_field');
  await rejects({ ...NEW, email: 'bad', wallet_id: '123456789' }, 'invalid_field');
  assert.equal(repo.log.length, 1); // failed writes leave no audit row
});

test('addTrader: manual mode takes the admin\'s own id and skips the Elefin check to activate', async () => {
  const s = setup();
  await assert.rejects(s.service.addTrader(s.ctx, { email: 'manual@x.com', manual: true, reason: REASON }), (e) => e.code === 'invalid_field' && e.field === 'wallet_id');

  const t = await s.service.addTrader(s.ctx, { email: 'manual@x.com', wallet_id: 'yg-sir-note-42', name: 'No Elefin Guy', manual: true, reason: REASON });
  assert.equal(t.account_source, 'manual');
  assert.equal(t.wallet_id, 'yg-sir-note-42');

  // Elefin check is meaningless for a trader with no Elefin account.
  await assert.rejects(s.service.checkTrader(s.ctx, 'manual@x.com'), (e) => e.code === 'not_applicable');

  // Activating does not need override_check, unlike an Elefin-sourced trader.
  const active = await s.service.setStatus(s.ctx, 'manual@x.com', { to: 'active', version: 1, reason: REASON });
  assert.equal(active.status, 'active');
});

test('locks: no new traders after the cutoff; nothing writable after finalize', async () => {
  const late = setup({ nowMs: comp.cutoffMs + 1 });
  await assert.rejects(late.service.addTrader(late.ctx, NEW), (e) => e.code === 'entry_closed' && e.status === 409);

  const fin = setup();
  await fin.service.addTrader(fin.ctx, NEW);
  fin.repo.current = { competition_over: true };
  await assert.rejects(fin.service.addTrader(fin.ctx, { ...NEW, email: 'b@x.com', wallet_id: '123456789' }), (e) => e.code === 'competition_finalized');
  await assert.rejects(fin.service.setStatus(fin.ctx, 'amrit@x.com', { to: 'withdrawn', version: 1, reason: REASON }), (e) => e.code === 'competition_finalized');
  await assert.rejects(fin.service.setManual(fin.ctx, NEW.wallet_id, { mode: 'fields', fields: { closed_pnl: 1 }, source: 'organiser', reason: REASON }), (e) => e.code === 'competition_finalized');
});

test('updateTrader/setStatus: optimistic version, activation needs an Elefin check, withdrawn allowed after cutoff', async () => {
  const s = setup();
  await s.service.addTrader(s.ctx, NEW);
  await assert.rejects(s.service.updateTrader(s.ctx, 'amrit@x.com', { version: 7, name: 'X', reason: REASON }), (e) => e.code === 'stale');
  const u = await s.service.updateTrader(s.ctx, 'amrit@x.com', { version: 1, name: 'Amritpal', reason: REASON });
  assert.equal(u.version, 2);
  await assert.rejects(s.service.updateTrader(s.ctx, 'amrit@x.com', { version: 1, name: 'again', reason: REASON }), (e) => e.code === 'stale');

  await assert.rejects(s.service.setStatus(s.ctx, 'amrit@x.com', { to: 'active', version: 2, reason: REASON }), (e) => e.code === 'check_required');
  const ok = await s.service.setStatus(s.ctx, 'amrit@x.com', { to: 'active', version: 2, reason: REASON, override_check: true });
  assert.equal(ok.status, 'active');

  s.setNow(comp.cutoffMs + 5000);
  const w = await s.service.setStatus(s.ctx, 'amrit@x.com', { to: 'withdrawn', version: 3, reason: REASON });
  assert.equal(w.status, 'withdrawn');
});

test('updateTrader: wallet cannot change once the baseline is frozen', async () => {
  const s = setup();
  await s.service.addTrader(s.ctx, NEW);
  s.repo.baselines.set('amrit@x.com', { status: 'frozen' });
  await assert.rejects(s.service.updateTrader(s.ctx, 'amrit@x.com', { version: 1, wallet_id: '999999999', reason: REASON }), (e) => e.code === 'baseline_frozen');
});

test('checkTrader: owner match, mismatch, unknown client, and the 10 s rate limit', async () => {
  let reply = { ok: true, data: { client_id: 1, accounts: { logins: ['12345992151'], items: [{ login: '12345992151', equity: 150 }] } } };
  const s = setup({ elefin: { lookupClient: async () => reply } });
  await s.service.addTrader(s.ctx, { ...NEW, client_id: 1 });
  const c1 = await s.service.checkTrader(s.ctx, 'amrit@x.com');
  assert.equal(c1.owner_match, true);
  assert.equal(c1.equity, 150);
  await assert.rejects(s.service.checkTrader(s.ctx, 'amrit@x.com'), (e) => e.status === 429);

  s.setNow(T0 + 20000);
  reply = { ok: true, data: { client_id: 1, accounts: { logins: ['555555555'], items: [] } } };
  assert.equal((await s.service.checkTrader(s.ctx, 'amrit@x.com')).owner_match, false);
  s.setNow(T0 + 40000);
  reply = { ok: true, data: null };
  assert.equal((await s.service.checkTrader(s.ctx, 'amrit@x.com')).ok, false);
  assert.equal(s.repo.log.filter((a) => a.action === 'elefin.check').length, 3);
});

// ---------- manual data ----------
const FULL = { start_capital: 100, balance_start: 100, captured_at: iso(T0 + 3600000), dep_w: 0, wdr_w: 0, closed_pnl: 25, closed_trades: 4 };

test('setManual: validation of every field, version handling, disable', async () => {
  const s = setup();
  await s.service.addTrader(s.ctx, NEW);
  const set = (input) => s.service.setManual(s.ctx, NEW.wallet_id, { source: 'mt5_statement', reason: REASON, ...input });
  const rej = (input, code) => assert.rejects(set(input), (e) => e.code === code);

  await rej({ mode: 'fields', fields: { closed_pnl: 1.234 } }, 'invalid_field'); // > 2 decimals
  await rej({ mode: 'fields', fields: { closed_trades: -1 } }, 'invalid_field');
  await rej({ mode: 'fields', fields: { dep_w: -5 } }, 'invalid_field');
  await rej({ mode: 'fields', fields: { captured_at: iso(comp.cutoffMs + 1000) } }, 'invalid_field');
  await rej({ mode: 'fields', fields: { category: 'diamond' } }, 'invalid_field'); // category can be pinned, but only to a real band
  await rej({ mode: 'fields', fields: {} }, 'field_required');
  await rej({ mode: 'full', fields: { closed_pnl: 5 } }, 'field_required');
  await rej({ mode: 'fields', fields: { closed_pnl: 5 }, source: 'rumour' }, 'invalid_field');
  await rej({ mode: 'fields', fields: { closed_pnl: 5 }, version: 3 }, 'stale');

  const d1 = await set({ mode: 'fields', fields: { closed_pnl: -1090.77 } });
  assert.equal(d1.version, 1);
  await rej({ mode: 'full', fields: FULL }, 'stale'); // replacing needs the current version
  const d2 = await set({ mode: 'full', fields: FULL, version: 1 });
  assert.equal(d2.version, 2);
  const off = await s.service.disableManual(s.ctx, NEW.wallet_id, { reason: REASON });
  assert.equal(off.enabled, false);
  assert.deepEqual(s.repo.log.map((a) => a.action), ['trader.create', 'manual.set', 'manual.set', 'manual.disable']);
});

test('setManual: start-line fields after the cutoff need an explicit re-baseline', async () => {
  const s = setup({ nowMs: comp.cutoffMs + 1000 });
  s.repo.traders.set('amrit@x.com', { email: 'amrit@x.com', wallet_id: NEW.wallet_id, version: 1 });
  const input = { mode: 'fields', fields: { balance_start: 90 }, source: 'organiser', reason: REASON };
  await assert.rejects(s.service.setManual(s.ctx, NEW.wallet_id, input), (e) => e.code === 'rebaseline_required');
  assert.ok(await s.service.setManual(s.ctx, NEW.wallet_id, { ...input, rebaseline: true }));
});

test('setManual: a manual trader can be added and fully baselined after the entry cutoff, no re-baseline flag needed', async () => {
  const s = setup({ nowMs: comp.cutoffMs + 1000 });
  const t = await s.service.addTrader(s.ctx, { email: 'manual2@x.com', wallet_id: 'manual-id-1', manual: true, reason: REASON });

  const fields = { ...FULL, captured_at: iso(comp.cutoffMs + 2000) }; // after cutoff, still inside the competition
  const d = await s.service.setManual(s.ctx, t.wallet_id, { mode: 'full', fields, source: 'organiser', reason: REASON });
  assert.equal(d.fields.captured_at, iso(comp.cutoffMs + 2000));

  // Still bounded by the actual competition end, just not the entry cutoff.
  await assert.rejects(
    s.service.setManual(s.ctx, t.wallet_id, { mode: 'fields', fields: { captured_at: iso(comp.endMs + 2000) }, source: 'organiser', reason: REASON, version: d.version }),
    (e) => e.code === 'invalid_field' && e.field === 'captured_at',
  );
});

test('preview: full mode is derived without writing; fields mode patches the last score', async () => {
  const s = setup({ elefin: { getAccount: async () => ({ ok: true, account: { login: '12345992151', balance: 125, equity: 125, total_deposit: 100, total_withdrawal: 0 } }) } });
  await s.service.addTrader(s.ctx, NEW);
  const before = s.repo.log.length;

  const full = await s.service.preview(NEW.wallet_id, { mode: 'full', fields: FULL });
  assert.equal(full.category, 'bronze');
  assert.equal(full.return_pct, 25);
  assert.ok(full.flags.includes('manual_full'));
  assert.equal(s.repo.manual.size, 0);
  assert.equal(s.repo.log.length, before);

  // A pinned category overrides the band derived from start capital.
  const pinned = await s.service.preview(NEW.wallet_id, { mode: 'full', fields: { ...FULL, category: 'gold' } });
  assert.equal(pinned.category, 'gold');

  await assert.rejects(s.service.preview(NEW.wallet_id, { mode: 'fields', fields: { closed_pnl: 5 } }), (e) => e.code === 'no_score_yet');

  s.repo.baselines.set('amrit@x.com', { status: 'frozen', wallet_id: NEW.wallet_id, captured_at: iso(T0), start_capital_usd: 100, balance_start: 100, total_deposit_start: 100, total_withdrawal_start: 0, category: 'bronze' });
  s.repo.entries.set('amrit@x.com', { dep_w: 0, wdr_w: 0, trade_cache: { summary: { pnl: 5, closedTrades: 1, unpriceable: [], openAtEntry: 0 } } });
  const patched = await s.service.preview(NEW.wallet_id, { mode: 'fields', fields: { closed_pnl: 25 } });
  assert.equal(patched.pnl, 25);
  assert.equal(patched.return_pct, 25);
  assert.equal(patched.flags.includes('pnl_mismatch'), false); // balance 125 = 100 + 25: the statement value reconciles
  const wrong = await s.service.preview(NEW.wallet_id, { mode: 'fields', fields: { closed_pnl: 60 } });
  assert.ok(wrong.flags.includes('pnl_mismatch')); // a wrong manual value is caught by reconciliation
});

// ---------- category pin ----------
test('setCategory: pins a valid band, unpins, versions, and rejects unknown bands', async () => {
  const s = setup();
  await s.service.addTrader(s.ctx, NEW);

  await assert.rejects(s.service.setCategory(s.ctx, 'amrit@x.com', { category: 'diamond', version: 1, reason: REASON }), (e) => e.code === 'invalid_field' && e.field === 'category');
  await assert.rejects(s.service.setCategory(s.ctx, 'amrit@x.com', { category: 'gold', version: 7, reason: REASON }), (e) => e.code === 'stale');
  await assert.rejects(s.service.setCategory(s.ctx, 'amrit@x.com', { category: 'gold', version: 1, reason: 'short' }), (e) => e.code === 'reason_required');

  const pinned = await s.service.setCategory(s.ctx, 'amrit@x.com', { category: 'gold', version: 1, reason: REASON });
  assert.equal(pinned.category_pin, 'gold');
  assert.equal(pinned.version, 2);
  assert.equal(s.repo.traders.get('amrit@x.com').category_pin, 'gold');

  const unpinned = await s.service.setCategory(s.ctx, 'amrit@x.com', { category: '', version: 2, reason: REASON });
  assert.equal(unpinned.category_pin, null);
  assert.deepEqual(s.repo.log.filter((a) => a.action === 'trader.category').length, 2);

  s.repo.current = { competition_over: true };
  await assert.rejects(s.service.setCategory(s.ctx, 'amrit@x.com', { category: 'gold', version: 3, reason: REASON }), (e) => e.code === 'competition_finalized');
});

// ---------- set baseline ----------
test('setBaseline: freezes a fresh Elefin snapshot, overwrites a frozen baseline, triggers a re-score', async () => {
  const account = { login: '12345992151', client_id: 1, currency: 'USD', equity: 640, balance: 620, total_deposit: 500, total_withdrawal: 0 };
  const s = setup({ elefin: { getAccount: async () => ({ ok: true, account }) } });
  await s.service.addTrader(s.ctx, { ...NEW, client_id: 1 });
  s.repo.baselines.set('amrit@x.com', { status: 'frozen', wallet_id: NEW.wallet_id, start_capital_usd: 100, category: 'bronze' });
  s.setNow(comp.cutoffMs + 100000); // re-baseline deliberately after the entry cutoff

  const r = await s.service.setBaseline(s.ctx, 'amrit@x.com', { version: 1, reason: REASON });
  assert.equal(r.rescore, true);
  assert.equal(r.baseline.status, 'frozen');
  assert.equal(r.baseline.admin_baseline, true);
  assert.equal(r.baseline.late_entry, false);
  assert.equal(r.baseline.start_capital_usd, 640);
  assert.equal(r.baseline.category, 'gold'); // derived from the fresh equity, not the old bronze
  assert.equal(r.baseline.captured_at, iso(comp.cutoffMs + 100000));
  assert.equal(s.repo.baselines.get('amrit@x.com').start_capital_usd, 640); // frozen baseline was overwritten
  assert.deepEqual(s.triggered, ['admin']);
  assert.equal(s.repo.log.at(-1).action, 'trader.baseline');
});

test('setBaseline: honours a pinned category, and refuses bad inputs', async () => {
  const account = { login: '12345992151', client_id: 1, currency: 'USD', equity: 640, balance: 620, total_deposit: 0, total_withdrawal: 0 };
  const s = setup({ elefin: { getAccount: async () => ({ ok: true, account }) } });
  await s.service.addTrader(s.ctx, { ...NEW, client_id: 1 });

  s.repo.traders.get('amrit@x.com').category_pin = 'platinum';
  const pinned = await s.service.setBaseline(s.ctx, 'amrit@x.com', { version: 1, reason: REASON });
  assert.equal(pinned.baseline.category, 'platinum'); // pin wins over the equity-derived band

  // manual trader has no Elefin account to baseline from
  await s.service.addTrader(s.ctx, { email: 'm@x.com', wallet_id: 'man-1', manual: true, reason: REASON });
  await assert.rejects(s.service.setBaseline(s.ctx, 'm@x.com', { version: 1, reason: REASON }), (e) => e.code === 'not_applicable');
});

test('setBaseline: surfaces Elefin failure, wrong owner, non-USD and sub-minimum equity', async () => {
  const addOne = async (svc, ctx) => svc.addTrader(ctx, { ...NEW, client_id: 1 });

  const down = setup({ elefin: { getAccount: async () => ({ ok: false, error: 'boom' }) } });
  await addOne(down.service, down.ctx);
  await assert.rejects(down.service.setBaseline(down.ctx, 'amrit@x.com', { version: 1, reason: REASON }), (e) => e.status === 502);

  const wrong = setup({ elefin: { getAccount: async () => ({ ok: true, account: { login: '99999', client_id: 1, currency: 'USD', equity: 640 } }) } });
  await addOne(wrong.service, wrong.ctx);
  await assert.rejects(wrong.service.setBaseline(wrong.ctx, 'amrit@x.com', { version: 1, reason: REASON }), (e) => e.code === 'wallet_not_on_client');

  const inr = setup({ elefin: { getAccount: async () => ({ ok: true, account: { login: '12345992151', client_id: 1, currency: 'INR', equity: 640 } }) } });
  await addOne(inr.service, inr.ctx);
  await assert.rejects(inr.service.setBaseline(inr.ctx, 'amrit@x.com', { version: 1, reason: REASON }), (e) => e.code === 'unsupported_currency');

  const low = setup({ elefin: { getAccount: async () => ({ ok: true, account: { login: '12345992151', client_id: 1, currency: 'USD', equity: 10 } }) } });
  await addOne(low.service, low.ctx);
  await assert.rejects(low.service.setBaseline(low.ctx, 'amrit@x.com', { version: 1, reason: REASON }), (e) => e.code === 'below_min_capital');
});

test('rescore triggers the locked run and is audited', async () => {
  const s = setup();
  await s.service.rescore(s.ctx);
  assert.deepEqual(s.triggered, ['admin']);
  assert.equal(s.repo.log[0].action, 'rescore');
});

test('fixPnlMismatch: validates the reason before delegating, then audits per-trader plus a summary row', async () => {
  const repo = memRepo();
  const calls = [];
  const stubRounds = {
    fixPnlMismatch: async () => {
      calls.push('called');
      return {
        fixed: 1, finalized: true, winners: { bronze: { email: 'a@x.com' } },
        changes: [{ email: 'a@x.com', category: 'bronze', pnl: { from: 10, to: 25 }, return_pct: { from: 10, to: 25 }, winner_eligible: { from: false, to: true } }],
      };
    },
  };
  const service = createAdminService({ repo, elefin: {}, cfg, trigger: () => {}, rounds: stubRounds, now: () => T0 + 1000 });
  const ctx = { admin: 'vipin', ip: '1.2.3.4' };

  await assert.rejects(service.fixPnlMismatch(ctx, { reason: 'short' }), (e) => e.code === 'reason_required');
  assert.equal(calls.length, 0); // rejected before it ever reached rounds

  const res = await service.fixPnlMismatch(ctx, { reason: REASON });
  assert.equal(res.fixed, 1);
  assert.equal(calls.length, 1);
  assert.equal(repo.log.filter((l) => l.action === 'pnl_fix.apply').length, 1);
  assert.equal(repo.log.find((l) => l.action === 'pnl_fix.apply').target, 'a@x.com');
  const summary = repo.log.find((l) => l.action === 'pnl_fix.run');
  assert.equal(summary.after.count, 1);
  assert.equal(summary.after.finalized, true);
});

test('fixPnlMismatch: fails cleanly when rounds is not configured', async () => {
  const { service, ctx } = setup(); // setup() never wires a rounds module
  await assert.rejects(service.fixPnlMismatch(ctx, { reason: REASON }), (e) => e.code === 'rounds_unavailable');
});

// ---------- scorer precedence ----------
function scoringStore({ traders, manual }) {
  const s = { published: null, entries: new Map(), baselines: new Map(),
    loadCurrent: async () => null, loadTraders: async () => traders, loadBaselines: async () => s.baselines, loadEntries: async () => s.entries,
    loadManual: async () => new Map(manual.map((m) => [m.wallet_id, m])),
    saveBaseline: async (c, e, d) => { s.baselines.set(e, d); }, saveEntries: async (c, rows) => rows.forEach((r) => s.entries.set(r.email, r)),
    publish: async (c, d) => { s.published = d; } };
  return s;
}
const acct = (o) => ({ login: '1', client_id: 1, currency: 'USD', balance: 200, equity: 200, total_deposit: 200, total_withdrawal: 0, trades: 0, ...o });
const tr = { email: 't@x.com', wallet_id: '1', client_id: 1, name: 'T One', status: 'active' };

test('scorer: "full" makes zero Elefin account/trade calls and derives the category', async () => {
  const calls = [];
  const elefin = { getTransactions: async () => ({ ok: true, rows: [] }), getAccount: async () => { calls.push('a'); }, getTrades: async () => { calls.push('t'); } };
  const store = scoringStore({ traders: [tr], manual: [{ wallet_id: '1', enabled: true, mode: 'full', fields: { ...FULL, start_capital: 600 }, source: 'mt5_statement', entered_by: 'vipin' }] });
  await runScoring({ store, elefin, cfg, nowMs: T0 + 10000 });
  assert.deepEqual(calls, []);
  const e = store.published.categories.gold.entries[0]; // 600 -> gold, never typed in
  assert.equal(e.return_pct, (25 / 600) * 100);
  assert.ok(e.flags.includes('manual_full'));
  assert.equal(e.winner_eligible, true);
});

test('scorer: "fields" overrides only the listed fields, "disabled" falls back to Elefin', async () => {
  const win = { trade_ticket_id: 'W', instrument: 'XAUUSD', type: 'BUY', lots: 0.1, open_time: iso(T0 + 5000), close_time: iso(T0 + 9000), open_price: 100, close_price: 101, swap: 0 };
  const run = async (manual) => {
    const store = scoringStore({ traders: [tr], manual });
    const first = { getTransactions: async () => ({ ok: true, rows: [] }), getAccount: async () => ({ ok: true, account: acct({}) }), getTrades: async () => ({ ok: true, rows: [] }) };
    await runScoring({ store, elefin: first, cfg, nowMs: T0 + 1000 });
    const second = { ...first, getAccount: async () => ({ ok: true, account: acct({ balance: 210, equity: 210, trades: 1 }) }), getTrades: async () => ({ ok: true, rows: [win] }) };
    await runScoring({ store, elefin: second, cfg, nowMs: T0 + 20000 });
    return store.published.categories.bronze.entries[0];
  };
  const plain = await run([]);
  assert.equal(plain.pnl, 10);

  const patched = await run([{ wallet_id: '1', enabled: true, mode: 'fields', fields: { closed_pnl: 10.5 }, source: 'organiser' }]);
  assert.equal(patched.pnl, 10.5);
  assert.equal(patched.net_capital, 200); // everything else still from Elefin
  assert.ok(patched.flags.includes('manual_fields'));
  assert.deepEqual(patched.manual.fields, ['closed_pnl']);

  const off = await run([{ wallet_id: '1', enabled: false, mode: 'fields', fields: { closed_pnl: 999 } }]);
  assert.equal(off.pnl, 10);
});

test('public API never exposes manual reason, source or admin names', async () => {
  const store = { loadCurrent: async () => ({ generated_at: 'x', window_end: 'y', competition_over: false, stats: { registered: 1, frozen: 1, ranked: 1 },
    categories: { bronze: { stats: {}, entries: [{ rank: 1, name: 'T One', category: 'bronze', return_pct: 5, pnl: 1, start_capital: 100, net_capital: 100, closed_trades: 1, flags: ['manual_full'], manual: { source: 'mt5_statement', entered_by: 'vipin', reason: 'secret reason' } }] } } }) };
  const app = createApp({ store, trigger: async () => {}, cfg });
  const server = await new Promise((r) => { const sv = app.listen(0, () => r(sv)); });
  try {
    const raw = await (await fetch(`http://127.0.0.1:${server.address().port}/api/leaderboard`)).text();
    for (const leak of ['vipin', 'mt5_statement', 'secret reason', 'manual']) assert.ok(!raw.includes(leak), leak);
  } finally { server.close(); }
});

// ---------- auth ----------
test('auth: password hashing, cookie signing/expiry/tamper, lockout', () => {
  const h = auth.hashPassword('correct horse');
  assert.ok(auth.verifyPassword('correct horse', h));
  assert.ok(!auth.verifyPassword('wrong', h));
  assert.ok(!auth.verifyPassword('x', 'garbage'));
  assert.ok(!h.includes('correct horse'));
  assert.equal(auth.parseUsers(`vipin:${h},bad,:nohash,yash:plain`).size, 1);

  const secret = 's'.repeat(40);
  const c = auth.makeCookie('vipin', secret, 1000);
  assert.equal(auth.readCookie(c, secret, 2000), 'vipin');
  assert.equal(auth.readCookie(c, secret, 1000 + auth.SESSION_MS + 1), null); // expired
  assert.equal(auth.readCookie(c, 'x'.repeat(40), 2000), null); // secret rotated -> everyone logged out
  const [u, exp, sig] = c.split('.');
  assert.equal(auth.readCookie(`${Buffer.from('yash').toString('base64url')}.${exp}.${sig}`, secret, 2000), null); // other user
  assert.equal(auth.readCookie(`${u}.${Number(exp) + 99999999}.${sig}`, secret, 2000), null); // extended expiry
  assert.equal(auth.readCookie('', secret), null);

  let t = 0;
  const lock = new auth.Lockout({ now: () => t });
  for (let i = 0; i < 4; i += 1) lock.fail('ip');
  assert.equal(lock.lockedMinutes('ip'), 0);
  lock.fail('ip');
  assert.equal(lock.lockedMinutes('ip'), 15);
  t = 16 * 60000;
  assert.equal(lock.lockedMinutes('ip'), 0);
});

// ---------- HTTP ----------
const PASSWORD = 'a-long-test-password';
const SECRET = 'z'.repeat(48);
const adminCfg = { ...cfg, admin: { path: '/ops-test', secret: SECRET, users: auth.parseUsers(`vipin:${auth.hashPassword(PASSWORD)}`) } };

async function withAdmin(fn, { repoSeed } = {}) {
  const { repo, service } = setup({ configOverride: adminCfg, elefin: { lookupClient: async () => ({ ok: true, data: null }) } });
  if (repoSeed) repoSeed(repo);
  const app = createApp({ store: { loadCurrent: async () => null }, trigger: async () => {}, cfg: adminCfg, adminService: service });
  const server = await new Promise((r) => { const sv = app.listen(0, () => r(sv)); });
  const base = `http://127.0.0.1:${server.address().port}/ops-test`;
  const call = (p, { method = 'GET', body, cookie, headers = {} } = {}) =>
    fetch(base + p, { method, redirect: 'manual', headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  try {
    return await fn({ call, repo });
  } finally { server.close(); }
}

async function login(call) {
  const res = await call('/api/login', { method: 'POST', body: { username: 'vipin', password: PASSWORD } });
  return res.headers.get('set-cookie').split(';')[0];
}

test('HTTP: every admin API route needs a cookie; tampered/expired cookies are rejected', async () => {
  await withAdmin(async ({ call }) => {
    for (const [m, p] of [['GET', '/api/me'], ['GET', '/api/traders'], ['POST', '/api/traders'], ['GET', '/api/audit'], ['POST', '/api/rescore'], ['GET', '/api/manual/123456'], ['POST', '/api/preview/123456']]) {
      const res = await call(p, { method: m, body: m === 'POST' ? {} : undefined });
      assert.equal(res.status, 401, `${m} ${p}`);
    }
    const bad = auth.makeCookie('vipin', 'q'.repeat(48));
    assert.equal((await call('/api/me', { cookie: `admin=${bad}` })).status, 401);
    const expired = auth.makeCookie('vipin', SECRET, Date.now() - auth.SESSION_MS - 1000);
    assert.equal((await call('/api/me', { cookie: `admin=${expired}` })).status, 401);
    const unknownUser = auth.makeCookie('mallory', SECRET);
    assert.equal((await call('/api/me', { cookie: `admin=${unknownUser}` })).status, 401);
  });
});

test('HTTP: login sets a hardened cookie, wrong password is generic, 6th attempt is locked, headers are private', async () => {
  await withAdmin(async ({ call, repo }) => {
    const ok = await call('/api/login', { method: 'POST', body: { username: 'vipin', password: PASSWORD } });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.match(ok.headers.get('x-robots-tag'), /noindex/);

    const me = await (await call('/api/me', { cookie: cookie.split(';')[0] })).json();
    assert.equal(me.username, 'vipin');

    const wrongUser = await call('/api/login', { method: 'POST', body: { username: 'nobody', password: PASSWORD } });
    const wrongPass = await call('/api/login', { method: 'POST', body: { username: 'vipin', password: 'nope' } });
    assert.equal(wrongUser.status, 401);
    assert.deepEqual(await wrongUser.json(), await wrongPass.json()); // cannot tell which part was wrong
    for (let i = 0; i < 3; i += 1) await call('/api/login', { method: 'POST', body: { username: 'vipin', password: 'nope' } });
    const locked = await call('/api/login', { method: 'POST', body: { username: 'vipin', password: PASSWORD } });
    assert.equal(locked.status, 429); // even the right password is refused while locked

    const audit = JSON.stringify(repo.log);
    assert.ok(!audit.includes(PASSWORD) && !audit.includes('nope'));
    assert.ok(repo.log.some((a) => a.action === 'login.fail') && repo.log.some((a) => a.action === 'login.ok'));
  });
});

test('HTTP: writes need JSON; trader + manual flow works end to end; errors use the contract shape', async () => {
  await withAdmin(async ({ call }) => {
    const cookie = await login(call);
    const form = await fetch(`${(await call('/', {})).url}api/traders`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=b' });
    assert.equal(form.status, 415);

    const created = await call('/api/traders', { method: 'POST', cookie, body: NEW });
    assert.equal(created.status, 201);
    const dup = await call('/api/traders', { method: 'POST', cookie, body: NEW });
    assert.equal(dup.status, 409);
    const err = (await dup.json()).error;
    assert.ok(err.code && err.message);

    const put = await call(`/api/manual/${NEW.wallet_id}`, { method: 'PUT', cookie, body: { mode: 'fields', fields: { closed_pnl: -1090.77 }, source: 'mt5_statement', source_ref: 'ReportHistorys-12345992151.xlsx', reason: REASON } });
    assert.equal(put.status, 200);
    const got = await (await call(`/api/manual/${NEW.wallet_id}`, { cookie })).json();
    assert.equal(got.current.fields.closed_pnl, -1090.77);
    assert.equal(got.history.length, 1);
    assert.equal(got.history[0].action, "manual.set");
    const unknown = await call('/api/nope', { cookie });
    assert.equal(unknown.status, 404);
  });
});

test('admin panel is not mounted without users or with a weak secret; its page is served only at the path', async () => {
  assert.equal(adminEnabled({ path: '/ops-test', secret: SECRET, users: new Map() }), false);
  assert.equal(adminEnabled({ path: '/ops-test', secret: 'short', users: adminCfg.admin.users }), false);
  assert.equal(adminEnabled({ path: '/a', secret: SECRET, users: adminCfg.admin.users }), false);
  assert.equal(adminEnabled(adminCfg.admin), true);
  const two = new Map([...adminCfg.admin.users, ['second', auth.hashPassword('another-long-password')]]);
  assert.equal(adminEnabled({ ...adminCfg.admin, users: two }), false); // single admin account only

  const { service } = setup();
  const app = createApp({ store: { loadCurrent: async () => null }, trigger: async () => {}, cfg: { ...cfg, admin: { path: '/ops-test', secret: SECRET, users: new Map() } }, adminService: service });
  const server = await new Promise((r) => { const sv = app.listen(0, () => r(sv)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/ops-test/api/me`);
    assert.match(res.headers.get('content-type'), /html/); // falls through to the public landing page, never the admin API
  } finally { server.close(); }
});
