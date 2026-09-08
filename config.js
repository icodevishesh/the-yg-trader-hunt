'use strict';

require('dotenv').config();

function bool(v, fallback) {
  if (v === undefined || v === '') return fallback;
  return String(v).toLowerCase() === 'true' || v === '1';
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v, fallback) {
  return v === undefined || v === '' ? fallback : String(v);
}

const config = {
  port: num(process.env.PORT, 3005),

  mongo: {
    uri: str(process.env.MONGO_URI, 'mongodb://localhost:27017'),
    dbName: str(process.env.MONGO_DB_NAME, 'yg_trader_hunt'),
  },

  elefin: {
    key: str(process.env.ELEFIN_API_KEY, ''),
    secret: str(process.env.ELEFIN_API_SECRET, ''),
    baseUrl: str(process.env.ELEFIN_API_BASE_URL, 'https://el.theloginarea.com/api/v1').replace(/\/+$/, ''),
    perPage: 100,
    timeoutMs: 30000,
  },

  refreshCron: str(process.env.REFRESH_CRON, '*/15 * * * *'),
  uiPollMinutes: num(process.env.UI_POLL_MINUTES, 5),

  scoring: {
    formula: str(process.env.SCORE_FORMULA, 'net_profit'), // 'net_profit' | 'equity'
    // $95, not $100 — a $100 deposit lands as ~$98-99.5 after the payment-rail
    // fee. This keeps genuine sub-$100 entries out without punishing that fee.
    minDepositUsd: num(process.env.MIN_DEPOSIT_USD, 95),
    requireTrade: bool(process.env.REQUIRE_TRADE, true),
    usdtToInr: num(process.env.USDT_TO_INR_RATE, 102),
    leaderboardSize: num(process.env.LEADERBOARD_SIZE, 33),
    shortlistSize: num(process.env.SHORTLIST_SIZE, 5),
    // A reload (deposit after Day 1) above this (FX-normalised USD) is flagged
    // for info only — it is allowed and added to the cumulative-capital base.
    depositToleranceUsd: num(process.env.DEPOSIT_TOLERANCE_USD, 1),
  },

  competition: {
    cohort: str(process.env.COHORT, 'sep-2026'),
    start: str(process.env.COMPETITION_START, '2026-09-07T00:00:00+05:30'),
    // Trading close. PLACEHOLDER far-future default so the scheduler keeps
    // refreshing and never auto-finalises until a real end is set in .env.
    end: str(process.env.COMPETITION_END, '2026-12-31T23:59:59+05:30'),
    // The winner is announced after trading closes. finalizeResult() runs at `end`
    // (organisers get the audit); the public winner reveal + the
    // /api/leaderboard/result endpoint are gated until this moment.
    announceAt: str(process.env.WINNER_ANNOUNCE, '2027-01-01T12:00:00+05:30'),
    // How long after the start the baseline may still be re-captured. plan.md §3b.
    baselineGraceHours: num(process.env.BASELINE_GRACE_HOURS, 2),
  },

  refreshToken: str(process.env.REFRESH_TOKEN, ''),
  mockElefin: bool(process.env.MOCK_ELEFIN, false),
};

module.exports = config;
