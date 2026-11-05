'use strict';

const path = require('path');
const express = require('express');
const { createLeaderboardRouter } = require('./leaderboard');
const { createRegisterRouter } = require('./register');
const { createAdminRouter, adminEnabled } = require('../admin/routes');

const ROOT = path.resolve(__dirname, '../..');

/** Only the public site is served; nothing else in the repo root is reachable. */
function createApp({ store, trigger, cfg, google, limiter, now, adminService, rounds }) {
  const app = express();
  app.disable('x-powered-by');

  // The admin panel exists only when users and a strong secret are configured.
  if (adminService && adminEnabled(cfg.admin)) {
    app.use(cfg.admin.path, createAdminRouter({ service: adminService, admin: cfg.admin }));
  }

  app.use(createRegisterRouter({ store, google, cfg, limiter, now }));
  app.use(createLeaderboardRouter({ store, trigger, cfg, rounds }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

  app.use('/assets', express.static(path.join(ROOT, 'assets'), { dotfiles: 'ignore' }));
  app.use('/uploads', express.static(path.join(ROOT, 'uploads'), { dotfiles: 'ignore' }));
  app.get('/styles.css', (req, res) => res.sendFile(path.join(ROOT, 'styles.css')));
  app.get('/support.js', (req, res) => res.sendFile(path.join(ROOT, 'support.js')));
  app.get('/form', (req, res) => res.sendFile(path.join(ROOT, 'form.html')));
  app.get('/leaderboard', (req, res) => res.sendFile(path.join(ROOT, 'leaderboard.html')));
  app.get('*', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));

  return app;
}

module.exports = { createApp };
