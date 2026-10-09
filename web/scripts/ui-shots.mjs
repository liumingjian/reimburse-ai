// Screenshot every page and state of the mock build, for before/after visual comparison of layout changes.
// Operator tool, not a test: nothing asserts on the images.
//
// Usage (from the repo root, on the Mac):
//   pnpm --filter @baox/web build:mock
//   node web/scripts/ui-shots.mjs --out <dir> [--only <name-prefix>[,<prefix>...]] [--widths 1440,1920]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const { values: args } = parseArgs({
  options: {
    out: { type: 'string' },
    only: { type: 'string' },
    widths: { type: 'string', default: '1440,1920' },
  },
});
if (!args.out) throw new Error('--out <dir> is required');

const webDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(webDir, 'package.json'));
const { chromium } = require('@playwright/test');
const INDEX = 'file://' + path.join(webDir, 'dist-mock', 'index.html');
const url = (q, h) => `${INDEX}${q}${h}`;
const outDir = path.resolve(args.out);
fs.mkdirSync(outDir, { recursive: true });

// The mock samples all have short names. Two long-named copies stress file-name layout; the mock does not recognise
// them, so they become 不支持的材料类型 pending items, and the second is rejected as a content duplicate of the first.
const samples = path.join(webDir, 'dist-mock', 'sample-materials');
const upDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-shots-'));
for (const f of fs.readdirSync(samples)) fs.copyFileSync(path.join(samples, f), path.join(upDir, f));
const LONG = [
  '2026年8月上海出差_全季酒店上海虹桥国家会展中心店_住宿费增值税电子普通发票_含早餐及服务费明细.pdf',
  '上海市出租汽车统一发票_沪A·D12345_2026-08-10_浦东国际机场T2航站楼至静安寺商圈_夜间附加费.pdf',
];
for (const f of LONG) fs.copyFileSync(path.join(samples, '办公用品_发票.pdf'), path.join(upDir, f));
const allFiles = fs.readdirSync(upDir).map((f) => path.join(upDir, f));
const shortFiles = allFiles.filter((f) => !LONG.some((l) => f.endsWith(l)));

const HEIGHTS = { 1280: 800, 1440: 900, 1920: 1080 };
const settle = (page, ms = 900) => page.waitForTimeout(ms);
const click = async (page, loc) => {
  await loc.first().click({ timeout: 8000 });
  await settle(page);
};
const btn = (page, name) => page.getByRole('button', { name, exact: true });
const upload = async (page, files) => {
  await page.locator('input[type=file]').first().setInputFiles(files);
  await settle(page, 2000);
};

