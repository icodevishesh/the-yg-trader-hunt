'use strict';

const express = require('express');
const path = require('path');
const config = require('./config');
const leaderboardRoutes = require('./routes/leaderboard');
const { connect, ensureIndexes } = require('./db/mongo');
const scheduler = require('./jobs/scheduler');

const app = express();

// The whole project root is served statically (pre-existing behaviour), so keep
// server code, config, data exports and secrets out of reach.
const BLOCKED = [
  /^\/\.env/i,
  /^\/config\.js$/i,
  /^\/server\.js$/i,
  /^\/package(-lock)?\.json$/i,
  /^\/leaderboard-plan\.md$/i,
  /^\/(data|db|jobs|routes|services|scripts|fixtures|node_modules)(\/|$)/i,
];
app.use((req, res, next) => {
  if (BLOCKED.some((re) => re.test(req.path))) return res.status(404).type('txt').send('Not found');
  next();
});

app.use(express.static(path.join(__dirname), { dotfiles: 'ignore' }));

app.get('/form', (req, res) => res.sendFile(path.join(__dirname, 'form.html')));
app.get('/leaderboard', (req, res) => res.sendFile(path.join(__dirname, 'leaderboard.html')));

app.use(leaderboardRoutes);

// Unknown /api routes stay JSON; everything else falls back to the landing page.
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(config.port, () => {
  console.log(`Running on port ${config.port}`);
  bootstrap();
});

async function bootstrap() {
  try {
    await connect();
    await ensureIndexes();
    console.log('[mongo] connected, indexes ensured');
    scheduler.start();
  } catch (err) {
    console.error('[bootstrap] Mongo/scheduler init failed — static site still served:', err.message);
  }
}
