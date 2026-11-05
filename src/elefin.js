'use strict';

/*
 * Thin, throttled Elefin client for the Season-2 backend. Auth, retry and paging
 * use ./elefin-client; this layer adds the per-account
 * lookup and a global request spacing (key quota = 60 req/min).
 */

const client = require('./elefin-client');
const { config } = require('./config');

let chain = Promise.resolve();
const sleep = (n) => new Promise((r) => setTimeout(r, n));

/** Serialises calls and spaces them by ELEFIN_MIN_INTERVAL_MS. */
function throttled(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => sleep(config.elefin.minIntervalMs), () => sleep(config.elefin.minIntervalMs));
  return run;
}

/** GET /accounts/{login} -> { ok, account } */
function getAccount(login) {
  return throttled(async () => {
    const r = await client.request(`/accounts/${encodeURIComponent(String(login))}`);
    if (!r.success) return { ok: false, error: r.error, status: r.status };
    const body = r.data && r.data.data !== undefined ? r.data.data : r.data;
    return { ok: true, account: body };
  });
}

/** Closed trades for one login in [from, to]. */
function getTrades(login, range) {
  return throttled(() => client.getAccountTrades(login, range));
}

/** Deposits or withdrawals in [from, to] across the partner. */
function getTransactions(type, range) {
  return throttled(() => client.getTransactions({ type, ...range }));
}

/** GET /clients/lookup?email= -> { ok, data } (data is null when the client does not exist yet). */
function lookupClient(email) {
  return throttled(async () => {
    const r = await client.request('/clients/lookup', { email });
    if (r.status === 404) return { ok: true, data: null };
    if (!r.success) return { ok: false, error: r.error, status: r.status };
    return { ok: true, data: r.data && r.data.data !== undefined ? r.data.data : r.data };
  });
}

module.exports = { getAccount, getTrades, getTransactions, lookupClient };
