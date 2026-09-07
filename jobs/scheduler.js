'use strict';

const cron = require('node-cron');
const config = require('../config');
const { connect, COLLECTIONS } = require('../db/mongo');
const { computeStandings, writeCurrent, markStale } = require('./windowScore');
const { finalizeResult } = require('./finalizeResult');

let task = null;
let running = false;

// Minutes between refreshes, from the cron expr. Handles "*/N * * * *" (minutes),
// "M */N * * *" (hours) and "M * * * *" (hourly).
function intervalMinutes() {
  const expr = config.refreshCron || '';
  let m = /^\s*\*\/(\d+)\s/.exec(expr);
  if (m) return Number(m[1]);
  m = /^\s*\S+\s+\*\/(\d+)\s/.exec(expr);
  if (m) return Number(m[1]) * 60;
  if (/^\s*\d+\s+\*\s/.test(expr)) return 60;
  return 240;
}

function nextRefreshFrom(from) {
  return new Date(from.getTime() + intervalMinutes() * 60 * 1000);
}

async function snapshotIsStale() {
  const db = await connect();
  const cur = await db
    .collection(COLLECTIONS.current)
    .findOne({ _id: 'current' }, { projection: { generated_at: 1 } });
  if (!cur || !cur.generated_at) return true;
  return Date.now() - new Date(cur.generated_at).getTime() > 1.5 * intervalMinutes() * 60 * 1000;
}

// Score the window from live Elefin and write lb_current. One run at a time.
async function runSafely(trigger) {
  if (running) {
    console.log(`[score:${trigger}] skipped — a run is already in progress`);
    return { ok: false, skipped: true };
  }
  running = true;
  const started = Date.now();
  try {
    const result = await computeStandings({ markToMarket: true, onProgress: () => {} });
    await writeCurrent(result, { nextRefreshAt: nextRefreshFrom(new Date()) });
    const w = result.winner;
    console.log(
      `[score:${trigger}] ok in ${Math.round((Date.now() - started) / 1000)}s — ` +
        `${result.ranked.length} ranked / ${result.detail.filter((d) => d.matched).length} matched / ${result.participants_total} in cohort` +
        (w ? ` · leader ${w.name || w.email} ${w.return_pct}%` : ' · no leader') +
        (result.data_errors ? ` · ⚠ ${result.data_errors} trades-call errors (${result.carried_forward} carried fwd)` : '') +
        (result.positions_as_of ? ` · positions as_of ${result.positions_as_of}` : '')
    );
    return { ok: true, result };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error(`[score:${trigger}] failed — ${msg}`);
    await markStale(msg);
    return { ok: false, error: msg };
  } finally {
    running = false;
  }
}

// After COMPETITION_END: one final score, then write lb_result, then stop the cron.
// COMPETITION_END is a far-future placeholder while the board runs live, so this
// is dormant until a real end is set.
async function maybeFinalize() {
  if (Date.now() <= Date.parse(config.competition.end)) return false;
  const db = await connect();
  const done = await db.collection(COLLECTIONS.result).findOne({ _id: config.competition.cohort });
  if (done) {
    stop();
    return true;
  }
  console.log('[scheduler] competition window closed — final score + finalize');
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

async function tick(trigger) {
  try {
    if (await maybeFinalize()) return;
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
  console.log(`[scheduler] cron "${config.refreshCron}" active (every ${intervalMinutes()} min) — engine: window-score (mark-to-market)`);

  maybeFinalize()
    .then((finalized) => {
      if (finalized) return;
      return snapshotIsStale().then((stale) => {
        if (stale) {
          console.log('[scheduler] snapshot stale — scoring now');
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
