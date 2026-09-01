'use strict';

/*
 * One refresh run: Elefin -> join form participants -> score -> rank -> persist.
 * Every trigger (cron, boot catch-up, manual endpoint, CLI) goes through here,
 * so the Mongo lock lives inside this function.
 */

const config = require('../config');
const { connect, COLLECTIONS } = require('../db/mongo');
const elefin = require('../services/elefin');
const {
  normalizeClient, computeReturnPct, isEligible, maskName, rankEntries, countryLabel, toUsd,
} = require('../services/scoring');

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function nextRefreshFrom(cronExpr, from) {
  // Good enough for the "next update in ..." label. Handles "M */N * * *".
  const m = /^\s*\S+\s+\*\/(\d+)\s/.exec(cronExpr || '');
  const hours = m ? Number(m[1]) : 4;
  return new Date(from.getTime() + hours * 3600 * 1000);
}

function toPublicEntry(e) {
  return {
    rank: e.rank,
    client_id: e.client_id,
    name: e.name,
    country: e.country_label.code,
    flag: e.country_label.flag,
    country_name: e.country_label.name,
    return_pct: e.return_pct,
    net_profit: e.net_profit_usd,
    net_deposit: e.net_deposit,
    equity: e.equity,
    currency: e.currency,
    trades: e.trades,
    shortlisted: e.shortlisted,
  };
}

async function tryAcquireLock(db, holder) {
  try {
    await db.collection(COLLECTIONS.locks).insertOne({ _id: 'refresh', acquired_at: new Date(), holder });
    return true;
  } catch (err) {
    if (err && err.code === 11000) return false;
    throw err;
  }
}

async function releaseLock(db, holder) {
  await db.collection(COLLECTIONS.locks).deleteOne({ _id: 'refresh', holder });
}

async function refreshLeaderboard({ trigger = 'manual' } = {}) {
  const db = await connect();
  const startedAt = new Date();
  const runId = startedAt.toISOString();

  const gotLock = await tryAcquireLock(db, runId);
  if (!gotLock) return { ok: false, skipped: true, reason: 'locked' };

  const jobRun = { run_id: runId, trigger, started_at: startedAt, ok: false };

  try {
    const meRes = await elefin.me();
    if (!meRes.ok) throw new Error(`Elefin /me failed: ${meRes.error}`);
    jobRun.rate_limit_remaining = meRes.rateLimitRemaining ?? null;

    const clientsRes = await elefin.getAllClients();
    if (!clientsRes.ok) throw new Error(`Elefin /clients failed: ${clientsRes.error}`);
    jobRun.clients_fetched = clientsRes.clients.length;

    const byEmail = new Map();
    for (const raw of clientsRes.clients) {
      const c = normalizeClient(raw);
      if (c.email) byEmail.set(c.email, c);
    }

    const participants = await db.collection(COLLECTIONS.participants).find({}).toArray();
    const checkedAt = new Date();
    const bulk = [];
    const eligibleEntries = [];
    let matched = 0;

    for (const p of participants) {
      const c = byEmail.get(p._id);
      if (!c) {
        bulk.push({
          updateOne: {
            filter: { _id: p._id },
            update: { $set: { 'elefin.matched': false, 'elefin.checked_at': checkedAt } },
          },
        });
        continue;
      }

      matched += 1;
      const returnPct = computeReturnPct(c);
      const { eligible, reasons } = isEligible(c);

      bulk.push({
        updateOne: {
          filter: { _id: p._id },
          update: {
            $set: {
              elefin: {
                matched: true,
                client_id: c.client_id,
                name: c.name,
                country: c.country,
                status: c.status,
                currency: c.currency,
                net_deposit: c.net_deposit,
                deposits: c.deposits,
                withdrawals: c.withdrawals,
                balance: c.balance,
                equity: c.equity,
                net_profit: c.net_profit,
                trades: c.trades,
                lots: c.lots,
                return_pct: returnPct === null ? null : round2(returnPct),
                eligible,
                ineligible_reasons: reasons,
                last_trade_at: c.last_trade_at,
                checked_at: checkedAt,
              },
            },
          },
        },
      });

      if (eligible && returnPct !== null) {
        eligibleEntries.push({
          client_id: c.client_id,
          name: maskName(c.name || p.name_form, c.client_id),
          country_label: countryLabel(c.country),
          return_pct: round2(returnPct),
          return_pct_raw: returnPct,
          net_profit_usd: round2(toUsd(c.net_profit, c.currency)),
          net_deposit: round2(toUsd(c.net_deposit, c.currency)),
          equity: round2(toUsd(c.equity, c.currency)),
          currency: c.currency,
          trades: c.trades,
          referred_at: c.referred_at,
        });
      }
    }

    if (bulk.length) {
      await db.collection(COLLECTIONS.participants).bulkWrite(bulk, { ordered: false });
    }

    const ranked = rankEntries(eligibleEntries);
    const entries = ranked.slice(0, config.scoring.leaderboardSize).map(toPublicEntry);
    const stats = {
      registered: participants.length,
      matched,
      participants: ranked.length,
      in_profit: ranked.filter((e) => e.return_pct_raw > 0).length,
      avg_return_pct: ranked.length
        ? round2(ranked.reduce((s, e) => s + e.return_pct_raw, 0) / ranked.length)
        : 0,
      total_trades: ranked.reduce((s, e) => s + (e.trades || 0), 0),
    };

    const generatedAt = new Date();
    const snapshot = {
      generated_at: generatedAt,
      run_id: runId,
      trigger,
      source: config.mockElefin ? 'mock' : 'elefin',
      formula:
        config.scoring.formula === 'equity'
          ? '(equity-net_deposit)/net_deposit'
          : 'net_profit/net_deposit',
      participants_total: participants.length,
      matched,
      eligible: ranked.length,
      competition: { start: config.competition.start, end: config.competition.end },
      top3: entries.slice(0, 3),
      entries,
      stats,
      duration_ms: Date.now() - startedAt.getTime(),
    };

    await db.collection(COLLECTIONS.snapshots).insertOne({ ...snapshot });
    await db.collection(COLLECTIONS.current).replaceOne(
      { _id: 'current' },
      {
        _id: 'current',
        ...snapshot,
        is_stale: false,
        last_error: null,
        next_refresh_at: nextRefreshFrom(config.refreshCron, generatedAt),
      },
      { upsert: true }
    );

    jobRun.ok = true;
    jobRun.matched = matched;
    jobRun.eligible = ranked.length;
    jobRun.finished_at = new Date();
    jobRun.error = null;
    await db.collection(COLLECTIONS.jobRuns).insertOne(jobRun);

    return { ok: true, snapshot };
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    jobRun.ok = false;
    jobRun.finished_at = new Date();
    jobRun.error = message;
    await db.collection(COLLECTIONS.jobRuns).insertOne(jobRun).catch(() => {});
    await db
      .collection(COLLECTIONS.current)
      .updateOne(
        { _id: 'current' },
        { $set: { is_stale: true, last_error: message, last_error_at: new Date() } }
      )
      .catch(() => {});
    return { ok: false, error: message };
  } finally {
    await releaseLock(db, runId).catch(() => {});
  }
}

module.exports = { refreshLeaderboard };
