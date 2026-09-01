'use strict';

const config = require('../config');

const COUNTRY_NAMES = {
  IN: 'India', US: 'United States', GB: 'United Kingdom', AE: 'UAE', PK: 'Pakistan',
  BD: 'Bangladesh', NP: 'Nepal', LK: 'Sri Lanka', SA: 'Saudi Arabia', QA: 'Qatar',
  OM: 'Oman', KW: 'Kuwait', BH: 'Bahrain', MY: 'Malaysia', SG: 'Singapore',
  ID: 'Indonesia', PH: 'Philippines', NG: 'Nigeria', ZA: 'South Africa', CA: 'Canada',
  AU: 'Australia', DE: 'Germany', FR: 'France', ES: 'Spain', IT: 'Italy', NL: 'Netherlands',
  BR: 'Brazil', MX: 'Mexico', TR: 'Turkey', EG: 'Egypt', VN: 'Vietnam', TH: 'Thailand',
};

const NAME_TO_CODE = Object.fromEntries(
  Object.entries(COUNTRY_NAMES).map(([code, name]) => [name.toLowerCase(), code])
);
const COUNTRY_ALIASES = {
  'united arab emirates': 'AE', usa: 'US', 'u.s.a.': 'US', 'united states of america': 'US',
  uk: 'GB', england: 'GB', 'great britain': 'GB', 'south korea': 'KR', 'korea': 'KR',
  vietnam: 'VN', russia: 'RU', 'viet nam': 'VN',
};

function codeToFlag(cc) {
  if (!cc || !/^[a-z]{2}$/i.test(cc)) return '';
  const base = 0x1f1e6;
  return String.fromCodePoint(
    ...[...cc.toUpperCase()].map((ch) => base + ch.charCodeAt(0) - 65)
  );
}

// Elefin's `country` is sometimes an ISO alpha-2 code, sometimes a full name,
// sometimes "Unknown"/blank. Normalise all three to { code, flag, name }.
function countryLabel(raw) {
  const s = (raw || '').trim();
  if (!s || /^(unknown|n\/?a|none|null)$/i.test(s)) return { code: '', flag: '', name: '' };

  if (/^[a-z]{2}$/i.test(s)) {
    const cc = s.toUpperCase();
    return { code: cc, flag: codeToFlag(cc), name: COUNTRY_NAMES[cc] || cc };
  }

  const lower = s.toLowerCase();
  const cc = NAME_TO_CODE[lower] || COUNTRY_ALIASES[lower] || '';
  const name = cc && COUNTRY_NAMES[cc] ? COUNTRY_NAMES[cc] : s.replace(/\S+/g, titleCase);
  return { code: cc, flag: cc ? codeToFlag(cc) : '', name };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// INR balances -> USD for the *displayed* dollar column only. Ranking uses the
// currency-agnostic ratio, so this never affects return_pct.
function toUsd(amount, currency) {
  const a = num(amount);
  if ((currency || 'USD').toUpperCase() === 'INR') return a / (config.scoring.usdtToInr || 102);
  return a;
}

// Flatten one Elefin /clients row into the shape the rest of the app uses.
function normalizeClient(row) {
  const funding = row.funding || {};
  const accounts = row.accounts || {};
  const trading = row.trading || {};
  return {
    client_id: row.client_id,
    name: (row.name || '').trim(),
    email: (row.email || '').trim().toLowerCase(),
    country: row.country || '',
    status: (row.status || '').toLowerCase(),
    currency: (funding.currency || 'USD').toUpperCase(),
    net_deposit: num(funding.net_deposit),
    deposits: num(funding.deposits),
    withdrawals: num(funding.withdrawals),
    balance: num(accounts.balance),
    equity: num(accounts.equity),
    net_profit: num(trading.net_profit),
    trades: num(trading.trades),
    lots: num(trading.lots),
    last_trade_at: trading.last_trade_at || null,
    referred_at: row.referred_at || null,
    registered_at: row.registered_at || null,
  };
}

// return_pct — null when there is no positive deposit base to measure against.
function computeReturnPct(c, formula = config.scoring.formula) {
  if (!(c.net_deposit > 0)) return null;
  const gain = formula === 'equity' ? c.equity - c.net_deposit : c.net_profit;
  return (gain / c.net_deposit) * 100;
}

function isEligible(c, cfg = config.scoring) {
  const reasons = [];
  if (c.status && c.status !== 'active') reasons.push('inactive');
  if (!(c.net_deposit > 0)) reasons.push('no_deposit');
  else if (toUsd(c.net_deposit, c.currency) < cfg.minDepositUsd) reasons.push('below_min_deposit');
  if (cfg.requireTrade && !(c.trades > 0)) reasons.push('no_trades');
  return { eligible: reasons.length === 0, reasons };
}

// Title-case a token, keeping hyphen / apostrophe segments capitalised
// ("SARTHAK" -> "Sarthak", "o'brien" -> "O'Brien", "jean-paul" -> "Jean-Paul").
function titleCase(token) {
  return token
    .toLowerCase()
    .replace(/(^|[-'])([a-zÀ-ɏ])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

function maskName(name, clientId) {
  const clean = (name || '').replace(/\s+/g, ' ').trim();
  if (!clean) return `Trader ${String(clientId || '').slice(-4) || '????'}`;
  const parts = clean.split(' ');
  const first = titleCase(parts[0]);
  if (parts.length === 1) return first;
  const lastInitial = parts[parts.length - 1][0].toUpperCase();
  return `${first} ${lastInitial}.`;
}

// Sort desc by return_pct; ties -> higher net_profit -> earlier referral.
function rankEntries(rows, { shortlistSize = config.scoring.shortlistSize } = {}) {
  const sorted = [...rows].sort((a, b) => {
    if (b.return_pct !== a.return_pct) return b.return_pct - a.return_pct;
    if (b.net_profit !== a.net_profit) return b.net_profit - a.net_profit;
    const at = a.referred_at ? Date.parse(a.referred_at) : Infinity;
    const bt = b.referred_at ? Date.parse(b.referred_at) : Infinity;
    return at - bt;
  });
  return sorted.map((row, i) => ({ ...row, rank: i + 1, shortlisted: i < shortlistSize }));
}

module.exports = {
  toUsd,
  normalizeClient,
  computeReturnPct,
  isEligible,
  maskName,
  rankEntries,
  countryLabel,
};
