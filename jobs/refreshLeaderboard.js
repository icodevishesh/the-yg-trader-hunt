'use strict';

/*
 * One refresh run: Elefin -> join the cohort's frozen baselines -> window score
 * -> rank -> persist. plan.md §7.
 *
 * Every trigger (cron, boot catch-up, manual endpoint, CLI) goes through here,
 * so the Mongo lock lives inside this function.
 */

const os = require('os');
const config = require('../config');
const { connect, COLLECTIONS } = require('../db/mongo');
const elefin = require('../services/elefin');
const {
  normalizeClient, baselineFromClient, computeWindow, isEligibleWindow,
  maskName, rankCompetitionEntries, countryLabel, toUsd, round2,
} = require('../services/scoring');

function nextRefreshFrom(cronExpr, from) {
  // Good enough for the "next update in ..." label. Handles "M */N * * *" and "M * * * *".
  const every = /^\s*\S+\s+\*\/(\d+)\s/.exec(cronExpr || '');
  if (every) return new Date(from.getTime() + Number(every[1]) * 3600 * 1000);
  const hourly = /^\s*\d+\s+\*\s/.test(cronExpr || '');
  return new Date(from.getTime() + (hourly ? 1 : 4) * 3600 * 1000);
}

function toPublicEntry(e) {
  return {
    rank: e.rank,
    client_id: e.client_id,
    name: e.name,
    country: e.country_label.code,
    flag: e.country_label.flag,
    country_name: e.country_label.name,
    return_pct: e.return_pct,            // window %
    return_pct_alt: e.return_pct_alt,
    net_profit: e.net_profit_window_usd, // window realized P/L, USD
    base_start: e.base_start_usd,
    net_deposit: e.net_deposit,
    equity: e.equity,
    currency: e.currency,
    trades: e.trades_window,             // window trades
    added_funds: e.added_funds,
    winner_eligible: e.winner_eligible,
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
  const holder = `${os.hostname()}/${process.pid}`;

  const gotLock = await tryAcquireLock(db, runId);
  if (!gotLock) return { ok: false, skipped: true, reason: 'locked' };

  const jobRun = { run_id: runId, trigger, started_at: startedAt, ok: false, holder };
  const cohort = config.competition.cohort;

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

    const participants = await db
      .collection(COLLECTIONS.participants)
      .find({ in_competition: true, cohort })
      .toArray();

    const baselines = new Map(
      (await db.collection(COLLECTIONS.baseline).find({ cohort }).toArray()).map((b) => [b._id, b])
    );

    const checkedAt = new Date();
    const afterStart = checkedAt.getTime() >= Date.parse(config.competition.start);
    const bulk = [];
    const newBaselines = [];
    const eligibleEntries = [];
    let matched = 0;
    let baselineReady = 0;
    const flags = { added_funds: 0, late_entry: 0, anomalies: 0, unmatched: 0 };

    for (const p of participants) {
      const c = byEmail.get(p._id);

      if (!c) {
        flags.unmatched += 1;
        bulk.push({
          updateOne: {
            filter: { _id: p._id },
            update: {
              $set: {
                'elefin.matched': false,
                'elefin.eligible': false,
                'elefin.winner_eligible': false,
                'elefin.checked_at': checkedAt,
              },
            },
          },
        });
        continue;
      }

      matched += 1;

      // Matched but never baselined (funded/referred after the start line).
      let baseline = baselines.get(p._id);
      if (!baseline || baseline.matched === false) {
        baseline = {
          _id: p._id,
          cohort,
          ...baselineFromClient(c),
          captured_at: checkedAt,
          competition_start: config.competition.start,
          source: config.mockElefin ? 'mock' : 'elefin',
          frozen: true,
          late_entry: afterStart, // created before the start => not actually late
        };
        baselines.set(p._id, baseline);
        newBaselines.push(baseline);
      }
      if (baseline.matched !== false) baselineReady += 1;

      const win = computeWindow(baseline, c);
      const elig = isEligibleWindow(c, win, baseline);

      if (win.added_funds) flags.added_funds += 1;
      if (elig.late_entry) flags.late_entry += 1;
      if (win.data_anomaly) flags.anomalies += 1;

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
                // live cumulative
                net_deposit: c.net_deposit,
                deposits: c.deposits,
                withdrawals: c.withdrawals,
                balance: c.balance,
                equity: c.equity,
                net_profit: c.net_profit,
                trades: c.trades,
                lots: c.lots,
                last_trade_at: c.last_trade_at,
                // window block
                baseline_captured_at: baseline.captured_at || null,
                base_start: win.base_start === null ? null : round2(win.base_start),
                net_profit_window: round2(win.net_profit_window),
                trades_window: win.trades_window,
                deposits_window: round2(win.deposits_window),
                withdrawals_window: round2(win.withdrawals_window),
                return_pct: win.return_pct === null ? null : round2(win.return_pct),
                return_pct_alt: win.return_pct_alt === null ? null : round2(win.return_pct_alt),
                // flags
                added_funds: win.added_funds,
                eligible: elig.eligible,
                winner_eligible: elig.winner_eligible,
                late_entry: elig.late_entry,
                data_anomaly: win.data_anomaly,
                ineligible_reasons: elig.ineligible_reasons,
                checked_at: checkedAt,
              },
            },
          },
        },
      });

      if (elig.eligible && win.return_pct !== null) {
        eligibleEntries.push({
          client_id: c.client_id,
          name: maskName(c.name || p.name_form, c.client_id),
          country_label: countryLabel(c.country),
          return_pct: round2(win.return_pct),
          return_pct_alt: win.return_pct_alt === null ? null : round2(win.return_pct_alt),
          return_pct_raw: win.return_pct,
          net_profit_window: round2(win.net_profit_window),
          net_profit_window_usd: round2(toUsd(win.net_profit_window, c.currency)),
          base_start: round2(win.base_start),
          base_start_usd: round2(toUsd(win.base_start, c.currency)),
          net_deposit: round2(toUsd(c.net_deposit, c.currency)),
          equity: round2(toUsd(c.equity, c.currency)),
          currency: c.currency,
          trades_window: win.trades_window,
          deposits_window: round2(win.deposits_window),
          withdrawals_window: round2(win.withdrawals_window),
          added_funds: win.added_funds,
          winner_eligible: elig.winner_eligible,
          referred_at: c.referred_at,
          baseline_captured_at: baseline.captured_at || null,
        });
      }
    }

    if (newBaselines.length) {
      await db.collection(COLLECTIONS.baseline).bulkWrite(
        newBaselines.map((b) => ({ replaceOne: { filter: { _id: b._id }, replacement: b, upsert: true } })),
        { ordered: false }
      );
    }
    if (bulk.length) {
      await db.collection(COLLECTIONS.participants).bulkWrite(bulk, { ordered: false });
    }

    const ranked = rankCompetitionEntries(eligibleEntries);
    const entries = ranked.slice(0, config.scoring.leaderboardSize).map(toPublicEntry);
    const winnerRow = ranked.find((e) => e.winner_eligible) || null;
    const winnerProvisional = winnerRow
      ? { client_id: winnerRow.client_id, name: winnerRow.name, return_pct: winnerRow.return_pct }
      : null;

    const stats = {
      cohort_size: participants.length,
      matched,
      baseline_ready: baselineReady,
      participants: ranked.length,
      winner_eligible: ranked.filter((e) => e.winner_eligible).length,
      in_profit: ranked.filter((e) => e.return_pct_raw > 0).length,
      avg_return_pct: ranked.length
        ? round2(ranked.reduce((s, e) => s + e.return_pct_raw, 0) / ranked.length)
        : 0,
      total_trades: ranked.reduce((s, e) => s + (e.trades_window || 0), 0),
    };

    const generatedAt = new Date();
    const snapshot = {
      generated_at: generatedAt,
      run_id: runId,
      trigger,
      source: config.mockElefin ? 'mock' : 'elefin',
      cohort,
      formula: 'net_profit_window / base_start * 100',
      participants_total: participants.length,
      matched,
      baseline_ready: baselineReady,
      eligible: ranked.length,
      competition: { start: config.competition.start, end: config.competition.end },
      window: { start: config.competition.start, end: config.competition.end },
      announce_at: config.competition.announceAt,
      competition_over: generatedAt.getTime() > Date.parse(config.competition.end),
      winner_announced: generatedAt.getTime() >= Date.parse(config.competition.announceAt),
      winner_provisional: winnerProvisional,
      flags,
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
    jobRun.flags = flags;
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
