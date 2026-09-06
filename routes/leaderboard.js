'use strict';

const express = require('express');
const config = require('../config');
const { connect, COLLECTIONS } = require('../db/mongo');
const { runSafely } = require('../jobs/scheduler');

const router = express.Router();

const competition = { start: config.competition.start, end: config.competition.end };
const announceAt = config.competition.announceAt;
const winnerAnnounced = () => Date.now() >= Date.parse(announceAt);

router.get('/api/leaderboard', async (req, res) => {
  try {
    const db = await connect();
    const cur = await db.collection(COLLECTIONS.current).findOne({ _id: 'current' });
    const announced = winnerAnnounced();

    if (!cur) {
      return res.json({
        status: 'pending',
        ui_poll_minutes: config.uiPollMinutes,
        competition,
        window: competition,
        announce_at: announceAt,
        winner_announced: announced,
        top3: [],
        entries: [],
        stats: {},
      });
    }

    const over = !!cur.competition_over;

    res.set('Cache-Control', 'public, max-age=300');
    return res.json({
      status: 'ok',
      generated_at: cur.generated_at,
      next_refresh_at: cur.next_refresh_at,
      is_stale: !!cur.is_stale,
      last_error: cur.is_stale ? cur.last_error || null : null,
      formula: cur.formula,
      source: cur.source,
      cohort: cur.cohort || config.competition.cohort,
      competition: cur.competition || competition,
      window: cur.window || competition,
      competition_over: over,
      announce_at: announceAt,
      winner_announced: announced,
      finalized_at: cur.finalized_at || null,
      ui_poll_minutes: config.uiPollMinutes,
      // Hide the winner between trading close and the announcement.
      winner_provisional: over && !announced ? null : cur.winner_provisional || null,
      flags: cur.flags || {},
      baseline_ready: cur.baseline_ready ?? null,
      top3: cur.top3 || [],
      entries: cur.entries || [],
      stats: cur.stats || {},
    });
  } catch (err) {
    return res.status(503).json({ status: 'error', error: 'leaderboard temporarily unavailable' });
  }
});

// The finalized, audited result. Pending until finalizeResult() has run AND the
// announcement moment (WINNER_ANNOUNCE) has passed.
router.get('/api/leaderboard/result', async (req, res) => {
  try {
    if (!winnerAnnounced()) {
      return res
        .status(404)
        .json({ status: 'pending', message: 'winner is announced on ' + announceAt, announce_at: announceAt });
    }
    const db = await connect();
    const result = await db.collection(COLLECTIONS.result).findOne({ _id: config.competition.cohort });
    if (!result) return res.status(404).json({ status: 'pending', message: 'result not finalized yet' });
    res.set('Cache-Control', 'public, max-age=600');
    return res.json({ status: 'ok', ...result });
  } catch (err) {
    return res.status(503).json({ status: 'error', error: 'result temporarily unavailable' });
  }
});

router.post('/api/leaderboard/refresh', express.json(), (req, res) => {
  const token = req.get('x-refresh-token');
  if (!config.refreshToken || token !== config.refreshToken) {
    return res.status(401).json({ ok: false, error: 'bad or missing x-refresh-token' });
  }
  runSafely('manual');
  return res.status(202).json({ ok: true, started: true });
});

module.exports = router;
