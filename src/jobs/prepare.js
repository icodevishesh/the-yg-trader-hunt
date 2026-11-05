'use strict';

const { resolveAccount, verifyWallet } = require('../domain/registration');

const MAX_SYNC_ATTEMPTS = 5;

/**
 * Checks pending registrations against Elefin by email. A trader who typed an account ID is only
 * verified (the ID must belong to their client); one without an ID falls back to auto-detection.
 */
async function resolveTraders({ store, elefin, cfg, limit = 40 }) {
  const cohort = cfg.competition.cohort;
  const out = { checked: 0, activated: 0, needs_account: 0 };
  for (const t of await store.loadUnresolved(cohort, limit)) {
    const r = await elefin.lookupClient(t.email);
    if (!r.ok) continue; // transient failure: leave untouched and retry next tick
    out.checked += 1;
    const res = t.wallet_id
      ? verifyWallet(r.data, String(t.wallet_id))
      : resolveAccount(r.data, { minCapitalUsd: cfg.scoring.minCapitalUsd });
    const set = { status: res.status, reason: res.reason || null, resolve_checked_at: new Date().toISOString() };
    if (res.client_id != null) set.client_id = res.client_id;
    if (res.country) set.country = res.country;
    if (res.wallet_id && !t.wallet_id) set.wallet_id = res.wallet_id;
    const saved = await store.updateTrader(cohort, t.email, set);
    if (saved === 'wallet_conflict') {
      await store.updateTrader(cohort, t.email, { status: 'needs_account', reason: 'wallet_conflict' });
      out.needs_account += 1;
    } else if (res.status === 'active') out.activated += 1;
    else if (res.status === 'needs_account') out.needs_account += 1;
  }
  return out;
}

/** Retries registrations that have not reached the Google sheet yet. */
async function syncGoogle({ store, google, cfg, limit = 20 }) {
  const cohort = cfg.competition.cohort;
  let synced = 0;
  for (const t of await store.loadUnsynced(cohort, MAX_SYNC_ATTEMPTS, limit)) {
    const r = await google.postRegistration(t);
    if (r.skipped) break;
    await store.markGoogle(cohort, t.email, r.ok, r.error);
    if (r.ok) synced += 1;
  }
  return synced;
}

module.exports = { resolveTraders, syncGoogle, MAX_SYNC_ATTEMPTS };
