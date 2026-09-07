'use strict';

/*
 * Freeze the final competition result from the current window-score snapshot.
 * Runs once, after COMPETITION_END, after a final `window-score --write`.
 *
 * Writes `lb_result` (_id: <cohort>) from lb_current.entries and sets
 * lb_current.competition_over = true.
 */

const config = require('../config');
const { connect, COLLECTIONS } = require('../db/mongo');

async function finalizeResult({ trigger = 'auto' } = {}) {
  const db = await connect();
  const cohort = config.competition.cohort;

  const current = await db.collection(COLLECTIONS.current).findOne({ _id: 'current' });
  if (!current || !Array.isArray(current.entries) || !current.entries.length) {
    return { ok: false, error: 'no lb_current standings to finalize from — run window-score --write first' };
  }

  const standings = current.entries;
  const winner = standings[0] || null;
  const finalizedAt = new Date();

  const result = {
    _id: cohort,
    finalized_at: finalizedAt,
    trigger,
    generated_from: current.generated_at || null,
    window: current.window || { start: config.competition.start, end: config.competition.end },
    announce_at: config.competition.announceAt,
    formula: current.formula || '(closed_pnl_window + open_position_pnl) / cumulative_capital * 100',
    mark_to_market: !!current.mark_to_market,
    positions_as_of: current.positions_as_of || null,
    winner: winner
      ? {
          rank: winner.rank,
          client_id: winner.client_id,
          name: winner.name,
          return_pct: winner.return_pct,
          return_pct_closed: winner.return_pct_closed ?? null,
          score_pnl: winner.net_profit,
          closed_pnl: winner.closed_pnl ?? null,
          open_pnl: winner.open_pnl ?? null,
          cumulative_capital: winner.cumulative_capital ?? winner.base_start ?? null,
          trades: winner.trades,
          open_positions: winner.open_positions ?? 0,
          reloaded: !!winner.reloaded,
          window_deposits: winner.window_deposits ?? 0,
        }
      : null,
    runners_up: standings.slice(1, 3).map((e) => ({
      rank: e.rank, client_id: e.client_id, name: e.name, return_pct: e.return_pct,
      score_pnl: e.net_profit, cumulative_capital: e.cumulative_capital ?? e.base_start ?? null,
    })),
    standings,
    stats: current.stats || {},
  };

  await db.collection(COLLECTIONS.result).replaceOne({ _id: cohort }, result, { upsert: true });
  await db
    .collection(COLLECTIONS.current)
    .updateOne({ _id: 'current' }, { $set: { competition_over: true, finalized_at: finalizedAt } });

  return { ok: true, result };
}

module.exports = { finalizeResult };
