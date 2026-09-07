'use strict';

/*
 * Elefin Client Data API client — a JS port of
 * tele_approval_bot/bot/services/elefin_service.py.
 *
 * Auth:  Authorization: Bearer <KEY>.<SECRET>
 *
 *   me()                        -> GET /me                              (health / rate limit)
 *   getAllClients()             -> GET /clients?page&per_page           (our referred clients)
 *   getAccountTrades(login,rng) -> GET /accounts/{login}/trades?from&to (closed trades, date-bounded)
 *   getTransactions({type,rng}) -> GET /transactions?type&from&to       (deposits/withdrawals in a window)
 *   getAccountPositions(login)  -> GET /accounts/{login}/positions      (open positions, with as_of)
 *
 * The window scorer (scripts/window-score.js) uses the trades + transactions
 * endpoints for a real date-bounded P&L and a real deposit ledger, rather than
 * diffing lifetime aggregates from /clients.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

const ERROR_MESSAGES = {
  400: 'Bad Request - check request parameters.',
  401: 'Unauthorized - check API credentials.',
  403: 'Forbidden - API key may not have the required permissions.',
  404: 'Resource not found.',
  422: 'Validation error.',
  429: 'Rate limit exceeded.',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function headers() {
  const token = `${config.elefin.key}.${config.elefin.secret}`;
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' };
}

async function rawGet(endpoint, params) {
  const url = new URL(`${config.elefin.baseUrl}${endpoint}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.elefin.timeoutMs);
  try {
    const res = await fetch(url, { headers: headers(), signal: controller.signal });
    let body;
    try {
      body = await res.json();
    } catch {
      body = { raw_response: await res.text().catch(() => '') };
    }
    if (res.ok) {
      return {
        success: true,
        status: res.status,
        data: body,
        rateLimitRemaining: Number(res.headers.get('x-ratelimit-remaining')) || null,
      };
    }
    return {
      success: false,
      status: res.status,
      error: ERROR_MESSAGES[res.status] || `HTTP ${res.status}`,
      data: body,
    };
  } catch (err) {
    const aborted = err.name === 'AbortError';
    return { success: false, status: null, error: aborted ? 'Request timed out.' : String(err.message || err), data: null };
  } finally {
    clearTimeout(timer);
  }
}

// One retry on 429 / 5xx / network error, with linear backoff.
async function get(endpoint, params) {
  let last;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    last = await rawGet(endpoint, params);
    if (last.success) return last;
    const retryable = last.status === null || last.status === 429 || (last.status >= 500 && last.status < 600);
    if (!retryable || attempt === 1) return last;
    await sleep(600 * (attempt + 1));
  }
  return last;
}

function loadFixture() {
  const p = path.resolve(__dirname, '../fixtures/elefin-sample.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// The tech team's rule: a bare date `to=2026-09-30` is read as midnight and
// silently drops the final day. Send a full instant with an explicit zone.
// We normalise any input to UTC ISO without milliseconds -> `2026-09-30T23:59:59Z`.
function toApiInstant(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function cleanParams(obj) {
  const out = {};
  for (const [k, val] of Object.entries(obj || {})) {
    if (val === undefined || val === null || val === '') continue;
    out[k] = k === 'from' || k === 'to' ? toApiInstant(val) : val;
  }
  return out;
}

// Pull rows out of the several envelope shapes Elefin uses:
//   [ ... ]  |  { data: [ ... ] }  |  { data: { data: [ ... ], meta } }  |  { data: { ...one } }
function extractRows(payload) {
  if (Array.isArray(payload)) return { rows: payload, meta: null };
  const inner = payload && typeof payload === 'object' ? payload.data : null;
  if (Array.isArray(inner)) return { rows: inner, meta: (payload && payload.meta) || null };
  if (inner && Array.isArray(inner.data)) return { rows: inner.data, meta: inner.meta || null };
  if (inner && typeof inner === 'object') return { rows: [inner], meta: null };
  return { rows: [], meta: null };
}

// Generic pager. Stops on a short page, an empty page, or meta.current_page >= meta.last_page.
async function pageAll(endpoint, params, { pageParam = 'page', sizeParam = 'limit', size = 200, delayMs = 250, maxPages = 500 } = {}) {
  const all = [];
  let meta = null;
  for (let page = 1; page <= maxPages; page += 1) {
    const r = await get(endpoint, { ...params, [pageParam]: page, [sizeParam]: size });
    if (!r.success) return { ok: false, error: r.error, status: r.status, rows: all };
    const ex = extractRows(r.data);
    all.push(...ex.rows);
    meta = ex.meta || meta;
    const lastByMeta =
      meta &&
      Number.isFinite(Number(meta.last_page)) &&
      Number.isFinite(Number(meta.current_page)) &&
      Number(meta.current_page) >= Number(meta.last_page);
    if (ex.rows.length < size || ex.rows.length === 0 || lastByMeta) break;
    await sleep(delayMs);
  }
  return { ok: true, rows: all, meta };
}

/**
 * Closed trades for one MT5 login, bounded to [from, to].
 *   -> { ok: true, rows: [ { profit, ... } ] } | { ok: false, error, rows }
 */
