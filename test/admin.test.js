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
    getTrader: async (c, email) => (String(c).endsWith('-w2') ? null : r.traders.get(email) || null), // no week-2 rows here
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
    replaceBaseline: async (c, email, doc, expected) => {
      const cur = r.baselines.get(email);
      if (((cur && cur.rev) || 0) !== expected) return false;
      r.baselines.set(email, { ...doc });
      return true;
    },
    moveTrader: async (c, oldEmail, expected, doc, { walletChanged, oldWallet, admin, at }) => {
      const t = r.traders.get(oldEmail);
      if (!t || (t.version || 1) !== expected) return 'stale';
      if (doc.email !== oldEmail && r.traders.has(doc.email)) return 'email';
      if ([...r.traders.values()].some((x) => x !== t && x.wallet_id === doc.wallet_id)) return 'wallet';
      r.traders.delete(oldEmail);
      r.traders.set(doc.email, { ...doc });
      const b = r.baselines.get(oldEmail);
      if (b) {
        r.baselines.delete(oldEmail);
        const { history, ...prev } = b;
        r.baselines.set(doc.email, walletChanged
          ? { email: doc.email, wallet_id: doc.wallet_id, status: 'superseded', rev: (b.rev || 0) + 1, history: [...(history || []), prev], superseded_at: at, superseded_by: admin }
          : { ...prev, email: doc.email, history: history || [] });
      }
      r.entries.delete(oldEmail);
      const m = r.manual.get(oldWallet);
      if (m && walletChanged && m.enabled) Object.assign(m, { enabled: false, version: m.version + 1 });
      if (m && !walletChanged) m.email = doc.email;
      return true;
    },
    deleteManual: async (c, w) => { r.manual.delete(w); },
    deleteTrader: async (c, email, wallet) => {
      const snapshot = { trader: r.traders.get(email) || null, baseline: r.baselines.get(email) || null, manual: r.manual.get(wallet) || null };
      r.traders.delete(email); r.baselines.delete(email); r.entries.delete(email); r.manual.delete(wallet);
      return snapshot;
    },
    locks: new Set(),
    acquireLock: async (n) => (r.locks.has(n) ? false : (r.locks.add(n), true)),
    releaseLock: async (n) => { r.locks.delete(n); },
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

test('updateTrader: an Elefin trader\'s wallet only changes through correctIdentity (verified)', async () => {
  const s = setup();
  await s.service.addTrader(s.ctx, NEW);
  await assert.rejects(s.service.updateTrader(s.ctx, 'amrit@x.com', { version: 1, wallet_id: '999999999', reason: REASON }), (e) => e.code === 'use_correct_details');
});

// ---------- corrections: email / account ID ----------
const client = (logins, id = 7) => ({ ok: true, data: { client_id: id, country: 'IN', accounts: { logins, items: logins.map((l) => ({ login: l, equity: 300 })) } } });

test('correctIdentity: verified email + wallet change moves the trader, retires the old start line and manual data', async () => {
  const lookups = [];
  const s = setup({ nowMs: comp.cutoffMs + 60000, elefin: { lookupClient: async (e) => { lookups.push(e); return client(['55555555']); } } });
  s.repo.traders.set('amrit@x.com', { email: 'amrit@x.com', wallet_id: '12345992151', status: 'needs_account', version: 3, cohort: comp.cohort, google_sync: { ok: true } });
  s.repo.baselines.set('amrit@x.com', { status: 'frozen', category: 'bronze', start_capital_usd: 150, captured_at: iso(T0 + 5000) });
  s.repo.entries.set('amrit@x.com', { email: 'amrit@x.com' });
  s.repo.manual.set('12345992151', { wallet_id: '12345992151', enabled: true, version: 1 });

  const r = await s.service.correctIdentity(s.ctx, 'amrit@x.com', { version: 3, new_email: 'Amrit.Real@X.com', new_wallet_id: '55555555', reason: REASON });
  assert.deepEqual(lookups, ['amrit.real@x.com']);
  assert.equal(r.needs_baseline, true);
  assert.equal(s.repo.traders.has('amrit@x.com'), false);
  const t = s.repo.traders.get('amrit.real@x.com');
  assert.equal(t.wallet_id, '55555555');
  assert.equal(t.status, 'active'); // verified -> no longer needs_account
  assert.equal(t.client_id, 7);
  assert.equal(t.version, 4);
  assert.deepEqual(t.google_sync, { ok: false, attempts: 0, previous_email: 'amrit@x.com' });
  assert.equal(t.identity_history[0].wallet_id, '12345992151');
  const b = s.repo.baselines.get('amrit.real@x.com');
  assert.equal(b.status, 'superseded');
  assert.equal(b.history[0].start_capital_usd, 150);
  assert.equal(s.repo.entries.size, 0);
  assert.equal(s.repo.manual.get('12345992151').enabled, false);
  assert.equal(s.repo.log.filter((a) => a.action === 'trader.identity').length, 2); // under old and new email
  assert.equal(s.repo.locks.size, 0);
});

test('correctIdentity: email-only fix keeps the frozen start line', async () => {
  const s = setup({ elefin: { lookupClient: async () => client(['12345992151']) } });
  await s.service.addTrader(s.ctx, NEW);
  s.repo.baselines.set('amrit@x.com', { status: 'frozen', category: 'silver', start_capital_usd: 350 });
  const r = await s.service.correctIdentity(s.ctx, 'amrit@x.com', { version: 1, new_email: 'right@x.com', reason: REASON });
  assert.equal(r.needs_baseline, false);
  assert.equal(s.repo.baselines.get('right@x.com').status, 'frozen');
  assert.equal(s.repo.baselines.get('right@x.com').start_capital_usd, 350);
});

test('correctIdentity: wallet not on the email\'s Elefin client is blocked and nothing moves', async () => {
  let reply = client(['11111111']);
  const s = setup({ elefin: { lookupClient: async () => reply } });
  await s.service.addTrader(s.ctx, NEW);
  await s.service.addTrader(s.ctx, { ...NEW, email: 'other@x.com', wallet_id: '22222222' });
  const fix = (body) => s.service.correctIdentity(s.ctx, 'amrit@x.com', { version: 1, reason: REASON, ...body });

  await assert.rejects(fix({ new_wallet_id: '99999999' }), (e) => e.code === 'wallet_not_on_client' && /11111111/.test(e.message));
  reply = { ok: true, data: null };
  await assert.rejects(fix({ new_wallet_id: '99999999' }), (e) => e.code === 'elefin_no_client');
  await assert.rejects(fix({ new_wallet_id: '22222222' }), (e) => e.code === 'duplicate_wallet');
  await assert.rejects(fix({ new_email: 'other@x.com' }), (e) => e.code === 'duplicate_email');
  await assert.rejects(fix({ new_email: 'amrit@x.com' }), (e) => e.code === 'nothing_to_change');
  await assert.rejects(fix({ new_wallet_id: '12ab' }), (e) => e.code === 'invalid_field');
  await assert.rejects(fix({ version: 9, new_wallet_id: '99999999' }), (e) => e.code === 'stale');
  assert.equal(s.repo.traders.get('amrit@x.com').wallet_id, '12345992151');
});

