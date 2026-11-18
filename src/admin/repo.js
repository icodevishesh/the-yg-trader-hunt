'use strict';

const { connect, COLLECTIONS: C } = require('../db');

const key = (cohort, email) => `${cohort}:${email}`;
const PAGE = 50;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Mongo implementation of the admin service's repo. All reads/writes are cohort-scoped. */
const mongoRepo = {
  async loadCurrent(cohort) {
    return (await connect()).collection(C.current).findOne({ _id: cohort }, { projection: { competition_over: 1 } });
  },

  async getTrader(cohort, email) {
    return (await connect()).collection(C.traders).findOne({ _id: key(cohort, email) });
  },

  async getTraderByWallet(cohort, wallet) {
    return (await connect()).collection(C.traders).findOne({ cohort, wallet_id: wallet });
  },

  async listTraders(cohort, { status, q, page, pageSize }) {
    const d = await connect();
    const filter = { cohort };
    if (status) filter.status = status;
    if (q) {
      const rx = new RegExp(esc(q), 'i');
      filter.$or = [{ email: rx }, { wallet_id: rx }, { name: rx }];
    }
    const [rows, total, counts] = await Promise.all([
      d.collection(C.traders).find(filter).sort({ added_at: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
      d.collection(C.traders).countDocuments(filter),
      d.collection(C.traders).aggregate([{ $match: { cohort } }, { $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),
    ]);
    const entries = await d.collection(C.entries).find({ _id: { $in: rows.map((r) => key(cohort, r.email)) } }, { projection: { category: 1, flags: 1, eligible: 1, manual: 1, return_pct: 1, winner_eligible: 1, reasons: 1 } }).toArray();
    const byId = new Map(entries.map((e) => [e._id, e]));
    const manual = await d.collection(C.manual).find({ cohort, enabled: true, wallet_id: { $in: rows.map((r) => r.wallet_id).filter(Boolean) } }, { projection: { wallet_id: 1, mode: 1 } }).toArray();
    const manualBy = new Map(manual.map((m) => [m.wallet_id, m.mode]));
    return {
      page, page_size: pageSize, total,
      counts: Object.fromEntries(counts.map((c) => [c._id, c.n])),
      rows: rows.map((r) => {
        const e = byId.get(key(cohort, r.email)) || {};
        return {
          ...r, _id: undefined, category: e.category || null, flags: e.flags || [], manual: manualBy.get(r.wallet_id) || null,
          return_pct: e.return_pct ?? null, eligible: !!e.eligible, winner_eligible: !!e.winner_eligible, reasons: e.reasons || [],
        };
      }),
    };
  },

  /** true | 'email' | 'wallet' (which unique key collided) */
  async insertTrader(cohort, row) {
    try {
      await (await connect()).collection(C.traders).insertOne({ _id: key(cohort, row.email), ...row });
      return true;
    } catch (err) {
      if (err.code !== 11000) throw err;
      return /wallet_id/.test(err.message) ? 'wallet' : 'email';
    }
  },

  /** Optimistic update: true | false (stale) | 'wallet' (duplicate). Rows without `version` count as 1. */
  async updateTrader(cohort, email, expected, set) {
    const versionMatch = expected === 1 ? { $or: [{ version: 1 }, { version: { $exists: false } }] } : { version: expected };
    try {
      const r = await (await connect()).collection(C.traders).updateOne({ _id: key(cohort, email), ...versionMatch }, { $set: set });
      return r.matchedCount === 1;
    } catch (err) {
      if (err.code === 11000) return 'wallet';
      throw err;
    }
  },

  async setTraderCheck(cohort, email, check) {
    await (await connect()).collection(C.traders).updateOne({ _id: key(cohort, email) }, { $set: { elefin_check: check } });
  },

  async getBaseline(cohort, email) {
    return (await connect()).collection(C.baseline).findOne({ _id: key(cohort, email) });
  },

  /**
   * Unconditionally writes a baseline, overwriting a frozen one. The only place allowed to do this:
   * the admin "Set baseline" action deliberately re-freezes a start line from fresh Elefin data,
   * whereas the scoring pass's store.saveBaseline always protects a frozen baseline.
   */
  async forceSaveBaseline(cohort, email, doc) {
    const { _id, ...fields } = doc;
    await (await connect()).collection(C.baseline).replaceOne(
      { _id: key(cohort, email) },
      { _id: key(cohort, email), ...fields, cohort, email },
      { upsert: true },
    );
  },

  async getEntry(cohort, email) {
    return (await connect()).collection(C.entries).findOne({ _id: key(cohort, email) });
  },

  async getManual(cohort, wallet) {
    return (await connect()).collection(C.manual).findOne({ _id: `${cohort}:${wallet}` });
  },

  /** Insert when `expected` is null, otherwise replace only if the stored version matches. */
  async putManual(cohort, doc, expected) {
    const col = (await connect()).collection(C.manual);
    if (expected === null) {
      try {
        await col.insertOne(doc);
        return true;
      } catch (err) {
        if (err.code === 11000) return false;
        throw err;
      }
    }
    return (await col.replaceOne({ _id: doc._id, version: expected }, doc)).matchedCount === 1;
  },

  async audit(entry) {
    await (await connect()).collection(C.audit).insertOne(entry); // append-only: no update/delete path exists
  },

  async listAudit(cohort, { target, action, page }) {
    const filter = { cohort };
    if (target) filter.target = target;
    if (action) filter.action = action;
    return (await connect()).collection(C.audit).find(filter).sort({ at: -1 }).skip((page - 1) * PAGE).limit(PAGE).toArray();
  },
};

module.exports = { mongoRepo };