async function getAccountTrades(login, { from, to } = {}) {
  if (config.mockElefin) return { ok: true, rows: [] };
  return pageAll(`/accounts/${encodeURIComponent(String(login))}/trades`, cleanParams({ from, to }), {
    pageParam: 'page',
    sizeParam: 'limit',
  });
}

/**
 * Money movements in [from, to], optionally filtered by type ('deposit' | 'withdrawal').
 * Each row carries amount, a timestamp and the MT5 login.
 *   -> { ok: true, rows: [...] } | { ok: false, error, rows }
 */
async function getTransactions({ type, from, to } = {}) {
  if (config.mockElefin) return { ok: true, rows: [] };
  return pageAll('/transactions', cleanParams({ type, from, to }), { pageParam: 'page', sizeParam: 'limit' });
}

/**
 * Open positions for one MT5 login (net_profit on /clients is closed trades only,
 * so anything still open at the cut-off shows up here, with an as_of timestamp).
 *   -> { ok: true, rows: [...], as_of } | { ok: false, error, rows }
 */
async function getAccountPositions(login) {
  if (config.mockElefin) return { ok: true, rows: [], as_of: null };
  const r = await get(`/accounts/${encodeURIComponent(String(login))}/positions`);
  if (!r.success) return { ok: false, error: r.error, status: r.status, rows: [] };
  // Shape seen live: { data: { login, affiliated, positions: [...], as_of } }
  const body = r.data && r.data.data !== undefined ? r.data.data : r.data;
  let rows = [];
  let asOf = null;
  if (body && Array.isArray(body.positions)) {
    rows = body.positions;
    asOf = body.as_of || null;
  } else {
    const ex = extractRows(r.data);
    rows = ex.rows;
    asOf = (body && body.as_of) || (ex.meta && ex.meta.as_of) || null;
  }
  return { ok: true, rows, as_of: asOf };
}

async function me() {
  if (config.mockElefin) {
    return { ok: true, data: { scope: { partner: { name: 'MOCK', code: 'MOCK' } } }, rateLimitRemaining: 999 };
  }
  const r = await get('/me');
  if (!r.success) return { ok: false, error: r.error, status: r.status };
  const data = r.data && r.data.data ? r.data.data : r.data;
  return { ok: true, data, rateLimitRemaining: r.rateLimitRemaining };
}

/**
 * Pages GET /clients until a short page. Returns
 *   { ok: true, clients: [...], total } | { ok: false, error, clients: [...] }
 * On a mid-pagination failure, `clients` holds whatever was fetched first.
 */
async function getAllClients({ perPage = config.elefin.perPage } = {}) {
  if (config.mockElefin) {
    const clients = loadFixture();
    return { ok: true, clients, total: clients.length };
  }

  const all = [];
  let page = 1;
  let total = null;

  for (;;) {
    const r = await get('/clients', { page, per_page: perPage });
    if (!r.success) return { ok: false, error: r.error, status: r.status, clients: all };

    const payload = r.data;
    const inner = payload && typeof payload === 'object' ? payload.data : null;
    let rows = [];
    if (Array.isArray(inner)) {
      rows = inner;
    } else if (inner && Array.isArray(inner.data)) {
      rows = inner.data;
      if (inner.meta && typeof inner.meta.total === 'number') total = inner.meta.total;
    } else if (Array.isArray(payload)) {
      rows = payload;
    }

    all.push(...rows);
    if (rows.length < perPage) break;
    page += 1;
    await sleep(250);
  }

  return { ok: true, clients: all, total: total === null ? all.length : total };
}

module.exports = { me, getAllClients, getAccountTrades, getTransactions, getAccountPositions };
