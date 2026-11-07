'use strict';

const { connect, COLLECTIONS: C } = require('./db');

const key = (cohort, email) => `${cohort}:${email}`;

/** Mongo-backed store consumed by jobs/score.js. All reads/writes are cohort-scoped. */
const mongoStore = {
  async loadCurrent(cohort) {
    return (await connect()).collection(C.current).findOne({ _id: cohort });
  },

  async loadTraders(cohort) {
    return (await connect()).collection(C.traders).find({ cohort, status: 'active' }).toArray();
  },

  /** Inserts a registration once. true = created, false = email already registered, 'wallet_taken' = account ID used by someone else. */
  async registerTrader(cohort, row) {
    try {
      const res = await (await connect()).collection(C.traders).updateOne(
        { _id: key(cohort, row.email) },
        { $setOnInsert: { ...row, cohort, version: 1, google_sync: { ok: false, attempts: 0 } } },
        { upsert: true },
      );
      return res.upsertedCount === 1;
    } catch (err) {
      if (err.code === 11000) return 'wallet_taken';
      throw err;
    }
  },

  /** Registrations still waiting for an account match, least recently checked first. */
  async loadUnresolved(cohort, limit) {
    return (await connect()).collection(C.traders)
      .find({ cohort, status: { $in: ['pending', 'needs_account'] } })
      .sort({ resolve_checked_at: 1 })
      .limit(limit)
      .toArray();
  },

  /** Returns 'wallet_conflict' when another trader already holds that wallet id. */
  async updateTrader(cohort, email, set) {
    try {
      await (await connect()).collection(C.traders).updateOne({ _id: key(cohort, email) }, { $set: set });
      return 'ok';
    } catch (err) {
      if (err.code === 11000) return 'wallet_conflict';
      throw err;
    }
  },

  /**
   * Rows not yet in the sheet: fresh ones (< maxAttempts tries), rows without google_sync
   * (older admin adds, registry imports), and failed rows whose last try is older than
   * retryAfterMs, so a fixed endpoint eventually picks everything up again.
   */
  async loadUnsynced(cohort, maxAttempts, limit, retryAfterMs = 60 * 60000) {
    const staleBefore = new Date(Date.now() - retryAfterMs).toISOString();
    return (await connect()).collection(C.traders)
      .find({
        cohort,
        'google_sync.ok': { $ne: true },
        $or: [
          { 'google_sync.attempts': { $lt: maxAttempts } },
          { 'google_sync.attempts': { $exists: false } },
          { 'google_sync.at': { $lt: staleBefore } },
        ],
      })
      .sort({ 'google_sync.at': 1 })
      .limit(limit)
      .toArray();
  },

  async markGoogle(cohort, email, ok, error) {
    await (await connect()).collection(C.traders).updateOne(
      { _id: key(cohort, email) },
      { $set: { 'google_sync.ok': !!ok, 'google_sync.error': ok ? null : error || null, 'google_sync.at': new Date().toISOString() }, $inc: { 'google_sync.attempts': 1 } },
    );
  },

  async loadBaselines(cohort) {
    const docs = await (await connect()).collection(C.baseline).find({ cohort }).toArray();
    return new Map(docs.map((d) => [d.email, d]));
  },

  /** Enabled manual entries keyed by wallet id (admin-plan §4). */
  async loadManual(cohort) {
    const docs = await (await connect()).collection(C.manual).find({ cohort, enabled: true }).toArray();
    return new Map(docs.map((d) => [d.wallet_id, d]));
  },

  async loadRound(cohort, round) {
    return (await connect()).collection(C.result).findOne({ _id: `${cohort}:${round}` });
  },

  /** Claims a round for finalizing. False when it is already finalized or being finalized. */
  async claimRound(cohort, round, admin, at) {
    try {
      await (await connect()).collection(C.result).updateOne(
        { $or: [{ status: { $nin: ['finalizing', 'finalized'] } }, { status: 'finalizing', started_at: { $lt: new Date(Date.now() - 30 * 60000).toISOString() } }], _id: `${cohort}:${round}` }, // a crashed finalize can be retried after 30 min
        { $set: { cohort, round, status: 'finalizing', started_by: admin, started_at: at, error: null } },
        { upsert: true },
      );
      return true;
    } catch (err) {
      if (err.code === 11000) return false;
      throw err;
    }
  },

  async finishRound(cohort, round, fields) {
    await (await connect()).collection(C.result).updateOne({ _id: `${cohort}:${round}` }, { $set: { ...fields, status: 'finalized', error: null } });
  },

  async failRound(cohort, round, error) {
    await (await connect()).collection(C.result).updateOne(
      { _id: `${cohort}:${round}`, status: { $ne: 'finalized' } },
      { $set: { status: 'failed', error: String(error).slice(0, 300) } },
    );
  },

  /** Marks each category winner on their registry row so organisers can see it. */
  async markWinners(cohort, round, winners, at) {
    const col = (await connect()).collection(C.traders);
    for (const [category, w] of Object.entries(winners)) {
      if (w) await col.updateOne({ _id: `${cohort}:${w.email}` }, { $addToSet: { wins: { round, category, at } } });
    }
  },

  async loadEntries(cohort) {
    const docs = await (await connect()).collection(C.entries).find({ cohort }).toArray();
    return new Map(docs.map((d) => [d.email, d]));
  },

  /** Never overwrites a frozen/excluded baseline, even if two runs race. */
  async saveBaseline(cohort, email, doc) {
    const { _id, ...fields } = doc;
    try {
      await (await connect()).collection(C.baseline).updateOne(
        { _id: key(cohort, email), status: { $nin: ['frozen', 'excluded'] } },
        { $set: { ...fields, cohort, email } },
        { upsert: true },
      );
    } catch (err) {
      if (err.code !== 11000) throw err; // duplicate key = already frozen by a racing run
    }
  },

  async saveEntries(cohort, rows) {
    if (!rows.length) return;
    const now = new Date().toISOString();
    await (await connect()).collection(C.entries).bulkWrite(
      rows.map((r) => ({
        replaceOne: { filter: { _id: key(cohort, r.email) }, replacement: { ...r, cohort, checked_at: now }, upsert: true },
      })),
      { ordered: false },
    );
  },

  /** Refuses to overwrite a finalized board. */
  async publish(cohort, doc) {
    const res = await (await connect()).collection(C.current).replaceOne(
      { _id: cohort, competition_over: { $ne: true } },
      { _id: cohort, ...doc },
      { upsert: true },
    ).catch((err) => {
      if (err.code === 11000) return null; // already finalized
      throw err;
    });
    return !!res;
  },

  /** TTL-backed lock (index in db.js expires stale locks after 10 min). */
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

  async logRun(entry) {
    await (await connect()).collection(C.jobRuns).insertOne(entry);
  },
};

module.exports = { mongoStore };
