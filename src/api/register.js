'use strict';

const express = require('express');
const { validateRegistration } = require('../domain/registration');

/** Small in-memory limiter: `max` requests per `windowMs` per IP. */
function rateLimiter({ max, windowMs, now = Date.now }) {
  const hits = new Map();
  return (req, res, next) => {
    const t = now();
    const recent = (hits.get(req.ip) || []).filter((x) => t - x < windowMs);
    if (recent.length >= max) return res.status(429).json({ ok: false, error: 'Too many attempts. Please try again in a minute.' });
    recent.push(t);
    hits.set(req.ip, recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => t - x < windowMs)) hits.delete(k);
    return next();
  };
}

/**
 * POST /api/register: stores the registration, then mirrors it to Google in the background.
 * The response is identical for new and repeat emails, so it cannot be used to probe who is registered.
 */
function createRegisterRouter({ store, google, cfg, now = Date.now, limiter = rateLimiter({ max: 5, windowMs: 60000 }) }) {
  const router = express.Router();
  const comp = cfg.competition;

  router.post('/api/register', limiter, express.json({ limit: '10kb' }), async (req, res) => {
    if (req.body && req.body.website) return res.status(201).json({ ok: true }); // honeypot: pretend success
    const { errors, value } = validateRegistration(req.body);
    if (Object.keys(errors).length) return res.status(400).json({ ok: false, errors });

    if (!cfg.errors.length && now() > comp.cutoffMs) {
      return res.status(409).json({ ok: false, error: 'Entries are closed for this session.' });
    }

    try {
      const row = { ...value, cohort: comp.cohort, status: 'pending', registered_at: new Date(now()).toISOString() };
      const created = await store.registerTrader(comp.cohort, row);
      if (created === 'wallet_taken') {
        return res.status(409).json({ ok: false, errors: { wallet_id: 'That account ID is already registered. Check the number, or contact support.' } });
      }
      if (created) {
        // Fire and forget; failures are retried by the scheduler (google_sync.attempts).
        google.postRegistration(row)
          .then((r) => (r.skipped ? null : store.markGoogle(comp.cohort, row.email, r.ok, r.error)))
          .catch((e) => console.error('[register] google sync', e.message));
      }
      return res.status(201).json({ ok: true });
    } catch (err) {
      console.error('[register]', err.message);
      return res.status(503).json({ ok: false, error: 'Registration is temporarily unavailable. Please try again.' });
    }
  });

  return router;
}

module.exports = { createRegisterRouter, rateLimiter };
