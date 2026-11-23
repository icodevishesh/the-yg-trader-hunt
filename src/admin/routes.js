'use strict';

const path = require('path');
const express = require('express');
const auth = require('./auth');
const { AdminError } = require('./service');

const PAGE_FILE = path.resolve(__dirname, '../../admin/admin.html');

const guard = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    if (err instanceof AdminError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.field ? { field: err.field } : {}) } });
    }
    console.error('[admin]', err.message);
    return res.status(500).json({ error: { code: 'internal', message: 'Something went wrong.' } });
  });

/**
 * Admin HTTP API (admin-plan §2, §5). Mounted at ADMIN_PATH only when users and a strong
 * secret are configured. `service` is the shared module the CLI also uses.
 */
function createAdminRouter({ service, admin, now = Date.now, lockout = new auth.Lockout({ now }) }) {
  const router = express.Router();
  const { secret, users } = admin;

  router.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    next();
  });

  router.get('/', (req, res) => res.sendFile(PAGE_FILE));

  const json = express.json({ limit: '20kb' });
  // JSON-only writes: a cross-site HTML form cannot send this content type.
  router.use('/api', (req, res, next) => {
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('json')) {
      return res.status(415).json({ error: { code: 'json_required', message: 'Content-Type must be application/json.' } });
    }
    return next();
  }, json);

  router.post('/api/login', guard(async (req, res) => {
    const ip = req.ip;
    const mins = lockout.lockedMinutes(ip);
    if (mins) return res.status(429).json({ error: { code: 'locked', message: `Too many attempts, try again in ${mins} min.` } });

    const { username = '', password = '' } = req.body || {};
    const stored = users.get(String(username));
    // Always run a hash comparison so response time does not reveal which usernames exist.
    const ok = auth.verifyPassword(String(password), stored || users.values().next().value || 'scrypt.x.x') && !!stored;
    if (!ok) {
      lockout.fail(ip);
      await service.audit({ admin: String(username).slice(0, 50), ip }, 'login.fail', null, null, null, null).catch(() => {});
      return res.status(401).json({ error: { code: 'bad_login', message: 'Wrong username or password.' } });
    }
    lockout.ok(ip);
    await service.audit({ admin: username, ip }, 'login.ok', null, null, null, null).catch(() => {});
    const secure = req.secure ? '; Secure' : '';
    res.set('Set-Cookie', `${auth.COOKIE}=${auth.makeCookie(username, secret, now())}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${auth.SESSION_MS / 1000}${secure}`);
    return res.json({ ok: true, username });
  }));

  router.post('/api/logout', (req, res) => {
    res.set('Set-Cookie', `${auth.COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  // Everything below needs a valid, unexpired, correctly signed cookie.
  router.use('/api', (req, res, next) => {
    const user = auth.readCookie(auth.parseCookies(req.headers.cookie)[auth.COOKIE], secret, now());
    if (!user || !users.has(user)) return res.status(401).json({ error: { code: 'unauthorized', message: 'Please sign in.' } });
    req.ctx = { admin: user, ip: req.ip };
    return next();
  });

  const body = (req) => req.body || {};
  const h = (fn) => guard(async (req, res) => res.json(await fn(req)));

  router.get('/api/me', h(async (req) => ({ username: req.ctx.admin, ...(await service.me()) })));
  router.get('/api/traders', h((req) => service.listTraders(req.query)));
  router.post('/api/traders', guard(async (req, res) => res.status(201).json(await service.addTrader(req.ctx, body(req)))));
  router.patch('/api/traders/:email', h((req) => service.updateTrader(req.ctx, req.params.email, body(req))));
  router.post('/api/traders/:email/status', h((req) => service.setStatus(req.ctx, req.params.email, body(req))));
  router.post('/api/traders/:email/check', h((req) => service.checkTrader(req.ctx, req.params.email)));
  router.post('/api/traders/:email/identity', h((req) => service.correctIdentity(req.ctx, req.params.email, body(req))));
  router.get('/api/traders/:email/baseline', h((req) => service.getBaseline(req.params.email)));
  router.post('/api/traders/:email/baseline/preview', h((req) => service.previewBaseline(req.params.email, body(req))));
  router.put('/api/traders/:email/baseline', h((req) => service.setBaseline(req.ctx, req.params.email, body(req))));
  router.get('/api/manual/:wallet', h((req) => service.getManual(req.params.wallet)));
  router.put('/api/manual/:wallet', h((req) => service.setManual(req.ctx, req.params.wallet, body(req))));
  router.post('/api/manual/:wallet/disable', h((req) => service.disableManual(req.ctx, req.params.wallet, body(req))));
  router.post('/api/preview/:wallet', h((req) => service.preview(req.params.wallet, body(req))));
  router.get('/api/rounds', h(() => service.rounds()));
  router.post('/api/rounds/:round/finalize', guard(async (req, res) => res.status(202).json(await service.finalizeRound(req.ctx, req.params.round, body(req)))));
  router.get('/api/week2/entrants', h((req) => service.listWeek2(req.query)));
  router.post('/api/week2/entrants', guard(async (req, res) => res.status(201).json(await service.addWeek2Entrant(req.ctx, body(req)))));
  router.put('/api/week2/host', h((req) => service.setWeek2Host(req.ctx, body(req))));
  router.get('/api/week2/manual/:wallet', h((req) => service.getManual(req.params.wallet, 'week2')));
  router.put('/api/week2/manual/:wallet', h((req) => service.setManual(req.ctx, req.params.wallet, body(req), 'week2')));
  router.post('/api/week2/manual/:wallet/disable', h((req) => service.disableManual(req.ctx, req.params.wallet, body(req), 'week2')));
  router.post('/api/week2/preview/:wallet', h((req) => service.preview(req.params.wallet, body(req), 'week2')));
  router.post('/api/week2/entrants/:email/remove', h((req) => service.removeWeek2Entrant(req.ctx, req.params.email, body(req))));
  router.post('/api/rescore', h((req) => service.rescore(req.ctx)));
  router.post('/api/pnl-fix', h((req) => service.fixPnlMismatch(req.ctx, body(req))));
  router.get('/api/audit', h((req) => service.listAudit(req.query)));
  router.use('/api', (req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Not found.' } }));

  return router;
}

/** True when the admin panel is safely configured; otherwise its routes are not mounted. */
function adminEnabled(admin) {
  // Exactly one admin account is allowed.
  return admin.users.size === 1 && admin.secret.length >= 32 && /^\/[A-Za-z0-9_-]{4,}$/.test(admin.path);
}

module.exports = { createAdminRouter, adminEnabled };
