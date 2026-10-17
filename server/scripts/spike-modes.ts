// S8 of docs/design/erp-headless-v1.md §验证计划: which way should the executor drive ERP on the employee's PC? The same
// 去报销 runs in the 浏览器扩展, in a dedicated headed Chromium and in a headless one, round after round, and the modes
// are compared by success rate and time (spike/modes.ts has the how).
//
// It runs on the test environment, the Mac mini, with the test ERP account and one test invoice. It is READ-ONLY: each
// run stops before 发票导入单据, imports nothing, saves nothing, and closes its unsaved 费用报销单-新增 with 否. Each mode
// keeps its own persistent profile under --profiles, as the executor will on a PC; round 0 warms those caches and is
// reported but left out of the comparison. Every login may knock the test account's other ERP sessions off.
//
//   set -a; . ~/.baox-erp-live.env; set +a
//   pnpm --filter @baox/server exec tsx scripts/spike-modes.ts [--invoice <pdf>] [--rounds 3] [--modes extension,headed,headless]
//     [--chromium <path>] [--profiles <dir>] [--out <dir>] [--prefetch] [--port 47391]
//
// --chromium should be Playwright's Chromium for every mode: branded Chrome no longer loads an unpacked extension, and one
// binary keeps the comparison about the mode alone.
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { erpEntryOf } from '@baox/erp-executor/probe';
import { sleep } from '@baox/erp-executor/pace';
import { erpConfigFromEnv } from '../src/erp/config';
import { MODES, readInvoice, runMode, stampedExtension, standInApp, type Mode, type ModeCtx } from './spike/modes';
import { Report, type CheckRecord } from './spike/report';

const USAGE = `用法：pnpm --filter @baox/server exec tsx scripts/spike-modes.ts [--invoice <文件>] [选项]
  --invoice <文件>     测试发票（pdf/png/jpg，一张）；每次运行都上传、识别、勾选它，但不导入。不给就是冒烟运行
  --rounds <n>        计入比较的轮数（默认 3）；另有第 0 轮预热，不计入
  --modes <a,b,…>     extension,headed,headless 中的若干个（默认全部）
  --chromium <路径>    所有模式共用的 Chromium（应为 Playwright 的 Chromium：品牌 Chrome 不再加载未打包扩展）
  --profiles <目录>    每种模式的持久配置目录的上级目录（默认 ~/.baox-spike/s8-profiles）
  --out <目录>         报告目录（默认 ./spike-modes-<时间>）
  --prefetch          登录前先把主控台脚本取进浏览器缓存
  --port <n>          替身应用的端口（默认 47391；扩展按这个地址盖章，换端口要重新配对）`;

const { values: args } = parseArgs({
  options: {
    invoice: { type: 'string' }, rounds: { type: 'string', default: '3' }, modes: { type: 'string' }, chromium: { type: 'string' },
    profiles: { type: 'string' }, out: { type: 'string' }, prefetch: { type: 'boolean', default: false }, port: { type: 'string', default: '47391' },
    help: { type: 'boolean', default: false },
  },
  strict: true,
});
if (args.help) { console.log(USAGE); process.exit(0); }
const refuse = (message: string): never => { console.error(`spike-modes refused: ${message}\n\n${USAGE}`); process.exit(2); };

const here = process.env['INIT_CWD'] || process.cwd();
const invoicePath = args.invoice ?? null;
const rounds = Number(args.rounds);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20) refuse('--rounds 只能是 1–20');
const port = Number(args.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) refuse('--port 不是可用端口');
const modes = (args.modes ?? MODES.join(',')).split(',').map((m) => m.trim()).filter(Boolean) as Mode[];
for (const mode of modes) if (!MODES.includes(mode)) refuse(`未知的模式 ${mode}`);
const account = process.env['BAOX_ERP_TEST_ACCOUNT']?.trim() ?? '';
const password = process.env['BAOX_ERP_TEST_PASSWORD']?.trim() ?? '';
if (!account || !password) refuse('需要 BAOX_ERP_TEST_ACCOUNT 与 BAOX_ERP_TEST_PASSWORD（例如 set -a; . ~/.baox-erp-live.env; set +a）');

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const report = new Report(args.out ? resolve(here, args.out) : resolve(here, `spike-modes-${stamp}`));
report.secret(account);
report.secret(password);
const profileRoot = args.profiles ? resolve(here, args.profiles) : join(homedir(), '.baox-spike', 's8-profiles');
mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
const erp = erpConfigFromEnv(process.env);
const invoice = invoicePath ? readInvoice(resolve(here, invoicePath)) : null;
const app = await standInApp({ port, invoice });
const extensionDir = modes.includes('extension') ? stampedExtension(join(profileRoot, 'extension'), app.origin) : '';

