'use strict';

const crypto = require('crypto');
const express = require('express');

const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

/** "Yash Agarwal" -> "Yash A."; never expose emails, wallet ids or review flags. */
function maskName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Trader';
  const first = parts[0][0].toUpperCase() + parts[0].slice(1).toLowerCase();
  return parts.length > 1 ? `${first} ${parts[parts.length - 1][0].toUpperCase()}.` : first;
}

function publicEntry(e) {
  return {
    rank: e.rank,
    name: e.is_host ? e.name || 'YG Sir' : maskName(e.name),
    is_host: !!e.is_host,
    country: e.country || null,
    category: e.category,
    return_pct: round2(e.return_pct),
    pnl: e.pnl,
    start_capital: e.start_capital,
    net_capital: e.net_capital,
    closed_trades: e.closed_trades,
    late_entry: e.flags.includes('late_entry'),
    no_trades: !!e.no_trades,
  };
}

function phaseOf(nowMs, comp, over) {
  if (over) return 'finalized';
  if (nowMs < comp.startMs) return 'pending';
  if (nowMs < comp.endMs && !over) return nowMs <= comp.cutoffMs ? 'live_entry_open' : 'live';
  return nowMs < comp.announceMs ? 'closed_verifying' : 'announced';
}

function categoryMeta(c) {
  return { id: c.id, label: c.label, min_usd: c.displayMinUsd, max_usd: c.maxUsd, reward: c.reward };
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * @param store      needs loadCurrent(cohort)
 * @param trigger    async (name) => result, used by the guarded manual refresh
 */
function createLeaderboardRouter({ store, trigger, cfg, now = Date.now, rounds }) {
  const router = express.Router();

  const datesOf = (comp) => ({
    start: comp.start,
    entry_cutoff: comp.entryCutoff,
    end: comp.end,
    announce_at: comp.announceAt,
  });

  // Winners are public only once an admin has finalized the round.
  const publicChallenge = (c) => ({
    host_won: !!c.host_won,
    winner: c.winner ? { name: maskName(c.winner.name), category: c.winner.category, return_pct: round2(c.winner.return_pct), base_reward: c.winner.base_reward, final_reward: c.winner.final_reward, stay_with_yg: !!c.winner.stay_with_yg } : null,
    standings: (c.standings || []).map((e) => ({ rank: e.rank, name: e.is_host ? e.name || 'YG Sir' : maskName(e.name), is_host: !!e.is_host, return_pct: round2(e.return_pct), pnl: e.pnl, category: e.week1_winner_of || null })),
  });
  const publicWinners = (doc) =>
    doc && doc.status === 'finalized' && doc.challenge
      ? { finalized_at: doc.finalized_at, challenge: publicChallenge(doc.challenge) }
      : doc && doc.status === 'finalized'
      ? { finalized_at: doc.finalized_at, categories: Object.fromEntries(Object.entries(doc.winners || {}).map(([c, w]) => [c, w ? { name: maskName(w.name), return_pct: round2(w.return_pct), pnl: w.pnl, start_capital: w.start_capital } : null])) }
      : null;

  router.get('/api/health', (req, res) => res.json({ ok: true, cohort: cfg.competition.cohort, config_errors: cfg.errors.length }));

  router.get('/api/leaderboard', async (req, res) => {
    try {
      const round = req.query.round === 'week2' ? 'week2' : 'week1';
      const sc = round === 'week2' && rounds ? await rounds.scoreCfg('week2') : cfg;
      const { competition: comp, scoring } = sc || cfg;
      const want = req.query.category ? String(req.query.category).toLowerCase() : null;
      if (want && !scoring.categories.some((c) => c.id === want)) {
        return res.status(400).json({ status: 'error', error: 'unknown category' });
      }

      if (!sc) return res.json({ status: 'pending', round, phase: 'locked', message: 'Week 2 opens after week 1 is finalized.', competition: {}, categories: scoring.categories.map(categoryMeta), stats: {}, boards: {} });
      const roundDoc = rounds ? await rounds.state(round) : null;
      const cur = cfg.errors.length ? null : await store.loadCurrent(comp.cohort);
      const over = !!(cur && cur.competition_over);
      const base = {
        cohort: comp.cohort,
        round,
        winners: publicWinners(roundDoc),
        phase: cfg.errors.length ? 'unconfigured' : phaseOf(now(), comp, over),
        ui_poll_minutes: cfg.uiPollMinutes,
        competition: datesOf(comp),
        // The week-2 window (from .env WEEK2_START/END) on every response so the page can show the
        // week-2 tab the moment week 2 begins, independent of which round is being requested.
        week2_window: cfg.week2 ? { start: cfg.week2.start, end: cfg.week2.end } : null,
        categories: scoring.categories.filter((c) => !want || c.id === want).map(categoryMeta),
      };

      if (!cur) return res.json({ status: 'pending', ...base, stats: {}, boards: {} });

      const boards = {};
      for (const c of scoring.categories) {
        if (want && c.id !== want) continue;
        const b = cur.categories[c.id] || { entries: [], entered: [], stats: {} };
        const entries = b.entries.map(publicEntry);
        const entered = (b.entered || []).map(publicEntry);
        boards[c.id] = { stats: b.stats, leader: entries[0] || null, entries, entered };
      }

      res.set('Cache-Control', 'public, max-age=60');
      return res.json({
        status: 'ok',
        ...base,
        generated_at: cur.generated_at,
        window_end: cur.window_end,
        competition_over: over,
        stats: { registered: cur.stats.registered, entered: cur.stats.frozen, ranked: cur.stats.ranked },
        boards,
      });
    } catch (err) {
      console.error('[api] leaderboard', err.message);
      return res.status(503).json({ status: 'error', error: 'leaderboard temporarily unavailable' });
    }
  });

  router.post('/api/leaderboard/refresh', (req, res) => {
    const token = req.get('x-refresh-token');
    if (!cfg.refreshToken || !token || !safeEqual(token, cfg.refreshToken)) {
      return res.status(401).json({ ok: false, error: 'bad or missing x-refresh-token' });
    }
    trigger('manual');
    return res.status(202).json({ ok: true, started: true });
  });

  return router;
}

module.exports = { createLeaderboardRouter, maskName, publicEntry, phaseOf };
