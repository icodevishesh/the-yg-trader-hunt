'use strict';

const { connect, getClient, COLLECTIONS: C } = require('../db');

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
   * Replaces a trader's baseline with an admin-set one. `expectedRev` is the rev the admin saw
   * (0 = no baseline, or one never set by an admin). false = someone changed it meanwhile.
   * The scorer never overwrites a frozen baseline, so this cannot be undone by a racing run.
   */
  async replaceBaseline(cohort, email, doc, expectedRev) {
    const col = (await connect()).collection(C.baseline);
    const _id = key(cohort, email);
    const filter = expectedRev === 0 ? { _id, $or: [{ rev: { $exists: false } }, { rev: 0 }] } : { _id, rev: expectedRev };
    try {
      const r = await col.replaceOne(filter, { _id, ...doc, cohort, email }, { upsert: expectedRev === 0 });
      return r.matchedCount === 1 || r.upsertedCount === 1;
    } catch (err) {
      if (err.code === 11000) return false; // a baseline with a rev appeared meanwhile
      throw err;
    }
  },

  /**
   * Moves a trader to a corrected email and/or wallet id in one transaction:
   * trader row, baseline (archived as "superseded" when the wallet changes), score row, manual data.
   * Returns true | 'stale' | 'email' | 'wallet'.
   */
  async moveTrader(cohort, oldEmail, expectedVersion, newDoc, { walletChanged, oldWallet, admin, at }) {
    const d = await connect();
    const client = await getClient();
    const oldId = key(cohort, oldEmail);
    const newId = key(cohort, newDoc.email);
    const versionMatch = expectedVersion === 1 ? { $or: [{ version: 1 }, { version: { $exists: false } }] } : { version: expectedVersion };

    const ops = async (session) => {
      const o = session ? { session } : {};
      const del = await d.collection(C.traders).deleteOne({ _id: oldId, ...versionMatch }, o);
      if (del.deletedCount !== 1) return 'stale';
      if (newId !== oldId && (await d.collection(C.traders).findOne({ _id: newId }, o))) return 'email';
      if (await d.collection(C.traders).findOne({ cohort, wallet_id: newDoc.wallet_id }, o)) return 'wallet';
      await d.collection(C.traders).insertOne({ _id: newId, ...newDoc }, o);

      const b = await d.collection(C.baseline).findOne({ _id: oldId }, o);
      if (b) {
        await d.collection(C.baseline).deleteOne({ _id: oldId }, o);
        const { _id, history, ...prev } = b;
        const moved = walletChanged
          ? { cohort, email: newDoc.email, wallet_id: newDoc.wallet_id, status: 'superseded', reason: 'wallet_changed', rev: (b.rev || 0) + 1, history: [...(history || []), prev].slice(-10), superseded_at: at, superseded_by: admin }
          : { ...prev, email: newDoc.email, history: history || [] };
        await d.collection(C.baseline).insertOne({ _id: newId, ...moved }, o);
      }
      await d.collection(C.entries).deleteOne({ _id: oldId }, o); // the next scoring run writes it fresh

      const manualId = `${cohort}:${oldWallet}`;
      if (walletChanged) {
        await d.collection(C.manual).updateOne({ _id: manualId, enabled: true }, { $set: { enabled: false, disabled_by: admin, disabled_at: at, disabled_reason: 'wallet_changed' }, $inc: { version: 1 } }, o);
      } else {
        await d.collection(C.manual).updateOne({ _id: manualId }, { $set: { email: newDoc.email } }, o);
      }
      return true;
    };

    const session = client.startSession();
    const ABORT = new Error('abort');
    let result;
    try {
      await session.withTransaction(async () => {
        result = await ops(session);
        if (result !== true) throw ABORT; // rolls back the delete
      });
      return result;
    } catch (err) {
      if (err === ABORT) return result;
      if (err.code === 11000) return /wallet_id/.test(err.message) ? 'wallet' : 'email';
      // Standalone MongoDB (local dev) has no transactions; Atlas always does.
      if (err.code === 20 || /Transaction numbers are only allowed|replica set/i.test(err.message)) return ops(null);
      throw err;
    } finally {
      await session.endSession();
    }
  },

  async acquireLock(name) {
    try {
      await (await connect()).collection(C.locks).insertOne({ _id: name, acquired_at: new Date() });
      return true;
    } catch (err) {
      if (err.code === 11000) return false;
      throw err;
    }
  },

  async releaseLock(name) {
    await (await connect()).collection(C.locks).deleteOne({ _id: name });
  },

  /**
   * Unconditionally writes a baseline, overwriting a frozen one. Used by the admin "Set baseline"
   * (snapshot now) action, which deliberately re-freezes a start line from fresh Elefin data;
   * replaceBaseline is the versioned equivalent for "Start line". The scoring pass's
   * store.saveBaseline always protects a frozen baseline.
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