const ctx: ModeCtx = {
  report, origin: erp.origin, entry: erpEntryOf(erp.origin), compatibility: erp.compatibility, account, password,
  prefetch: args.prefetch, chromium: args.chromium ? resolve(here, args.chromium) : null, profileRoot, extensionDir,
  invoice, app, catalogItem: null,
};

report.say(`ERP ${ctx.origin}；模式 ${modes.join(' ')}；预热 1 轮 + 比较 ${rounds} 轮；报告目录 ${report.dir}`);
report.say(invoice ? '只读：每次运行停在「发票导入单据」之前，不导入、不保存，新增单以「否」关闭。' : '冒烟（没有 --invoice）：每次运行在取发票原件处停下，不打开新增单、不上传。');
report.say('每次登录都可能挤掉同一账号在别处的 ERP 会话；每次运行结束时脚本会登出它自己的会话。');

const runs: Array<{ mode: Mode; round: number; record: CheckRecord }> = [];
let stopping = false;
process.once('SIGINT', () => { stopping = true; report.note('收到 Ctrl-C：当前这次运行收尾后停止'); });

for (let round = 0; round <= rounds && !stopping; round += 1) {
  // Rotated each round, so no mode always goes first after a pause, or always last.
  const order = modes.map((_, i) => modes[(i + round) % modes.length]!);
  for (const mode of order) {
    if (stopping) break;
    const label = `${mode}-r${round}`;
    const record = await report.check(label, `${mode} 第 ${round} 轮${round === 0 ? '（预热，不计入）' : ''}`, (obs) => runMode(ctx, mode, label, obs));
    runs.push({ mode, round, record });
    await sleep(5000);
  }
}
await app.close();

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};
const num = (v: unknown) => (typeof v === 'number' ? v : null);
const summary = modes.map((mode) => {
  const counted = runs.filter((r) => r.mode === mode && r.round > 0);
  const passed = counted.filter((r) => r.record.status === 'PASS');
  const field = (pick: (o: Record<string, any>) => unknown, from = passed) => from.map((r) => num(pick(r.record.observations))).filter((v): v is number => v !== null);
  return {
    mode, runs: counted.length, passed: passed.length,
    toBoundaryMedianMs: median(field((o) => o['job']?.toBoundaryMs)),
    toBoundaryMaxMs: Math.max(0, ...field((o) => o['job']?.toBoundaryMs)) || null,
    loginMedianMs: median(field((o) => o['login']?.ms, counted)),
    launchMedianMs: median(field((o) => o['launchMs'], counted)),
    totalMedianMs: median(field((o) => o['totalMs'], counted)),
    peakRssMb: Math.max(0, ...field((o) => o['memory']?.peakRssMb, counted)) || null,
    failures: counted.filter((r) => r.record.status !== 'PASS').map((r) => `${r.record.id}: ${r.record.reason}`),
    warmup: runs.filter((r) => r.mode === mode && r.round === 0).map((r) => `${r.record.status} ${r.record.reason}`),
  };
});
report.write({ selected: modes, rounds, summary });

const s = (ms: number | null) => (ms === null ? '-' : `${(ms / 1000).toFixed(1)}s`);
console.log('\n==== S8 汇总（不含预热轮） ====');
console.log('模式        成功    到导入前(中位/最长)  登录(中位)  启动(中位)  整次(中位)  峰值 RSS');
for (const row of summary) {
  console.log(`${row.mode.padEnd(10)}  ${`${row.passed}/${row.runs}`.padEnd(6)}  ${`${s(row.toBoundaryMedianMs)} / ${s(row.toBoundaryMaxMs)}`.padEnd(19)}  ${s(row.loginMedianMs).padEnd(10)}  ${s(row.launchMedianMs).padEnd(10)}  ${s(row.totalMedianMs).padEnd(10)}  ${row.peakRssMb ?? '-'} MB`);
  for (const failure of row.failures) console.log(`    失败 ${report.redact(failure)}`);
}
console.log(`\n报告：${report.dir}/report.json`);
process.exit(0);
