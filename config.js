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

  refreshCron: str(process.env.REFRESH_CRON, '0 */4 * * *'),
  uiPollMinutes: num(process.env.UI_POLL_MINUTES, 60),

  scoring: {
    formula: str(process.env.SCORE_FORMULA, 'net_profit'), // 'net_profit' | 'equity'
    minDepositUsd: num(process.env.MIN_DEPOSIT_USD, 100),
    requireTrade: bool(process.env.REQUIRE_TRADE, true),
    usdtToInr: num(process.env.USDT_TO_INR_RATE, 102),
    leaderboardSize: num(process.env.LEADERBOARD_SIZE, 15),
    shortlistSize: num(process.env.SHORTLIST_SIZE, 5),
  },

  competition: {
    start: str(process.env.COMPETITION_START, '2026-09-03T00:00:00+05:30'),
    end: str(process.env.COMPETITION_END, '2026-09-10T23:59:59+05:30'),
    windowFilter: bool(process.env.WINDOW_FILTER, false),
  },

  refreshToken: str(process.env.REFRESH_TOKEN, ''),
  mockElefin: bool(process.env.MOCK_ELEFIN, false),
};

module.exports = config;
