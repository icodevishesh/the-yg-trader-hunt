'use strict';

const { closedPnl, rankByCategory } =require('../domain/scoring');
const { decideBaseline } = require('../domain/baseline');
const { scoreTrader, scoreManualFull, applyBaselineOverrides, ledgerFlows } = require('../domain/entry');

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
    const decided = decision.doc;

    if (decided.status !== 'frozen') {
      stats[decided.status === 'excluded' ? 'excluded' : 'pending'] += 1;
      rows.push(emptyRow(trader, decided, [decided.status === 'excluded' ? 'entry_closed' : decided.reason || 'awaiting_funding']));
      continue;
    }
    stats.frozen += 1;
    // "fields": the start line may be patched; everything else still comes from Elefin.
    const overrides = useManual ? manual.fields || {} : null;
    const baseline = applyBaselineOverrides(decided, overrides, scoring);

    // The trades counter only moves when a trade closes, so an unchanged counter means
    // the cached closed-trade summary is still exact. This keeps a run inside the cron interval.
    const cache = prev && prev.trade_cache;
    let summary;
    if (cache && cache.acct_trades === account.trades && cache.captured_at === baseline.captured_at) {
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

    const flows = ledgerFlows(ledger, baseline, windowEnd);
    const row = scoreTrader({ trader, baseline, account, summary, flows, overrides, manual: useManual ? manual : null, competition: comp, scoring });
    row.trade_cache = { acct_trades: account.trades, captured_at: baseline.captured_at, summary };
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
