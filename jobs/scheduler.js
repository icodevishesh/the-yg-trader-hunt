'use strict';

const cron = require('node-cron');
const config = require('../config');
const { connect, COLLECTIONS } = require('../db/mongo');
const { refreshLeaderboard } = require('./refreshLeaderboard');

let task = null;

function intervalHours() {
  const m = /^\s*\S+\s+\*\/(\d+)\s/.exec(config.refreshCron || '');
  return m ? Number(m[1]) : 4;
}

async function snapshotIsStale() {
  const db = await connect();
  const cur = await db
    .collection(COLLECTIONS.current)
    .findOne({ _id: 'current' }, { projection: { generated_at: 1 } });
  if (!cur || !cur.generated_at) return true;
  return Date.now() - new Date(cur.generated_at).getTime() > intervalHours() * 3600 * 1000;
}

function runSafely(trigger) {
  return refreshLeaderboard({ trigger })
    .then((res) => {
      if (res.skipped) console.log(`[refresh:${trigger}] skipped (${res.reason})`);
      else if (res.ok) {
        const s = res.snapshot;
        console.log(`[refresh:${trigger}] ok — ${s.eligible} ranked / ${s.matched} matched / ${s.participants_total} registered`);
      } else console.error(`[refresh:${trigger}] failed — ${res.error}`);
      return res;
    })
    .catch((err) => {
      console.error(`[refresh:${trigger}] threw —`, err);
      return { ok: false, error: String(err) };
    });
}

function start() {
  if (task) return;
  if (!cron.validate(config.refreshCron)) {
    console.error(`[scheduler] invalid REFRESH_CRON "${config.refreshCron}" — cron not started`);
    return;
  }
  task = cron.schedule(config.refreshCron, () => runSafely('cron'));
  console.log(`[scheduler] cron "${config.refreshCron}" active (every ~${intervalHours()}h)`);

  snapshotIsStale()
    .then((stale) => {
      if (stale) {
        console.log('[scheduler] no fresh snapshot — running an initial refresh');
        runSafely('boot');
      }
    })
    .catch((err) => console.error('[scheduler] boot staleness check failed:', err.message));
}

function stop() {
  if (task) {
    task.stop();
    task = null;
  }
}

module.exports = { start, stop, runSafely };
