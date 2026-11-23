'use strict';

const { MongoClient } = require('mongodb');
const { config } = require('./config');

// Every competition-scoped doc carries the cohort in its key, so Sep 2026 data is never touched.
const COLLECTIONS = {
  traders: 'lb_traders', // registry: who is in the cohort + their wallet id
  baseline: 'lb_baseline', // _id "<cohort>:<email>"
  entries: 'lb_entries', // latest scored row per trader, _id "<cohort>:<email>"
  current: 'lb_current', // published board, _id "<cohort>"
  jobRuns: 'lb_job_runs',
  locks: 'lb_locks',
  manual: 'lb_manual_scores', // _id "<cohort>:<wallet_id>" (Sep docs use client_id and stay untouched)
  audit: 'lb_admin_audit', // append-only
  result: 'lb_result', // round docs, _id "<cohort>:week1" | "<cohort>:week2" (Sep uses _id = cohort and stays untouched)
};

let client;
let db;
let connecting;

async function connect() {
  if (db) return db;
  if (!connecting) {
    connecting = (async () => {
      client = new MongoClient(config.mongo.uri, { serverSelectionTimeoutMS: 20000, retryWrites: true });
      await client.connect();
      db = client.db(config.mongo.dbName);
      return db;
    })().finally(() => {
      connecting = null;
    });
  }
  return connecting;
}

async function ensureIndexes() {
  const d = await connect();
  await Promise.all([
    d.collection(COLLECTIONS.traders).createIndex({ cohort: 1, status: 1 }),
    // Partial: registrations without a resolved account have wallet_id null and must not collide.
    d.collection(COLLECTIONS.traders).createIndex(
      { cohort: 1, wallet_id: 1 },
      { unique: true, partialFilterExpression: { wallet_id: { $type: 'string' } } },
    ),
    d.collection(COLLECTIONS.baseline).createIndex({ cohort: 1, status: 1 }),
    d.collection(COLLECTIONS.entries).createIndex({ cohort: 1, category: 1, return_pct: -1 }),
    d.collection(COLLECTIONS.manual).createIndex({ cohort: 1, enabled: 1 }),
    d.collection(COLLECTIONS.audit).createIndex({ cohort: 1, at: -1 }),
    d.collection(COLLECTIONS.audit).createIndex({ target: 1, at: -1 }),
    d.collection(COLLECTIONS.jobRuns).createIndex({ started_at: -1 }),
    d.collection(COLLECTIONS.locks).createIndex({ acquired_at: 1 }, { expireAfterSeconds: 600 }),
  ]);
}

async function close() {
  if (client) await client.close();
  client = undefined;
  db = undefined;
}

/** The connected MongoClient (for multi-document transactions). */
async function getClient() {
  await connect();
  return client;
}

module.exports = { connect, ensureIndexes, close, getClient, COLLECTIONS };