test('correctIdentity: refuses while a scoring run holds the lock', async () => {
  const s = setup({ elefin: { lookupClient: async () => client(['55555555']) } });
  await s.service.addTrader(s.ctx, NEW);
  s.repo.locks.add(`score:${comp.cohort}`);
  await assert.rejects(s.service.correctIdentity(s.ctx, 'amrit@x.com', { version: 1, new_wallet_id: '55555555', reason: REASON }), (e) => e.code === 'scoring_running');
  assert.ok(s.repo.traders.has('amrit@x.com'));
});

// ---------- corrections: start line ----------
const { rebuildBaseline } = require('../src/domain/baseline');
const AT = T0 + 3 * 86400000; // re-baseline 3 days in
const NOW = AT + 2 * 86400000;
const trade = (o) => ({ instrument: 'XAUUSD', type: 'BUY', lots: 0.01, swap: 0, ...o });

test('rebuildBaseline: balance at T = balance now - net flows since T - P/L of every trade closed since T', () => {
  const account = { login: '55555555', currency: 'USD', balance: 520, equity: 520, total_deposit: 700, total_withdrawal: 50 };
  const trades = [
    trade({ trade_ticket_id: 'before', open_time: iso(AT - 9000), close_time: iso(AT - 5000), open_price: 100, close_price: 200 }), // closed before T: ignored
    trade({ trade_ticket_id: 'after', open_time: iso(AT + 1000), close_time: iso(AT + 5000), open_price: 100, close_price: 130 }), // +30
    trade({ trade_ticket_id: 'straddle', open_time: iso(AT - 1000), close_time: iso(AT + 9000), open_price: 100, close_price: 90 }), // -10, open at T
  ];
  const ledger = [
    { login: '55555555', type: 'deposit', amount: 100, created_at: iso(AT + 2000) },
    { login: '55555555', type: 'withdrawal', amount: 50, created_at: iso(AT + 3000) },
    { login: '55555555', type: 'deposit', amount: 999, created_at: iso(AT - 2000) }, // before T
    { login: '99', type: 'deposit', amount: 999, created_at: iso(AT + 2000) }, // someone else
  ];
  const { doc, rebuilt, warnings } = rebuildBaseline({ account, trades, ledger, atMs: AT, nowMs: NOW, competition: comp, scoring: cfg.scoring });
  assert.deepEqual(rebuilt, { balance_now: 520, deposits_since: 100, withdrawals_since: 50, closed_pnl_since: 20 });
  assert.equal(doc.balance_start, 450); // 520 - 100 + 50 - 20
  assert.equal(doc.start_capital_usd, 450);
  assert.equal(doc.category, 'silver');
  assert.equal(doc.total_deposit_start, 600);
  assert.equal(doc.total_withdrawal_start, 0);
  assert.equal(doc.captured_at, iso(AT));
  assert.equal(doc.source, 'admin');
  assert.equal(doc.status, 'frozen');
  assert.match(warnings[0], /1 trade/);
});

function baselineSetup(previous) {
  const account = { login: '12345992151', currency: 'USD', balance: 380, equity: 380, total_deposit: 500, total_withdrawal: 0 };
  const s = setup({
    nowMs: NOW,
    elefin: { getAccount: async () => ({ ok: true, account }), getTrades: async () => ({ ok: true, rows: [] }), getTransactions: async () => ({ ok: true, rows: [] }) },
  });
  s.repo.traders.set('amrit@x.com', { email: 'amrit@x.com', wallet_id: '12345992151', status: 'active', version: 1 });
  if (previous) s.repo.baselines.set('amrit@x.com', previous);
  return s;
}

test('setBaseline: re-baseline at a date keeps the old category unless a capital is given', async () => {
  const s = baselineSetup({ status: 'frozen', category: 'gold', start_capital_usd: 520, balance_start: 520, captured_at: iso(T0 + 5000) });
  const kept = await s.service.previewBaseline('amrit@x.com', { at: iso(AT) });
  assert.equal(kept.baseline.start_capital_usd, 380);
  assert.equal(kept.baseline.category, 'gold'); // kept, although 380 is silver
  assert.equal(kept.category_changed, false);

  const r = await s.service.setBaseline(s.ctx, 'amrit@x.com', { at: iso(AT), start_capital: 500, rev: 0, reason: REASON });
  assert.equal(r.baseline.start_capital_usd, 500);
  assert.equal(r.baseline.balance_start, 380); // reconciliation still uses the real balance
  assert.equal(r.baseline.category, 'gold'); // 500 -> gold, from the capital
  assert.equal(r.baseline.rev, 1);
  assert.equal(r.baseline.history[0].start_capital_usd, 520);
  assert.equal(s.repo.log.at(-1).action, 'baseline.set');
  await assert.rejects(s.service.setBaseline(s.ctx, 'amrit@x.com', { start_capital: 600, rev: 0, reason: REASON }), (e) => e.code === 'stale');
});

test('setBaseline: capital-only change on a frozen start line, with category derived or pinned', async () => {
  const s = baselineSetup({ status: 'frozen', category: 'silver', start_capital_usd: 380, balance_start: 380, captured_at: iso(T0 + 5000) });
  const r = await s.service.setBaseline(s.ctx, 'amrit@x.com', { start_capital: 500, rev: 0, reason: REASON });
  assert.equal(r.baseline.category, 'gold');
  assert.equal(r.baseline.captured_at, iso(T0 + 5000)); // start time unchanged
  assert.equal(r.baseline.balance_start, 380);
  const pinned = await s.service.previewBaseline('amrit@x.com', { start_capital: 500, category: 'silver' });
  assert.equal(pinned.baseline.category, 'silver');
});

