'use strict';

const { config } = require('./config');
const { connect, ensureIndexes } = require('./db');
const { mongoStore } = require('./store');
const { createApp } = require('./api/app');
const scheduler = require('./jobs/scheduler');

const google = require('./google');
const elefin = require('./elefin');
const { mongoRepo } = require('./admin/repo');
const { createAdminService } = require('./admin/service');

const trigger = (t) => scheduler.runSafely(t);
const rounds = scheduler.defaultRounds();
const adminService = createAdminService({ repo: mongoRepo, elefin, cfg: config, trigger, rounds });

const app = createApp({ store: mongoStore, trigger, cfg: config, google, adminService, rounds });
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1)); // behind one HTTPS reverse proxy by default; set TRUST_PROXY=0 for a direct connection

app.listen(config.port, async () => {
  console.log(`[api] ${config.competition.cohort} listening on :${config.port}`);
  try {
    await connect();
    await ensureIndexes();
    scheduler.start();
  } catch (err) {
    console.error('[bootstrap] Mongo init failed — API/site still served:', err.message);
  }
});
