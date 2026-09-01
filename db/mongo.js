'use strict';

const { MongoClient } = require('mongodb');
const config = require('../config');

let client;
let db;
let connecting;

async function connect() {
  if (db) return db;
  if (connecting) return connecting;

  connecting = (async () => {
    client = new MongoClient(config.mongo.uri, {
      serverSelectionTimeoutMS: 8000,
      retryWrites: true,
    });
    await client.connect();
    db = client.db(config.mongo.dbName);
    return db;
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

function getDb() {
  if (!db) throw new Error('Mongo not connected yet — call connect() first');
  return db;
}

// Collection name constants so nothing drifts across files.
const COLLECTIONS = {
  participants: 'participants',
  snapshots: 'lb_snapshots',
  current: 'lb_current',
  jobRuns: 'lb_job_runs',
  locks: 'lb_locks',
};

async function ensureIndexes() {
  const d = await connect();
  await Promise.all([
    d.collection(COLLECTIONS.participants).createIndex({ 'elefin.return_pct': -1 }),
    d.collection(COLLECTIONS.participants).createIndex({ 'elefin.matched': 1 }),
    d.collection(COLLECTIONS.participants).createIndex({ 'elefin.eligible': 1 }),
    d.collection(COLLECTIONS.snapshots).createIndex({ generated_at: -1 }),
    d.collection(COLLECTIONS.jobRuns).createIndex({ started_at: -1 }),
    // TTL lock: a stale lock auto-expires ~10 min after it was acquired.
    d.collection(COLLECTIONS.locks).createIndex({ acquired_at: 1 }, { expireAfterSeconds: 600 }),
  ]);
}

async function close() {
  if (client) await client.close();
  client = undefined;
  db = undefined;
}

module.exports = { connect, getDb, ensureIndexes, close, COLLECTIONS };
