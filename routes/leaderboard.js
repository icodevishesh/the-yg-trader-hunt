'use strict';

const express = require('express');
const config = require('../config');
const { connect, COLLECTIONS } = require('../db/mongo');
const { runSafely } = require('../jobs/scheduler');

const router = express.Router();

const competition = { start: config.competition.start, end: config.competition.end };

router.get('/api/leaderboard', async (req, res) => {
  try {
    const db = await connect();
    const cur = await db.collection(COLLECTIONS.current).findOne({ _id: 'current' });

    if (!cur) {
      return res.json({
        status: 'pending',
        ui_poll_minutes: config.uiPollMinutes,
        competition,
        top3: [],
        entries: [],
        stats: {},
      });
    }

    res.set('Cache-Control', 'public, max-age=300');
    return res.json({
      status: 'ok',
      generated_at: cur.generated_at,
      next_refresh_at: cur.next_refresh_at,
      is_stale: !!cur.is_stale,
      last_error: cur.is_stale ? cur.last_error || null : null,
      formula: cur.formula,
      source: cur.source,
      competition: cur.competition || competition,
      ui_poll_minutes: config.uiPollMinutes,
      top3: cur.top3 || [],
      entries: cur.entries || [],
      stats: cur.stats || {},
    });
  } catch (err) {
    return res.status(503).json({ status: 'error', error: 'leaderboard temporarily unavailable' });
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
