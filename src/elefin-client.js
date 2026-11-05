'use strict';

/*
 * Low-level Elefin Client Data API client (auth, retry, paging).
 * Auth: Authorization: Bearer <KEY>.<SECRET>
 *
 *   request(endpoint, params)    raw GET with one retry on 429 / 5xx / network error
 *   getAccountTrades(login, rng) GET /accounts/{login}/trades   closed trades, date-bounded
 *   getTransactions({type, rng}) GET /transactions               deposits / withdrawals
 *   getAccountPositions(login)   GET /accounts/{login}/positions open positions
 *   me()                         GET /me                         health + rate limit
 *   getAllClients()              GET /clients                    every referred client
 *
 * The throttled wrapper the app uses is src/elefin.js.
 */

const { config } = require('./config');

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
  return { Authorization: `Bearer ${config.elefin.key}.${config.elefin.secret}`, Accept: 'application/json' };
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
      return { success: true, status: res.status, data: body, rateLimitRemaining: Number(res.headers.get('x-ratelimit-remaining')) || null };
    }
    return { success: false, status: res.status, error: ERROR_MESSAGES[res.status] || `HTTP ${res.status}`, data: body };
  } catch (err) {
    const aborted = err.name === 'AbortError';
    return { success: false, status: null, error: aborted ? 'Request timed out.' : String(err.message || err), data: null };
  } finally {
    clearTimeout(timer);
  }
}

// One retry on 429 / 5xx / network error, with a short backoff.
async function request(endpoint, params) {
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

// The tech team's rule: a bare date `to=2026-09-30` is read as midnight and silently drops the
// final day. Always send a full UTC instant: `2026-09-30T23:59:59Z`.
function toApiInstant(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function cleanParams(obj) {
  const out = {};
  for (const [k, val] of Object.entries(obj || {})) {
    if (val === undefined || val === null || val === '') continue;
    out[k] = k === 'from' || k === 'to' ? toApiInstant(val) : val;
  }
  return out;
}

// Rows come in several envelopes: [..] | { data: [..] } | { data: { data: [..], meta } } | { data: {..} }
function extractRows(payload) {
  if (Array.isArray(payload)) return { rows: payload, meta: null };
  const inner = payload && typeof payload === 'object' ? payload.data : null;
  if (Array.isArray(inner)) return { rows: inner, meta: (payload && payload.meta) || null };
  if (inner && Array.isArray(inner.data)) return { rows: inner.data, meta: inner.meta || null };
  if (inner && typeof inner === 'object') return { rows: [inner], meta: null };
  return { rows: [], meta: null };
}

// Pages until a short or empty page, or meta says it was the last one.
async function pageAll(endpoint, params, { pageParam = 'page', sizeParam = 'limit', size = 200, delayMs = 250, maxPages = 500 } = {}) {
  const all = [];
  let meta = null;
  for (let page = 1; page <= maxPages; page += 1) {
    const r = await request(endpoint, { ...params, [pageParam]: page, [sizeParam]: size });
    if (!r.success) return { ok: false, error: r.error, status: r.status, rows: all };
    const ex = extractRows(r.data);
    all.push(...ex.rows);
    meta = ex.meta || meta;
    const lastByMeta =
      meta && Number.isFinite(Number(meta.last_page)) && Number.isFinite(Number(meta.current_page)) && Number(meta.current_page) >= Number(meta.last_page);
    if (ex.rows.length < size || ex.rows.length === 0 || lastByMeta) break;
    await sleep(delayMs);
  }
  return { ok: true, rows: all, meta };
}

/** Closed trades for one MT5 login in [from, to]. -> { ok, rows } */
function getAccountTrades(login, { from, to } = {}) {
  return pageAll(`/accounts/${encodeURIComponent(String(login))}/trades`, cleanParams({ from, to }));
}

/** Money movements in [from, to], optionally one type ('deposit' | 'withdrawal'). -> { ok, rows } */
function getTransactions({ type, from, to } = {}) {
  return pageAll('/transactions', cleanParams({ type, from, to }));
}

/** Open positions for one MT5 login. -> { ok, rows, as_of } */
async function getAccountPositions(login) {
  const r = await request(`/accounts/${encodeURIComponent(String(login))}/positions`);
  if (!r.success) return { ok: false, error: r.error, status: r.status, rows: [] };
  // Shape seen live: { data: { login, affiliated, positions: [...], as_of } }
  const body = r.data && r.data.data !== undefined ? r.data.data : r.data;
  if (body && Array.isArray(body.positions)) return { ok: true, rows: body.positions, as_of: body.as_of || null };
  const ex = extractRows(r.data);
  return { ok: true, rows: ex.rows, as_of: (body && body.as_of) || (ex.meta && ex.meta.as_of) || null };
}

async function me() {
  const r = await request('/me');
  if (!r.success) return { ok: false, error: r.error, status: r.status };
  return { ok: true, data: r.data && r.data.data ? r.data.data : r.data, rateLimitRemaining: r.rateLimitRemaining };
}

/** Pages GET /clients until a short page. -> { ok, clients, total } */
async function getAllClients({ perPage = 100 } = {}) {
  const all = [];
  let total = null;
  for (let page = 1; ; page += 1) {
    const r = await request('/clients', { page, per_page: perPage });
    if (!r.success) return { ok: false, error: r.error, status: r.status, clients: all };
    const ex = extractRows(r.data);
    if (ex.meta && typeof ex.meta.total === 'number') total = ex.meta.total;
    all.push(...ex.rows);
    if (ex.rows.length < perPage) break;
    await sleep(250);
  }
  return { ok: true, clients: all, total: total === null ? all.length : total };
}

module.exports = { request, getAccountTrades, getTransactions, getAccountPositions, me, getAllClients };
