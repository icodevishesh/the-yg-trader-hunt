'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildConfig } = require('../src/config');
const { validateRegistration, resolveAccount, verifyWallet } = require('../src/domain/registration');
const { resolveTraders, syncGoogle } = require('../src/jobs/prepare');
const { createApp } = require('../src/api/app');
const { rateLimiter } = require('../src/api/register');

const cfg = buildConfig({
  COMPETITION_START: '2026-11-09T09:00:00+05:30',
  COMPETITION_END: '2026-11-14T23:59:59+05:30',
  WINNER_ANNOUNCE: '2026-11-15T12:00:00+05:30',
});
const comp = cfg.competition;
const good = { name: ' Yash   Agarwal ', email: ' Yash@Example.COM ', phone: '+91 98765 43210', wallet_id: ' 12345992652 ', capital: '100', agree: true };

// ---------- validation ----------
test('validateRegistration: normalises and accepts a good body', () => {
  const { errors, value } = validateRegistration(good);
  assert.deepEqual(errors, {});
  assert.equal(value.name, 'Yash Agarwal');
  assert.equal(value.email, 'yash@example.com');
  assert.equal(value.declared_capital, 100);
  assert.equal(value.wallet_id, '12345992652');
});

test('validateRegistration: rejects bad fields, requires agree === true, tolerates N/A capital', () => {
  const r = validateRegistration({ name: '', email: 'nope', phone: '12', agree: 'true', capital: 'abc' });
  assert.deepEqual(Object.keys(r.errors).sort(), ['agree', 'capital', 'email', 'name', 'phone', 'wallet_id']);
  for (const bad of ['', '12ab', '12345', '1234567890123456', '123 456 789']) assert.ok(validateRegistration({ ...good, wallet_id: bad }).errors.wallet_id, `wallet ${bad}`);
  assert.equal(validateRegistration({ ...good, capital: 'N/A' }).value.declared_capital, null);
  assert.equal(validateRegistration({ ...good, capital: null }).errors.capital, undefined);
  assert.ok(validateRegistration(null).errors.name);
});

// ---------- account resolution ----------
const min = { minCapitalUsd: 95 };
const item = (login, equity) => ({ login, equity });

test('resolveAccount: single login -> active; none -> pending; unknown client -> pending', () => {
  assert.deepEqual(resolveAccount({ client_id: 5, country: 'India', accounts: { logins: ['111'], items: [item('111', 0)] } }, min), {
    client_id: 5, country: 'India', status: 'active', wallet_id: '111',
  });
  assert.equal(resolveAccount({ accounts: { logins: [] } }, min).reason, 'no_trading_account');
  assert.equal(resolveAccount(null, min).reason, 'client_not_found');
  assert.equal(resolveAccount({ affiliated: false }, min).reason, 'not_affiliated');
});

test('resolveAccount: several logins -> the one funded login, else needs_account', () => {
  const two = (a, b) => ({ accounts: { logins: ['1', '2'], items: [item('1', a), item('2', b)] } });
  assert.equal(resolveAccount(two(0, 300), min).wallet_id, '2');
  assert.equal(resolveAccount(two(0, 0), min).status, 'needs_account');
  assert.equal(resolveAccount(two(200, 300), min).status, 'needs_account');
});

test('verifyWallet: the typed ID must be one of the client logins; it is never replaced', () => {
  const data = { client_id: 5, country: 'India', accounts: { logins: ['111', '222'], items: [] } };
  assert.equal(verifyWallet(data, '222').status, 'active');
  assert.equal(verifyWallet(data, '222').wallet_id, undefined);
  const wrong = verifyWallet(data, '999');
  assert.equal(wrong.status, 'needs_account');
  assert.equal(wrong.reason, 'wallet_not_on_client');
  assert.equal(verifyWallet(null, '111').reason, 'client_not_found');
  assert.equal(verifyWallet({ affiliated: false }, '111').reason, 'not_affiliated');
});

