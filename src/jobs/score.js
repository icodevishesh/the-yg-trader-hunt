'use strict';

const { closedPnl, rankByCategory } =require('../domain/scoring');
const { decideBaseline } = require('../domain/baseline');
const { scoreTrader, scoreManualFull, applyBaselineOverrides, ledgerFlows } = require('../domain/entry');

// Bump when closed-trade pricing changes (2: broker-suffixed symbols, unpricedTrades) so every
// cached summary is rebuilt once instead of waiting for the trader's next trade.
const TRADE_CACHE_V = 2;
// The trade feed can lag the account's trade counter by hours (seen 2026-11-25: 39 trades appeared
// in the feed long after they closed). A summary fetched less than this long after the last trade
// is re-fetched on the next run.
const FEED_SETTLE_MS = 6 * 3600 * 1000;
// When the account counter shows more trades than the cached summary, re-fetch at most this often.
const FEED_GAP_RETRY_MS = 3600 * 1000;
// While a deposit/withdrawal of the trader's is pending, the previous row is kept for at most this
// long; after that the fresh row is published, still flagged (prize held).
const FLOW_HOLD_MAX_MS = 6 * 3600 * 1000;

const feedCount = (s) => (s.closedTrades || 0) + (s.openAtEntry || 0) + (s.unpricedTrades || 0);
const counterOf = (account) => (account && account.trades !== null && account.trades !== undefined && account.trades !== '' && Number.isFinite(Number(account.trades)) ? Number(account.trades) : null);

const emptyRow = (trader, baseline, reasons) => ({
  email: trader.email,
  client_id: trader.client_id ?? null,
  name: trader.name || null,
  wallet_id: String(trader.wallet_id),
  is_host: !!trader.is_host,
  category: baseline ? baseline.category || null : null,
  eligible: false,
  winner_eligible: false,
  reasons,
  flags: [],
});

/**
 * One scoring pass. Collaborators are injected (`store`, `elefin`) so the whole
 * pass is testable without Mongo or network.
 *
 * Throws (and publishes nothing) if the ledger is unavailable or too many
 * accounts failed, so a partial board never replaces a good one.
 */
