'use strict';

/* Mirrors each registration to the Google Apps Script web app that feeds the sheet. Server-side, best effort. */

const { config } = require('./config');

async function postRegistration(row, endpoint = config.googleFormEndpoint) {
  if (!endpoint) return { ok: false, skipped: true, error: 'GOOGLE_FORM_ENDPOINT not set' };
  const body = new URLSearchParams({
    // Admin-added traders have no phone/registered_at; send '' rather than the string "undefined".
    name: row.name || '',
    phone: row.phone || '',
    email: row.email,
    wallet_id: row.wallet_id || '',
    capital: row.declared_capital == null ? 'N/A' : String(row.declared_capital),
    timestamp: row.registered_at || row.added_at || '',
  });
  try {
    const res = await fetch(endpoint, { method: 'POST', body, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

module.exports = { postRegistration };
