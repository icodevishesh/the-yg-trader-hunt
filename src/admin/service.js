'use strict';

const { validateRegistration, resolveAccount, verifyWallet } = require('../domain/registration');
const { scoreTrader, scoreManualFull, applyBaselineOverrides, OVERRIDABLE } = require('../domain/entry');
const { rebuildBaseline, adjustCapital, BaselineError, tradesCounter } = require('../domain/baseline');
const { pnlCheck } = require('../domain/pnlcheck');
const { categoryFor, netCapital, round2 } = require('../domain/scoring');

/*
 * Admin operations (admin-plan §3-§5). One module shared by the HTTP routes and the CLI,
 * so validation, locks, versioning and the audit log are identical everywhere.
 * `repo` is injected (Mongo in production, in-memory in tests).
 */

class AdminError extends Error {
  constructor(status, code, message, field) {
    super(message);
    Object.assign(this, { status, code, field });
  }
}
const bad = (code, message, field) => new AdminError(400, code, message, field);
const conflict = (code, message) => new AdminError(409, code, message);

const STATUSES = ['pending', 'active', 'withdrawn', 'disqualified', 'needs_account'];
const SOURCES = ['mt5_statement', 'broker_email', 'organiser', 'other'];
const START_LINE = ['start_capital', 'balance_start', 'captured_at'];
const WALLET_RE = /^\d{6,15}$/;
const MIN_REASON = 10;

