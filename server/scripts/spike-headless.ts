// The ADR-0033 / ADR-0034 spike: can 去报销 run in a headless Chromium, signed in with hosted ERP credentials? The
// browser runs on the employee's PC (ADR-0033, amended 2026-10-12), not on the intranet host. It runs S1–S7 of
// docs/design/erp-headless-v1.md §验证计划 and prints one PASS / FAIL / SKIP line each.
//
// It runs on the test environment, the Mac mini, with the test ERP account (10.250.0.222 only hosts the server and
// never drives ERP); S3 needs the account's owner at their own browser. It is READ-ONLY by default:
//   - S1, S2, S6, S7 (login only) read; S3 logs in and out and asks the owner what they saw;
//   - S4 (needs --invoice) imports one invoice into an UNSAVED 新增 form and closes it with 否. The bill is never saved,
//     but 发票导入单据 mints or overwrites that invoice's 收票单 in ERP (ADR-0025, ADR-0026);
//   - S5 (needs --save) is the only step that leaves a bill in ERP: it presses 暂存 on S4's form, prints the 单据编号,
//     and the owner deletes that draft by hand. Nothing here ever presses 保存/提交/审核/删除, and no WebAPI write stub
//     is ever sent (spike/erp.ts allows three stubs by name, plus the executor's own ExecuteBillQuery).
// It prints shapes, counts and timings, never amounts, names or invoice numbers — the S5 draft's 单据编号 excepted.
//
//   set -a; . ~/.baox-erp-live.env; set +a
//   pnpm --filter @baox/server exec tsx scripts/spike-headless.ts [--only S1,S2,...] [--invoice <pdf>] [--invoice-no <号码,…>]
//     [--save] [--bill <单据编号>] [--concurrency 2] [--chromium <path>] [--out <dir>] [--non-interactive] [--prefetch]
//
// Env: BAOX_ERP_TEST_ACCOUNT, BAOX_ERP_TEST_PASSWORD (never printed, never on a command line); optional
// BAOX_ERP_TEST_TENANT (S2 compares the 账套 it lands in), BAOX_ERP_ORIGIN / BAOX_ERP_BUILD (erp/config.ts), BAOX_CHROME.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { erpEntryOf } from '@baox/erp-executor/probe';
import { erpConfigFromEnv } from '../src/erp/config';
import { discardForms, endSession, s1, s2, s3, s4, s5, s6, s7, s9, s10, s11, s12, type Ctx } from './spike/checks';
import { memAvailableMb } from './spike/browser';
import { Report } from './spike/report';

const USAGE = `用法：pnpm --filter @baox/server exec tsx scripts/spike-headless.ts [选项]
  --only S1,S2,…        只跑这些检查（默认全部）
  --invoice <文件>       S4 用的测试发票（pdf/png/jpg，一个文件一张发票）；没有就跳过 S4
  --invoice-no <号码,…>  S6 额外查询的发票号码
  --save                S5 点「暂存」，在 ERP 留下一张测试草稿（需要手工删除）；或 S11 用执行器的暂存入口暂存、核对后自动删除
  --bill <单据编号>       S6 的对照：一张已保存、带发票的单据；没有 --save 时 S5 只读 View 它
  --concurrency <n>     S7 并行的无头会话数（默认 1）
  --chromium <路径>      Chromium 可执行文件（默认按 BAOX_CHROME 和常见路径找）
  --out <目录>           报告目录（默认 ./spike-report-<时间>）
  --non-interactive     不提问；S3 跳过
  --drafts-since <时间>   S9（只读）列出这之后创建的暂存单，「YYYY-MM-DD[ HH:mm]」（默认今天 00:00）
  --delete-draft <内码>   S10 删除这一张测试暂存单：只删暂存、无单据编号、创建于 --drafts-since 之后的（需要所有者同意）
  --prefetch            登录前先把主控台脚本取进浏览器缓存（链路慢时 RequireJS 30 秒超时的对照）`;

