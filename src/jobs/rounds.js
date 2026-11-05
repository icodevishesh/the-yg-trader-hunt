'use strict';

const { runScoring } = require('./score');

/*
 * Rounds, finalized by an admin with a button.
 *   week1  the main competition (cohort "<cohort>"), one board per category
 *   week2  "Beat YG Sir" (cohort "<cohort>-w2"): ONE board with the four week-1 category
 *          winners plus YG Sir, all added by an admin. Dates come from .env (WEEK2_START/END).
 *
 * Finalizing a round scores it one last time up to "now", works out the winner(s), and closes the
 * board: from then on that round's traders are never refreshed again.
 */

const ROUNDS = ['week1', 'week2'];

class RoundError extends Error {
  constructor(status, code, message) {
    super(message);
    Object.assign(this, { status, code });
  }
}

const roundCohort = (cfg, round) => (round === 'week1' ? cfg.competition.cohort : `${cfg.competition.cohort}-w2`);
const pick = (e) => ({
  email: e.email, name: e.name, rank: e.rank, is_host: !!e.is_host, return_pct: e.return_pct, pnl: e.pnl,
  start_capital: e.start_capital, net_capital: e.net_capital, flags: e.flags,
});

/**
 * The week-2 result. #1 of the board wins. If #1 is a category winner, their category reward is
 * multiplied and they get the week with YG Sir. If YG Sir is #1, everyone keeps the normal reward.
 */
function challengeResult(entries, entrants, cfg) {
  const top = entries.find((e) => e.winner_eligible);
  const standings = entries.map((e) => ({ ...pick(e), week1_winner_of: (entrants.get(e.email) || {}).week1_winner_of || null }));
  if (!top) return { winner: null, host_won: false, reason: 'no_eligible_entrant', standings };
  if (top.is_host) return { winner: null, host_won: true, standings };
  const category = (entrants.get(top.email) || {}).week1_winner_of || null;
  const reward = (cfg.scoring.categories_week1 || []).find((c) => c.id === category);
  const mult = cfg.week2.rewardMultiplier;
  return {
    winner: {
      ...pick(top), category, stay_with_yg: true,
      base_reward: reward ? reward.reward : null,
      final_reward: reward ? { ...reward.reward, value: reward.reward.value * mult } : null,
    },
    host_won: false,
    standings,
  };
}

function createRounds({ store, elefin, cfg, now = Date.now }) {
  const base = cfg.competition.cohort;
  const check = (round) => {
    if (!ROUNDS.includes(round)) throw new RoundError(404, 'unknown_round', 'Unknown round.');
  };
  const isFinal = (doc) => doc && doc.status === 'finalized';

  /** Why week 2 cannot run yet, or null when it can. */
  async function lockReason() {
    if (!cfg.week2) return 'dates_not_set';
    return isFinal(await store.loadRound(base, 'week1')) ? null : 'week1_not_finalized';
  }

  /** Scoring config for a round, or null while the round cannot exist yet. */
  async function scoreCfg(round) {
    check(round);
    if (round === 'week1') return cfg;
    if (await lockReason()) return null;
    const { startMs, endMs } = cfg.week2;
    const iso = (ms) => new Date(ms).toISOString();
    return {
      ...cfg,
      competition: { ...cfg.competition, cohort: roundCohort(cfg, 'week2'), startMs, cutoffMs: endMs, endMs, announceMs: endMs, start: iso(startMs), entryCutoff: iso(endMs), end: iso(endMs), announceAt: iso(endMs) },
      // One combined board: everyone is in the single "challenge" category.
      scoring: { ...cfg.scoring, categories_week1: cfg.scoring.categories, categories: [{ id: 'challenge', label: 'Beat YG Sir', minUsd: cfg.scoring.minCapitalUsd, displayMinUsd: cfg.scoring.minCapitalUsd, maxUsd: null, reward: null }] },
    };
  }

  async function state(round) {
    check(round);
    return (await store.loadRound(base, round)) || { round, status: 'live' };
  }

  async function status() {
    const [w1, w2] = [await state('week1'), await state('week2')];
    const reason = await lockReason();
    return { week1: w1, week2: reason ? { round: 'week2', status: 'locked', reason } : w2 };
  }

  /** Does the actual work. Safe to await in tests; the admin API runs it in the background. */
  async function run(round, admin) {
    const sc = await scoreCfg(round);
    const cohort = sc.competition.cohort;
    const lock = `score:${cohort}`;
    if (!(await store.acquireLock(lock))) {
      await store.failRound(base, round, 'A scoring run is in progress. Try again in a minute.');
      return;
    }
    try {
      const res = await runScoring({ store, elefin, cfg: sc, nowMs: now(), finalize: true });
      if (!res.published) throw new Error(`nothing was finalized (${res.skipped || 'no result'})`);
      const cur = await store.loadCurrent(cohort);
      const at = new Date(now()).toISOString();
      const fields = { finalized_at: at, finalized_by: admin, window_end: cur.window_end };
      let winners = {};

      if (round === 'week1') {
        const standings = {};
        for (const c of sc.scoring.categories) {
          const entries = (cur.categories[c.id] || { entries: [] }).entries;
          const w = entries.find((e) => e.winner_eligible);
          winners[c.id] = w ? pick(w) : null;
          standings[c.id] = entries.slice(0, 3).map(pick);
        }
        Object.assign(fields, { winners, standings });
      } else {
        const entrants = new Map((await store.loadTraders(cohort)).map((t) => [t.email, t]));
        const challenge = challengeResult((cur.categories.challenge || { entries: [] }).entries, entrants, sc);
        winners = { challenge: challenge.winner };
        Object.assign(fields, { challenge, winners });
      }
      await store.finishRound(base, round, fields);
      await store.markWinners(base, round, winners, at);
    } catch (err) {
      console.error(`[finalize:${round}]`, err.message);
      await store.failRound(base, round, err.message);
    } finally {
      await store.releaseLock(lock).catch(() => {});
    }
  }

  /** Validates, claims the round, then finalizes in the background (a full pass takes minutes). */
  async function start(round, admin, { background = true } = {}) {
    check(round);
    if (round === 'week2') {
      const reason = await lockReason();
      if (reason === 'dates_not_set') throw new RoundError(409, 'dates_not_set', 'Set WEEK2_START and WEEK2_END in .env first.');
      if (reason) throw new RoundError(409, 'week1_not_finalized', 'Finalize week 1 first.');
      const entrants = await store.loadTraders(roundCohort(cfg, 'week2'));
      if (!entrants.length) throw new RoundError(409, 'no_entrants', 'Add the entrants first.');
      if (!entrants.some((t) => t.is_host)) throw new RoundError(409, 'host_missing', 'Add YG Sir before finalizing week 2.');
    }
    if (!(await store.claimRound(base, round, admin, new Date(now()).toISOString()))) {
      throw new RoundError(409, 'already_finalized', 'This round is already finalized or being finalized.');
    }
    const job = run(round, admin);
    if (!background) await job;
    else job.catch((e) => console.error('[finalize]', e.message));
    return { started: true };
  }

  return { ROUNDS, RoundError, scoreCfg, state, status, start, run, lockReason, roundCohort: (r) => roundCohort(cfg, r) };
}

module.exports = { createRounds, RoundError, ROUNDS, roundCohort, challengeResult };
