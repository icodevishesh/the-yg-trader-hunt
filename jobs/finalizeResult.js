'use strict';

/*
 * Build the final, defensible competition result. plan.md §8.
 * Runs once, after COMPETITION_END, after a final refresh has landed.
 *
 * Writes `lb_result` (_id: <cohort>) and sets lb_current.competition_over = true.
 */

const config = require('../config');
const { connect, COLLECTIONS } = require('../db/mongo');
const { maskName } = require('../services/scoring');

function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!domain) return '';
  const head = user.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(1, user.length - 1))}@${domain}`;
}

async function finalizeResult({ trigger = 'auto' } = {}) {
  const db = await connect();
  const cohort = config.competition.cohort;

  const current = await db.collection(COLLECTIONS.current).findOne({ _id: 'current' });
  if (!current || !Array.isArray(current.entries)) {
    return { ok: false, error: 'no lb_current snapshot to finalize from' };
  }

  const participants = await db
    .collection(COLLECTIONS.participants)
    .find({ in_competition: true, cohort })
    .toArray();
  const baselines = new Map(
    (await db.collection(COLLECTIONS.baseline).find({ cohort }).toArray()).map((b) => [b._id, b])
  );

  // client_id -> { email, baseline, elefin }
  const byClientId = new Map();
  for (const p of participants) {
    const e = p.elefin || {};
    if (e.client_id != null) {
      byClientId.set(e.client_id, { email: p._id, name_form: p.name_form, baseline: baselines.get(p._id) || null, elefin: e });
    }
  }

  const standings = current.entries;
  const winnerEligible = standings.filter((e) => e.winner_eligible);
  const winner = winnerEligible[0] || null;
  const runnersUp = winnerEligible.slice(1, 3);

  const excluded = standings
    .filter((e) => !e.winner_eligible)
    .map((e) => {
      const ref = byClientId.get(e.client_id) || {};
      const el = ref.elefin || {};
      const reason = el.late_entry ? 'late_entry' : el.added_funds ? 'added_funds' : 'not_winner_eligible';
      return {
        rank: e.rank,
        name: e.name,
        client_id: e.client_id,
        reason,
        return_pct: e.return_pct,
        deposits_window: el.deposits_window ?? null,
        withdrawals_window: el.withdrawals_window ?? null,
      };
    });

  const auditIds = new Set([
    ...standings.slice(0, 10).map((e) => e.client_id),
    ...excluded.map((e) => e.client_id),
  ]);
  const audit = [...auditIds].map((cid) => {
    const ref = byClientId.get(cid) || {};
    const b = ref.baseline || {};
    const el = ref.elefin || {};
    return {
      client_id: cid,
      name: maskName(el.name || ref.name_form || '', cid),
      email_masked: maskEmail(ref.email),
      baseline: {
        equity_start: b.equity_start ?? null,
        net_profit_start: b.net_profit_start ?? null,
        deposits_start: b.deposits_start ?? null,
        withdrawals_start: b.withdrawals_start ?? null,
        trades_start: b.trades_start ?? null,
        base_start: b.base_start ?? null,
        captured_at: b.captured_at ?? null,
        late_entry: !!b.late_entry,
      },
      final: {
        equity_now: el.equity ?? null,
        net_profit_now: el.net_profit ?? null,
        deposits_now: el.deposits ?? null,
        withdrawals_now: el.withdrawals ?? null,
        trades_now: el.trades ?? null,
        checked_at: el.checked_at ?? null,
      },
      net_profit_window: el.net_profit_window ?? null,
      deposits_window: el.deposits_window ?? null,
      withdrawals_window: el.withdrawals_window ?? null,
      return_pct: el.return_pct ?? null,
      return_pct_alt: el.return_pct_alt ?? null,
    };
  });

  const finalizedAt = new Date();
  const winnerAudit = winner ? (byClientId.get(winner.client_id) || {}) : {};
  const result = {
    _id: cohort,
    finalized_at: finalizedAt,
    trigger,
    generated_from: current.generated_at || null,
    window: { start: config.competition.start, end: config.competition.end },
    announce_at: config.competition.announceAt,
    formula: 'net_profit_window / base_start * 100',
    winner: winner
      ? {
          rank: winner.rank,
          client_id: winner.client_id,
          name: winner.name,
          email_masked: maskEmail(winnerAudit.email),
          return_pct: winner.return_pct,
          return_pct_alt: winner.return_pct_alt ?? null,
          net_profit_window: winner.net_profit,
          base_start: winner.base_start,
          trades_window: winner.trades,
          deposits_window: (winnerAudit.elefin || {}).deposits_window ?? 0,
          withdrawals_window: (winnerAudit.elefin || {}).withdrawals_window ?? 0,
        }
      : null,
    runners_up: runnersUp.map((e) => ({
      rank: e.rank, client_id: e.client_id, name: e.name,
      return_pct: e.return_pct, net_profit_window: e.net_profit, base_start: e.base_start,
    })),
    standings,
    excluded_from_winner: excluded,
    audit,
    stats: current.stats || {},
  };

  await db.collection(COLLECTIONS.result).replaceOne({ _id: cohort }, result, { upsert: true });
  await db
    .collection(COLLECTIONS.current)
    .updateOne({ _id: 'current' }, { $set: { competition_over: true, finalized_at: finalizedAt } });

  return { ok: true, result };
}

module.exports = { finalizeResult };