const { values: args } = parseArgs({
  options: {
    only: { type: 'string' }, invoice: { type: 'string' }, 'invoice-no': { type: 'string' }, save: { type: 'boolean', default: false },
    bill: { type: 'string' }, concurrency: { type: 'string', default: '1' }, chromium: { type: 'string' }, out: { type: 'string' },
    'non-interactive': { type: 'boolean', default: false }, prefetch: { type: 'boolean', default: false }, 'drafts-since': { type: 'string' }, 'delete-draft': { type: 'string' }, help: { type: 'boolean', default: false },
  },
  strict: true,
});
if (args.help) { console.log(USAGE); process.exit(0); }
const refuse = (message: string): never => { console.error(`spike refused: ${message}\n\n${USAGE}`); process.exit(2); };

// pnpm runs this from server/, so relative paths are taken from where the owner typed the command.
const here = process.env['INIT_CWD'] || process.cwd();
const ALL = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S9', 'S10', 'S11', 'S12'];
// S10 deletes and S11 暂存s, so neither runs by default: S10 needs --only S10 and --delete-draft, S11 --only and --save.
const only = new Set((args.only ?? ALL.filter((id) => id !== 'S10' && id !== 'S11').join(',')).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
for (const id of only) if (!ALL.includes(id)) refuse(`未知的检查 ${id}`);
const invoice = args.invoice ? resolve(here, args.invoice) : null;
if (invoice && !existsSync(invoice)) refuse(`找不到测试发票 ${invoice}`);
if (invoice && !/\.(pdf|png|jpe?g)$/i.test(invoice)) refuse('测试发票只能是 pdf、png 或 jpg');
const chromium = args.chromium ? resolve(here, args.chromium) : null;
if (chromium && !existsSync(chromium)) refuse(`找不到 Chromium：${chromium}`);
const concurrency = Number(args.concurrency);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) refuse('--concurrency 只能是 1–4');
if (args.save && !only.has('S5') && !only.has('S11')) refuse('--save 只对 S5 或 S11 有意义，而这次都没有选');
if (only.has('S5') && only.has('S11')) refuse('S5 和 S11 都会在 S4 那张单上点暂存，一次只选一个');
if (only.has('S10') !== Boolean(args['delete-draft'])) refuse('S10 与 --delete-draft 要一起给');
if (only.has('S10') && !args['drafts-since']) refuse('S10 要 --drafts-since：只删这之后创建的暂存单');

const account = process.env['BAOX_ERP_TEST_ACCOUNT']?.trim() ?? '';
const password = process.env['BAOX_ERP_TEST_PASSWORD']?.trim() ?? '';
const needsLogin = [...only].some((id) => id !== 'S1');
if (needsLogin && (!account || !password)) refuse('需要 BAOX_ERP_TEST_ACCOUNT 与 BAOX_ERP_TEST_PASSWORD（例如 set -a; . ~/.baox-erp-live.env; set +a）');

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const report = new Report(args.out ? resolve(here, args.out) : resolve(here, `spike-report-${stamp}`));
report.secret(account);
report.secret(password);
const erp = erpConfigFromEnv(process.env);
const interactive = !args['non-interactive'] && process.stdin.isTTY === true;