test('setBaseline: validation', async () => {
  const none = baselineSetup(null);
  await assert.rejects(none.service.previewBaseline('amrit@x.com', { start_capital: 500 }), (e) => e.code === 'no_baseline');
  await assert.rejects(none.service.previewBaseline('amrit@x.com', { at: iso(T0 - 1000) }), (e) => e.code === 'invalid_field');
  await assert.rejects(none.service.previewBaseline('amrit@x.com', { at: iso(NOW + 1000) }), (e) => e.code === 'invalid_field');
  await assert.rejects(none.service.previewBaseline('amrit@x.com', { at: iso(AT), start_capital: -5 }), (e) => e.code === 'invalid_field');
  await assert.rejects(none.service.previewBaseline('amrit@x.com', { at: iso(AT), start_capital: 20 }), (e) => e.code === 'no_category');
  await assert.rejects(none.service.previewBaseline('amrit@x.com', { at: iso(AT), category: 'diamond' }), (e) => e.code === 'invalid_field');
  await assert.rejects(none.service.setBaseline(none.ctx, 'amrit@x.com', { at: iso(AT), rev: 0, reason: 'short' }), (e) => e.code === 'reason_required');
  const built = await none.service.setBaseline(none.ctx, 'amrit@x.com', { at: iso(AT), rev: 0, reason: REASON });
  assert.equal(built.baseline.category, 'silver'); // no previous band: derived from the rebuilt 380
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
  // Without any start line, a partial patch would be ignored by scoring, so it is refused.
  await assert.rejects(s.service.setManual(s.ctx, NEW.wallet_id, { ...input, rebaseline: true }), (e) => e.code === 'no_start_line');
  s.repo.baselines.set('amrit@x.com', { status: 'frozen' });
  await assert.rejects(s.service.setManual(s.ctx, NEW.wallet_id, input), (e) => e.code === 'rebaseline_required');
  assert.ok(await s.service.setManual(s.ctx, NEW.wallet_id, { ...input, rebaseline: true }));
});

test('setManual: a manual trader must use mode full; saving and deleting re-score', async () => {
  const s = setup();
  const t = await s.service.addTrader(s.ctx, { email: 'm@x.com', wallet_id: 'Manual ID #1', manual: true, reason: REASON });
  await assert.rejects(s.service.setManual(s.ctx, t.wallet_id, { mode: 'fields', fields: { closed_pnl: 5 }, source: 'organiser' }), (e) => e.code === 'full_required');
  const d = await s.service.setManual(s.ctx, t.wallet_id, { mode: 'full', fields: FULL, source: 'organiser' });
  assert.equal(d.mode, 'full');
  assert.deepEqual(s.triggered, ['admin']);

  await s.service.deleteManual(s.ctx, t.wallet_id, {});
  assert.equal(s.repo.manual.has(t.wallet_id), false);
  assert.equal(s.repo.log.at(-1).action, 'manual.delete');
  assert.equal(s.repo.log.at(-1).before.version, 1); // History keeps the deleted numbers
  await assert.rejects(s.service.deleteManual(s.ctx, t.wallet_id, {}), (e) => e.status === 404);
  assert.deepEqual(s.triggered, ['admin', 'admin']);
});

test('scorer: a "fields" entry with a whole start line stands in for a missing one', async () => {
  const at = comp.cutoffMs + 1000;
  const fields = { start_capital: 500, balance_start: 480, captured_at: iso(at) };
  const store = scoringStore({ traders: [tr], manual: [{ wallet_id: '1', enabled: true, mode: 'fields', fields, rebaseline: true, source: 'mt5_statement' }] });
  const win = { trade_ticket_id: 'W', instrument: 'XAUUSD', type: 'BUY', lots: 0.1, open_time: iso(at + 1000), close_time: iso(at + 5000), open_price: 100, close_price: 101, swap: 0 };
  const elefin = { getTransactions: async () => ({ ok: true, rows: [] }), getAccount: async () => ({ ok: true, account: acct({ balance: 490, equity: 490, trades: 1 }) }), getTrades: async () => ({ ok: true, rows: [win] }) };
  await runScoring({ store, elefin, cfg, nowMs: at + 20000 }); // no stored baseline; after the cutoff it would be "entry_closed"
  const row = store.entries.get('t@x.com');
  assert.deepEqual(row.reasons, []);
  assert.equal(row.category, 'gold'); // from the typed 500
  assert.equal(row.return_pct, 2); // +10 on 500
  assert.ok(!row.flags.includes('flow_mismatch')); // no account totals to compare against
  assert.ok(!row.flags.includes('pnl_mismatch')); // 480 + 10 = 490
});

test('deleteTrader: needs the typed email, refuses winners and week-2 entrants, removes everything', async () => {
  const s = setup();
  await s.service.addTrader(s.ctx, NEW);
  const del = (body) => s.service.deleteTrader(s.ctx, 'amrit@x.com', body);
  await assert.rejects(del({ confirm_email: 'wrong@x.com' }), (e) => e.code === 'confirm_required');
  s.repo.traders.get('amrit@x.com').wins = [{ round: 'week1', category: 'gold' }];
  await assert.rejects(del({ confirm_email: 'amrit@x.com' }), (e) => e.code === 'is_winner');
  delete s.repo.traders.get('amrit@x.com').wins;
  s.repo.locks.add(`score:${comp.cohort}`);
  await assert.rejects(del({ confirm_email: 'Amrit@X.com' }), (e) => e.code === 'scoring_running');
  s.repo.locks.clear();

  const r = await del({ confirm_email: ' Amrit@X.com ' });
  assert.equal(r.deleted, true);
  assert.equal(s.repo.traders.has('amrit@x.com'), false);
  const a = s.repo.log.at(-1);
  assert.equal(a.action, 'trader.delete');
  assert.equal(a.before.trader.wallet_id, NEW.wallet_id); // restorable copy
  assert.deepEqual(s.triggered, ['admin']);
});

test('setManual / disableManual: the reason is optional', async () => {
  const s = setup();
  await s.service.addTrader(s.ctx, NEW);
  const d = await s.service.setManual(s.ctx, NEW.wallet_id, { mode: 'fields', fields: { closed_pnl: 5 }, source: 'organiser' });
  assert.equal(d.reason, null);
  const off = await s.service.disableManual(s.ctx, NEW.wallet_id, {});
  assert.equal(off.enabled, false);
  assert.deepEqual(s.repo.log.slice(-2).map((a) => [a.action, a.admin, a.reason]), [['manual.set', 'vipin', null], ['manual.disable', 'vipin', null]]);
});