// ---------- prepare jobs ----------
function fakeStore(traders) {
  const s = {
    traders: new Map(traders.map((t) => [t.email, { ...t }])),
    owners: new Map(),
    loadUnresolved: async () => [...s.traders.values()].filter((t) => ['pending', 'needs_account'].includes(t.status)),
    updateTrader: async (c, email, set) => {
      if (set.wallet_id && s.owners.has(set.wallet_id) && s.owners.get(set.wallet_id) !== email) return 'wallet_conflict';
      if (set.wallet_id) s.owners.set(set.wallet_id, email);
      Object.assign(s.traders.get(email), set);
      return 'ok';
    },
    loadUnsynced: async () => [...s.traders.values()].filter((t) => !t.google_sync || !t.google_sync.ok),
    markGoogle: async (c, email, ok) => {
      s.traders.get(email).google_sync = { ok };
    },
  };
  return s;
}

test('resolveTraders: activates matched, leaves unmatched pending, survives lookup failure, flags wallet conflict', async () => {
  const store = fakeStore([
    { email: 'a@x.com', status: 'pending' },
    { email: 'b@x.com', status: 'pending' },
    { email: 'c@x.com', status: 'pending' },
    { email: 'd@x.com', status: 'pending' },
  ]);
  const data = {
    'a@x.com': { client_id: 1, accounts: { logins: ['111'], items: [] } },
    'b@x.com': null, // not an Elefin client yet
    'd@x.com': { client_id: 4, accounts: { logins: ['111'], items: [] } }, // same wallet as a
  };
  const elefin = { lookupClient: async (email) => (email === 'c@x.com' ? { ok: false, error: 'down' } : { ok: true, data: data[email] }) };
  const out = await resolveTraders({ store, elefin, cfg });
  assert.equal(store.traders.get('a@x.com').status, 'active');
  assert.equal(store.traders.get('a@x.com').wallet_id, '111');
  assert.equal(store.traders.get('b@x.com').status, 'pending');
  assert.equal(store.traders.get('c@x.com').resolve_checked_at, undefined); // untouched, retried next tick
  assert.equal(store.traders.get('d@x.com').status, 'needs_account');
  assert.equal(store.traders.get('d@x.com').reason, 'wallet_conflict');
  assert.equal(out.activated, 1);
});

test('resolveTraders: a typed wallet is only verified, never swapped for another login', async () => {
  const store = fakeStore([
    { email: 'ok@x.com', status: 'pending', wallet_id: '222' },
    { email: 'typo@x.com', status: 'pending', wallet_id: '999' },
    { email: 'none@x.com', status: 'pending', wallet_id: '333' },
  ]);
  const clients = {
    'ok@x.com': { client_id: 1, accounts: { logins: ['111', '222'], items: [] } },
    'typo@x.com': { client_id: 2, accounts: { logins: ['444'], items: [] } },
    'none@x.com': null,
  };
  const out = await resolveTraders({ store, elefin: { lookupClient: async (e) => ({ ok: true, data: clients[e] }) }, cfg });
  assert.equal(store.traders.get('ok@x.com').status, 'active');
  assert.equal(store.traders.get('ok@x.com').wallet_id, '222'); // kept, not replaced
  assert.equal(store.traders.get('typo@x.com').status, 'needs_account');
  assert.equal(store.traders.get('typo@x.com').reason, 'wallet_not_on_client');
  assert.equal(store.traders.get('typo@x.com').wallet_id, '999'); // admin sees what they typed
  assert.equal(store.traders.get('none@x.com').status, 'pending');
  assert.equal(out.activated, 1);

  // a later Elefin sync that adds the account fixes a needs_account row without any admin work
  clients['typo@x.com'] = { client_id: 2, accounts: { logins: ['999'], items: [] } };
  await resolveTraders({ store, elefin: { lookupClient: async (e) => ({ ok: true, data: clients[e] }) }, cfg });
  assert.equal(store.traders.get('typo@x.com').status, 'active');
});

test('syncGoogle: marks success, stops quietly when no endpoint is configured', async () => {
  const store = fakeStore([{ email: 'a@x.com', status: 'pending' }]);
  assert.equal(await syncGoogle({ store, cfg, google: { postRegistration: async () => ({ ok: true }) } }), 1);
  assert.equal(store.traders.get('a@x.com').google_sync.ok, true);

  const store2 = fakeStore([{ email: 'a@x.com', status: 'pending' }]);
  assert.equal(await syncGoogle({ store: store2, cfg, google: { postRegistration: async () => ({ ok: false, skipped: true }) } }), 0);
  assert.equal(store2.traders.get('a@x.com').google_sync, undefined);
});

