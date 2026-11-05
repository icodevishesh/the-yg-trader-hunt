'use strict';

/*
 * Admin CLI. Uses the same service as the web panel, so validation, locks,
 * versioning and the audit log are identical. Entries are logged as "cli:<os user>".
 *
 *   node scripts/admin.js hash-password
 *   node scripts/admin.js trader add    --email a@b.com --wallet 12345992151 [--name "..."] --reason "..."
 *   node scripts/admin.js trader status --email a@b.com --to disqualified --reason "..." [--override-check]
 *   node scripts/admin.js trader check  --email a@b.com
 *   node scripts/admin.js manual set    --wallet 12345992151 --mode fields closed_pnl=-1090.77 \
 *                                       --source mt5_statement --source-ref file.xlsx --reason "..."
 *   node scripts/admin.js manual off    --wallet 12345992151 --reason "..."
 *   node scripts/admin.js preview       --wallet 12345992151 --mode fields closed_pnl=25
 *   node scripts/admin.js audit         [--wallet 12345992151 | --email a@b.com]
 */

const os = require('os');
const readline = require('readline');

const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (n) => argv.includes(`--${n}`);
/** key=value arguments become manual field values. */
const kv = () =>
  Object.fromEntries(
    argv.filter((a) => /^[a-z_]+=/.test(a)).map((a) => {
      const [k, ...rest] = a.split('=');
      const v = rest.join('=');
      return [k, k === 'captured_at' ? v : Number(v)];
    }),
  );

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, (a) => { rl.output.write('\n'); rl.close(); resolve(a); });
  });
}

async function main() {
  const [group, action] = argv;

  if (group === 'hash-password') {
    const pw = await askHidden('New password: ');
    if (pw.length < 12) throw new Error('Use at least 12 characters.');
    if (pw !== (await askHidden('Repeat: '))) throw new Error('Passwords differ.');
    console.log('\nPut this after the username in ADMIN_USERS (user:hash):\n' + require('../src/admin/auth').hashPassword(pw));
    return;
  }

  const { config } = require('../src/config');
  const { mongoRepo } = require('../src/admin/repo');
  const { createAdminService } = require('../src/admin/service');
  const { connect, ensureIndexes, close } = require('../src/db');
  const elefin = require('../src/elefin');

  if (config.errors.length) throw new Error('Config invalid:\n  - ' + config.errors.join('\n  - '));
  await connect();
  await ensureIndexes();
  const service = createAdminService({ repo: mongoRepo, elefin, cfg: config, trigger: () => console.log('(re-score runs on the next scheduler tick)') });
  const ctx = { admin: `cli:${os.userInfo().username}`, ip: null };
  const reason = flag('reason');
  const print = (x) => console.log(JSON.stringify(x, null, 2));

  try {
    if (group === 'trader' && action === 'add') {
      print(await service.addTrader(ctx, { email: flag('email'), wallet_id: flag('wallet'), name: flag('name'), notes: flag('notes'), reason }));
    } else if (group === 'trader' && action === 'status') {
      const t = await mongoRepo.getTrader(config.competition.cohort, String(flag('email')).toLowerCase());
      if (!t) throw new Error('Trader not found.');
      print(await service.setStatus(ctx, t.email, { to: flag('to'), version: t.version || 1, reason, ...(has('override-check') ? { override_check: true } : {}) }));
    } else if (group === 'trader' && action === 'check') {
      print(await service.checkTrader(ctx, flag('email')));
    } else if (group === 'manual' && action === 'set') {
      const cur = await mongoRepo.getManual(config.competition.cohort, flag('wallet'));
      print(await service.setManual(ctx, flag('wallet'), {
        mode: flag('mode'), fields: kv(), source: flag('source'), source_ref: flag('source-ref'), reason,
        version: cur ? cur.version : null, ...(has('rebaseline') ? { rebaseline: true } : {}),
      }));
    } else if (group === 'manual' && action === 'off') {
      print(await service.disableManual(ctx, flag('wallet'), { reason }));
    } else if (group === 'preview') {
      print(await service.preview(flag('wallet'), { mode: flag('mode') || 'fields', fields: kv() }));
    } else if (group === 'audit') {
      print(await service.listAudit({ target: flag('wallet') || flag('email') }));
    } else {
      throw new Error('Unknown command. See the header of scripts/admin.js.');
    }
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err.code ? `[${err.code}] ${err.message}` : err.message);
  process.exit(1);
});