const ctx: Ctx = {
  report, origin: erp.origin, entry: erpEntryOf(erp.origin), erpBuild: erp.compatibility.erpBuild,
  account, password, tenant: process.env['BAOX_ERP_TEST_TENANT']?.trim() || null,
  chromium, invoice, invoiceNos: (args['invoice-no'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  save: args.save, bill: args.bill?.trim() || null, concurrency, interactive, prefetch: args.prefetch,
  main: null, mainLogin: null, formOpen: false, s4Passed: false, s4InvoiceNos: [], draftBillNo: null,
  draftsSince: args['drafts-since']?.trim() || new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10),
  deleteDraft: args['delete-draft']?.trim() || null,
  mainMemory: null, mainCrashes: [], sessions: new Set(), signedIn: new Set(),
};

let ask: Interface | null = null;
let tornDown = false;
/** Every browser this run started is signed out, closed and its profile deleted — also on Ctrl-C. */
async function teardown() {
  if (tornDown) return;
  tornDown = true;
  ask?.close();
  for (const h of [...ctx.sessions]) {
    if (h === ctx.main && ctx.formOpen) for (const line of await discardForms(ctx, h).catch((e: Error) => [`main: 关闭表单失败：${e.message}`])) report.note(line);
    for (const line of await endSession(ctx, h).catch((e: Error) => [`${h.label}: 收尾出错：${e.message}`])) report.note(line);
  }
}
process.once('SIGINT', () => { report.note('收到 Ctrl-C，正在登出并关闭浏览器'); void teardown().finally(() => { report.write(); process.exit(130); }); });

report.say(`ERP ${ctx.origin}；报告目录 ${report.dir}`);
report.say(`检查：${[...only].join(' ')}；${args.save ? '带 --save：S5 会暂存一张测试草稿' : '只读（不带 --save，S5 不暂存）'}${ctx.deleteDraft ? `；S10 会删除内码 ${ctx.deleteDraft} 这一张测试暂存单` : ''}`);
report.say('截图是真实页面画面，可能含姓名和金额；把报告目录交给别人之前请先看一眼。');
if (needsLogin) report.say('每次登录都可能挤掉同一账号在别处的 ERP 会话（ADR-0033 已接受）；脚本结束时会登出它自己的会话。');
const run = (id: string, title: string, body: Parameters<Report['check']>[2]) => (only.has(id) ? report.check(id, title, body) : null);

try {
  await run('S1', '主机能访问 ERP 与发票助手，无头浏览器能加载', (obs) => s1(ctx, obs));
  await run('S2', '无头浏览器账号密码登录', (obs) => s2(ctx, obs));
  if (only.has('S4')) {
    if (invoice) await report.check('S4', '无头环境下发票助手上传、识别、导入', (obs) => s4(ctx, obs));
    else await report.skip('S4', '无头环境下发票助手上传、识别、导入', '没有 --invoice <测试发票>，跳过');
  }
  await run('S5', '暂存与 View 模型回读', (obs) => s5(ctx, obs));
  await run('S11', '执行器暂存入口：归属标记、暂存、按标记找回、View 核对（之后删除）', (obs) => s11(ctx, obs));
  await run('S6', '用 ExecuteBillQuery 查发票占用', (obs) => s6(ctx, obs));
  await run('S9', '找回暂存草稿（只读：查询与按内码 View）', (obs) => s9(ctx, obs));
  await run('S12', '执行器的发票占用检查（只读，用账号里已有的单据对照）', (obs) => s12(ctx, obs));
  await run('S10', '删除一张测试暂存单（按内码）', (obs) => s10(ctx, obs));

  // S4's form is discarded, and the main session's memory read, before anything else starts a browser.
  if (ctx.main) {
    if (ctx.formOpen) for (const line of await discardForms(ctx, ctx.main)) report.note(line);
    ctx.mainMemory = ctx.main.memory();
    ctx.mainCrashes = [...ctx.main.crashes];
    for (const line of await endSession(ctx, ctx.main)) report.note(line);
  }

  if (only.has('S3')) {
    if (!interactive) await report.skip('S3', '挤号行为', args['non-interactive'] ? '--non-interactive，跳过' : '标准输入不是终端，没法提问，跳过');
    else {
      ask = createInterface({ input: process.stdin, output: process.stdout });
      const prompts = ask;
      await report.check('S3', '挤号行为', async (obs) => {
        try { return await s3(ctx, obs, prompts); } finally {
          for (const h of [...ctx.sessions]) if (h.label === 's3') for (const line of await endSession(ctx, h)) report.note(line);
        }
      });
      ask.close();
      ask = null;
    }
  }
  await run('S7', '资源占用', (obs) => s7(ctx, obs));
} catch (error) {
  report.note(`运行中断：${error instanceof Error ? error.message : String(error)}`);
} finally {
  await teardown();
  report.write({ draftBillNo: ctx.draftBillNo, memAvailableEndMb: memAvailableMb(), selected: [...only], save: ctx.save });
}

console.log('\n==== 汇总 ====');
for (const c of report.checks) console.log(`${c.id} ${c.status.padEnd(4)} ${c.reason}`);
if (ctx.draftBillNo) console.log(`\n测试草稿 ${ctx.draftBillNo} 留在 ERP 里：请手工删除。`);
console.log(`\n报告：${report.dir}/report.json`);
process.exit(report.checks.some((c) => c.status === 'FAIL') ? 1 : 0);
