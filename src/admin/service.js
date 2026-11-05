'use strict';

const { validateRegistration, resolveAccount, verifyWallet } = require('../domain/registration');
const { scoreTrader, scoreManualFull, applyBaselineOverrides, OVERRIDABLE } = require('../domain/entry');

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

function rejectUnknown(input, allowed) {
  for (const k of Object.keys(input || {})) if (!allowed.includes(k)) throw bad('unknown_field', `Unknown field: ${k}`, k);
}

/** Validates the manual input fields. `cfg` supplies the entry window for captured_at. */
function validateFields(fields, { requireAll, cfg }) {
  const f = fields && typeof fields === 'object' ? fields : {};
  rejectUnknown(f, OVERRIDABLE);
  const out = {};
  for (const k of OVERRIDABLE) {
    const v = f[k];
    if (v === undefined || v === null || v === '') {
      if (requireAll) throw bad('field_required', `${k} is required in full mode.`, k);
      continue;
    }
    if (k === 'captured_at') {
      const t = Date.parse(v);
      if (!Number.isFinite(t)) throw bad('invalid_field', 'captured_at must be a valid date.', k);
      if (t < cfg.competition.startMs || t > cfg.competition.cutoffMs) throw bad('invalid_field', 'captured_at must fall inside the entry window.', k);
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

  const ver = (t) => t.version || 1;
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
      rejectUnknown(input, ['email', 'wallet_id', 'name', 'notes', 'client_id', 'reason']);
      await assertNotFinalized();
      if (now() > cfg.competition.cutoffMs) throw conflict('entry_closed', 'Entry is closed; no new traders can be added.');
      const reason = requireReason(input);
      const { errors, value } = validateRegistration({ name: input.name || 'x', email: input.email, phone: '00000000', agree: true });
      if (errors.email) throw bad('invalid_field', errors.email, 'email');
      const wallet = String(input.wallet_id ?? '');
      if (!WALLET_RE.test(wallet)) throw bad('invalid_field', 'wallet_id must be 6-15 digits.', 'wallet_id');
      const row = {
        email: value.email, wallet_id: wallet, client_id: input.client_id != null ? Number(input.client_id) : null,
        name: input.name ? value.name : null, notes: input.notes ? String(input.notes).slice(0, 500) : null,
        status: 'pending', cohort, version: 1, added_at: new Date(now()).toISOString(), added_by: ctx.admin,
        updated_at: null, updated_by: null, elefin_check: null,
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
        const ok = t.elefin_check && t.elefin_check.ok && t.elefin_check.owner_match;
        if (!ok && !input.override_check) throw conflict('check_required', 'Run "Check in Elefin" first (or override with a reason).');
      }
      const set = { status: input.to, updated_at: new Date(now()).toISOString(), updated_by: ctx.admin, version: ver(t) + 1 };
      if (!(await repo.updateTrader(cohort, t.email, ver(t), set))) throw conflict('stale', 'Someone else changed this trader. Reload and try again.');
      await audit(ctx, 'trader.status', t.email, { status: t.status }, { status: input.to, override_check: !!input.override_check }, reason);
      return { ...t, ...set };
    },

    /** One Elefin lookup: does this wallet id belong to this email's client? */
    async checkTrader(ctx, email) {
      const t = await mustTrader(email);
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
      const reason = requireReason(input);
      if (!['fields', 'full'].includes(input.mode)) throw bad('invalid_field', 'mode must be "fields" or "full".', 'mode');
      if (!SOURCES.includes(input.source)) throw bad('invalid_field', `source must be one of ${SOURCES.join(', ')}.`, 'source');
      const fields = validateFields(input.fields, { requireAll: input.mode === 'full', cfg: sc });
      if (START_LINE.some((k) => k in fields) && now() > sc.competition.cutoffMs && !input.rebaseline) {
        throw conflict('rebaseline_required', 'Start-line fields can only change after the entry cutoff with an explicit re-baseline.');
      }
      const before = await repo.getManual(c, String(wallet));
      if ((before ? before.version : null) !== (input.version ?? null)) throw conflict('stale', 'Someone else changed this manual entry. Reload and try again.');
      const doc = {
        _id: `${c}:${wallet}`, cohort: c, email: t.email, wallet_id: String(wallet), mode: input.mode, enabled: true, fields,
        source: input.source, source_ref: input.source_ref ? String(input.source_ref).slice(0, 200) : null,
        reason, entered_by: ctx.admin, entered_at: new Date(now()).toISOString(), version: (before ? before.version : 0) + 1,
      };
      if (!(await repo.putManual(c, doc, before ? before.version : null))) throw conflict('stale', 'Someone else changed this manual entry. Reload and try again.');
      await audit(ctx, 'manual.set', String(wallet), before, doc, reason, c);
      return doc;
    },

    async disableManual(ctx, wallet, input, scope = 'week1') {
      rejectUnknown(input, ['reason']);
      const { c } = await scopeOf(scope);
      await assertWritable(scope);
      await mustTraderByWallet(wallet, c);
      const reason = requireReason(input);
      const before = await repo.getManual(c, String(wallet));
      if (!before || !before.enabled) throw conflict('not_enabled', 'No active manual entry for this wallet.');
      const after = { ...before, enabled: false, version: before.version + 1, disabled_by: ctx.admin, disabled_at: new Date(now()).toISOString() };
      if (!(await repo.putManual(c, after, before.version))) throw conflict('stale', 'Someone else changed this manual entry. Reload and try again.');
      await audit(ctx, 'manual.disable', String(wallet), before, after, reason, c);
      return after;
    },

    /** Dry run: what this trader would score with the given manual input. Writes nothing. */
    async preview(wallet, input, scope = 'week1') {
      rejectUnknown(input, ['mode', 'fields']);
      const { c, sc } = await scopeOf(scope);
      const t = await mustTraderByWallet(wallet, c);
      if (!['fields', 'full'].includes(input.mode)) throw bad('invalid_field', 'mode must be "fields" or "full".', 'mode');
      const fields = validateFields(input.fields, { requireAll: input.mode === 'full', cfg: sc });
      const { competition, scoring } = sc;
      const pick = (row) => ({ category: row.category, return_pct: row.return_pct, pnl: row.pnl, net_capital: row.net_capital, eligible: row.eligible, winner_eligible: row.winner_eligible, reasons: row.reasons, flags: row.flags });

      if (input.mode === 'full') return { ...pick(scoreManualFull({ trader: t, doc: { mode: 'full', fields }, competition, scoring })), warnings: [] };

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

    async rescore(ctx) {
      await audit(ctx, 'rescore', null, null, null, null);
      trigger('admin');
      return { started: true };
    },

    listAudit(query) {
      return repo.listAudit(cohort, { target: query.target || null, page: Math.max(1, Number(query.page) || 1) });
    },

    audit,
  };
}

module.exports = { createAdminService, AdminError, validateFields };
