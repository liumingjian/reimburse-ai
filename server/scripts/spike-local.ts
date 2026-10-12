// The local executor (@baox/local-executor) on the real ERP, end to end through its own command line: it pairs with
// S8's stand-in app (spike/modes.ts) by 配对码, dials its channel, and each `erp.fill` the stand-in sends — with the ERP
// 凭据, as the app does for a 本地执行器 — runs in a headless Chromium the executor launched itself, signed in, signed
// out and closed at the end.
//
// READ-ONLY, like S8: the stand-in answers `attempt_started` with `{ persisted: false }`, so each run stops before
// 发票导入单据, imports nothing and saves nothing; its unsaved 新增单 goes with the browser. Every login may knock the
// test account's other ERP sessions off.
//
//   set -a; . ~/.baox-erp-live.env; set +a
//   pnpm --filter @baox/server exec tsx scripts/spike-local.ts --invoice <pdf> [--rounds 3] [--chromium <path>] [--home <dir>] [--port 47392]
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { sleep, waitFor } from '@baox/erp-executor/pace';
import { PROTOCOL_VERSION, type FillPlan } from '@baox/erp-executor/protocol';
import { erpConfigFromEnv } from '../src/erp/config';
import { readInvoice, standInApp } from './spike/modes';

const { values: args } = parseArgs({
  options: {
    invoice: { type: 'string' }, rounds: { type: 'string', default: '3' }, chromium: { type: 'string' },
    home: { type: 'string' }, port: { type: 'string', default: '47392' },
  },
  strict: true,
});
const refuse = (message: string): never => { console.error(`spike-local refused: ${message}`); process.exit(2); };
const here = process.env['INIT_CWD'] || process.cwd();
if (!args.invoice) refuse('需要 --invoice <测试发票>');
const rounds = Number(args.rounds);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20) refuse('--rounds 只能是 1–20');
const account = process.env['BAOX_ERP_TEST_ACCOUNT']?.trim() ?? '';
const password = process.env['BAOX_ERP_TEST_PASSWORD']?.trim() ?? '';
if (!account || !password) refuse('需要 BAOX_ERP_TEST_ACCOUNT 与 BAOX_ERP_TEST_PASSWORD');

const home = args.home ? resolve(here, args.home) : join(homedir(), '.baox-spike', 'local-executor');
mkdirSync(home, { recursive: true, mode: 0o700 });
const erp = erpConfigFromEnv(process.env);
const invoice = readInvoice(resolve(here, args.invoice!));
const app = await standInApp({ port: Number(args.port), invoice });
const say = (line: string) => console.log(line.split(account).join('<account>').split(password).join('<secret>'));

// The executor's own environment: its home and the Chromium. The ERP 凭据 go down with each job, not through here.
const { BAOX_ERP_TEST_ACCOUNT: _account, BAOX_ERP_TEST_PASSWORD: _password, ...inherited } = process.env;
const env = { ...inherited, BAOX_LOCAL_EXECUTOR_HOME: home, ...(args.chromium ? { BAOX_CHROME: resolve(here, args.chromium) } : {}) };
const executor = (command: string[]) => ['--silent', '--filter', '@baox/local-executor', 'start', ...command];

// Not spawnSync: the stand-in answers the 配对码 from this very process, so its event loop must keep running.
const paired = await new Promise<{ status: number | null; output: string }>((done) => {
  const child = spawn('pnpm', executor(['pair', '--origin', app.origin, 'S8PAIR01']), { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout!.on('data', (chunk: Buffer) => { output += String(chunk); });
  child.stderr!.on('data', (chunk: Buffer) => { output += String(chunk); });
  child.on('close', (status) => done({ status, output }));
});
say(`pair: exit ${paired.status} ${paired.output.trim()}`);
if (paired.status !== 0) { await app.close(); process.exit(1); }

const run: ChildProcess = spawn('pnpm', executor(['run']), { env, stdio: ['ignore', 'pipe', 'pipe'] });
const lines: string[] = [];
const take = (chunk: Buffer) => { for (const line of String(chunk).split('\n').filter(Boolean)) { lines.push(line); say(`  executor: ${line}`); } };
run.stdout!.on('data', take);
run.stderr!.on('data', take);
if (!(await waitFor(async () => app.connected(), Boolean, 60_000, 500))) { say('本地执行器 60 秒内没有连上替身应用'); run.kill(); await app.close(); process.exit(1); }

const profileDir = join(home, 'profile');
const browsersOpen = () => spawnSync('pgrep', ['-f', `--user-data-dir=${profileDir}`], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean).length;

// The 试登录 first, as the app runs it after a save: signed in, signed out, browser closed.
{
  const started = Date.now();
  const trial = await app.trySignIn(erp.origin, { account, password }).catch((error: Error) => ({ ok: false, code: 'request_failed', message: error.message }));
  await sleep(3000);
  say(`试登录: ${JSON.stringify(trial)} in ${Math.round((Date.now() - started) / 1000)}s, browsers-left ${browsersOpen()}`);
}

let passed = 0;
for (let round = 1; round <= rounds; round += 1) {
  app.fresh();
  const started = Date.now();
  const plan: FillPlan = {
    protocolVersion: PROTOCOL_VERSION, kind: 'fill', jobId: `local-r${round}-${started}`, taskId: `local-r${round}`, erpOrigin: erp.origin,
    compatibility: erp.compatibility, catalog: { projects: [], expenseItems: [] },
    invoices: [{ sha256: invoice.sha256, fileName: 'local-test-invoice.pdf', mime: invoice.mime }],
    purpose: '本地执行器实测',
  };
  const result = await app.fill(plan, 'start', { account, password }).catch((error: Error) => ({ status: 'error', code: 'request_failed', message: error.message }));
  const events = app.events();
  const brake = events.find((e) => e.event.type === 'attempt_started');
  const failedStep = events.find((e) => e.event.type === 'step' && e.event.status === 'failed')?.event;
  await sleep(3000);
  const open = browsersOpen();
  const ok = !!brake && brake.event.type === 'attempt_started' && brake.event.action === 'import' && open === 0;
  if (ok) passed += 1;
  say(`round ${round}: ${ok ? 'PASS' : 'FAIL'} to-boundary ${brake ? `${Math.round((brake.at - started) / 1000)}s` : '-'} total ${Math.round((Date.now() - started) / 1000)}s`
    + ` result ${result.status}/${result.code ?? '-'} ${failedStep && failedStep.type === 'step' ? `failed-step ${failedStep.step} ` : ''}browsers-left ${open}`
    + (ok ? '' : ` message ${String(result.message ?? '').slice(0, 300)}`));
  await sleep(5000);
}
say(`==== ${passed}/${rounds} passed; signed out ${lines.filter((l) => l.includes('signed out')).length}×`);
run.kill('SIGTERM');
await app.close();
process.exit(passed === rounds ? 0 : 1);
