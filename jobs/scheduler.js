'use strict';

const cron = require('node-cron');
const config = require('../config');
const { connect, COLLECTIONS } = require('../db/mongo');
const { refreshLeaderboard } = require('./refreshLeaderboard');
const { captureBaseline } = require('./captureBaseline');
const { finalizeResult } = require('./finalizeResult');

let task = null;

function intervalHours() {
  const expr = config.refreshCron || '';
  const every = /^\s*\S+\s+\*\/(\d+)\s/.exec(expr);
  if (every) return Number(every[1]);
  if (/^\s*\d+\s+\*\s/.test(expr)) return 1; // "M * * * *" = hourly
  return 4;
}

async function snapshotIsStale() {
  const db = await connect();
  const cur = await db
    .collection(COLLECTIONS.current)
    .findOne({ _id: 'current' }, { projection: { generated_at: 1 } });
  if (!cur || !cur.generated_at) return true;
  return Date.now() - new Date(cur.generated_at).getTime() > intervalHours() * 3600 * 1000;
}

// Safety net: if we're at/after the start line and no baseline exists for the
// cohort, freeze one now. The intended path is a manual `npm run baseline`.
async function maybeAutoBaseline() {
  if (Date.now() < Date.parse(config.competition.start)) return;
  const db = await connect();
  const have = await db
    .collection(COLLECTIONS.baseline)
    .countDocuments({ cohort: config.competition.cohort });
  if (have > 0) return;
  console.log('[scheduler] no baseline for the cohort — auto-capturing at the start line');
  const res = await captureBaseline({ force: false }).catch((err) => ({ ok: false, error: String(err) }));
  if (res.ok) console.log(`[scheduler] baseline captured — created ${res.created}, unmatched ${res.unmatched}`);
  else console.error(`[scheduler] auto-baseline failed — ${res.error}`);
}

// After the window closes: one final refresh, then write lb_result, then stop.
async function maybeFinalize() {
  if (Date.now() <= Date.parse(config.competition.end)) return false;
  const db = await connect();
  const done = await db.collection(COLLECTIONS.result).findOne({ _id: config.competition.cohort });
  if (done) {
    stop();
    return true;
  }
  console.log('[scheduler] competition window closed — final refresh + finalize');
  await runSafely('final');
  const res = await finalizeResult({ trigger: 'auto' }).catch((err) => ({ ok: false, error: String(err) }));
  if (res.ok) {
    const w = res.result.winner;
    console.log(`[scheduler] result finalized — winner: ${w ? `${w.name} (${w.return_pct}%)` : 'none eligible'}`);
  } else {
    console.error(`[scheduler] finalize failed — ${res.error}`);
  }
  stop();
  return true;
}

function runSafely(trigger) {
  return refreshLeaderboard({ trigger })
    .then((res) => {
      if (res.skipped) console.log(`[refresh:${trigger}] skipped (${res.reason})`);
      else if (res.ok) {
        const s = res.snapshot;
        console.log(
          `[refresh:${trigger}] ok — ${s.eligible} ranked / ${s.matched} matched / ${s.participants_total} in cohort` +
            (s.winner_provisional ? ` · leader ${s.winner_provisional.name} ${s.winner_provisional.return_pct}%` : '')
        );
      } else console.error(`[refresh:${trigger}] failed — ${res.error}`);
      return res;
    })
    .catch((err) => {
      console.error(`[refresh:${trigger}] threw —`, err);
      return { ok: false, error: String(err) };
    });
}

async function tick(trigger) {
  try {
    if (await maybeFinalize()) return;
    await maybeAutoBaseline();
    await runSafely(trigger);
  } catch (err) {
    console.error(`[scheduler] tick(${trigger}) error:`, err.message);
  }
}

function start() {
  if (task) return;
  if (!cron.validate(config.refreshCron)) {
    console.error(`[scheduler] invalid REFRESH_CRON "${config.refreshCron}" — cron not started`);
    return;
  }
  task = cron.schedule(config.refreshCron, () => tick('cron'));
  console.log(`[scheduler] cron "${config.refreshCron}" active (every ~${intervalHours()}h)`);

  maybeFinalize()
    .then((finalized) => {
      if (finalized) return;
      return snapshotIsStale().then((stale) => {
        if (stale) {
          console.log('[scheduler] no fresh snapshot — running an initial refresh');
          return tick('boot');
        }
      });
    })
    .catch((err) => console.error('[scheduler] boot check failed:', err.message));
}

function stop() {
  if (task) {
    task.stop();
    task = null;
  }
}

module.exports = { start, stop, runSafely };
