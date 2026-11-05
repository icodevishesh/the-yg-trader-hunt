'use strict';

/*
 * Season-2 configuration. Everything date-like comes from the environment, is
 * validated at boot, and is served to the frontend by the API (single source).
 * `buildConfig(env)` is pure so it can be unit-tested; `config` is the process-wide instance.
 */

require('dotenv').config();

const IST_OFFSET_MS = 5.5 * 3600 * 1000;

const num = (v, d) => {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const str = (v, d) => (v === undefined || v === '' ? d : String(v));

// Bands: lower bound inclusive, upper bound exclusive. Rewards are data, not logic.
const CATEGORIES = [
  { id: 'bronze', label: 'Bronze', minUsd: 95, displayMinUsd: 100, maxUsd: 300, reward: { currency: 'INR', value: 25000, type: 'cash' } },
  { id: 'silver', label: 'Silver', minUsd: 300, displayMinUsd: 300, maxUsd: 500, reward: { currency: 'INR', value: 50000, type: 'cash' } },
  { id: 'gold', label: 'Gold', minUsd: 500, displayMinUsd: 500, maxUsd: 1000, reward: { currency: 'INR', value: 100000, type: 'cash' } },
  { id: 'platinum', label: 'Platinum', minUsd: 1000, displayMinUsd: 1000, maxUsd: null, reward: { currency: 'INR', value: 150000, type: 'cash' } },
];

// Verified against MT5 statements (plan §1b). An instrument missing here is never guessed.
const CONTRACT_SIZE = { XAUUSD: 100, BTCUSD: 1, ETHUSD: 1 };

/** 23:59:59 IST two calendar days after `start`'s IST date (start day + 2 more days: Mon -> Wed). */
function defaultEntryCutoff(startMs) {
  const ist = new Date(startMs + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  const d = ist.getUTCDate();
  return Date.UTC(y, m, d + 2, 23, 59, 59) - IST_OFFSET_MS;
}

function parseTime(v) {
  if (!v) return NaN;
  const t = Date.parse(v);
  return t;
}

function validateCategories(cats, minCapitalUsd) {
  const errs = [];
  if (!cats.length) return ['no categories configured'];
  if (cats[0].minUsd !== minCapitalUsd) errs.push(`first category minUsd (${cats[0].minUsd}) must equal MIN_CAPITAL_USD (${minCapitalUsd})`);
  for (let i = 0; i < cats.length; i += 1) {
    const c = cats[i];
    const next = cats[i + 1];
    if (next) {
      if (c.maxUsd === null || c.maxUsd !== next.minUsd) errs.push(`bands not contiguous between ${c.id} and ${next.id}`);
    } else if (c.maxUsd !== null) {
      errs.push(`last category ${c.id} must be unbounded (maxUsd null)`);
    }
    if (c.maxUsd !== null && c.maxUsd <= c.minUsd) errs.push(`category ${c.id}: maxUsd must exceed minUsd`);
  }
  return errs;
}

function buildConfig(env = process.env) {
  const startMs = parseTime(env.COMPETITION_START);
  const endMs = parseTime(env.COMPETITION_END);
  const announceMs = parseTime(env.WINNER_ANNOUNCE);
  const cutoffMs = env.ENTRY_CUTOFF ? parseTime(env.ENTRY_CUTOFF) : Number.isFinite(startMs) ? defaultEntryCutoff(startMs) : NaN;

  const minCapitalUsd = num(env.MIN_CAPITAL_USD, 95);
  const errors = [];
  for (const [k, v] of [['COMPETITION_START', startMs], ['COMPETITION_END', endMs], ['WINNER_ANNOUNCE', announceMs], ['ENTRY_CUTOFF', cutoffMs]]) {
    if (!Number.isFinite(v)) errors.push(`${k} is missing or not a valid date`);
  }
  if (!errors.length && !(startMs <= cutoffMs && cutoffMs < endMs && endMs <= announceMs)) {
    errors.push('dates must satisfy COMPETITION_START <= ENTRY_CUTOFF < COMPETITION_END <= WINNER_ANNOUNCE');
  }
  errors.push(...validateCategories(CATEGORIES, minCapitalUsd));

  // Week 2 ("Beat YG Sir") window, also from .env. Both dates or neither; absent = week 2 stays locked.
  const w2Start = parseTime(env.WEEK2_START);
  const w2End = parseTime(env.WEEK2_END);
  let week2 = null;
  if (env.WEEK2_START || env.WEEK2_END) {
    if (!Number.isFinite(w2Start) || !Number.isFinite(w2End)) errors.push('WEEK2_START and WEEK2_END must both be valid dates');
    else if (!(w2Start < w2End)) errors.push('WEEK2_START must be before WEEK2_END');
    else if (Number.isFinite(endMs) && w2Start < endMs) errors.push('WEEK2_START must not be before COMPETITION_END');
    else week2 = { startMs: w2Start, endMs: w2End, rewardMultiplier: num(env.WEEK2_REWARD_MULTIPLIER, 2) };
  }

  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

  return {
    port: num(env.PORT, 3005),
    mongo: { uri: str(env.MONGO_URI, 'mongodb://localhost:27017'), dbName: str(env.MONGO_DB_NAME, 'yg_trader_hunt') },
    elefin: {
      key: str(env.ELEFIN_API_KEY, ''),
      secret: str(env.ELEFIN_API_SECRET, ''),
      baseUrl: str(env.ELEFIN_API_BASE_URL, 'https://el.theloginarea.com/api/v1').replace(/\/+$/, ''),
      timeoutMs: 30000,
      minIntervalMs: num(env.ELEFIN_MIN_INTERVAL_MS, 1100), // key quota is 60 req/min
    },
    refreshCron: str(env.REFRESH_CRON, '*/15 * * * *'),
    refreshToken: str(env.REFRESH_TOKEN, ''),
    // Google Apps Script web app that appends each registration to the sheet. Optional.
    admin: {
      path: str(env.ADMIN_PATH, ''),
      users: require('./admin/auth').parseUsers(env.ADMIN_USERS),
      secret: str(env.ADMIN_SESSION_SECRET, ''),
    },
    googleFormEndpoint: str(env.GOOGLE_FORM_ENDPOINT, ''),
    uiPollMinutes: num(env.UI_POLL_MINUTES, 5),
    competition: {
      cohort: str(env.COHORT, 'ses-2'),
      startMs, cutoffMs, endMs, announceMs,
      start: iso(startMs), entryCutoff: iso(cutoffMs), end: iso(endMs), announceAt: iso(announceMs),
    },
    week2: week2 && { ...week2, start: iso(week2.startMs), end: iso(week2.endMs) },
    scoring: {
      minCapitalUsd,
      flowToleranceUsd: num(env.FLOW_TOLERANCE_USD, 1),
      pnlToleranceUsd: num(env.PNL_TOLERANCE_USD, 1),
      maxFailedFraction: num(env.MAX_FAILED_FRACTION, 0.2),
      categories: CATEGORIES,
      contractSize: CONTRACT_SIZE,
    },
    errors, // non-empty => scheduler refuses to start; the API still serves
  };
}

module.exports = { buildConfig, defaultEntryCutoff, validateCategories, CATEGORIES, CONTRACT_SIZE, config: buildConfig() };