// ---------- API ----------
async function withApp({ store, google, now, cfg: c = cfg, limiter }, fn) {
  const app = createApp({ store, trigger: async () => {}, cfg: c, google, limiter, now });
  const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}
const post = (url, body) => fetch(`${url}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function regStore() {
  const rows = new Map();
  return {
    rows,
    marks: [],
    loadCurrent: async () => null,
    registerTrader: async (c, row) => {
      if (rows.has(row.email)) return false;
      if ([...rows.values()].some((r) => r.wallet_id === row.wallet_id)) return 'wallet_taken';
      rows.set(row.email, row);
      return true;
    },
    markGoogle: async function (c, email, ok) { this.marks.push([email, ok]); },
  };
}

test('POST /api/register: stores once, mirrors to Google once, identical response for a repeat', async () => {
  const store = regStore();
  const sent = [];
  const google = { postRegistration: async (row) => { sent.push(row.email); return { ok: true }; } };
  await withApp({ store, google, limiter: (q, r, n) => n() }, async (url) => {
    const a = await post(url, good);
    const b = await post(url, good);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.deepEqual(await a.json(), await b.json());
    await new Promise((r) => setTimeout(r, 30)); // let the background mirror finish
  });
  assert.equal(store.rows.size, 1);
  assert.equal(store.rows.get('yash@example.com').status, 'pending');
  assert.deepEqual(sent, ['yash@example.com']);
  assert.deepEqual(store.marks, [['yash@example.com', true]]);
});

test('POST /api/register: validation errors -> 400, honeypot stores nothing, bad Google never fails the request', async () => {
  const store = regStore();
  const google = { postRegistration: async () => { throw new Error('google down'); } };
  await withApp({ store, google, limiter: (q, r, n) => n() }, async (url) => {
    const bad = await post(url, { ...good, email: 'nope' });
    assert.equal(bad.status, 400);
    assert.ok((await bad.json()).errors.email);
    assert.equal((await post(url, { ...good, email: 'bot@x.com', website: 'spam.com' })).status, 201);
    assert.equal(store.rows.has('bot@x.com'), false);
    assert.equal((await post(url, good)).status, 201);
  });
  assert.equal(store.rows.size, 1);
});

test('POST /api/register: stores the wallet id, mirrors it to Google, refuses an ID that belongs to someone else', async () => {
  const store = regStore();
  const sent = [];
  const google = { postRegistration: async (row) => { sent.push(row.wallet_id); return { ok: true }; } };
  await withApp({ store, google, limiter: (q, r, n) => n() }, async (url) => {
    assert.equal((await post(url, good)).status, 201);
    const dup = await post(url, { ...good, email: 'other@example.com' });
    assert.equal(dup.status, 409);
    assert.ok((await dup.json()).errors.wallet_id);
    const missing = await post(url, { ...good, email: 'third@example.com', wallet_id: '' });
    assert.equal(missing.status, 400);
    await new Promise((r) => setTimeout(r, 30));
  });
  assert.equal(store.rows.get('yash@example.com').wallet_id, '12345992652');
  assert.equal(store.rows.size, 1);
  assert.deepEqual(sent, ['12345992652']);
});

test('POST /api/register: closed after the entry cutoff, open exactly at it', async () => {
  const store = regStore();
  const base = { store, google: { postRegistration: async () => ({ ok: true }) }, limiter: (q, r, n) => n() };
  await withApp({ ...base, now: () => comp.cutoffMs + 1 }, async (url) => assert.equal((await post(url, good)).status, 409));
  assert.equal(store.rows.size, 0);
  await withApp({ ...base, now: () => comp.cutoffMs }, async (url) => assert.equal((await post(url, good)).status, 201));
});

test('rateLimiter: blocks the 4th request in a window, frees after it', () => {
  let t = 0;
  const lim = rateLimiter({ max: 3, windowMs: 1000, now: () => t });
  const hit = () => { let code = 200; lim({ ip: '1.1.1.1' }, { status: (c) => ({ json: () => { code = c; } }) }, () => {}); return code; };
  assert.deepEqual([hit(), hit(), hit(), hit()], [200, 200, 200, 429]);
  t = 1500;
  assert.equal(hit(), 200);
});
