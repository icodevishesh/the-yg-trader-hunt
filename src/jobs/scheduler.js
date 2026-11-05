'use strict';

const cron = require('node-cron');
const { config } = require('../config');
const { mongoStore } = require('../store');
const elefin = require('../elefin');
const { runScoring } = require('./score');
const { resolveTraders, syncGoogle } = require('./prepare');
const googleClient = require('../google');
const { createRounds } = require('./rounds');

/** One locked scoring pass for one round, with logging. */
async function scoreRound({ trigger, store, client, cfg, nowMs, prepare }) {
  const lock = `score:${cfg.competition.cohort}`;
  if (!(await store.acquireLock(lock))) return { skipped: 'locked' };
  const started = new Date();
  try {
    const prep = prepare ? await prepare() : undefined;
    const result = { ...(await runScoring({ store, elefin: client, cfg, nowMs })), ...(prep ? { prepare: prep } : {}) };
    await store.logRun({ trigger, cohort: cfg.competition.cohort, ok: true, started_at: started, finished_at: new Date(), result });
    return result;
  } catch (err) {
    console.error(`[score:${trigger}:${cfg.competition.cohort}]`, err.message);
    await store.logRun({ trigger, cohort: cfg.competition.cohort, ok: false, started_at: started, finished_at: new Date(), error: err.message }).catch(() => {});
    return { error: err.message };
  } finally {
    await store.releaseLock(lock).catch(() => {});
  }
}

/**
 * One tick: week 1 (skips itself once finalized), then week 2 if it is open.
 * Safe to call from cron, a timer or the API. Finalized rounds are never refreshed again.
 */
async function runSafely(trigger, { store = mongoStore, client = elefin, cfg = config, nowMs, rounds = defaultRounds() } = {}) {
  const week1 = await scoreRound({
    trigger, store, client, cfg, nowMs,
    // Registrations first, so a trader who just funded is scored in this same pass.
    prepare: async () => {
      const prep = {};
      try {
        prep.resolved = await resolveTraders({ store, elefin: client, cfg });
        prep.google_synced = await syncGoogle({ store, google: googleClient, cfg });
      } catch (err) {
        console.error(`[prepare:${trigger}]`, err.message);
      }
      return prep;
    },
  });

  let week2 = { skipped: 'not_open' };
  try {
    const cfg2 = await rounds.scoreCfg('week2');
    const doc2 = await rounds.state('week2');
    if (cfg2 && doc2.status !== 'finalized' && doc2.status !== 'finalizing') {
      week2 = await scoreRound({ trigger, store, client, cfg: cfg2, nowMs });
    }
  } catch (err) {
    console.error('[week2]', err.message);
    week2 = { error: err.message };
  }
  return { ...week1, week2 };
}

let sharedRounds;
function defaultRounds() {
  if (!sharedRounds) sharedRounds = createRounds({ store: mongoStore, elefin, cfg: config });
  return sharedRounds;
}

function start() {
  if (config.errors.length) {
    console.error('[scheduler] refusing to start, config invalid:\n  - ' + config.errors.join('\n  - '));
    return false;
  }
  cron.schedule(config.refreshCron, () => runSafely('cron'));

  // Extra capture pass just before entry closes so nobody funded at 23:58 is missed by cron timing.
  const untilCutoff = config.competition.cutoffMs - 30000 - Date.now();
  if (untilCutoff > 0 && untilCutoff < 2 ** 31) setTimeout(() => runSafely('cutoff'), untilCutoff);

  // A pass at the end of trading scores through the configured end. The board stays open until an admin finalizes.
  const untilEnd = config.competition.endMs + 1000 - Date.now();
  if (untilEnd > 0 && untilEnd < 2 ** 31) setTimeout(() => runSafely('final'), untilEnd);

  console.log(`[scheduler] ${config.competition.cohort} started (${config.refreshCron})`);
  return true;
}

module.exports = { start, runSafely, defaultRounds };
