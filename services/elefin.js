'use strict';

/*
 * Minimal Elefin Client Data API client — a JS port of
 * tele_approval_bot/bot/services/elefin_service.py.
 *
 * Auth:  Authorization: Bearer <KEY>.<SECRET>
 * Only two calls are used:
 *   me()            -> GET /me                       (health / rate-limit check)
 *   getAllClients() -> GET /clients?page&per_page    (paged; our referred clients only)
 *
 * The /clients list row already carries funding / accounts / trading aggregates,
 * so no per-account calls are needed.
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

module.exports = { me, getAllClients };
