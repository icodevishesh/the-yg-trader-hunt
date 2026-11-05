'use strict';

/* Pure registration rules: input validation and Elefin account resolution. */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function validateRegistration(body) {
  const b = body && typeof body === 'object' ? body : {};
  const errors = {};
  const name = clean(b.name, 100);
  const email = clean(b.email, 254).toLowerCase();
  const phone = clean(b.phone, 30);
  const digits = phone.replace(/\D/g, '');

  if (!name) errors.name = 'Please enter your name.';
  if (!email) errors.email = 'Please enter your email.';
  else if (!EMAIL_RE.test(email)) errors.email = 'Please enter a valid email address.';
  if (!digits) errors.phone = 'Please enter your WhatsApp number.';
  else if (digits.length < 8 || digits.length > 15) errors.phone = 'That number does not look right.';
  const wallet = String(b.wallet_id ?? '').trim();
  if (!/^\d{6,15}$/.test(wallet)) errors.wallet_id = 'Enter your trading account ID (digits only).';
  if (b.agree !== true) errors.agree = 'Please confirm your account and the rules.';

  let capital = null;
  if (b.capital !== undefined && b.capital !== null && b.capital !== '' && b.capital !== 'N/A') {
    capital = Number(b.capital);
    if (!Number.isFinite(capital) || capital < 0 || capital > 1e7) errors.capital = 'Capital must be a number.';
  }
  return { errors, value: { name, email, phone, wallet_id: wallet, declared_capital: capital } };
}

/**
 * Verifies the account ID the trader typed in the form against their Elefin client.
 *   active         the wallet id is one of this client's logins
 *   needs_account  the client exists but does not own that id (typo or someone else's account)
 *   pending        no Elefin client yet; re-checked later
 */
function verifyWallet(data, wallet) {
  if (!data) return { status: 'pending', reason: 'client_not_found' };
  if (data.affiliated === false) return { status: 'pending', reason: 'not_affiliated' };
  const items = (data.accounts && data.accounts.items) || [];
  const logins = ((data.accounts && data.accounts.logins) || items.map((i) => i.login)).map(String);
  const base = { client_id: data.client_id ?? null, country: data.country || null };
  return logins.includes(String(wallet))
    ? { ...base, status: 'active' }
    : { ...base, status: 'needs_account', reason: 'wallet_not_on_client' };
}

/**
 * Picks the single competition account from an Elefin /clients/lookup payload.
 *   active         exactly one usable login (or exactly one funded login among several)
 *   pending        client/account does not exist yet; re-checked later
 *   needs_account  several candidate logins; an organiser must choose
 */
function resolveAccount(data, { minCapitalUsd }) {
  if (!data) return { status: 'pending', reason: 'client_not_found' };
  if (data.affiliated === false) return { status: 'pending', reason: 'not_affiliated' };

  const items = (data.accounts && data.accounts.items) || [];
  const logins = ((data.accounts && data.accounts.logins) || items.map((i) => i.login)).map(String);
  const base = { client_id: data.client_id ?? null, country: data.country || null };

  if (!logins.length) return { ...base, status: 'pending', reason: 'no_trading_account' };
  if (logins.length === 1) return { ...base, status: 'active', wallet_id: logins[0] };

  const funded = items.filter((i) => Number(i.equity) >= minCapitalUsd);
  if (funded.length === 1) return { ...base, status: 'active', wallet_id: String(funded[0].login) };
  return { ...base, status: 'needs_account', reason: 'multiple_accounts' };
}

module.exports = { validateRegistration, resolveAccount, verifyWallet };