async function runScoring({ store, elefin, cfg, nowMs = Date.now(), finalize = false }) {
  const { competition: comp, scoring } = cfg;
  const cohort = comp.cohort;

  if (nowMs < comp.startMs) return { skipped: 'pre_start' };
  const current = await store.loadCurrent(cohort);
  if (current && current.competition_over) return { skipped: 'competition_over' };

  // Past the end the numbers are fixed (window is capped at `end`). After one pass that reaches the
  // end, stop polling Elefin until an admin finalizes, which is the only thing that closes the board.
  const endIso = new Date(comp.endMs).toISOString();
  if (!finalize && nowMs >= comp.endMs && current && current.window_end === endIso) return { skipped: 'awaiting_finalize' };

  const isFinal = finalize;
  const windowEnd = new Date(Math.min(nowMs, comp.endMs)).toISOString();

  const traders = await store.loadTraders(cohort);
  const baselines = await store.loadBaselines(cohort);
  const previous = await store.loadEntries(cohort);
  // Organiser-entered values (admin-plan §4). Optional so simple stores keep working.
  const manualDocs = store.loadManual ? await store.loadManual(cohort) : new Map();

  const range = { from: new Date(comp.startMs).toISOString(), to: windowEnd };
  const ledger = [];
  for (const type of ['deposit', 'withdrawal']) {
    const r = await elefin.getTransactions(type, range);
    if (!r.ok) throw new Error(`ledger unavailable (${type}): ${r.error}`);
    ledger.push(...r.rows);
  }

  const rows = [];
  const stats = { registered: traders.length, frozen: 0, pending: 0, excluded: 0, failed: 0 };

  for (const trader of traders) {
    const prev = previous.get(trader.email);
    const carry = () => {
      stats.failed += 1;
      if (prev) rows.push({ ...prev, stale: true });
    };

    const manual = manualDocs.get(String(trader.wallet_id));
    const useManual = manual && manual.enabled;

    if (trader.account_source === 'manual' && !useManual) {
      rows.push(emptyRow(trader, null, ['awaiting_manual_data']));
      continue;
    }

    // "full": score purely from our database. No Elefin calls for this trader.
    if (useManual && manual.mode === 'full') {
      stats.frozen += 1;
      rows.push(scoreManualFull({ trader, doc: manual, competition: comp, scoring }));
      continue;
    }

    const acct = await elefin.getAccount(trader.wallet_id);
    if (!acct.ok) {
      carry();
      continue;
    }
    const account = acct.account;
    const ownsAccount =
      String(account.login) === String(trader.wallet_id) &&
      (trader.client_id == null || String(account.client_id) === String(trader.client_id));
    if (!ownsAccount) {
      rows.push(emptyRow(trader, null, ['account_not_found']));
      continue;
    }

    const decision = decideBaseline({
      existing: baselines.get(trader.email),
      account,
      nowMs,
      competition: comp,
      scoring,
    });
    if (decision.changed) await store.saveBaseline(cohort, trader.email, decision.doc);
    let decided = decision.doc;
    // A "fields" manual entry that carries a whole start line stands in for a missing one (e.g. the
    // account was never funded inside the entry window). It is an admin start line, so not late.
    const mf = useManual && manual.mode === 'fields' ? manual.fields || {} : null;
    if (decided.status !== 'frozen' && mf && ['start_capital', 'balance_start', 'captured_at'].every((k) => mf[k] !== undefined && mf[k] !== null)) {
      decided = {
        wallet_id: String(account.login), currency: 'USD', status: 'frozen', source: 'admin', admin_baseline: true,
        captured_at: new Date(mf.captured_at).toISOString(), start_capital: mf.start_capital, start_capital_usd: mf.start_capital,
        balance_start: mf.balance_start, total_deposit_start: null, total_withdrawal_start: null, category: null,
      };
    }

    if (decided.status !== 'frozen') {
      stats[decided.status === 'excluded' ? 'excluded' : 'pending'] += 1;
      rows.push(emptyRow(trader, decided, [decided.status === 'excluded' ? 'entry_closed' : decided.reason || 'awaiting_funding']));
      continue;
    }
    stats.frozen += 1;
    // "fields": the start line may be patched; everything else still comes from Elefin.
    // A trader-level pinned category (set from the trader editor) is applied last so it wins
    // over the capital-derived band, whether or not a manual entry is also active.
    const pin = trader.category_pin ? { category: trader.category_pin } : null;
    const overrides = useManual || pin ? { ...(useManual ? manual.fields || {} : {}), ...(pin || {}) } : null;
    const baseline = applyBaselineOverrides(decided, overrides, scoring);

    // The trades counter only moves when a trade closes, so an unchanged counter means
    // the cached closed-trade summary is still exact. This keeps a run inside the cron interval.
    // Also re-fetch when the cache came from older pricing code (TRADE_CACHE_V) or was taken soon
    // after the last trade: Elefin's feed can lag the counter, and a cached gap would stick until
    // the trader's next trade.
    const cache = prev && prev.trade_cache;
    const lastTradeMs = account.last_trade_at ? Date.parse(account.last_trade_at) : NaN;
    const settled = !Number.isFinite(lastTradeMs) || (cache && Date.parse(cache.fetched_at) - lastTradeMs > FEED_SETTLE_MS);
    // Start lines frozen before trades_start existed (2026-11-23) carry no counter; the estimate
    // kept on the entry row stands in for it (see below).
    const counter = counterOf(account);
    const samePrev = prev && prev.captured_at === baseline.captured_at;
    const knownStart = baseline.trades_start !== null && baseline.trades_start !== undefined && Number.isFinite(Number(baseline.trades_start));
    const prevEst = !knownStart && samePrev && Number.isFinite(prev.trades_start_est) ? prev.trades_start_est : null;
    const startCount = knownStart ? Number(baseline.trades_start) : prevEst;
    const feedBehind = !!cache && !!cache.summary && counter !== null && startCount !== null && counter - startCount > feedCount(cache.summary) &&
      !(nowMs - Date.parse(cache.fetched_at) < FEED_GAP_RETRY_MS);
    // The first estimate must come from a fresh fetch, not an old cached summary.
    const needsEstimate = !knownStart && counter !== null && prevEst === null;
    let summary;
    if (cache && cache.v === TRADE_CACHE_V && settled && !feedBehind && !needsEstimate && cache.acct_trades === account.trades && cache.captured_at === baseline.captured_at) {
      summary = cache.summary;
    } else {
      const t = await elefin.getTrades(trader.wallet_id, { from: baseline.captured_at, to: windowEnd });
      if (!t.ok) {
        stats.frozen -= 1;
        carry();
        continue;
      }
      summary = closedPnl(t.rows, { from: baseline.captured_at, to: windowEnd, contractSize: scoring.contractSize });
    }

    // Estimated counter at the start line: counter now minus the trades the feed shows since then.
    // The feed only ever misses trades, so this is never below the true value, and the smallest
    // estimate seen so far is the best one. closed_trades = max(feed, counter - estimate) >= feed.
    let tradesStartEst = null;
    if (!knownStart && counter !== null) {
      const cand = Math.max(0, counter - feedCount(summary));
      tradesStartEst = prevEst === null ? cand : Math.min(prevEst, cand);
    }
    const scoredBaseline = tradesStartEst === null ? baseline : { ...baseline, trades_start: tradesStartEst };

    const flows = ledgerFlows(ledger, baseline, windowEnd);
    let row = scoreTrader({ trader, baseline: scoredBaseline, account, summary, flows, overrides, manual: useManual ? manual : null, competition: comp, scoring });
    const reused = cache && cache.summary === summary;
    const tradeCache = { v: TRADE_CACHE_V, acct_trades: account.trades, captured_at: baseline.captured_at, fetched_at: reused ? cache.fetched_at : new Date(nowMs).toISOString(), summary };
    row.trade_cache = tradeCache;
    if (tradesStartEst !== null) row.trades_start_est = tradesStartEst;

    // Money still moving: keep the last good figures instead of publishing the jump a pending
    // withdrawal (balance already debited) would cause. Prize stays blocked meanwhile (flow_pending).
    if (row.flows_unsettled) {
      const since = samePrev && prev.flow_hold_since ? prev.flow_hold_since : new Date(nowMs).toISOString();
      const prevGood = samePrev && (!prev.flows_unsettled || prev.flow_held);
      if (prevGood && nowMs - Date.parse(since) < FLOW_HOLD_MAX_MS) {
        const flowFlags = row.flags.filter((f) => f === 'flow_mismatch' || f === 'flow_pending');
        const { stale: _s, ...kept } = prev;
        row = {
          ...kept,
          flags: [...(prev.flags || []).filter((f) => f !== 'flow_mismatch' && f !== 'flow_pending'), ...flowFlags],
          winner_eligible: false,
          flows_unsettled: true,
          flow_held: true,
          flow_hold_since: since,
          trade_cache: tradeCache,
          ...(tradesStartEst !== null ? { trades_start_est: tradesStartEst } : {}),
        };
      } else {
        row.flow_hold_since = since;
      }
    }
    rows.push(row);
  }

  if (traders.length && stats.failed / traders.length > scoring.maxFailedFraction) {
    throw new Error(`partial board refused: ${stats.failed}/${traders.length} accounts failed`);
  }

  await store.saveEntries(cohort, rows);

  const ranked = rankByCategory(rows, scoring.categories);
  const addedByEmail = new Map(traders.map((t) => [t.email, !!t.added_by]));
  // Reasons an admin-curated entry (added through the panel, not self-registered) is allowed to
  // override: they were vetted by hand, so the automated anti-gaming checks don't apply to them.
  // "no_category" / "invalid_net_capital" / blocking flags still stand -- those mean the equity
  // itself is not usable, which no amount of admin review changes.
  const ADMIN_OVERRIDABLE_REASONS = new Set(['entered_after_cutoff', 'no_closed_trade']);
  const categories = {};
  for (const c of scoring.categories) {
    const entered = rows
      .filter(
        (r) =>
          !r.eligible &&
          r.category === c.id &&
          r.reasons.length &&
          r.reasons.every((reason) => ADMIN_OVERRIDABLE_REASONS.has(reason)) &&
          (addedByEmail.get(r.email) || (r.reasons.length === 1 && r.reasons[0] === 'no_closed_trade')),
      )
      // Equity is the only meaningful number for someone with no closed trades, so that is what
      // orders them; they never outrank an actually-trading entrant (those are in `entries`).
      .sort((a, b) => b.net_capital - a.net_capital)
      .map((r, i) => ({ ...r, no_trades: (r.closed_trades || 0) < 1, rank: ranked[c.id].entries.length + i + 1 }));
    categories[c.id] = {
      entries: ranked[c.id].entries,
      entered,
      stats: {
        ranked: ranked[c.id].entries.length,
        entered: entered.length,
        flagged: ranked[c.id].entries.filter((e) => e.flags.length).length,
      },
    };
  }

  const doc = {
    cohort,
    generated_at: new Date(nowMs).toISOString(),
    window_end: windowEnd,
    competition_over: isFinal,
    finalized_at: isFinal ? new Date(nowMs).toISOString() : null,
    stats: { ...stats, ranked: rows.filter((r) => r.eligible).length },
    categories,
  };
  await store.publish(cohort, doc);
  return { published: true, final: isFinal, stats: doc.stats };
}

module.exports = { runScoring };