// [name, query, hash, action?]. An action may call shot(suffix) for extra shots and returns 'done' to skip the final one.
const STATES = [
  ['01-tasks-list', '?seed=review', '#/tasks'],
  ['01-tasks-list-actions', '?seed=actions', '#/tasks'],
  ['01-tasks-abandon-dialog', '?seed=review', '#/tasks', (p) => click(p, btn(p, '作废'))],
  ['01-tasks-service-disconnected', '?fault=service-disconnected', '#/tasks'],
  ['02-new-task-dialog', '', '#/tasks/new'],
  ['02-new-task-dialog-location-unavailable', '?location=unavailable', '#/tasks/new'],
  ['03-upload-empty', '?seed=upload', '#/task/T1/upload'],
  ['03-upload-long-names', '?seed=upload', '#/task/T1/upload', (p) => upload(p, allFiles)],
  ['03-upload-after-inventory', '?seed=inventory', '#/task/T1/upload'],
  ['04-inventory', '?seed=inventory', '#/task/T1/inventory'],
  ['04-inventory-unsupported', '?seed=inventory&fault=unsupported-material', '#/task/T1/inventory'],
  ['04-inventory-duplicate-blocker', '?duplicate=1', '#/task/T1/upload', async (p) => {
    await upload(p, shortFiles);
    await click(p, btn(p, '开始材料盘点'));
    await settle(p, 6000);
  }],
  ['04-inventory-long-names', '?seed=upload', '#/task/T1/upload', async (p, shot) => {
    await upload(p, allFiles);
    await click(p, btn(p, '开始材料盘点'));
    const toPending = p.getByRole('link', { name: /处理 \d+ 个待确认项/ });
    await toPending.waitFor({ timeout: 30000 });
    await settle(p);
    await shot('');
    await click(p, toPending);
    await pendingItems(p, shot, 'pending-long-');
    return 'done';
  }],
  ['05-pending', '?seed=pending', '#/task/T1/pending', async (p, shot) => {
    await pendingItems(p, shot, '');
    return 'done';
  }],
  ['05-pending-lodging-preview-retry', '?seed=pending', '#/task/T1/pending', async (p) => {
    await click(p, p.getByLabel('待确认项清单').getByRole('button', { name: /支付截图/ }));
    await settle(p, 3000);
    const retry = btn(p, '重试预览');
    if (await retry.count()) await click(p, retry);
  }],
  ['05-pending-allocation', '?seed=pending&allocation=1', '#/task/T1/pending'],
  ['05-pending-unsupported', '?seed=pending&fault=unsupported-material', '#/task/T1/pending'],
  ['05-pending-all-done', '?seed=project', '#/task/T1/pending'],
  ['06-project-assign', '?seed=project', '#/task/T1/project'],
  ['06-project-assign-deadline', '?seed=project&deadline=warning', '#/task/T1/project'],
  ['06-project-add-dialog', '?seed=project', '#/task/T1/project', (p) => click(p, btn(p, '新增项目'))],
  ['06-project-empty-book-gate', '?seed=project&book=empty', '#/task/T1/project'],
  ['06-project-after-actions', '?seed=actions', '#/task/T1/project'],
  ['06-dining', '?seed=upload', '#/task/T1/upload', async (p, shot) => {
    await upload(p, ['餐饮_发票.pdf', '餐饮_小票.pdf'].map((name) => path.join(samples, name)));
    await click(p, btn(p, '开始材料盘点'));
    await click(p, p.getByRole('link', { name: '进入项目归属', exact: true }));
    await click(p, btn(p, '查看餐饮材料 No.1'));
    await settle(p, 3000);
    await shot('-invoice');
    await click(p, p.getByRole('tab', { name: '餐饮小票：餐饮_小票.pdf' }));
    await settle(p, 3000);
    await shot('-receipt');
    await click(p, btn(p, '关闭预览'));
    await p.getByLabel('报销事由', { exact: true }).fill('客户招待');
    await p.locator('label[for^="pick-"]').first().click();
    await click(p, p.getByRole('complementary', { name: '归入项目' }).getByRole('button', { name: /P-2307/ }));
    await click(p, btn(p, '确认项目归属'));
    await click(p, btn(p, '确认整单明细'));
    await click(p, p.getByRole('link', { name: '去打印', exact: true }));
    await settle(p, 3000);
    await shot('-print');
    await click(p, p.locator('img.app-page-image').first());
    await shot('-print-fullscreen');
    return 'done';
  }],
  ['07-review', '?seed=review', '#/task/T1/review'],
  ['07-review-actions', '?seed=actions', '#/task/T1/review'],
  ['07-review-not-ready', '?seed=project', '#/task/T1/review'],
  ['08-print', '?seed=print', '#/task/T1/print'],
  ['09-erp-waiting-login', '?seed=erp', '#/task/T1/erp'],
  ['09-erp-login-missing', '?seed=erp&fault=erp-login-missing', '#/task/T1/erp', (p) => click(p, btn(p, '我已登录，继续'))],
  ['09-erp-readback-mismatch', '?seed=erp&fault=readback-mismatch', '#/task/T1/erp', async (p, shot) => {
    await click(p, btn(p, '我已登录，继续'));
    await btn(p, '开始对账').waitFor({ timeout: 30000 }).catch(() => {});
    await settle(p, 1500);
    await shot('-before');
    const start = btn(p, '开始对账');
    if (await start.count()) await click(p, start);
    await settle(p, 3000);
  }],
  ['10-done', '?seed=done', '#/task/T1/done'],
  ['10-done-T3', '', '#/task/T3/done'],
  ['11-reconcile-T2', '', '#/task/T2/reconcile'],
  ['11-reconcile-T2-expanded', '', '#/task/T2/reconcile', (p) => click(p, p.getByRole('button', { name: /展开/ }))],
  ['11-reconcile-undetermined', '?seed=reconcile', '#/task/T1/reconcile'],
  ['12-projects-book', '?seed=review', '#/projects'],
  ['12-projects-book-empty', '?book=empty', '#/projects'],
  ['13-settings', '', '#/settings'],
  ['13-settings-legacy-failed', '?legacy=failed', '#/settings'],
  ['13-settings-extension-paired', '?extension=paired', '#/settings'],
  ['13-settings-extension-disconnected', '?extension=disconnected', '#/settings'],
  ['13-settings-reset-dialog', '', '#/settings', async (p, shot) => {
    await click(p, p.getByText('高级设置', { exact: true }));
    await shot('-advanced-open');
    await click(p, btn(p, '完全重置'));
  }],
  ['13-settings-password', '', '#/settings/password'],
  ['14-extension-tutorial', '', '#/settings/tutorial'],
  ['15-admin', '', '#/admin'],
  ['16-auth-signed-out', '?auth=signed-out', '#/tasks'],
  ['16-auth-setup', '?auth=setup', '#/tasks'],
];

async function pendingItems(p, shot, prefix) {
  const list = p.getByLabel('待确认项清单');
  await list.waitFor({ timeout: 10000 });
  const n = await list.getByRole('button').count();
  for (let i = 0; i < n; i++) {
    const item = list.getByRole('button').nth(i);
    await item.click();
    await settle(p, 1200);
    const tag = /支付截图/.test(await item.innerText()) ? 'lodging-missing-payment' : `item${i + 1}`;
    await shot(`-${prefix}${tag}`);
  }
}

const only = args.only?.split(',');
const states = only ? STATES.filter(([name]) => only.some((o) => name.startsWith(o))) : STATES;
const log = [];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
for (const w of args.widths.split(',').map(Number)) {
  for (const [name, q, hash, act] of states) {
    const ctx = await browser.newContext({ viewport: { width: w, height: HEIGHTS[w] ?? 900 }, locale: 'zh-CN' });
    const page = await ctx.newPage();
    const shot = (suffix) => page.screenshot({ path: path.join(outDir, `${name}${suffix}-${w}.png`), fullPage: true });
    try {
      await page.goto(url(q, hash));
      await page.locator('h1').first().waitFor({ timeout: 10000 }).catch(() => {});
      await settle(page, 1200);
      const r = act ? await act(page, shot) : undefined;
      if (r !== 'done') await shot('');
      log.push(`ok   ${name}-${w}`);
    } catch (e) {
      await shot('-ERROR').catch(() => {});
      log.push(`FAIL ${name}-${w}: ${String(e.message).split('\n')[0]}`);
    }
    await ctx.close();
  }
}
await browser.close();
console.log(log.join('\n'));
