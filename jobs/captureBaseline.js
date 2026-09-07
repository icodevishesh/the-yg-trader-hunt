'use strict';

/*
 * Freeze every cohort participant's Elefin state into `lb_baseline`. plan.md §3.
 * Callable from the CLI wrapper (scripts/capture-baseline.js) and from the
 * scheduler (auto-run at the start line if the collection is empty).
 */

const os = require('os');
const config = require('../config');
const { connect, COLLECTIONS } = require('../db/mongo');
const elefin = require('../services/elefin');
const { normalizeClient, baselineFromClient } = require('../services/scoring');

async function captureBaseline({ force = false } = {}) {
  const db = await connect();

  const now = new Date();
  const startMs = Date.parse(config.competition.start);
  const graceEndMs = startMs + config.competition.baselineGraceHours * 3600 * 1000;
  const afterStart = now.getTime() >= startMs;
  const afterGrace = now.getTime() > graceEndMs;
  const cohort = config.competition.cohort;

  const meRes = await elefin.me();
  if (!meRes.ok) return { ok: false, error: `Elefin /me failed: ${meRes.error}` };

  const clientsRes = await elefin.getAllClients();
  if (!clientsRes.ok) return { ok: false, error: `Elefin /clients failed: ${clientsRes.error}` };

  const byEmail = new Map();
  for (const raw of clientsRes.clients) {
    const c = normalizeClient(raw);
    if (c.email) byEmail.set(c.email, c);
  }

  const participants = await db
    .collection(COLLECTIONS.participants)
    .find({ in_competition: true, cohort })
    .toArray();

  if (participants.length === 0) {
    return { ok: false, error: `no participants with { in_competition: true, cohort: "${cohort}" }` };
  }

  const baselineCol = db.collection(COLLECTIONS.baseline);
  const existing = new Map((await baselineCol.find({ cohort }).toArray()).map((d) => [d._id, d]));
  const holder = `${os.hostname()}/${process.pid}`;

  const rows = [];
  const summary = { ok: true, cohort, afterStart, afterGrace, created: 0, updated: 0, kept: 0, unmatched: 0, total: participants.length };

  for (const p of participants) {
    const email = p._id;
    const prev = existing.get(email);
    const c = byEmail.get(email);

    // Past the grace window, an existing baseline is never silently overwritten
    // — frozen OR a not-yet-frozen seed. Only --force gets through. (A seed that
    // outlives the grace window is a mistake to preserve, not to clobber.)
    if (prev && afterGrace && !force) {
      summary.kept += 1;
      rows.push({ email, matched: !!prev.matched, equity_start: prev.equity_start, net_profit_start: prev.net_profit_start, trades_start: prev.trades_start, action: 'kept' });
      continue;
    }

    const base = {
      _id: email,
      cohort,
      captured_at: now,
      competition_start: config.competition.start,
      source: config.mockElefin ? 'mock' : 'elefin',
      frozen: afterStart, // pre-start seeds stay unfrozen so the start-line run can replace them
      late_entry: false,
    };

    if (!c) {
      summary.unmatched += 1;
      Object.assign(base, { matched: false, client_id: null });
      rows.push({ email, matched: false, equity_start: null, net_profit_start: null, trades_start: null, action: prev ? 'updated' : 'created' });
    } else {
      Object.assign(base, baselineFromClient(c));
      rows.push({ email, matched: true, equity_start: base.equity_start, net_profit_start: base.net_profit_start, trades_start: base.trades_start, action: prev ? 'updated' : 'created' });
    }

    await baselineCol.replaceOne({ _id: email }, base, { upsert: true });
    if (prev) summary.updated += 1;
    else summary.created += 1;

    if (force && prev && prev.frozen) {
      await db.collection(COLLECTIONS.jobRuns).insertOne({
        run_id: now.toISOString(), trigger: 'baseline-force', started_at: now, finished_at: new Date(),
        ok: true, note: `--force overwrote frozen baseline for ${email}`, holder,
      });
    }
  }

  summary.rows = rows;
  return summary;
}

module.exports = { captureBaseline };