test('setManual: an Elefin trader\'s full data with a start time after the cutoff saves with re-baseline and scores eligible', async () => {
  const s = setup({ nowMs: comp.cutoffMs + 60000 });
  s.repo.traders.set('amrit@x.com', { email: 'amrit@x.com', wallet_id: NEW.wallet_id, version: 1, status: 'active' });
  const fields = { start_capital: 1000, balance_start: 1000, captured_at: iso(comp.cutoffMs + 30000), dep_w: 0, wdr_w: 0, closed_pnl: 200, closed_trades: 2 };
  const input = { mode: 'full', fields, source: 'mt5_statement' };
  await assert.rejects(s.service.setManual(s.ctx, NEW.wallet_id, input), (e) => e.code === 'invalid_field' && e.field === 'captured_at');
  const d = await s.service.setManual(s.ctx, NEW.wallet_id, { ...input, rebaseline: true });
  assert.equal(d.rebaseline, true);

  const p = await s.service.preview(NEW.wallet_id, { mode: 'full', fields, rebaseline: true });
  assert.equal(p.eligible, true);
  assert.equal(p.reasons.includes('entered_after_cutoff'), false);
  assert.equal(p.return_pct, 20);
  assert.ok(p.flags.includes('admin_baseline'));

  // Scoring reads the saved doc the same way.
  const store = scoringStore({ traders: [{ ...tr, wallet_id: NEW.wallet_id }], manual: [{ ...d }] });
  await runScoring({ store, elefin: { getTransactions: async () => ({ ok: true, rows: [] }) }, cfg, nowMs: comp.cutoffMs + 90000 });
  const row = store.entries.get('t@x.com');
  assert.deepEqual(row.reasons, []);
  assert.equal(row.category, 'platinum');
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
test('snapshotBaseline: freezes a fresh Elefin snapshot, overwrites a frozen baseline, triggers a re-score', async () => {
  const account = { login: '12345992151', client_id: 1, currency: 'USD', equity: 640, balance: 620, total_deposit: 500, total_withdrawal: 0 };
  const s = setup({ elefin: { getAccount: async () => ({ ok: true, account }) } });
  await s.service.addTrader(s.ctx, { ...NEW, client_id: 1 });
  s.repo.baselines.set('amrit@x.com', { status: 'frozen', wallet_id: NEW.wallet_id, start_capital_usd: 100, category: 'bronze' });
  s.setNow(comp.cutoffMs + 100000); // re-baseline deliberately after the entry cutoff

  const r = await s.service.snapshotBaseline(s.ctx, 'amrit@x.com', { version: 1, reason: REASON });
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

test('snapshotBaseline: honours a pinned category, and refuses bad inputs', async () => {
  const account = { login: '12345992151', client_id: 1, currency: 'USD', equity: 640, balance: 620, total_deposit: 0, total_withdrawal: 0 };
  const s = setup({ elefin: { getAccount: async () => ({ ok: true, account }) } });
  await s.service.addTrader(s.ctx, { ...NEW, client_id: 1 });

  s.repo.traders.get('amrit@x.com').category_pin = 'platinum';
  const pinned = await s.service.snapshotBaseline(s.ctx, 'amrit@x.com', { version: 1, reason: REASON });
  assert.equal(pinned.baseline.category, 'platinum'); // pin wins over the equity-derived band

  // manual trader has no Elefin account to baseline from
  await s.service.addTrader(s.ctx, { email: 'm@x.com', wallet_id: 'man-1', manual: true, reason: REASON });
  await assert.rejects(s.service.snapshotBaseline(s.ctx, 'm@x.com', { version: 1, reason: REASON }), (e) => e.code === 'not_applicable');
});

test('snapshotBaseline: surfaces Elefin failure, wrong owner, non-USD and sub-minimum equity', async () => {
  const addOne = async (svc, ctx) => svc.addTrader(ctx, { ...NEW, client_id: 1 });

  const down = setup({ elefin: { getAccount: async () => ({ ok: false, error: 'boom' }) } });
  await addOne(down.service, down.ctx);
  await assert.rejects(down.service.snapshotBaseline(down.ctx, 'amrit@x.com', { version: 1, reason: REASON }), (e) => e.status === 502);

  const wrong = setup({ elefin: { getAccount: async () => ({ ok: true, account: { login: '99999', client_id: 1, currency: 'USD', equity: 640 } }) } });
  await addOne(wrong.service, wrong.ctx);
  await assert.rejects(wrong.service.snapshotBaseline(wrong.ctx, 'amrit@x.com', { version: 1, reason: REASON }), (e) => e.code === 'wallet_not_on_client');

  const inr = setup({ elefin: { getAccount: async () => ({ ok: true, account: { login: '12345992151', client_id: 1, currency: 'INR', equity: 640 } }) } });
  await addOne(inr.service, inr.ctx);
  await assert.rejects(inr.service.snapshotBaseline(inr.ctx, 'amrit@x.com', { version: 1, reason: REASON }), (e) => e.code === 'unsupported_currency');

  const low = setup({ elefin: { getAccount: async () => ({ ok: true, account: { login: '12345992151', client_id: 1, currency: 'USD', equity: 10 } }) } });
  await addOne(low.service, low.ctx);
  await assert.rejects(low.service.snapshotBaseline(low.ctx, 'amrit@x.com', { version: 1, reason: REASON }), (e) => e.code === 'below_min_capital');
});

test('rescore triggers the locked run and is audited', async () => {
  const s = setup();
  await s.service.rescore(s.ctx);
  assert.deepEqual(s.triggered, ['admin']);
  assert.equal(s.repo.log[0].action, 'rescore');
});

test('fixPnlMismatch: reason is optional; audits per-trader plus a summary row', async () => {
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

  await assert.rejects(service.fixPnlMismatch(ctx, { bogus: 1 }), (e) => e.code === 'unknown_field');
  assert.equal(calls.length, 0); // rejected before it ever reached rounds

  const res = await service.fixPnlMismatch(ctx, {});
  assert.equal(res.fixed, 1);
  assert.equal(calls.length, 1);
  assert.equal(repo.log.filter((l) => l.action === 'pnl_fix.apply').length, 1);
  assert.equal(repo.log.find((l) => l.action === 'pnl_fix.apply').target, 'a@x.com');
  const summary = repo.log.find((l) => l.action === 'pnl_fix.run');
  assert.equal(summary.after.count, 1);
  assert.equal(summary.after.finalized, true);
});

test('fixPnlMismatch: switches the fixed traders to balance P/L so the next run keeps the fix', async () => {
  const repo = memRepo();
  repo.traders.set('a@x.com', { email: 'a@x.com', wallet_id: '1', version: 2 });
  const stubRounds = { fixPnlMismatch: async () => ({ fixed: 1, finalized: false, winners: null, changes: [{ email: 'a@x.com' }, { email: 'gone@x.com' }] }) };
  const triggered = [];
  const service = createAdminService({ repo, elefin: {}, cfg, trigger: (w) => triggered.push(w), rounds: stubRounds, now: () => T0 + 1000 });
  const res = await service.fixPnlMismatch({ admin: 'vipin' }, { reason: REASON });
  assert.equal(res.persisted, 1);
  assert.equal(repo.traders.get('a@x.com').pnl_source, 'balance');
  assert.equal(repo.traders.get('a@x.com').version, 3);
  assert.deepEqual(triggered, ['admin']); // board re-scored from live balances right away
});

// ---------- P/L check ----------
const { pnlCheck } = require('../src/domain/pnlcheck');

test('pnlCheck: lists closed trades since the start line and explains the gap to the balance', () => {
  const S = T0 + 86400000; // start line
  const N = S + 86400000;
  const xau = (o) => ({ instrument: 'XAUUSD', type: 'BUY', lots: 0.1, swap: 0, broker_commission: 0, ...o });
  const trades = [
    xau({ trade_ticket_id: 'a', open_time: iso(S + 1000), close_time: iso(S + 5000), open_price: 100, close_price: 102 }), // +20 counted
    xau({ trade_ticket_id: 'b', open_time: iso(S - 9000), close_time: iso(S + 7000), open_price: 100, close_price: 97 }), // -30 open at start
    { trade_ticket_id: 'c', instrument: 'EURUSD', type: 'BUY', lots: 1, open_time: iso(S + 1000), close_time: iso(S + 8000), open_price: 1, close_price: 1.1 }, // unpriceable
    xau({ trade_ticket_id: 'd', open_time: iso(S - 9000), close_time: iso(S - 1000), open_price: 100, close_price: 200 }), // closed before: not listed
  ];
  const ledger = [{ login: '9', type: 'deposit', amount: 100, created_at: iso(S + 2000) }];
  const account = { login: '9', balance: 600, equity: 600 };
  const r = pnlCheck({ account, trades, ledger, startLine: { captured_at: iso(S), balance_start: 500 }, nowMs: N, contractSize: cfg.scoring.contractSize, toleranceUsd: 1 });
  assert.equal(r.trades.length, 3);
  assert.deepEqual(r.trades.map((x) => x.status), ['counted', 'open_at_start', 'unpriceable']);
  assert.equal(r.trade_pnl, 20);
  assert.equal(r.balance_pnl, 0); // 600 - 500 - 100
  assert.equal(r.diff, -20);
  assert.equal(r.mismatch, true);
  assert.equal(r.totals.open_at_start.pnl, -30);
  assert.equal(r.residual, 10); // -20 - (-30): the unpriceable EURUSD trade
  assert.ok(r.causes.some((c) => /already open at the start line/.test(c)));
  assert.ok(r.causes.some((c) => /EURUSD/.test(c)));
});

test('scorer: pnl_source "balance" takes P/L from the balance, clears pnl_mismatch and keeps it every run', async () => {
  const at = T0 + 1000;
  const straddle = { trade_ticket_id: 'S', instrument: 'XAUUSD', type: 'BUY', lots: 0.1, open_time: iso(at - 60000), close_time: iso(at + 5000), open_price: 100, close_price: 105, swap: 0 }; // +50, open at start
  const win = { trade_ticket_id: 'W', instrument: 'XAUUSD', type: 'BUY', lots: 0.1, open_time: iso(at + 1000), close_time: iso(at + 6000), open_price: 100, close_price: 101, swap: 0 }; // +10
  const baseline = { status: 'frozen', wallet_id: '1', captured_at: iso(at), start_capital_usd: 200, start_capital: 200, balance_start: 200, total_deposit_start: 200, total_withdrawal_start: 0, category: 'bronze' };
  const elefin = { getTransactions: async () => ({ ok: true, rows: [] }), getAccount: async () => ({ ok: true, account: acct({ balance: 260, equity: 260, trades: 2 }) }), getTrades: async () => ({ ok: true, rows: [straddle, win] }) };
  const cfgOff = buildConfig({ ...ENV, AUTO_PNL_FIX: '0' });
  const run = async (trader, c = cfgOff) => {
    const store = scoringStore({ traders: [trader], manual: [] });
    store.baselines.set('t@x.com', { ...baseline });
    await runScoring({ store, elefin, cfg: c, nowMs: at + 20000 });
    return store.entries.get('t@x.com');
  };
  const before = await run(tr);
  assert.equal(before.pnl, 10);
  assert.ok(before.flags.includes('pnl_mismatch'));
  assert.equal(before.winner_eligible, false);

  const after = await run({ ...tr, pnl_source: 'balance' });
  assert.equal(after.pnl, 60); // 260 - 200: includes the trade open at the start line
  assert.equal(after.closed_trades, 2);
  assert.ok(!after.flags.includes('pnl_mismatch'));
  assert.ok(after.flags.includes('pnl_from_balance'));
  assert.equal(after.return_pct, 30);
  assert.equal(after.winner_eligible, true);
  assert.ok(!after.flags.includes('pnl_auto_fixed'));

  // Auto fix on (the default): the mismatched trader is switched to balance P/L by the run itself.
  const auto = await run(tr, cfg);
  assert.equal(auto.pnl, 60);
  assert.ok(!auto.flags.includes('pnl_mismatch'));
  assert.ok(auto.flags.includes('pnl_from_balance') && auto.flags.includes('pnl_auto_fixed'));
  // Plan §1b: an unchecked mismatch holds the prize until an admin approves the balance P/L
  // (setting the source to "balance", as `after` above shows, releases it).
  assert.equal(auto.eligible, true);
  assert.equal(auto.winner_eligible, false);
});

test('scorer: auto fix leaves a trader whose trades already match the balance alone', async () => {
  const at = T0 + 1000;
  const win = { trade_ticket_id: 'W', instrument: 'XAUUSD', type: 'BUY', lots: 0.1, open_time: iso(at + 1000), close_time: iso(at + 6000), open_price: 100, close_price: 101, swap: 0 }; // +10
  const baseline = { status: 'frozen', wallet_id: '1', captured_at: iso(at), start_capital_usd: 200, start_capital: 200, balance_start: 200, total_deposit_start: 200, total_withdrawal_start: 0, category: 'bronze' };
  const elefin = { getTransactions: async () => ({ ok: true, rows: [] }), getAccount: async () => ({ ok: true, account: acct({ balance: 210, equity: 210, trades: 1 }) }), getTrades: async () => ({ ok: true, rows: [win] }) };
  const store = scoringStore({ traders: [tr], manual: [] });
  store.baselines.set('t@x.com', { ...baseline });
  await runScoring({ store, elefin, cfg, nowMs: at + 20000 });
  const row = store.entries.get('t@x.com');
  assert.equal(row.pnl, 10);
  assert.ok(!row.flags.includes('pnl_from_balance') && !row.flags.includes('pnl_auto_fixed') && !row.flags.includes('pnl_mismatch'));
});

test('checkPnl / setPnlSource: service flow', async () => {
  const S = T0 + 86400000;
  const s = setup({
    nowMs: S + 86400000,
    elefin: {
      getAccount: async () => ({ ok: true, account: { login: '12345992151', balance: 520, equity: 520 } }),
      getTrades: async () => ({ ok: true, rows: [{ trade_ticket_id: 'a', instrument: 'XAUUSD', type: 'BUY', lots: 0.1, open_time: iso(S + 1000), close_time: iso(S + 5000), open_price: 100, close_price: 101, swap: 0 }] }),
      getTransactions: async () => ({ ok: true, rows: [] }),
    },
  });
  s.repo.traders.set('amrit@x.com', { email: 'amrit@x.com', wallet_id: '12345992151', status: 'active', version: 1 });
  await assert.rejects(s.service.checkPnl('amrit@x.com'), (e) => e.code === 'no_start_line');
  s.repo.baselines.set('amrit@x.com', { status: 'frozen', captured_at: iso(S), balance_start: 500, start_capital_usd: 500 });

  const r = await s.service.checkPnl('amrit@x.com');
  assert.equal(r.trade_pnl, 10);
  assert.equal(r.balance_pnl, 20);
  assert.equal(r.mismatch, true);
  assert.equal(r.pnl_source, 'trades');
  assert.equal(r.trades.length, 1);

  await assert.rejects(s.service.setPnlSource(s.ctx, 'amrit@x.com', { source: 'ledger', version: 1 }), (e) => e.code === 'invalid_field');
  const u = await s.service.setPnlSource(s.ctx, 'amrit@x.com', { source: 'balance', version: 1 }); // reason optional
  assert.equal(u.pnl_source, 'balance');
  assert.deepEqual(s.triggered, ['admin']);
  await assert.rejects(s.service.setPnlSource(s.ctx, 'amrit@x.com', { source: 'balance', version: 2 }), (e) => e.code === 'nothing_to_change');
  assert.equal((await s.service.checkPnl('amrit@x.com')).pnl_source, 'balance');
  assert.equal(s.repo.log.at(-1).action, 'trader.pnl_source');
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

test('scorer: an admin-set start line after the cutoff is not a late entry and is flagged admin_baseline', async () => {
  const at = comp.cutoffMs + 1000;
  const store = scoringStore({ traders: [tr], manual: [] });
  store.baselines.set('t@x.com', { status: 'frozen', source: 'admin', wallet_id: '1', captured_at: iso(at), start_capital_usd: 200, start_capital: 200, balance_start: 200, total_deposit_start: 200, total_withdrawal_start: 0, category: 'bronze' });
  const win = { trade_ticket_id: 'W', instrument: 'XAUUSD', type: 'BUY', lots: 0.1, open_time: iso(at + 1000), close_time: iso(at + 5000), open_price: 100, close_price: 101, swap: 0 };
  const elefin = { getTransactions: async () => ({ ok: true, rows: [] }), getAccount: async () => ({ ok: true, account: acct({ balance: 210, equity: 210, trades: 1 }) }), getTrades: async () => ({ ok: true, rows: [win] }) };
  await runScoring({ store, elefin, cfg, nowMs: at + 20000 });
  const row = store.entries.get('t@x.com');
  assert.deepEqual(row.reasons, []);
  assert.ok(row.flags.includes('admin_baseline'));
  assert.equal(row.winner_eligible, true);
  assert.equal(row.return_pct, 5);
  assert.equal(store.baselines.get('t@x.com').source, 'admin'); // the scorer never replaces it
});

test('HTTP: manual entry with a text id (save, switch off, delete) and trader delete', async () => {
  await withAdmin(async ({ call, repo }) => {
    const cookie = await login(call);
    const add = await call('/api/traders', { method: 'POST', cookie, body: { email: 'm@x.com', wallet_id: 'YG Sir / #1?', manual: true, reason: REASON } });
    assert.equal(add.status, 201);
    const W = encodeURIComponent('YG Sir / #1?');
    const put = await call(`/api/manual/${W}`, { method: 'PUT', cookie, body: { mode: 'full', fields: FULL, source: 'organiser' } }); // no reason
    assert.equal(put.status, 200, await put.clone().text());
    assert.equal((await (await call(`/api/manual/${W}`, { cookie })).json()).current.enabled, true);
    assert.equal((await call(`/api/manual/${W}/disable`, { method: 'POST', cookie, body: {} })).status, 200);
    assert.equal((await call(`/api/manual/${W}/delete`, { method: 'POST', cookie, body: {} })).status, 200);
    assert.equal((await (await call(`/api/manual/${W}`, { cookie })).json()).current, null);

    const bad = await call('/api/traders/m%40x.com/delete', { method: 'POST', cookie, body: { confirm_email: 'nope' } });
    assert.equal(bad.status, 400);
    const del = await call('/api/traders/m%40x.com/delete', { method: 'POST', cookie, body: { confirm_email: 'm@x.com' } });
    assert.equal(del.status, 200);
    assert.equal(repo.traders.size, 0);
  });
});

test('contract size: broker suffixes map to the base symbol (XAUUSD.P = XAUUSD); unknown stays unpriced', () => {
  const { contractSizeFor, tradePnl } = require('../src/domain/scoring');
  const cs = cfg.scoring.contractSize;
  for (const s of ['XAUUSD', 'XAUUSD.P', 'xauusd.p', 'XAUUSDm', '#XAUUSD', 'XAUUSD-ECN']) assert.equal(contractSizeFor(s, cs), 100, s);
  assert.equal(contractSizeFor('BTCUSD.P', cs), 1);
  assert.equal(contractSizeFor('EURUSD.P', cs), null);
  assert.equal(contractSizeFor('', cs), null);

  // The three XAUUSD.P trades from the admin P/L check (23 Nov): -21.70 + 65.80 + 110.60.
  const rows = [
    { instrument: 'XAUUSD.P', type: 'SELL', lots: 0.05, open_time: 'x', open_price: 3606, close_price: 3610.34, swap: 0 },
    { instrument: 'XAUUSD.P', type: 'BUY', lots: 0.1, open_time: 'x', open_price: 3613.39, close_price: 3619.97, swap: 0 },
    { instrument: 'XAUUSD.P', type: 'BUY', lots: 0.1, open_time: 'x', open_price: 3609.48, close_price: 3620.54, swap: 0 },
  ];
  const pnls = rows.map((r) => Math.round(tradePnl(r, cs) * 100) / 100);
  assert.deepEqual(pnls, [-21.7, 65.8, 110.6]);
});

test('scorer: with balance P/L, trades on an unpriceable instrument still count as closed trades (no false no_closed_trade)', async () => {
  const at = T0 + 1000;
  const odd = (id, h) => ({ trade_ticket_id: id, instrument: 'EURUSD.P', type: 'BUY', lots: 0.1, open_time: iso(at + h), close_time: iso(at + h + 1000), open_price: 1.1, close_price: 1.2, swap: 0 });
  const baseline = { status: 'frozen', wallet_id: '1', captured_at: iso(at), start_capital_usd: 500, start_capital: 500, balance_start: 500, total_deposit_start: 500, total_withdrawal_start: 0, category: 'gold' };
  const elefin = { getTransactions: async () => ({ ok: true, rows: [] }), getAccount: async () => ({ ok: true, account: acct({ balance: 600, equity: 600, trades: 2, total_deposit: 500 }) }), getTrades: async () => ({ ok: true, rows: [odd('A', 1000), odd('B', 3000)] }) };
  const store = scoringStore({ traders: [{ ...tr, pnl_source: 'balance' }], manual: [] });
  store.baselines.set('t@x.com', { ...baseline });
  await runScoring({ store, elefin, cfg, nowMs: at + 20000 });
  const row = store.entries.get('t@x.com');
  assert.equal(row.pnl, 100);
  assert.equal(row.closed_trades, 2);
  assert.ok(!row.reasons.includes('no_closed_trade'));
  assert.equal(row.eligible, true);
});

// ---------- account record vs trade feed ----------
describeFeed();
function describeFeed() {
  const at = T0 + 1000;
  const base = { status: 'frozen', wallet_id: '1', captured_at: iso(at), start_capital_usd: 200, start_capital: 200, balance_start: 200, total_deposit_start: 200, total_withdrawal_start: 0, category: 'bronze' };
  const runOne = async ({ account, rows = [], baseline = base, trader = tr, prev = null, ledger = [], nowMs = at + 3 * 3600000 }) => {
    const calls = [];
    const elefin = { getTransactions: async (type) => ({ ok: true, rows: ledger.filter((r) => r.type === type) }), getAccount: async () => ({ ok: true, account }), getTrades: async () => { calls.push('t'); return { ok: true, rows }; } };
    const store = scoringStore({ traders: [trader], manual: [] });
    store.baselines.set('t@x.com', { ...baseline });
    if (prev) store.entries.set('t@x.com', prev);
    await runScoring({ store, elefin, cfg, nowMs });
    return { row: store.entries.get('t@x.com'), calls, store };
  };

  test('feed gap: the account counter says 3 trades since the start line, the feed returned none -> 3 trades, ranked', async () => {
    const { row } = await runOne({ account: acct({ balance: 230, equity: 230, trades: 13 }), baseline: { ...base, trades_start: 10 } });
    assert.equal(row.pnl, 30); // auto fix: balance P/L
    assert.equal(row.closed_trades, 3);
    assert.ok(row.flags.includes('trade_feed_gap'));
    assert.equal(row.eligible, true);
  });

  test('feed gap without trades_start: last_trade_at after the start line counts as at least one trade', async () => {
    const { row } = await runOne({ account: acct({ balance: 230, equity: 230, trades: 13, last_trade_at: iso(at + 3600000) }) });
    assert.equal(row.closed_trades, 1);
    assert.equal(row.eligible, true);
  });

  test('balance moved with no trade since the start line (rebate/adjustment) -> flagged, not ranked', async () => {
    const { row } = await runOne({ account: acct({ balance: 206.17, equity: 206.17, trades: 10, last_trade_at: iso(at - 86400000) }), baseline: { ...base, trades_start: 10 } });
    assert.equal(row.closed_trades, 0);
    assert.ok(row.flags.includes('balance_without_trades'));
    assert.ok(row.reasons.includes('no_closed_trade'));
    assert.equal(row.eligible, false);
  });

  test('trade cache: a summary from older pricing code is rebuilt even when the counter is unchanged', async () => {
    const old = { email: 't@x.com', trade_cache: { acct_trades: 5, captured_at: iso(at), summary: { pnl: 0, closedTrades: 0, openAtEntry: 0, unpriceable: ['XAUUSD.P'] } } };
    const win = { trade_ticket_id: 'W', instrument: 'XAUUSD.P', type: 'BUY', lots: 0.1, open_time: iso(at + 1000), close_time: iso(at + 6000), open_price: 100, close_price: 101, swap: 0 };
    const { row, calls } = await runOne({ account: acct({ balance: 210, equity: 210, trades: 5 }), rows: [win], prev: old });
    assert.deepEqual(calls, ['t']); // re-fetched
    assert.equal(row.closed_trades, 1);
    assert.equal(row.pnl, 10);
    assert.equal(row.trade_cache.v, 2);
  });

  test('trade cache: a current, settled summary is reused (no feed call)', async () => {
    const summary = { pnl: 10, closedTrades: 1, openAtEntry: 0, unpriceable: [], unpricedTrades: 0 };
    // Fetched 7 h after the last trade: past the 6 h settle time.
    const prev = { email: 't@x.com', trade_cache: { v: 2, acct_trades: 5, captured_at: iso(at), fetched_at: iso(at + 7 * 3600000), summary } };
    const { row, calls } = await runOne({ account: acct({ balance: 210, equity: 210, trades: 5, last_trade_at: iso(at + 6000) }), baseline: { ...base, trades_start: 4 }, prev, nowMs: at + 8 * 3600000 });
    assert.deepEqual(calls, []);
    assert.equal(row.pnl, 10);
  });

  test('no trades_start and no estimate yet: one fresh fetch even with a settled cache, then the cache is reused', async () => {
    const t = { trade_ticket_id: 'A', instrument: 'XAUUSD', type: 'BUY', lots: 0.1, open_time: iso(at + 1000), close_time: iso(at + 2000), open_price: 100, close_price: 101, swap: 0 };
    const summary = { pnl: 0, closedTrades: 0, openAtEntry: 0, unpriceable: [], unpricedTrades: 0 }; // stale: feed had not caught up
    const prev = { email: 't@x.com', captured_at: iso(at), trade_cache: { v: 2, acct_trades: 5, captured_at: iso(at), fetched_at: iso(at + 7 * 3600000), summary } };
    const a = { balance: 210, equity: 210, trades: 5, last_trade_at: iso(at + 2000) };
    const r1 = await runOne({ account: acct(a), rows: [t], prev, nowMs: at + 8 * 3600000 });
    assert.deepEqual(r1.calls, ['t']);
    assert.equal(r1.row.trades_start_est, 4); // 5 - 1, not 5 - 0
    const r2 = await runOne({ account: acct(a), rows: [t], prev: r1.row, nowMs: at + 8.5 * 3600000 });
    assert.deepEqual(r2.calls, []);
    assert.equal(r2.row.trades_start_est, 4);
  });

  test('trade cache: a summary fetched under 6 h after the last trade is re-fetched (the feed backfills late)', async () => {
    const summary = { pnl: 10, closedTrades: 1, openAtEntry: 0, unpriceable: [], unpricedTrades: 0 };
    const prev = { email: 't@x.com', trade_cache: { v: 2, acct_trades: 5, captured_at: iso(at), fetched_at: iso(at + 3600000), summary } };
    const { calls } = await runOne({ account: acct({ balance: 210, equity: 210, trades: 5, last_trade_at: iso(at + 6000) }), prev, nowMs: at + 2 * 3600000 });
    assert.deepEqual(calls, ['t']);
  });

  test('trade cache: re-fetched when the counter shows more trades than the cached summary', async () => {
    const summary = { pnl: 10, closedTrades: 1, openAtEntry: 0, unpriceable: [], unpricedTrades: 0 };
    const prev = { email: 't@x.com', trade_cache: { v: 2, acct_trades: 13, captured_at: iso(at), fetched_at: iso(at + 7 * 3600000), summary } };
    const { calls, row } = await runOne({ account: acct({ balance: 210, equity: 210, trades: 13, last_trade_at: iso(at + 6000) }), baseline: { ...base, trades_start: 10 }, prev, nowMs: at + 9 * 3600000 });
    assert.deepEqual(calls, ['t']); // 3 since the start line, 1 cached
    assert.equal(row.closed_trades, 3);
  });

  test('no trades_start on the start line: estimated from counter - feed, kept at its lowest, and the count follows the counter', async () => {
    const t = (id, h) => ({ trade_ticket_id: id, instrument: 'XAUUSD', type: 'BUY', lots: 0.1, open_time: iso(at + h), close_time: iso(at + h + 1000), open_price: 100, close_price: 101, swap: 0 });
    // Run 1: counter 12, feed shows 2 -> estimate 10.
    const r1 = await runOne({ account: acct({ balance: 220, equity: 220, trades: 12 }), rows: [t('A', 1000), t('B', 2000)] });
    assert.equal(r1.row.trades_start_est, 10);
    assert.equal(r1.row.closed_trades, 2);
    // Run 2: counter 15 (3 more closed) but the feed lags at 2 -> count 5 from the counter; estimate stays 10.
    const r2 = await runOne({ account: acct({ balance: 250, equity: 250, trades: 15 }), rows: [t('A', 1000), t('B', 2000)], prev: r1.row, nowMs: at + 4 * 3600000 });
    assert.equal(r2.row.trades_start_est, 10);
    assert.equal(r2.row.closed_trades, 5);
    assert.ok(r2.row.flags.includes('trade_feed_gap'));
  });

  test('a pending withdrawal: the previous row is kept (prize held) instead of a fake loss, then released', async () => {
    const t = { trade_ticket_id: 'A', instrument: 'XAUUSD', type: 'BUY', lots: 0.1, open_time: iso(at + 1000), close_time: iso(at + 2000), open_price: 100, close_price: 110, swap: 0 }; // +100
    const good = await runOne({ account: acct({ balance: 300, equity: 300, trades: 1 }), rows: [t], baseline: { ...base, trades_start: 0 } });
    assert.equal(good.row.pnl, 100);
    // Balance already debited 100, totals not yet, ledger row pending: fresh P/L would read 0.
    const wdr = { login: '1', type: 'withdrawal', status: 'pending', amount: 100, created_at: iso(at + 3 * 3600000 + 60000) };
    const held = await runOne({ account: acct({ balance: 200, equity: 200, trades: 1 }), rows: [t], baseline: { ...base, trades_start: 0 }, prev: good.row, ledger: [wdr], nowMs: at + 3 * 3600000 + 120000 });
    assert.equal(held.row.pnl, 100);
    assert.equal(held.row.return_pct, 50);
    assert.ok(held.row.flags.includes('flow_pending') && held.row.flow_held);
    assert.equal(held.row.winner_eligible, false);
    // Settled: success row and totals updated -> fresh row, no hold, flags gone.
    const done = await runOne({ account: acct({ balance: 200, equity: 200, trades: 1, total_withdrawal: 100 }), rows: [t], baseline: { ...base, trades_start: 0 }, prev: held.row, ledger: [{ ...wdr, status: 'success' }], nowMs: at + 4 * 3600000 });
    assert.equal(done.row.pnl, 100);
    assert.ok(!done.row.flags.includes('flow_pending') && !done.row.flow_held && !done.row.flow_hold_since);
    // Stuck pending for over 6 h: the fresh row is published (still flagged, prize held).
    const stuck = await runOne({ account: acct({ balance: 200, equity: 200, trades: 1 }), rows: [t], baseline: { ...base, trades_start: 0 }, prev: { ...held.row, flow_hold_since: iso(at) }, ledger: [wdr], nowMs: at + 7 * 3600000 });
    assert.ok(!stuck.row.flow_held);
    assert.equal(stuck.row.pnl, 0);
    assert.ok(stuck.row.flags.includes('flow_pending'));
    assert.equal(stuck.row.winner_eligible, false);
  });

  test('ledger lags the account: P/L uses the account totals (no fake profit), prize blocked by flow_mismatch', async () => {
    // A 100 deposit is in the balance and the account totals, but not yet in the ledger.
    const t = { trade_ticket_id: 'A', instrument: 'XAUUSD', type: 'BUY', lots: 0.1, open_time: iso(at + 1000), close_time: iso(at + 2000), open_price: 100, close_price: 101, swap: 0 }; // +10
    const { row } = await runOne({ account: acct({ balance: 310, equity: 310, trades: 1, total_deposit: 300 }), rows: [t], baseline: { ...base, trades_start: 0 } });
    assert.equal(row.pnl, 10);
    assert.equal(row.dep_w, 100);
    assert.equal(row.net_capital, 300);
    assert.ok(row.flags.includes('flow_mismatch'));
    assert.equal(row.winner_eligible, false);
  });
}

test('baseline: a live capture stores the account trade counter as trades_start', () => {
  const { decideBaseline } = require('../src/domain/baseline');
  const d = decideBaseline({ existing: null, account: acct({ trades: 42, equity: 300, balance: 300 }), nowMs: T0 + 1000, competition: cfg.competition, scoring: cfg.scoring });
  assert.equal(d.doc.status, 'frozen');
  assert.equal(d.doc.trades_start, 42);
});

test('P/L check: explains a balance change with no trade since the start line', () => {
  const r = pnlCheck({
    account: acct({ balance: 208.2, equity: 208.2, trades: 10, last_trade_at: iso(T0 - 86400000) }), trades: [], ledger: [],
    startLine: { captured_at: iso(T0), balance_start: 202.03, trades_start: 10 }, nowMs: T0 + 3600000, contractSize: cfg.scoring.contractSize, toleranceUsd: 1,
  });
  assert.equal(r.balance_pnl, 6.17);
  assert.equal(r.account_activity.trades_since, 0);
  assert.ok(r.causes.some((c) => /no trade closed since the start line/.test(c)));
  assert.ok(!r.causes.some((c) => /not explained by the trades/.test(c)));
});
