'use strict';

/*
 * Dump EVERY Elefin API response for one trader to disk, verbatim.
 *
 *   node scripts/elefin-dump.js                              # default: ericagarg1@gmail.com
 *   node scripts/elefin-dump.js --email someone@example.com
 *   node scripts/elefin-dump.js --login 12345790671
 *   node scripts/elefin-dump.js --from 2026-08-01T00:00:00Z --to 2026-10-01T00:00:00Z
 *   node scripts/elefin-dump.js --out-dir data/elefin-dump
 *
 * Writes one file per HTTP response under
 *   <out-dir>/<email-or-login>/<timestamp>/<label>.json
 * each = { label, endpoint, params, requested_at, http_status, ok, error,
 *          rate_limit_remaining, body }   (body = the raw response payload)
 * plus a _manifest.json listing every call.
 *
 * Endpoints hit: /me, /clients/lookup, /clients (paged fallback),
 * /accounts/{login}, /accounts/{login}/positions,
 * /accounts/{login}/trades (every page), /transactions?type=deposit|withdrawal (every page).
 */

const fs = require('fs');
const path = require('path');
const elefin = require('../services/elefin');

const ARGV = process.argv.slice(2);
const argVal = (n, d) => {
  const i = ARGV.indexOf(n);
  return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : d;
};

const EMAIL = argVal('--email', 'subhashbetal@gmail.com').toLowerCase();
const ONLY_LOGIN = argVal('--login', null);
const FROM = argVal('--from', '2026-08-01T00:00:00Z');
const TO = argVal('--to', '2026-10-01T00:00:00Z');
const OUT_ROOT = path.resolve(process.cwd(), argVal('--out-dir', 'data/elefin-dump'));
const SLEEP_MS = Number(argVal('--sleep', '1100'));
const PAGE = 200;

const slug = (s) => String(s).replace(/[^a-z0-9._@-]+/gi, '_').slice(0, 80);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

async function main() {
  const outDir = path.join(OUT_ROOT, slug(ONLY_LOGIN || EMAIL), stamp);
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`\n  Elefin dump  ->  ${path.relative(process.cwd(), outDir)}`);
  console.log(`  target: ${ONLY_LOGIN ? 'login ' + ONLY_LOGIN : 'email ' + EMAIL}   range ${FROM} .. ${TO}\n`);

  const calls = [];
  let n = 0;

  async function dump(label, endpoint, params) {
    n += 1;
    const requestedAt = new Date().toISOString();
    let r;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      r = await elefin.request(endpoint, params);
      if (r.success || !/rate limit/i.test(r.error || '')) break;
      process.stderr.write('   rate limited — waiting 65s …\n');
      await sleep(65000);
    }
    const record = {
      label,
      endpoint,
      params: params || null,
      requested_at: requestedAt,
      http_status: r.status ?? null,
      ok: !!r.success,
      error: r.error || null,
      rate_limit_remaining: r.rateLimitRemaining ?? null,
      body: r.success ? r.data : (r.data ?? null),
    };
    const file = path.join(outDir, `${String(n).padStart(2, '0')}-${slug(label)}.json`);
    fs.writeFileSync(file, JSON.stringify(record, null, 2));
    calls.push({ n, label, endpoint, params: params || null, ok: record.ok, http_status: record.http_status, file: path.basename(file) });
    console.log(`  ${record.ok ? 'ok ' : 'ERR'}  ${String(n).padStart(2)}  ${label}   (${endpoint}${params ? ' ' + JSON.stringify(params) : ''})`);
    await sleep(SLEEP_MS);
    return r;
  }

  // rows out of any Elefin envelope shape
  const rowsOf = (body) => {
    if (Array.isArray(body)) return body;
    const inner = body && typeof body === 'object' ? body.data : null;
    if (Array.isArray(inner)) return inner;
    if (inner && Array.isArray(inner.data)) return inner.data;
    return [];
  };

  // 1. /me
  await dump('me', '/me');

  // 2. resolve the client
  let client = null;
  const lk = await dump('clients-lookup', '/clients/lookup', { email: EMAIL });
  if (lk.success) {
    const b = lk.data;
    client = (b && b.data && !Array.isArray(b.data) ? b.data : null) || (Array.isArray(b) ? b[0] : null) || (b && b.email ? b : null);
    if (b && Array.isArray(b.data)) client = b.data.find((c) => String(c.email || '').toLowerCase() === EMAIL) || b.data[0];
  }
  if (!client) {
    // paged fallback over /clients
    for (let page = 1; page <= 20; page += 1) {
      const r = await dump(`clients-page-${page}`, '/clients', { page, per_page: 100 });
      if (!r.success) break;
      const rows = rowsOf(r.data);
      const hit = rows.find((c) => String(c.email || '').toLowerCase() === EMAIL || (ONLY_LOGIN && (c.accounts?.logins || []).map(String).includes(String(ONLY_LOGIN))));
      if (hit) { client = hit; break; }
      if (rows.length < 100) break;
    }
  }

  const logins = ONLY_LOGIN
    ? [String(ONLY_LOGIN)]
    : client && client.accounts && Array.isArray(client.accounts.logins)
    ? client.accounts.logins.map(String)
    : [];

  if (!logins.length) {
    console.log('\n  ! could not resolve any MT5 login for this trader — stopping after client lookup.\n');
  }

  // 3. per-login: account, positions, all trade pages
  for (const login of logins) {
    await dump(`account-${login}`, `/accounts/${encodeURIComponent(login)}`);
    await dump(`positions-${login}`, `/accounts/${encodeURIComponent(login)}/positions`);
    for (let page = 1; page <= 100; page += 1) {
      const r = await dump(`trades-${login}-p${page}`, `/accounts/${encodeURIComponent(login)}/trades`, { page, limit: PAGE, from: FROM, to: TO });
      if (!r.success) break;
      if (rowsOf(r.data).length < PAGE) break;
    }
  }

  // 4. transactions (deposits + withdrawals), all pages
  for (const type of ['deposit', 'withdrawal']) {
    for (let page = 1; page <= 100; page += 1) {
      const r = await dump(`transactions-${type}-p${page}`, '/transactions', { type, from: FROM, to: TO, page, limit: PAGE });
      if (!r.success) break;
      if (rowsOf(r.data).length < PAGE) break;
    }
  }

  const manifest = {
    email: EMAIL,
    login_arg: ONLY_LOGIN || null,
    resolved_client_id: client ? client.client_id : null,
    resolved_name: client ? client.name : null,
    logins,
    range: { from: FROM, to: TO },
    generated_at: new Date().toISOString(),
    call_count: calls.length,
    calls,
  };
  fs.writeFileSync(path.join(outDir, '_manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`\n  ${calls.length} responses stored  ·  ${calls.filter((c) => !c.ok).length} errors`);
  console.log(`  manifest -> ${path.relative(process.cwd(), path.join(outDir, '_manifest.json'))}\n`);
}

main().catch((err) => {
  console.error('\n  elefin-dump failed:', err && err.stack ? err.stack : err, '\n');
  process.exit(1);
});