const isMoney = (n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;

function requireReason(input) {
  const reason = String((input && input.reason) || '').trim();
  if (reason.length < MIN_REASON) throw bad('reason_required', `A reason of at least ${MIN_REASON} characters is required.`, 'reason');
  return reason;
}

/** Manual-data edits: a reason is welcome but not required (who/when/before/after are always logged). */
function optionalReason(input) {
  const reason = String((input && input.reason) || '').trim();
  return reason ? reason.slice(0, 500) : null;
}

function rejectUnknown(input, allowed) {
  for (const k of Object.keys(input || {})) if (!allowed.includes(k)) throw bad('unknown_field', `Unknown field: ${k}`, k);
}

/**
 * Validates the manual input fields. `cfg` supplies the entry window for captured_at.
 * `allowLate` relaxes the captured_at upper bound to the competition end instead of the entry
 * cutoff -- for manual traders there is no live Elefin account to protect from backdating, and
 * admin curation is exactly how they are meant to be added after entry would otherwise be closed.
 */
function validateFields(fields, { requireAll, cfg, allowLate = false }) {
  const f = fields && typeof fields === 'object' ? fields : {};
  rejectUnknown(f, [...OVERRIDABLE, 'category']);
  const out = {};
  // Category is normally derived from start_capital; an admin may pin a band explicitly. Optional
  // in both modes (full mode still derives it from start_capital when left blank).
  if (f.category !== undefined && f.category !== null && f.category !== '') {
    const ids = cfg.scoring.categories.map((c) => c.id);
    if (!ids.includes(f.category)) throw bad('invalid_field', `category must be one of ${ids.join(', ')}.`, 'category');
    out.category = f.category;
  }
  for (const k of OVERRIDABLE) {
    const v = f[k];
    if (v === undefined || v === null || v === '') {
      if (requireAll) throw bad('field_required', `${k} is required in full mode.`, k);
      continue;
    }
    if (k === 'captured_at') {
      const t = Date.parse(v);
      const upper = allowLate ? cfg.competition.endMs : cfg.competition.cutoffMs;
      if (!Number.isFinite(t)) throw bad('invalid_field', 'captured_at must be a valid date.', k);
      if (t < cfg.competition.startMs || t > upper) throw bad('invalid_field', 'captured_at must fall inside the entry window.', k);
      out[k] = new Date(t).toISOString();
    } else if (k === 'closed_trades') {
      if (!Number.isInteger(v) || v < 0) throw bad('invalid_field', 'closed_trades must be an integer >= 0.', k);
      out[k] = v;
    } else {
      if (!isMoney(v)) throw bad('invalid_field', `${k} must be a number with at most 2 decimals.`, k);
      if (['start_capital', 'dep_w', 'wdr_w'].includes(k) && v < 0) throw bad('invalid_field', `${k} must be >= 0.`, k);
      out[k] = v;
    }
  }
  if (!requireAll && !Object.keys(out).length) throw bad('field_required', 'Give at least one field to override.');
  return out;
}

function createAdminService({ repo, elefin, cfg, trigger, rounds, now = Date.now }) {
  const cohort = cfg.competition.cohort;
  const cohort2 = `${cohort}-w2`;
  const lastCheck = new Map(); // admin -> ms, enforces 1 Elefin check per 10 s

  async function assertNotFinalized() {
    const cur = await repo.loadCurrent(cohort);
    if (cur && cur.competition_over) throw conflict('competition_finalized', 'The competition is finalized; this is read-only.');
  }

  async function audit(ctx, action, target, before, after, reason, auditCohort = cohort) {
    await repo.audit({ at: new Date(now()).toISOString(), admin: ctx.admin, action, cohort: auditCohort, target, before: before ?? null, after: after ?? null, reason: reason ?? null, ip: ctx.ip || null });
  }

  async function mustTrader(email) {
    const t = await repo.getTrader(cohort, String(email || '').toLowerCase());
    if (!t) throw new AdminError(404, 'not_found', 'Trader not found.');
    return t;
  }

  /** Which round's data an operation touches: its cohort and scoring config. Week 2 only exists once it can run. */
  async function scopeOf(scope) {
    if (scope === 'week2') {
      const sc = rounds && (await rounds.scoreCfg('week2'));
      if (!sc) throw conflict('week2_locked', 'Week 2 is not open yet (week 1 must be finalized and the week-2 dates set in .env).');
      return { c: cohort2, sc };
    }
    return { c: cohort, sc: cfg };
  }

  /** Week 1 is read-only once its competition is over; week 2 once it is being finalized. */
  async function assertWritable(scope) {
    if (scope !== 'week2') return assertNotFinalized();
    const st = await rounds.status();
    if (st.week2.status === 'locked') throw conflict('week2_locked', 'Week 2 is not open yet (week 1 must be finalized and the week-2 dates set in .env).');
    if (['finalizing', 'finalized'].includes(st.week2.status)) throw conflict('week2_closed', 'Week 2 is finalized; this is read-only.');
    return undefined;
  }

  async function mustTraderByWallet(wallet, c = cohort) {
    const t = await repo.getTraderByWallet(c, String(wallet));
    if (!t) throw new AdminError(404, 'not_found', 'No trader has that wallet id.');
    return t;
  }

  /** Validates a start-line change and computes the new baseline. Writes nothing. */
  async function planBaseline(email, input) {
    rejectUnknown(input, ['at', 'start_capital', 'category', 'rev', 'reason']);
    const t = await mustTrader(email);
    if (t.account_source === 'manual') throw bad('not_applicable', 'Manual traders have no Elefin account; set their numbers in Manual data.');
    if (!t.wallet_id) throw conflict('wallet_required', 'Set an account ID first.');
    const filled = (v) => v !== undefined && v !== null && v !== '';

    let startCapital = null;
    if (filled(input.start_capital)) {
      startCapital = Number(input.start_capital);
      if (!isMoney(startCapital) || startCapital <= 0) throw bad('invalid_field', 'Start capital must be a positive amount with at most 2 decimals.', 'start_capital');
    }
    let category = null;
    if (filled(input.category)) {
      const ids = cfg.scoring.categories.map((c) => c.id);
      if (!ids.includes(input.category)) throw bad('invalid_field', `category must be one of ${ids.join(', ')}.`, 'category');
      category = input.category;
    }

    const previous = await repo.getBaseline(cohort, t.email);
    const nowMs = now();
    const { competition: comp, scoring } = cfg;
    let plan;
    try {
      if (filled(input.at)) {
        const atMs = Date.parse(input.at);
        if (!Number.isFinite(atMs)) throw bad('invalid_field', 'Start time must be a valid date.', 'at');
        if (atMs < comp.startMs) throw bad('invalid_field', `Start time cannot be before the competition start (${comp.start}).`, 'at');
        if (atMs > Math.min(nowMs, comp.endMs)) throw bad('invalid_field', `Start time must be in the past and before the competition end (${comp.end}).`, 'at');
        const acct = await elefin.getAccount(t.wallet_id);
        if (!acct.ok) throw new AdminError(502, 'elefin_unavailable', `Elefin account lookup failed: ${acct.error}`);
        if (String(acct.account.login) !== String(t.wallet_id)) throw conflict('account_not_found', 'Elefin returned a different account.');
        const nowIso = new Date(nowMs).toISOString();
        // Trades from well before T: a position opened before T and closed after it still moved the balance.
        const trades = await elefin.getTrades(t.wallet_id, { from: new Date(comp.startMs - 30 * 86400000).toISOString(), to: nowIso });
        if (!trades.ok) throw new AdminError(502, 'elefin_unavailable', `Elefin trades lookup failed: ${trades.error}`);
        const ledger = [];
        for (const type of ['deposit', 'withdrawal']) {
          const r = await elefin.getTransactions(type, { from: new Date(atMs).toISOString(), to: nowIso });
          if (!r.ok) throw new AdminError(502, 'elefin_unavailable', `Elefin ${type} lookup failed: ${r.error}`);
          ledger.push(...r.rows);
        }
        plan = rebuildBaseline({ account: acct.account, trades: trades.rows, ledger, atMs, nowMs, competition: comp, scoring, startCapital, category, previous });
      } else {
        plan = adjustCapital({ previous, startCapital, category, scoring, nowMs });
      }
    } catch (err) {
      if (err instanceof BaselineError) throw conflict(err.code, err.message);
      throw err;
    }
    // A trader-level pin ("Save category") always wins at scoring time; show that here too.
    if (t.category_pin && !category && plan.doc.category !== t.category_pin) {
      plan.doc.category = t.category_pin;
      plan.warnings.push(`Category ${t.category_pin} is pinned on this trader and overrides the band from the start capital.`);
    }
    if (!plan.doc.category) throw conflict('no_category', `A start capital of $${plan.doc.start_capital_usd} is below the lowest category.`);

    const pick = (b) => b && { status: b.status, captured_at: b.captured_at || null, start_capital: b.start_capital_usd ?? null, balance_start: b.balance_start ?? null, category: b.category || null, source: b.source || 'auto' };
    return {
      t,
      previous,
      plan: {
        baseline: { ...plan.doc, wallet_id: String(t.wallet_id) },
        previous: pick(previous),
        rebuilt: plan.rebuilt,
        category_changed: !!(previous && previous.category && previous.category !== plan.doc.category),
        // Net capital before any deposits after the start line; deposits/withdrawals are added by scoring.
        net_capital_from: round2(netCapital({ startCapital: plan.doc.start_capital_usd, depW: 0, wdrW: 0 })),
        warnings: plan.warnings,
        rev: (previous && previous.rev) || 0,
      },
    };
  }

  const ver = (t) => t.version || 1;
  // Re-score right after an admin change so the board shows it now, not at the next cron tick.
  // Best effort: the scoring lock makes an overlapping run a no-op.
  const rescore = () => {
    try {
      const p = trigger && trigger('admin');
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* a failed trigger never fails the admin action */ }
  };
  const checkVersion = (t, v) => {
    if (v !== ver(t)) throw conflict('stale', 'Someone else changed this trader. Reload and try again.');
  };

  return {
    AdminError,

    async me() {
      const t = now();
      const cur = await repo.loadCurrent(cohort);
      return { cohort, entry_open: t <= cfg.competition.cutoffMs, finalized: !!(cur && cur.competition_over), dates: { start: cfg.competition.start, entry_cutoff: cfg.competition.entryCutoff, end: cfg.competition.end }, week2: cfg.week2 ? { start: cfg.week2.start, end: cfg.week2.end } : null };
    },

    listTraders(query) {
      return repo.listTraders(cohort, { status: query.status || null, q: String(query.q || '').toLowerCase(), page: Math.max(1, Number(query.page) || 1), pageSize: 50 });
    },

    async addTrader(ctx, input) {
      rejectUnknown(input, ['email', 'wallet_id', 'name', 'notes', 'client_id', 'reason', 'manual']);
      await assertNotFinalized();
      const manual = !!input.manual;
      // The entry cutoff exists to stop Elefin-sourced accounts from joining and getting scored
      // as if they had been trading since day one. A manual trader has no Elefin account to
      // backdate -- adding one late, on purpose, with hand-entered numbers, is exactly this
      // feature's point -- so the cutoff does not apply to them.
      if (!manual && now() > cfg.competition.cutoffMs) throw conflict('entry_closed', 'Entry is closed; no new traders can be added.');
      const reason = requireReason(input);
      const { errors, value } = validateRegistration({ name: input.name || 'x', email: input.email, phone: '00000000', agree: true });
      if (errors.email) throw bad('invalid_field', errors.email, 'email');
      // Manual traders have no Elefin account, so their id does not need to be a real MT5 login --
      // the admin picks any id to identify him by. Mark the source so scoring (score.js) and the
      // Elefin-check UI know to skip Elefin for him entirely.
      let wallet;
      if (manual) {
        wallet = String(input.wallet_id ?? '').trim();
        if (!wallet) throw bad('invalid_field', 'Give this trader an id (any text, does not need to be a real MT5 login).', 'wallet_id');
        if (wallet.length > 40) throw bad('invalid_field', 'wallet_id must be at most 40 characters.', 'wallet_id');
      } else {
        wallet = String(input.wallet_id ?? '');
        if (!WALLET_RE.test(wallet)) throw bad('invalid_field', 'wallet_id must be 6-15 digits.', 'wallet_id');
      }
      const row = {
        email: value.email, wallet_id: wallet, client_id: input.client_id != null ? Number(input.client_id) : null,
        name: input.name ? value.name : null, notes: input.notes ? String(input.notes).slice(0, 500) : null,
        status: 'pending', cohort, version: 1, added_at: new Date(now()).toISOString(), added_by: ctx.admin,
        updated_at: null, updated_by: null, elefin_check: null,
        ...(manual ? { account_source: 'manual' } : {}),
        google_sync: { ok: false, attempts: 0 }, // picked up by the scheduler's sheet mirror
      };
      const res = await repo.insertTrader(cohort, row);
      if (res !== true) throw conflict(res === 'wallet' ? 'duplicate_wallet' : 'duplicate_email', res === 'wallet' ? 'That wallet id belongs to another trader.' : 'That email is already registered.');
      await audit(ctx, 'trader.create', row.email, null, row, reason);
      return row;
    },

    async updateTrader(ctx, email, input) {
      rejectUnknown(input, ['version', 'name', 'notes', 'wallet_id', 'reason']);
      await assertNotFinalized();
      const t = await mustTrader(email);
      checkVersion(t, input.version);
      const reason = requireReason(input);
      const set = {};
      if (input.name !== undefined) set.name = String(input.name).trim().slice(0, 100) || null;
      if (input.notes !== undefined) set.notes = String(input.notes).slice(0, 500) || null;
      if (input.wallet_id !== undefined && String(input.wallet_id) !== t.wallet_id) {
        // A real account must be verified against the email in Elefin; that lives in correctIdentity.
        if (t.account_source !== 'manual') throw conflict('use_correct_details', 'Change the account ID with "Correct email / account ID"; it checks the account in Elefin first.');
        const wallet = String(input.wallet_id);
        if (!WALLET_RE.test(wallet)) throw bad('invalid_field', 'wallet_id must be 6-15 digits.', 'wallet_id');
        const b = await repo.getBaseline(cohort, t.email);
        if (b && b.status === 'frozen') throw conflict('baseline_frozen', 'This trader\'s start line is frozen on the current wallet; re-baseline first.');
        set.wallet_id = wallet;
        set.elefin_check = null;
      }
      if (!Object.keys(set).length) throw bad('nothing_to_change', 'No changes given.');
      Object.assign(set, { updated_at: new Date(now()).toISOString(), updated_by: ctx.admin, version: ver(t) + 1 });
      const res = await repo.updateTrader(cohort, t.email, ver(t), set);
      if (res === 'wallet') throw conflict('duplicate_wallet', 'That wallet id belongs to another trader.');
      if (res !== true) throw conflict('stale', 'Someone else changed this trader. Reload and try again.');
      await audit(ctx, 'trader.update', t.email, t, { ...t, ...set }, reason);
      return { ...t, ...set };
    },

    async setStatus(ctx, email, input) {
      rejectUnknown(input, ['to', 'version', 'reason', 'override_check']);
      await assertNotFinalized();
      const t = await mustTrader(email);
      checkVersion(t, input.version);
      const reason = requireReason(input);
      if (!STATUSES.includes(input.to)) throw bad('invalid_field', `status must be one of ${STATUSES.join(', ')}.`, 'to');
      if (input.to === 'active') {
        if (!t.wallet_id) throw conflict('wallet_required', 'Set a wallet id before activating.');
        // Manual traders have no Elefin account to match against; their numbers are vetted by
        // hand through the manual-data form instead, so the automated check does not apply.
        const ok = t.account_source === 'manual' || (t.elefin_check && t.elefin_check.ok && t.elefin_check.owner_match);
        if (!ok && !input.override_check) throw conflict('check_required', 'Run "Check in Elefin" first (or override with a reason).');
      }
      const set = { status: input.to, updated_at: new Date(now()).toISOString(), updated_by: ctx.admin, version: ver(t) + 1 };
      if (!(await repo.updateTrader(cohort, t.email, ver(t), set))) throw conflict('stale', 'Someone else changed this trader. Reload and try again.');
      await audit(ctx, 'trader.status', t.email, { status: t.status }, { status: input.to, override_check: !!input.override_check }, reason);
      return { ...t, ...set };
    },

    /**
     * Pins (or clears) a trader's category. First-class trader attribute: scoring applies
     * `category_pin` over the capital-derived band, independent of any manual entry. Empty/null
     * clears the pin and reverts to the derived band.
     */
    async setCategory(ctx, email, input) {
      rejectUnknown(input, ['category', 'version', 'reason']);
      await assertNotFinalized();
      const t = await mustTrader(email);
      checkVersion(t, input.version);
      const reason = requireReason(input);
      let category = null;
      if (input.category !== undefined && input.category !== null && input.category !== '') {
        const ids = cfg.scoring.categories.map((c) => c.id);
        if (!ids.includes(input.category)) throw bad('invalid_field', `category must be one of ${ids.join(', ')}.`, 'category');
        category = input.category;
      }
      const set = { category_pin: category, updated_at: new Date(now()).toISOString(), updated_by: ctx.admin, version: ver(t) + 1 };
      if (!(await repo.updateTrader(cohort, t.email, ver(t), set))) throw conflict('stale', 'Someone else changed this trader. Reload and try again.');
      await audit(ctx, 'trader.category', t.email, { category_pin: t.category_pin ?? null }, { category_pin: category }, reason);
      return { ...t, ...set };
    },

    /**
     * Re-baselines one trader from live Elefin data on demand. Fetches the account, freezes a new
     * start line at the current equity ("snapshot now"), overwriting any existing frozen baseline,
     * then triggers a re-score so the trade cache, flows and published board are rebuilt by the
     * normal pipeline. Marked `admin_baseline` so scoring exempts it from the entry cutoff/late flag.
     * ("Start line" -- setBaseline below -- is the variant for a chosen past time or a typed capital.)
     */
    async snapshotBaseline(ctx, email, input) {
      rejectUnknown(input, ['version', 'reason']);
      await assertNotFinalized();
      const t = await mustTrader(email);
      checkVersion(t, input.version);
      const reason = requireReason(input);
      if (t.account_source === 'manual') throw bad('not_applicable', 'Manual traders have no Elefin account to baseline from; enter their numbers in "Manual data" instead.');
      if (!t.wallet_id) throw conflict('wallet_required', 'Set a wallet id before setting a baseline.');
      const acct = await elefin.getAccount(t.wallet_id);
      if (!acct.ok) throw new AdminError(502, 'elefin_unavailable', `Elefin account lookup failed: ${acct.error}`);
      const account = acct.account;
      const ownsAccount = String(account.login) === String(t.wallet_id) && (t.client_id == null || String(account.client_id) === String(t.client_id));
      if (!ownsAccount) throw conflict('wallet_not_on_client', 'That wallet id does not belong to this trader in Elefin.');
      const equity = Number(account.equity);
      const currency = String(account.currency || 'USD').toUpperCase();
      if (currency !== 'USD') throw bad('unsupported_currency', `Account currency is ${currency}; only USD accounts can be baselined.`, 'currency');
      if (!Number.isFinite(equity) || equity < cfg.scoring.minCapitalUsd) throw bad('below_min_capital', `Account equity (${Number.isFinite(equity) ? equity : 'n/a'}) is below the ${cfg.scoring.minCapitalUsd} USD minimum.`, 'equity');
      const nowIso = new Date(now()).toISOString();
      const before = await repo.getBaseline(cohort, t.email);
      const doc = {
        wallet_id: String(account.login), currency, equity_seen: round2(equity), seen_at: nowIso,
        status: 'frozen', captured_at: nowIso,
        start_capital: round2(equity), start_capital_usd: round2(equity),
        balance_start: round2(Number(account.balance)),
        total_deposit_start: round2(Number(account.total_deposit) || 0),
        total_withdrawal_start: round2(Number(account.total_withdrawal) || 0),
        trades_start: tradesCounter(account),
        category: t.category_pin || categoryFor(equity, cfg.scoring.categories),
        late_entry: false, admin_baseline: true, source: 'admin',
        // Same history/rev bookkeeping as setBaseline, so "Start line" sees this change and can undo it.
        rev: ((before && before.rev) || 0) + 1,
        history: before ? [...(before.history || []), (({ _id, history, rev, ...prev }) => prev)(before)].slice(-10) : [],
        set_by: ctx.admin, set_at: nowIso, set_reason: reason,
      };
      await repo.forceSaveBaseline(cohort, t.email, doc);
      await audit(ctx, 'trader.baseline', t.email, before, doc, reason);
      trigger('admin');
      return { baseline: doc, rescore: true };
    },

    // ---------- P/L check: explain and fix pnl_mismatch per trader ----------

    /**
     * Lists every trade closed since the trader's start line (or `from`) with its P/L, and
     * reconciles the trade P/L with the balance movement, naming the causes of any gap. Read-only.
     */
    async checkPnl(email, input = {}) {
      rejectUnknown(input, ['from']);
      const t = await mustTrader(email);
      if (t.account_source === 'manual') throw bad('not_applicable', 'This trader has no Elefin account; their P/L is what you entered in Manual data.');
      const manual = await repo.getManual(cohort, String(t.wallet_id));
      if (manual && manual.enabled && manual.mode === 'full') throw bad('not_applicable', 'This trader is scored entirely from Manual data (mode full), so there are no Elefin trades to check.');
      const b = await repo.getBaseline(cohort, t.email);
      const mf = manual && manual.enabled && manual.mode === 'fields' ? manual.fields || {} : {};
      const hasTypedStart = ['captured_at', 'balance_start'].every((k) => mf[k] !== undefined && mf[k] !== null);
      if (!(b && b.status === 'frozen') && !hasTypedStart) throw conflict('no_start_line', 'This trader has no start line yet. Set one first ("Start line" or "Set baseline").');
      const startLine = applyBaselineOverrides(b && b.status === 'frozen' ? b : {}, mf, cfg.scoring);

      const nowMs = Math.min(now(), cfg.competition.endMs);
      let listFromMs = null;
      if (input.from) {
        listFromMs = Date.parse(input.from);
        if (!Number.isFinite(listFromMs) || listFromMs > nowMs) throw bad('invalid_field', '"From" must be a valid date in the past.', 'from');
      }
      const startMs = Date.parse(startLine.captured_at);
      const earliest = Math.min(startMs, listFromMs ?? startMs);
      const nowIso = new Date(nowMs).toISOString();

      const acct = await elefin.getAccount(t.wallet_id);
      if (!acct.ok) throw new AdminError(502, 'elefin_unavailable', `Elefin account lookup failed: ${acct.error}`);
      // From well before the start: a position opened before it and closed after it still counts in the balance.
      const tr = await elefin.getTrades(t.wallet_id, { from: new Date(earliest - 30 * 86400000).toISOString(), to: nowIso });
      if (!tr.ok) throw new AdminError(502, 'elefin_unavailable', `Elefin trades lookup failed: ${tr.error}`);
      const ledger = [];
      for (const type of ['deposit', 'withdrawal']) {
        const r = await elefin.getTransactions(type, { from: new Date(startMs).toISOString(), to: nowIso });
        if (!r.ok) throw new AdminError(502, 'elefin_unavailable', `Elefin ${type} lookup failed: ${r.error}`);
        ledger.push(...r.rows);
      }
      const res = pnlCheck({ account: acct.account, trades: tr.rows, ledger, startLine, nowMs, contractSize: cfg.scoring.contractSize, toleranceUsd: cfg.scoring.pnlToleranceUsd, listFromMs });
      const entry = await repo.getEntry(cohort, t.email);
      return {
        ...res,
        wallet_id: t.wallet_id,
        pnl_source: t.pnl_source === 'balance' ? 'balance' : 'trades',
        version: ver(t),
        scored: entry ? { pnl: entry.pnl ?? null, return_pct: entry.return_pct ?? null, flags: entry.flags || [], reconcile_diff: entry.reconcile_diff ?? null } : null,
      };
    },

    /**
     * Chooses where a trader's P/L comes from on every scoring run:
     *   trades   rebuilt from closed trades (default)
     *   balance  the real balance movement since the start line (fixes a pnl_mismatch for good)
     */
    async setPnlSource(ctx, email, input) {
      rejectUnknown(input, ['source', 'version', 'reason']);
      await assertNotFinalized();
      const t = await mustTrader(email);
      checkVersion(t, input.version);
      if (!['trades', 'balance'].includes(input.source)) throw bad('invalid_field', 'source must be "trades" or "balance".', 'source');
      if (t.account_source === 'manual') throw bad('not_applicable', 'This trader has no Elefin account; their P/L is what you entered in Manual data.');
      const before = t.pnl_source === 'balance' ? 'balance' : 'trades';
      if (before === input.source) throw bad('nothing_to_change', `P/L already comes from ${input.source}.`);
      const set = { pnl_source: input.source, updated_at: new Date(now()).toISOString(), updated_by: ctx.admin, version: ver(t) + 1 };
      if (!(await repo.updateTrader(cohort, t.email, ver(t), set))) throw conflict('stale', 'Someone else changed this trader. Reload and try again.');
      await audit(ctx, 'trader.pnl_source', t.email, { pnl_source: before }, { pnl_source: input.source }, optionalReason(input));
      rescore();
      return { ...t, ...set };
    },

    /** One Elefin lookup: does this wallet id belong to this email's client? */
    async checkTrader(ctx, email) {
      const t = await mustTrader(email);
      if (t.account_source === 'manual') throw bad('not_applicable', 'This trader has no Elefin account; manual traders skip this check.');
      const last = lastCheck.get(ctx.admin) || 0;
      if (now() - last < 10000) throw new AdminError(429, 'rate_limited', 'Please wait 10 seconds between Elefin checks.');
      lastCheck.set(ctx.admin, now());
      const r = await elefin.lookupClient(t.email);
      if (!r.ok) throw new AdminError(502, 'elefin_unavailable', `Elefin lookup failed: ${r.error}`);
      const data = r.data;
      const items = (data && data.accounts && data.accounts.items) || [];
      const logins = ((data && data.accounts && data.accounts.logins) || []).map(String);
      const mine = items.find((i) => String(i.login) === t.wallet_id);
      const ownerMatch = !!data && logins.includes(t.wallet_id) && (t.client_id == null || String(data.client_id) === String(t.client_id));
      const check = {
        at: new Date(now()).toISOString(), ok: !!data, logins, owner_match: ownerMatch,
        equity: mine ? mine.equity : null, suggested: data ? resolveAccount(data, { minCapitalUsd: cfg.scoring.minCapitalUsd }).wallet_id || null : null,
        message: !data ? 'No Elefin client with this email.' : ownerMatch ? 'Wallet id belongs to this client.' : 'Wallet id is not on this client.',
      };
      await repo.setTraderCheck(cohort, t.email, check);
      await audit(ctx, 'elefin.check', t.email, null, check, null);
      return check;
    },

    // ---------- corrections: email / account ID, start line ----------

    /**
     * Corrects a trader's email and/or account ID. The new account must belong to the (new) email
     * in Elefin -- a mismatch is refused, never overridden. Everything keyed by email moves with
     * the trader; a changed account supersedes the old start line, so the trader then needs a new
     * one (setBaseline) before they are scored again.
     */
    async correctIdentity(ctx, email, input) {
      rejectUnknown(input, ['version', 'new_email', 'new_wallet_id', 'reason']);
      await assertNotFinalized();
      const t = await mustTrader(email);
      checkVersion(t, input.version);
      const reason = requireReason(input);
      const isManual = t.account_source === 'manual';

      let newEmail = t.email;
      if (input.new_email !== undefined && String(input.new_email).trim() !== '') {
        const { errors, value } = validateRegistration({ name: 'x', email: input.new_email, phone: '00000000', agree: true });
        if (errors.email) throw bad('invalid_field', errors.email, 'new_email');
        newEmail = value.email;
      }
      let newWallet = t.wallet_id;
      if (input.new_wallet_id !== undefined && String(input.new_wallet_id).trim() !== '') {
        newWallet = String(input.new_wallet_id).trim();
        if (isManual ? newWallet.length > 40 : !WALLET_RE.test(newWallet)) throw bad('invalid_field', isManual ? 'Account ID must be at most 40 characters.' : 'Account ID must be 6-15 digits.', 'new_wallet_id');
      }
      const emailChanged = newEmail !== t.email;
      const walletChanged = newWallet !== t.wallet_id;
      if (!emailChanged && !walletChanged) throw bad('nothing_to_change', 'The new email and account ID are the same as the current ones.');
      if (emailChanged && (await repo.getTrader(cohort, newEmail))) throw conflict('duplicate_email', 'That email is already registered.');
      if (walletChanged) {
        const other = await repo.getTraderByWallet(cohort, newWallet);
        if (other && other.email !== t.email) throw conflict('duplicate_wallet', `That account ID belongs to ${other.email}.`);
      }

      const at = new Date(now()).toISOString();
      const set = {};
      if (!isManual) {
        const r = await elefin.lookupClient(newEmail);
        if (!r.ok) throw new AdminError(502, 'elefin_unavailable', `Elefin lookup failed: ${r.error}`);
        if (!r.data) throw conflict('elefin_no_client', `No Elefin client has the email ${newEmail}.`);
        const v = verifyWallet(r.data, newWallet);
        const logins = ((r.data.accounts && r.data.accounts.logins) || ((r.data.accounts && r.data.accounts.items) || []).map((i) => i.login)).map(String);
        if (v.status !== 'active') throw conflict('wallet_not_on_client', `Account ${newWallet} does not belong to ${newEmail} in Elefin.${logins.length ? ` Their accounts: ${logins.join(', ')}.` : ''}`);
        Object.assign(set, {
          client_id: v.client_id ?? null,
          country: v.country || t.country || null,
          elefin_check: { at, ok: true, logins, owner_match: true, equity: null, suggested: null, message: 'Verified while correcting details.' },
        });
        // A verified correction is what was missing; withdrawn/disqualified stay as they are.
        if (['pending', 'needs_account'].includes(t.status)) Object.assign(set, { status: 'active', reason: null });
      }

      const { _id, ...rest } = t;
      const doc = {
        ...rest, ...set, email: newEmail, wallet_id: newWallet, version: ver(t) + 1, updated_at: at, updated_by: ctx.admin,
        identity_history: [...(t.identity_history || []), { email: t.email, wallet_id: t.wallet_id, at, by: ctx.admin, reason }].slice(-10),
        // Re-send to the sheet; previous_email lets the Apps Script update the old row in place.
        google_sync: { ok: false, attempts: 0, previous_email: t.email },
      };

      const lock = `score:${cohort}`;
      if (!(await repo.acquireLock(lock))) throw conflict('scoring_running', 'A scoring run is in progress. Try again in a minute.');
      let res;
      try {
        res = await repo.moveTrader(cohort, t.email, ver(t), doc, { walletChanged, oldWallet: t.wallet_id, admin: ctx.admin, at });
      } finally {
        await repo.releaseLock(lock).catch(() => {});
      }
      if (res === 'email') throw conflict('duplicate_email', 'That email is already registered.');
      if (res === 'wallet') throw conflict('duplicate_wallet', 'That account ID belongs to another trader.');
      if (res !== true) throw conflict('stale', 'Someone else changed this trader. Reload and try again.');

      const before = { email: t.email, wallet_id: t.wallet_id, status: t.status, client_id: t.client_id ?? null };
      const after = { email: newEmail, wallet_id: newWallet, status: doc.status, client_id: doc.client_id ?? null, baseline: walletChanged ? 'superseded' : 'kept' };
      await audit(ctx, 'trader.identity', t.email, before, after, reason);
      if (emailChanged) await audit(ctx, 'trader.identity', newEmail, before, after, reason); // findable under both emails
      if (!(walletChanged && !isManual)) rescore(); // a changed account waits for its new start line
      return { trader: doc, needs_baseline: walletChanged && !isManual };
    },

    /** Current start line of a trader, with the rev the admin must send back to change it. */
    async getBaseline(email) {
      const t = await mustTrader(email);
      const b = await repo.getBaseline(cohort, t.email);
      return { baseline: b, rev: (b && b.rev) || 0 };
    },

    /** Dry run of setBaseline: the start line that would be saved, and what it does to net capital. */
    async previewBaseline(email, input) {
      const { t, plan } = await planBaseline(email, input);
      return { ...plan, wallet_id: t.wallet_id };
    },

    /**
     * Sets a trader's start line by hand:
     *   at (+ optional start_capital / category)  rebuild it at that moment from Elefin history
     *   start_capital and/or category alone        keep the start time, change capital / band
     * Category: a pinned one wins; an explicit capital derives the band; otherwise the old band stays.
     */
    async setBaseline(ctx, email, input) {
      const reason = requireReason(input);
      await assertNotFinalized();
      const { t, plan, previous } = await planBaseline(email, input);
      const expected = Number(input.rev ?? -1);
      const prevRev = (previous && previous.rev) || 0;
      if (expected !== prevRev) throw conflict('stale', 'The start line changed since you opened it. Reload and try again.');
      const { _id, history, rev, ...prev } = previous || {};
      const doc = { ...plan.baseline, rev: prevRev + 1, history: previous ? [...(history || []), prev].slice(-10) : [], set_by: ctx.admin, set_at: new Date(now()).toISOString(), set_reason: reason };
      if (!(await repo.replaceBaseline(cohort, t.email, doc, prevRev))) throw conflict('stale', 'The start line changed since you opened it. Reload and try again.');
      await audit(ctx, 'baseline.set', t.email, previous ? prev : null, plan.baseline, reason);
      rescore();
      return { ...plan, baseline: doc };
    },

    // ---------- manual data (week 1 by default; week 2 entrants use scope "week2") ----------

    async getManual(wallet, scope = 'week1') {
      const { c } = await scopeOf(scope);
      await mustTraderByWallet(wallet, c);
      return { current: await repo.getManual(c, String(wallet)), history: await repo.listAudit(c, { target: String(wallet), page: 1 }) };
    },

    async setManual(ctx, wallet, input, scope = 'week1') {
      rejectUnknown(input, ['mode', 'fields', 'source', 'source_ref', 'reason', 'version', 'rebaseline']);
      const { c, sc } = await scopeOf(scope);
      await assertWritable(scope);
      const t = await mustTraderByWallet(wallet, c);
      const reason = optionalReason(input);
      if (!['fields', 'full'].includes(input.mode)) throw bad('invalid_field', 'mode must be "fields" or "full".', 'mode');
      if (!SOURCES.includes(input.source)) throw bad('invalid_field', `source must be one of ${SOURCES.join(', ')}.`, 'source');
      const isManual = t.account_source === 'manual';
      // rebaseline = the admin deliberately sets the start line (like "Start line" / "Set baseline"),
      // so it may fall after the entry cutoff and is scored as an admin start line.
      const rebaseline = !!input.rebaseline;
      const fields = validateFields(input.fields, { requireAll: input.mode === 'full', cfg: sc, allowLate: isManual || rebaseline });
      // Re-baseline protection guards against backdating a *real* Elefin account's start line.
      // A manual trader has no live account to backdate -- the admin's numbers are the baseline --
      // so this does not apply to them.
      if (!isManual && START_LINE.some((k) => k in fields) && now() > sc.competition.cutoffMs && !input.rebaseline) {
        throw conflict('rebaseline_required', 'Start-line fields can only change after the entry cutoff with an explicit re-baseline.');
      }
      // A manual trader has no Elefin data to patch: only "full" can score him.
      if (isManual && input.mode === 'fields') throw bad('full_required', 'This trader has no Elefin account, so use mode "full" and fill every field.', 'mode');
      // "fields" patches an existing start line. Without one (after the cutoff it can no longer
      // freeze by itself) the values would be ignored, unless they include a whole new start line.
      if (!isManual && input.mode === 'fields' && scope !== 'week2' && now() > sc.competition.cutoffMs && !START_LINE.every((k) => k in fields)) {
        const b = await repo.getBaseline(c, t.email);
        if (!b || b.status !== 'frozen') throw conflict('no_start_line', 'This trader has no start line yet, so these values would be ignored. Also fill Start capital, Balance at start and Entered at, or use mode "full".');
      }
      const before = await repo.getManual(c, String(wallet));
      if ((before ? before.version : null) !== (input.version ?? null)) throw conflict('stale', 'Someone else changed this manual entry. Reload and try again.');
      const doc = {
        _id: `${c}:${wallet}`, cohort: c, email: t.email, wallet_id: String(wallet), mode: input.mode, enabled: true, fields,
        source: input.source, source_ref: input.source_ref ? String(input.source_ref).slice(0, 200) : null,
        reason, entered_by: ctx.admin, entered_at: new Date(now()).toISOString(), version: (before ? before.version : 0) + 1,
        rebaseline: rebaseline && START_LINE.some((k) => k in fields),
      };
      if (!(await repo.putManual(c, doc, before ? before.version : null))) throw conflict('stale', 'Someone else changed this manual entry. Reload and try again.');
      await audit(ctx, 'manual.set', String(wallet), before, doc, reason, c);
      rescore();
      return doc;
    },

    async disableManual(ctx, wallet, input, scope = 'week1') {
      rejectUnknown(input, ['reason']);
      const { c } = await scopeOf(scope);
      await assertWritable(scope);
      await mustTraderByWallet(wallet, c);
      const reason = optionalReason(input);
      const before = await repo.getManual(c, String(wallet));
      if (!before || !before.enabled) throw conflict('not_enabled', 'No active manual entry for this wallet.');
      const after = { ...before, enabled: false, version: before.version + 1, disabled_by: ctx.admin, disabled_at: new Date(now()).toISOString() };
      if (!(await repo.putManual(c, after, before.version))) throw conflict('stale', 'Someone else changed this manual entry. Reload and try again.');
      await audit(ctx, 'manual.disable', String(wallet), before, after, reason, c);
      rescore();
      return after;
    },

    /** Removes a manual entry completely (Switch off keeps it). The audit log keeps a copy. */
    async deleteManual(ctx, wallet, input, scope = 'week1') {
      rejectUnknown(input || {}, ['reason']);
      const { c } = await scopeOf(scope);
      await assertWritable(scope);
      await mustTraderByWallet(wallet, c);
      const before = await repo.getManual(c, String(wallet));
      if (!before) throw new AdminError(404, 'not_found', 'This trader has no manual entry.');
      await repo.deleteManual(c, String(wallet));
      await audit(ctx, 'manual.delete', String(wallet), before, null, optionalReason(input), c);
      rescore();
      return { deleted: true };
    },

    /**
     * Removes a trader from the competition: registry row, start line, score row and manual data.
     * The audit log keeps a full copy (so it can be restored by hand). Refused for a recorded winner
     * or a week-2 entrant, and the admin must type the trader's email to confirm.
     */
    async deleteTrader(ctx, email, input) {
      rejectUnknown(input || {}, ['confirm_email', 'reason']);
      await assertNotFinalized();
      const t = await mustTrader(email);
      if (String((input && input.confirm_email) || '').trim().toLowerCase() !== t.email) throw bad('confirm_required', `Type the trader's email (${t.email}) to confirm.`, 'confirm_email');
      if (t.wins && t.wins.length) throw conflict('is_winner', 'This trader is a recorded winner and cannot be deleted. Set the status to disqualified instead.');
      if (await repo.getTrader(cohort2, t.email)) throw conflict('in_week2', 'This trader is a week-2 entrant. Remove them from week 2 first.');
      const lock = `score:${cohort}`;
      if (!(await repo.acquireLock(lock))) throw conflict('scoring_running', 'A scoring run is in progress. Try again in a minute.');
      let snapshot;
      try {
        snapshot = await repo.deleteTrader(cohort, t.email, t.wallet_id);
      } finally {
        await repo.releaseLock(lock).catch(() => {});
      }
      await audit(ctx, 'trader.delete', t.email, snapshot, null, optionalReason(input));
      rescore();
      return { deleted: true, email: t.email };
    },

    /** Dry run: what this trader would score with the given manual input. Writes nothing. */
    async preview(wallet, input, scope = 'week1') {
      rejectUnknown(input, ['mode', 'fields', 'rebaseline']);
      const { c, sc } = await scopeOf(scope);
      const t = await mustTraderByWallet(wallet, c);
      if (!['fields', 'full'].includes(input.mode)) throw bad('invalid_field', 'mode must be "fields" or "full".', 'mode');
      const rebaseline = !!input.rebaseline;
      const fields = validateFields(input.fields, { requireAll: input.mode === 'full', cfg: sc, allowLate: t.account_source === 'manual' || rebaseline });
      const { competition, scoring } = sc;
      const pick = (row) => ({ category: row.category, return_pct: row.return_pct, pnl: row.pnl, net_capital: row.net_capital, eligible: row.eligible, winner_eligible: row.winner_eligible, reasons: row.reasons, flags: row.flags });

      if (input.mode === 'full') return { ...pick(scoreManualFull({ trader: t, doc: { mode: 'full', fields, rebaseline: rebaseline && START_LINE.some((k) => k in fields) }, competition, scoring })), warnings: [] };

      const [entry, baseline] = [await repo.getEntry(c, t.email), await repo.getBaseline(c, t.email)];
      if (!baseline || baseline.status !== 'frozen' || !entry || !entry.trade_cache) throw conflict('no_score_yet', 'This trader has no scored baseline yet, so there is nothing to patch.');
      const acct = await elefin.getAccount(wallet);
      if (!acct.ok) throw new AdminError(502, 'elefin_unavailable', `Elefin account lookup failed: ${acct.error}`);
      const warnings = [];
      if (fields.captured_at && fields.captured_at !== baseline.captured_at) warnings.push('captured_at changed: trade and ledger totals are recomputed on the next scoring run, not in this preview.');
      const row = scoreTrader({
        trader: t, baseline: applyBaselineOverrides(baseline, fields, scoring), account: acct.account, summary: entry.trade_cache.summary,
        flows: { depW: entry.dep_w, wdrW: entry.wdr_w }, overrides: fields, manual: { mode: 'fields' }, competition, scoring,
      });
      return { ...pick(row), reconcile_diff: row.reconcile_diff, warnings };
    },

    // ---------- rounds: finalize + week 2 ("Beat YG Sir"), all entries done by an admin ----------

    async rounds() {
      const st = await rounds.status();
      const entrants = st.week2.status === 'locked' ? [] : (await repo.listTraders(cohort2, { status: 'active', q: '', page: 1, pageSize: 50 })).rows;
      return { ...st, week2_entrants: entrants.length, week2_has_host: entrants.some((t) => t.is_host) };
    },

    /** Finalizes one round: the winner(s) are marked and that round's traders stop being updated. */
    async finalizeRound(ctx, round, input) {
      rejectUnknown(input, ['confirm', 'reason']);
      const reason = requireReason(input);
      if (input.confirm !== true) throw bad('confirm_required', 'Confirm that you want to finalize this round. It cannot be undone from the panel.', 'confirm');
      try {
        const res = await rounds.start(round, ctx.admin);
        await audit(ctx, 'round.finalize', round, null, { started: true }, reason);
        return res;
      } catch (err) {
        if (err.code && err.status && !(err instanceof AdminError)) throw new AdminError(err.status, err.code, err.message);
        throw err;
      }
    },

    listWeek2(query) {
      return repo.listTraders(cohort2, { status: query.status || null, q: String(query.q || '').toLowerCase(), page: Math.max(1, Number(query.page) || 1), pageSize: 50 });
    },

    /** Adds a week-1 category winner to the challenge. */
    async addWeek2Entrant(ctx, input) {
      rejectUnknown(input, ['email', 'reason']);
      const reason = requireReason(input);
      await assertWritable('week2');
      const st = await rounds.status();
      const email = String(input.email || '').trim().toLowerCase();
      const wins = Object.entries(st.week1.winners || {}).filter(([, w]) => w && w.email === email).map(([cat]) => cat);
      if (!wins.length) throw conflict('not_a_winner', 'Only the week-1 category winners can enter the challenge. YG Sir is added separately.');
      const t = await repo.getTrader(cohort, email);
      if (!t || !t.wallet_id) throw new AdminError(404, 'not_found', 'This winner has no registered wallet id.');
      const row = {
        email, wallet_id: t.wallet_id, client_id: t.client_id ?? null, name: t.name || null, country: t.country || null,
        status: 'active', cohort: cohort2, version: 1, source: 'admin', is_host: false, account_source: 'elefin', week1_winner_of: wins[0],
        added_at: new Date(now()).toISOString(), added_by: ctx.admin, updated_at: null, updated_by: null,
      };
      const res = await repo.insertTrader(cohort2, row);
      if (res !== true) throw conflict('already_entered', 'This trader is already in week 2.');
      await audit(ctx, 'week2.add', email, null, row, reason, cohort2);
      return row;
    },

    /**
     * Sets YG Sir's entry (exactly one). Two ways:
     *   elefin  he has an Elefin account: give email + wallet id; it is verified and scored like anyone else
     *   manual  no Elefin data: he is scored from numbers an admin enters (PUT manual, scope week2)
     */
    async setWeek2Host(ctx, input) {
      rejectUnknown(input, ['mode', 'email', 'wallet_id', 'name', 'reason']);
      const reason = requireReason(input);
      await assertWritable('week2');
      if (!['elefin', 'manual'].includes(input.mode)) throw bad('invalid_field', 'mode must be "elefin" or "manual".', 'mode');
      const name = String(input.name || 'YG Sir').trim().slice(0, 100) || 'YG Sir';
      const row = {
        name, status: 'active', cohort: cohort2, version: 1, source: 'admin', is_host: true, account_source: input.mode,
        week1_winner_of: null, added_at: new Date(now()).toISOString(), added_by: ctx.admin, updated_at: null, updated_by: null,
      };
      if (input.mode === 'manual') {
        Object.assign(row, { email: 'yg-sir@host.internal', wallet_id: 'YGSIR', client_id: null, country: null });
      } else {
        const email = String(input.email || '').trim().toLowerCase();
        const wallet = String(input.wallet_id ?? '');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw bad('invalid_field', 'A valid email is required.', 'email');
        if (!WALLET_RE.test(wallet)) throw bad('invalid_field', 'wallet_id must be 6-15 digits.', 'wallet_id');
        const r = await elefin.lookupClient(email);
        if (!r.ok) throw new AdminError(502, 'elefin_unavailable', `Elefin lookup failed: ${r.error}`);
        const v = r.data ? verifyWallet(r.data, wallet) : null;
        if (!v || v.status !== 'active') throw conflict('wallet_not_on_client', 'That account ID does not belong to this email in Elefin.');
        Object.assign(row, { email, wallet_id: wallet, client_id: v.client_id, country: v.country });
      }
      // Exactly one host: reuse his row if it exists (same email), retire any other host.
      const all = (await repo.listTraders(cohort2, { status: null, q: '', page: 1, pageSize: 50 })).rows;
      const same = all.find((t) => t.email === row.email);
      if (same && !same.is_host) throw conflict('already_entered', 'That email is already a week-2 entrant, not YG Sir.');
      const others = all.filter((t) => t.is_host && t.status !== 'withdrawn' && t.email !== row.email);
      for (const old of others) await repo.updateTrader(cohort2, old.email, old.version || 1, { status: 'withdrawn', updated_at: new Date(now()).toISOString(), updated_by: ctx.admin, version: (old.version || 1) + 1 });
      if (same) {
        const { added_at: _a, added_by: _b, ...fields } = row;
        const set = { ...fields, updated_at: new Date(now()).toISOString(), updated_by: ctx.admin, version: (same.version || 1) + 1 };
        const res = await repo.updateTrader(cohort2, same.email, same.version || 1, set);
        if (res === 'wallet') throw conflict('duplicate_wallet', 'That account is already in week 2.');
        if (res !== true) throw conflict('stale', 'Someone else changed this entrant. Reload and try again.');
        Object.assign(row, { version: set.version });
      } else {
        const res = await repo.insertTrader(cohort2, row);
        if (res !== true) throw conflict(res === 'wallet' ? 'duplicate_wallet' : 'already_entered', 'That account is already in week 2.');
      }
      const existing = [same || others[0] || null];
      await audit(ctx, 'week2.host', row.email, existing[0] || null, row, reason, cohort2);
      return row;
    },

    async removeWeek2Entrant(ctx, email, input) {
      rejectUnknown(input, ['reason']);
      const reason = requireReason(input);
      await assertWritable('week2');
      const t = await repo.getTrader(cohort2, String(email).toLowerCase());
      if (!t) throw new AdminError(404, 'not_found', 'Not a week-2 entrant.');
      const set = { status: 'withdrawn', updated_at: new Date(now()).toISOString(), updated_by: ctx.admin, version: (t.version || 1) + 1 };
      if (!(await repo.updateTrader(cohort2, t.email, t.version || 1, set))) throw conflict('stale', 'Someone else changed this entrant. Reload and try again.');
      await audit(ctx, 'week2.remove', t.email, { status: t.status }, { status: 'withdrawn' }, reason, cohort2);
      return { ...t, ...set };
    },

    /** Trusts the ledger over the per-trade reconstruction for every currently-mismatched row (admin-plan: see rounds.fixPnlMismatch). */
    async fixPnlMismatch(ctx, input) {
      rejectUnknown(input, ['reason']);
      if (!rounds) throw new AdminError(500, 'rounds_unavailable', 'Rounds module not configured.');
      const reason = optionalReason(input);
      const res = await rounds.fixPnlMismatch();
      for (const c of res.changes) await audit(ctx, 'pnl_fix.apply', c.email, null, c, reason);
      // The patch above is overwritten by the next scoring run; switching these traders to balance
      // P/L makes the same figure come out of every later run, so the fix sticks.
      let persisted = 0;
      for (const c of res.changes) {
        const t = await repo.getTrader(cohort, c.email);
        if (!t || t.pnl_source === 'balance' || t.account_source === 'manual') continue;
        const ok = await repo.updateTrader(cohort, t.email, ver(t), { pnl_source: 'balance', updated_at: new Date(now()).toISOString(), updated_by: ctx.admin, version: ver(t) + 1 });
        if (ok === true) {
          persisted += 1;
          await audit(ctx, 'trader.pnl_source', t.email, { pnl_source: 'trades' }, { pnl_source: 'balance' }, reason);
        }
      }
      res.persisted = persisted;
      await audit(ctx, 'pnl_fix.run', null, null, { count: res.fixed, persisted, finalized: res.finalized, winners: res.winners }, reason);
      if (persisted) rescore(); // refresh the board from live balances straight away
      return res;
    },

    async rescore(ctx) {
      await audit(ctx, 'rescore', null, null, null, null);
      trigger('admin');
      return { started: true };
    },

    listAudit(query) {
      return repo.listAudit(cohort, { target: query.target || null, action: query.action || null, page: Math.max(1, Number(query.page) || 1) });
    },

    audit,
  };
}

module.exports = { createAdminService, AdminError, validateFields };
