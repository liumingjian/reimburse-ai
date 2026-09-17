// Manual-style QA driver. Runs on the mac against the live app in real Chrome.
//   pnpm exec node qa/run.mjs
// An operator tool, never a CI job: it drives a live local app with real materials. See qa/README.md.
// Artifacts (screenshots, defect log) land in QA_OUT (default /tmp/baox-qa-artifacts), outside the
// rsync'd workspace so they survive the next sync.
import { chromium, expect } from '@playwright/test';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { qaSelfCheck, qaValue } from './values.mjs';

const BASE = process.env['QA_BASE'] ?? 'http://127.0.0.1:4319';
const MATERIALS = process.env['QA_MATERIALS'] ?? '/Users/lmj/Documents/temp/baox-resources';
const OUT = process.env['QA_OUT'] ?? '/tmp/baox-qa-artifacts';
const ACCOUNT = { name: process.env['QA_USER'] ?? 'admin', password: process.env['QA_PASSWORD'] ?? 'admin123' };
const HOME_CITY = process.env['QA_HOME_CITY'] ?? '广州';
const SKIP = new Set(
  (process.env['QA_SKIP'] ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean),
);
const PURPOSE = '广州本地用车费用报销（QA）';

// The app's own wording for "no verified 报销系统 identity" (contract/src/project-book.ts).
const NO_ERP_IDENTITY = /没有已核对的报销系统身份/;

// A 1x1 PNG, enough to stand in for a payment screenshot.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const findings = [];
let step = 0;

function note(level, area, text) {
  findings.push({ level, area, text });
  console.log(`[${level}] ${area}: ${text}`);
}
const defect = (area, text) => note('DEFECT', area, text);
const warn = (area, text) => note('WARN', area, text);
const ok = (area, text) => note('ok', area, text);

async function shot(page, label) {
  step += 1;
  const file = join(OUT, `${String(step).padStart(2, '0')}-${label}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  return file;
}

// Runs one QA area in isolation: a throw fails only that area, and always leaves
// a screenshot behind so a failure can be read after the fact. QA_SKIP names areas
// to leave out, so a pass can cover everything except, say, the ERP write.
async function area(page, name, body) {
  if (SKIP.has(name)) {
    console.log(`\n=== ${name} (skipped) ===`);
    return;
  }
  console.log(`\n=== ${name} ===`);
  try {
    await body();
  } catch (error) {
    defect(name, `area aborted: ${String(error?.message ?? error).split('\n')[0]}`);
    await shot(page, `${name.replace(/\W+/g, '-')}-abort`);
  }
}

async function materials() {
  const names = (await readdir(MATERIALS)).filter((n) => /\.(pdf|jpe?g|png)$/i.test(n));
  return names.sort().map((n) => join(MATERIALS, n));
}

const visible = async (locator, timeout = 5000) =>
  locator
    .first()
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);

async function main() {
  await mkdir(OUT, { recursive: true });
  const files = await materials();
  console.log(`${files.length} material files`);

  // Headful by default: QA is meant to be watched. QA_HEADLESS=1 is for an unattended smoke run.
  const headless = process.env['QA_HEADLESS'] === '1';
  const browser = await chromium.launch({ channel: 'chrome', headless, slowMo: headless ? 0 : 80 });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();

  // Console and network errors are defects in their own right; collect them throughout.
  page.on('pageerror', (e) => defect('console', `uncaught: ${String(e.message).slice(0, 200)}`));
  page.on('console', (m) => {
    // «Failed to load resource» is the browser echoing an HTTP status the response handler below already
    // reports with its reason — including the refusals this driver provokes on purpose. Everything else
    // logged as an error is the app's own.
    if (m.type() !== 'error' || /Failed to load resource/.test(m.text())) return;
    defect('console', `console.error: ${m.text().slice(0, 200)}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 500) {
      defect('network', `${r.status()} ${r.request().method()} ${r.url()}`);
      return;
    }
    // The console only says «Failed to load resource»; name the request, and for an API call its reason,
    // so a 4xx can still be read after the run.
    if (r.status() >= 400) {
      const where = `${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`;
      if (!r.url().includes('/api/')) {
        warn('network', where);
        return;
      }
      void r
        .text()
        .then((body) => warn('network', `${where}: ${body.replace(/\s+/g, ' ').slice(0, 200)}`))
        .catch(() => warn('network', where));
    }
  });

  await runAreas({ page, context, files });

  await writeFile(join(OUT, 'findings.json'), JSON.stringify(findings, null, 2));
  const defects = findings.filter((f) => f.level === 'DEFECT');
  const warns = findings.filter((f) => f.level === 'WARN');
  console.log(`\n=== summary: ${defects.length} defects, ${warns.length} warnings ===`);
  for (const f of [...defects, ...warns]) console.log(`${f.level} ${f.area}: ${f.text}`);

  await browser.close();
}

// --- areas ------------------------------------------------------------------

async function runAreas({ page, context, files }) {
  const state = { taskId: null };

  await area(page, 'auth', () => qaAuth(page));
  await area(page, 'task-list', () => qaTaskList(page, context, state));
  await area(page, 'upload', () => qaUpload(page, files, state));
  await area(page, 'inventory', () => qaInventory(page, context, state));
  await area(page, 'pending', () => qaPending(page, context, state));
  await area(page, 'project-book', () => qaProjectBook(page, state));
  await area(page, 'assignment', () => qaAssignment(page, state));
  await area(page, 'review', () => qaReview(page, context, state));
  await area(page, 'print', () => qaPrint(page, files, state));
  await area(page, 'settings', () => qaSettings(page));
  await area(page, 'admin', () => qaAdmin(page));
  await area(page, 'erp-off', () => qaErpOff(page, context, state));
}

async function qaAuth(page) {
  await page.goto(`${BASE}/#/tasks`);

  if (await visible(page.getByRole('heading', { name: '创建管理员', level: 1 }), 8000)) {
    defect('auth', 'the app asks to create an admin, but the account admin should already exist');
    return;
  }
  await expect(page.getByRole('heading', { name: '登录', level: 1 })).toBeVisible({ timeout: 10000 });

  // Wrong password must be refused with a readable message, not a stack or a hang.
  await page.getByLabel('用户名').fill(ACCOUNT.name);
  await page.getByLabel('密码').fill('definitely-wrong');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const err = page.locator('[role=alert]').filter({ hasText: /\S/ }).first();
  if (await visible(err, 8000)) {
    const text = (await err.innerText()).trim();
    if (text.includes('用户名或密码不对')) ok('auth', `wrong password refused: ${text}`);
    else warn('auth', `wrong password refused with an unexpected message: ${text}`);
  } else {
    defect('auth', 'wrong password produced no visible error');
  }
  await shot(page, 'auth-wrong-password');

  await page.getByLabel('密码').fill(ACCOUNT.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '报销任务', level: 1 })).toBeVisible({ timeout: 15000 });
  ok('auth', 'signed in as admin');

  const banner = page.getByRole('banner');
  if (!(await visible(banner.getByText('管理员'), 3000))) {
    defect('auth', 'the admin tag is missing from the header for an admin account');
  }
  if (!(await visible(page.getByRole('link', { name: '管理' }), 3000))) {
    defect('auth', 'the 管理 nav link is missing for an admin account');
  }

  // The session must survive a reload.
  await page.reload();
  if (await visible(page.getByRole('heading', { name: '登录', level: 1 }), 5000)) {
    defect('auth', 'reloading signs the user out');
  } else {
    await expect(page.getByRole('heading', { name: '报销任务', level: 1 })).toBeVisible({ timeout: 15000 });
    ok('auth', 'session survives a reload');
  }
  await shot(page, 'auth-signed-in');
}

async function qaTaskList(page, context, state) {
  await page.goto(`${BASE}/#/tasks`);
  await expect(page.getByRole('heading', { name: '报销任务', level: 1 })).toBeVisible({ timeout: 15000 });

  if (await visible(page.getByRole('alert').filter({ hasText: '本地服务未运行' }), 2000)) {
    defect('task-list', 'the offline banner 本地服务未运行 shows while the server is up');
  }

  // Only one unfinished task is allowed, so void whatever a previous run left behind.
  // Point QA at a data directory of its own (BAOX_DATA_DIR); this voids tasks it finds there.
  const existing = await (await context.request.get(`${BASE}/api/tasks`)).json();
  for (const t of existing?.tasks ?? []) {
    if (t.stage === 'done' || t.stage === 'voided') continue;
    if (!t.abandonable) {
      warn('task-list', `a leftover task (${t.name}, ${t.stage}) cannot be voided: ${t.abandonBlockedReason ?? '(no reason given)'}`);
      continue;
    }
    const res = await context.request.post(`${BASE}/api/tasks/${t.taskId}/abandon`, { data: {} });
    warn('task-list', `voided a leftover task ${t.taskId} (${t.name}) to get a clean run: ${res.status()}`);
  }

  await page.reload();
  await page.getByRole('button', { name: '新建报销任务' }).click();
  const dialog = page.getByRole('dialog', { name: '新建报销任务' });
  await expect(dialog).toBeVisible({ timeout: 10000 });

  // Empty home city must be refused in place.
  await dialog.getByLabel('常驻城市').fill('');
  await dialog.getByRole('button', { name: '创建并上传材料' }).click();
  if (await visible(dialog.getByText('请填写常驻城市。'), 4000)) ok('task-list', 'empty home city is refused');
  else defect('task-list', 'an empty 常驻城市 was accepted or gave no message');

  await dialog.getByLabel('常驻城市').fill(HOME_CITY);
  await shot(page, 'new-task-dialog');
  await dialog.getByRole('button', { name: '创建并上传材料' }).click();

  await expect(page.getByRole('heading', { name: '上传材料', level: 1 })).toBeVisible({ timeout: 15000 });
  const id = /#\/task\/([^/]+)\//.exec(page.url())?.[1];
  if (!id) throw new Error(`could not read the task id from ${page.url()}`);
  state.taskId = id;
  ok('task-list', `created a task with home city ${HOME_CITY}: ${id}`);
}

async function qaUpload(page, files, state) {
  if (!state.taskId) throw new Error('no task to upload into');
  await expect(page.getByRole('heading', { name: '上传材料', level: 1 })).toBeVisible({ timeout: 10000 });

  await page.locator('input[type=file]').first().setInputFiles(files);

  const batch = page.locator('section', { has: page.getByRole('heading', { name: /^上传批次 #1$/ }) });
  await expect(batch).toBeVisible({ timeout: 60000 });
  await expect(batch.locator('ul.app-file-list > li')).toHaveCount(files.length, { timeout: 60000 });

  const rejected = batch.getByText('拒绝', { exact: true });
  const rejectedCount = await rejected.count();
  if (rejectedCount > 0) {
    const rows = await batch.locator('ul.app-file-list > li').allInnerTexts();
    warn('upload', `${rejectedCount} of ${files.length} files rejected: ${rows.filter((r) => r.includes('拒绝')).join(' | ').slice(0, 600)}`);
  } else {
    ok('upload', `all ${files.length} files accepted`);
  }
  await shot(page, 'upload-batch');

  // Re-uploading the same file must be refused as duplicate content.
  await page.getByRole('button', { name: '追加下一批' }).click();
  const append = page.locator('section[aria-label="追加下一批"]');
  if (await visible(append, 8000)) {
    await append.locator('input[type=file]').first().setInputFiles([files[0]]);
    const dupe = page.getByText('内容重复', { exact: false });
    if (await visible(dupe, 30000)) ok('upload', 'a repeat of the same file is refused as duplicate content');
    else defect('upload', 'uploading the same file twice was not refused as duplicate content');
    await shot(page, 'upload-duplicate');
    const cancel = append.getByRole('button', { name: '取消' });
    if (await visible(cancel, 3000)) await cancel.click();
  } else {
    defect('upload', '追加下一批 did not open the append area');
  }

  const start = page.getByRole('button', { name: '开始材料盘点' });
  await expect(start).toBeEnabled({ timeout: 15000 });
  await start.click();
  await expect(page.getByRole('heading', { name: '材料盘点', level: 1 })).toBeVisible({ timeout: 20000 });
  ok('upload', 'inventory started');
}

async function qaInventory(page, context, state) {
  const id = state.taskId;
  // Real PDF parsing on 18 files can take a while; poll the API rather than the DOM.
  const deadline = Date.now() + 300000;
  let status = null;
  while (Date.now() < deadline) {
    const snap = await (await context.request.get(`${BASE}/api/tasks/${id}`)).json().catch(() => null);
    status = snap?.inventory?.status ?? null;
    if (status === 'done') break;
    await page.waitForTimeout(3000);
  }
  if (status !== 'done') {
    defect('inventory', `inventory did not finish within 5 minutes (status ${status})`);
    await shot(page, 'inventory-stuck');
    return;
  }
  ok('inventory', 'inventory finished');

  await expect(page.getByRole('group', { name: '盘点摘要' })).toBeVisible({ timeout: 30000 });
  const summary = (await page.getByRole('group', { name: '盘点摘要' }).innerText()).replace(/\s+/g, ' ');
  ok('inventory', `summary: ${summary}`);
  await shot(page, 'inventory-summary');

  if (await visible(page.locator('section[aria-label="跨任务重复发票"]'), 2000)) {
    warn('inventory', 'the cross-task duplicate blocker is showing on a first run');
  }

  const expandAll = page.getByRole('button', { name: '全部展开', exact: true });
  if (await visible(expandAll, 3000)) {
    await expandAll.click();
    await shot(page, 'inventory-expanded');
    ok('inventory', 'expand-all works');
  } else {
    warn('inventory', 'no 全部展开 control found');
  }

  const unfiled = page.locator('section[aria-label="未归入费用事件"]');
  if (await visible(unfiled, 2000)) {
    const text = (await unfiled.innerText()).replace(/\s+/g, ' ').slice(0, 400);
    warn('inventory', `some materials were not grouped into an expense event: ${text}`);
  }

  const table = page.getByRole('table', { name: '费用事件', exact: true });
  if (await visible(table, 5000)) {
    const rows = await table.locator('tbody tr').count();
    ok('inventory', `${rows} rows in the expense-event table`);
  } else {
    defect('inventory', 'the 费用事件 table is missing after inventory finished');
  }
}

// A 待确认项 the driver fails to answer is tried this many times and then left for the operator,
// so one unanswerable item can never spin the sweep.
const MAX_ATTEMPTS_PER_ITEM = 3;
// A choice item may open another item in its place (手工补填 → the fill form); bound that chain.
const MAX_CHOICE_DEPTH = 3;
// Upper bound on sweep rounds, in case the queue keeps growing as items are answered.
const MAX_PENDING_ROUNDS = 200;

// What the driver knows about each 待确认项 before it answers it, read from the snapshot: the page renders
// only the label, while `PendingField.format` (contract/src/snapshot.ts) is what the app validates against,
// and the material's already-read fields carry the facts a new value has to stay consistent with (above all
// the 价税合计, tax-inclusive total, 原文 价税合计).
// Returns itemId → { formats: key → format, known: key → value, kind }; empty when the snapshot cannot be
// read, and then the value generator falls back to the label.
async function pendingContext(context, taskId) {
  const byItem = new Map();
  const snap = await (await context.request.get(`${BASE}/api/tasks/${taskId}`)).json().catch(() => null);
  const materials = new Map((snap?.materials ?? []).map((m) => [m.materialId, m]));
  for (const item of snap?.pendingItems ?? []) {
    const material = materials.get(item.materialId);
    const known = new Map();
    for (const candidate of material?.fields ?? []) {
      // Two sources can read the same field (text layer and QR code). They agree, or the app raises its own
      // conflict item; either way the driver treats a disagreement as "not known".
      if (known.has(candidate.key) && known.get(candidate.key) !== candidate.value) known.set(candidate.key, undefined);
      else if (!known.has(candidate.key)) known.set(candidate.key, candidate.value);
    }
    byItem.set(item.itemId, {
      formats: new Map((item.fields ?? []).map((f) => [f.key, f.format])),
      known,
      kind: material?.kind ?? undefined,
      materialId: item.materialId,
      title: item.title ?? '',
      status: item.status,
    });
  }
  return byItem;
}

async function qaPending(page, context, state) {
  const id = state.taskId;
  await page.goto(`${BASE}/#/task/${id}/pending`);
  await page.waitForTimeout(2000);

  if (await visible(page.getByRole('heading', { name: '没有待确认项了' }), 4000)) {
    ok('pending', 'no pending items — everything parsed cleanly');
    await shot(page, 'pending-empty');
    return;
  }
  if (!(await visible(page.getByRole('heading', { name: '待确认项', level: 1 }), 8000))) {
    warn('pending', 'the pending page did not open; the task may not be in that stage');
    return;
  }

  const lead = await page.locator('h1').first().locator('..').innerText().catch(() => '');
  ok('pending', `opened with: ${lead.replace(/\s+/g, ' ').slice(0, 120)}`);
  await shot(page, 'pending-start');

  const list = page.getByLabel('待确认项清单');
  const attempts = new Map();
  const stuck = new Set();

  for (let round = 0; round < MAX_PENDING_ROUNDS; round += 1) {
    const buttons = list.getByRole('button');
    const total = await buttons.count();
    if (total === 0) break;

    let target = null;
    let key = null;
    for (let i = 0; i < total; i += 1) {
      const name = (await buttons.nth(i).innerText()).replace(/\s+/g, ' ').trim();
      if (name.includes('已处理')) continue;
      if ((attempts.get(name) ?? 0) >= MAX_ATTEMPTS_PER_ITEM) {
        stuck.add(name);
        continue;
      }
      target = buttons.nth(i);
      key = name;
      break;
    }
    if (!target) break;

    attempts.set(key, (attempts.get(key) ?? 0) + 1);
    const title = key.slice(0, 80);
    await target.click();
    await page.waitForTimeout(800);

    const items = await pendingContext(context, id);
    const detail = page.getByLabel('待确认项详情');
    const handled = await handlePendingItem(page, detail, title, items, 0);
    if (!handled) {
      attempts.set(key, MAX_ATTEMPTS_PER_ITEM);
      // An item can vanish while it is being answered: excluding a material takes its own items with it, and
      // the list can still be showing the stale row. Ask the snapshot before blaming the driver's reach.
      const after = await pendingContext(context, id);
      const stillOpen = [...after.values()].some((entry) => entry.status === 'open' && entry.title && key.includes(entry.title.slice(0, 30)));
      if (!stillOpen) {
        ok('pending', `«${title}» was already resolved by the previous action`);
      } else {
        // Nothing on this item's detail pane the driver knows how to answer: give up on it now rather
        // than spending its remaining attempts, and carry on with the rest of the queue.
        stuck.add(key);
        warn('pending', `could not answer «${title}» automatically; leaving it for the operator`);
        await shot(page, 'pending-unanswerable');
      }
    }
    await page.waitForTimeout(1200);
  }

  const unresolved = [...stuck];
  if (unresolved.length > 0) {
    warn('pending', `${unresolved.length} item(s) still open after ${MAX_ATTEMPTS_PER_ITEM} attempts each: ${unresolved.map((t) => t.slice(0, 60)).join(' | ').slice(0, 400)}`);
    await shot(page, 'pending-stuck');
  }

  await shot(page, 'pending-end');
  if (await visible(page.getByRole('heading', { name: '没有待确认项了' }), 4000)) {
    ok('pending', 'the queue reached the empty state');
  }
}

// Answers one 待确认项. `items` is what `pendingContext` read for each item; `depth` bounds the chain of
// choices that replace one form with another.
async function handlePendingItem(page, detail, title, items, depth) {
  // 1. per-segment allocation: the helper text carries the number to enter.
  const allocInputs = detail.locator('input[id^="pa-"]');
  if ((await allocInputs.count()) > 0) {
    const n = await allocInputs.count();
    for (let i = 0; i < n; i += 1) {
      const input = allocInputs.nth(i);
      const helper = await input.locator('xpath=ancestor::div[contains(@class,"cds--form-item")][1]').innerText().catch(() => '');
      const amount = /([0-9]+\.[0-9]{2})/.exec(helper)?.[1];
      await input.fill(amount ?? qaValue({ format: 'money' }));
      if (!amount) warn('pending', `no suggested amount for segment ${i + 1} of «${title}»`);
    }
    const submit = detail.getByRole('button', { name: '提交逐段金额' });
    await submit.click();
    ok('pending', `answered the per-segment split for «${title}»`);
    return true;
  }

  // 2. manual fill form.
  const form = detail.getByRole('form').first();
  if (await visible(form, 1500)) {
    const inputs = form.locator('input[id^="pf-"]');
    const n = await inputs.count();
    const fields = [];
    for (let i = 0; i < n; i += 1) {
      const input = inputs.nth(i);
      const id = (await input.getAttribute('id')) ?? '';
      // `pf-<itemId>-<field key>`; the field key is also the input's name.
      const key = (await input.getAttribute('name')) ?? '';
      const itemId = id.slice('pf-'.length, Math.max('pf-'.length, id.length - key.length - 1));
      const label = await page.locator(`label[for="${id}"]`).innerText().catch(() => '');
      fields.push({ input, key, label, itemId });
    }

    const item = items.get(fields[0]?.itemId ?? '');
    const known = Object.fromEntries([...(item?.known ?? new Map())].filter(([, value]) => value !== undefined));
    // 发票代码 belongs to 出租车车费发票 alone, so it names the kind when the material itself has none yet
    // (a 手工补填 of an unrecognised file picks its kind only as the form is submitted).
    const kind = item?.kind ?? (fields.some((f) => f.key === 'invoiceCode') ? 'taxi_receipt' : undefined);
    const filled = {};
    for (const { input, key, label, itemId } of fields) {
      const format = items.get(itemId)?.formats?.get(key);
      // The 价税合计 is the anchor the other two amounts have to add up to; when the form asks for it too,
      // `qaValue` derives all three from one stand-in total.
      const value = qaValue({ key, label, format, city: HOME_CITY, kind, total: known['totalAmount'], seed: item?.materialId });
      filled[key] = value;
      await input.fill(value);
    }

    await form.getByRole('button', { name: '保存并标记已处理' }).click();
    await page.waitForTimeout(1200);
    const errors = await detail.locator('[role=alert]').filter({ hasText: /\S/ }).allInnerTexts().catch(() => []);
    if (errors.length > 0) {
      const message = errors.join(' | ').replace(/\s+/g, ' ').slice(0, 200);
      // A refusal the app is right to make is not an application defect. The driver re-runs the app's own
      // checks over what it typed, merged with what was already read: if its submission satisfies them, the
      // refusal is the app's problem; if it does not, the app is holding the line and the driver's stand-in
      // values are simply not good enough to answer this item.
      const reason = qaSelfCheck({ ...known, ...filled }, kind);
      if (reason === null) defect('pending', `manual fill of «${title}» was refused although the driver's values are self-consistent: ${message}`);
      else warn('pending', `«${title}» was refused by a check the driver cannot satisfy with stand-in values (${reason}): ${message}`);
      return false;
    }
    ok('pending', `manually filled «${title}» (${n} fields)`);
    return true;
  }

  // 3. give-up blocker.
  const giveUp = detail.getByRole('button', { name: '排除这张发票及其行程单' });
  if (await visible(giveUp, 1000)) {
    await giveUp.click();
    warn('pending', `had to exclude the invoice for «${title}»`);
    return true;
  }

  // 4. plain choice: prefer manual fill, else the first offered option.
  const choices = detail.locator('button[aria-pressed]');
  if ((await choices.count()) > 0) {
    if (depth >= MAX_CHOICE_DEPTH) {
      warn('pending', `«${title}» kept offering choices after ${MAX_CHOICE_DEPTH} of them; giving up on this item`);
      return false;
    }
    const labels = await choices.allInnerTexts();
    const manual = detail.getByRole('button', { name: '手工补填' });
    if (await visible(manual, 800)) {
      await manual.click();
      ok('pending', `chose 手工补填 for «${title}» (offered: ${labels.join(' / ')})`);
    } else {
      await choices.first().click();
      ok('pending', `chose «${labels[0]}» for «${title}» (offered: ${labels.join(' / ')})`);
    }
    await page.waitForTimeout(1200);
    // A choice can be the whole answer (the item goes 已处理) or it can open a form in its place.
    if (await visible(detail.getByText('已处理', { exact: true }), 1500)) return true;
    return handlePendingItem(page, detail, title, items, depth + 1);
  }

  return false;
}

async function qaProjectBook(page, state) {
  await page.goto(`${BASE}/#/projects`);
  await expect(page.getByRole('heading', { name: '个人项目簿', level: 1 })).toBeVisible({ timeout: 15000 });

  const message = page.getByTestId('book-message');
  const intake = async (number) => {
    await page.getByLabel('项目号').fill(number);
    await page.getByRole('button', { name: '核验并加入' }).click();
    await page.waitForTimeout(2500);
    const text = (await message.innerText().catch(() => '(no message)')).replace(/\s+/g, ' ');
    ok('project-book', `«${number}» → ${text}`);
    return text;
  };

  const good = await intake('P-2307');
  // 个人项目簿 (personal project book, 原文 个人项目簿) only takes a number the 报销系统 catalog confirmed, and
  // the catalog is only reachable through a verified 报销系统 identity. A pass that skips ERP has none, so this
  // refusal is the app holding its own line, not a defect — and nothing further in this area can be judged.
  if (NO_ERP_IDENTITY.test(good)) {
    warn('project-book', 'the project book refuses entry without a verified 报销系统 identity, so this area could not be exercised (run with a project-catalog fixture or a signed-in ERP browser to reach it)');
    await shot(page, 'project-book-no-identity');
    return;
  }
  if (!good.includes('已加入')) defect('project-book', `P-2307 should be admitted but the app said: ${good}`);
  await intake('P-3312');

  const forbidden = await intake('P-9001');
  if (forbidden.includes('已加入') && !/停用|不可选|失效/.test(forbidden)) {
    defect('project-book', `P-9001 is forbidden in the catalog but was admitted as usable: ${forbidden}`);
  }

  const missing = await intake('P-0000');
  if (!/查不到|没有加入/.test(missing)) defect('project-book', `an unknown project number was not refused: ${missing}`);

  const unsafe = await intake('P-12;');
  if (!/不能安全查询|没有加入/.test(unsafe)) defect('project-book', `an unsafe project number was not refused: ${unsafe}`);

  await shot(page, 'project-book');

  const recheck = page.getByRole('button', { name: '复检全部' });
  if (await visible(recheck, 3000)) {
    await recheck.click();
    await page.waitForTimeout(3000);
    ok('project-book', `复检全部 → ${(await message.innerText().catch(() => '')).replace(/\s+/g, ' ')}`);
  } else {
    warn('project-book', 'no 复检全部 button');
  }
  void state;
}

async function qaAssignment(page, state) {
  const id = state.taskId;
  await page.goto(`${BASE}/#/task/${id}/project`);
  await page.waitForTimeout(2500);

  if (await visible(page.getByRole('heading', { name: '先维护个人项目簿', level: 1 }), 4000)) {
    const enter = page.getByRole('button', { name: '项目录完了，开始归属' });
    await expect(enter).toBeEnabled({ timeout: 10000 });
    await enter.click();
  }
  if (!(await visible(page.getByRole('heading', { name: '项目归属', level: 1 }), 10000))) {
    warn('assignment', `the assignment workbench did not open; page shows: ${(await page.locator('h1').first().innerText().catch(() => '?'))}`);
    await shot(page, 'assignment-blocked');
    return;
  }

  await page.getByLabel('报销事由').fill(PURPOSE);

  const summaryText = async () => (await page.getByTestId('assign-summary').innerText().catch(() => '')).replace(/\s+/g, ' ');
  const before = await summaryText();
  const submit = page.getByRole('button', { name: '确认项目归属' });
  if (await submit.isEnabled().catch(() => false)) {
    // The workbench is entered again after the 常驻城市 changes, and then the lines still carry the previous
    // assignment — an enabled button is right. Only an empty 归属 with an enabled button is worth a look.
    if (/已归属 0 \//.test(before)) warn('assignment', '确认项目归属 is enabled before any line has a project');
    else ok('assignment', `确认项目归属 is enabled on re-entry, with the previous assignment still in place: ${before}`);
  }

  await page
    .getByRole('checkbox', { name: '全选当前明细' })
    .locator('xpath=following-sibling::label[1]')
    .click();
  const batchBar = page.getByRole('region', { name: '批量操作' });
  await expect(batchBar).toBeVisible({ timeout: 10000 });
  await batchBar.getByRole('button', { name: '归入项目' }).click();

  const picker = page.getByRole('dialog', { name: '归入项目' });
  await expect(picker).toBeVisible({ timeout: 10000 });
  const project = picker.getByRole('radio', { name: /P-2307/ });
  if (!(await visible(project, 5000))) {
    // Nothing to assign to: the personal book stayed empty, which the project-book area already explained.
    warn('assignment', 'the project picker offers no P-2307, so the assignment could not be submitted');
    await shot(page, 'assignment-no-project');
    return;
  }
  await project.locator('xpath=following-sibling::label[1]').click();
  await picker.getByRole('button', { name: '确认归入' }).click();
  await page.waitForTimeout(2000);

  const overwrite = page.getByRole('dialog', { name: /条明细已有其他项目归属/ });
  if (await visible(overwrite, 2000)) await overwrite.getByRole('button', { name: '确认覆盖' }).click();

  const summary = await summaryText();
  ok('assignment', `after assigning everything to P-2307: ${summary}`);
  // 整单合计 now comes from the assignment view, which carries the whole-list total from the moment the workbench
  // opens. It used to be read off the confirmation, which does not exist yet at this step, and the workbench printed
  // the unit with nothing in front of it. An empty amount here is that defect back.
  if (/整单合计\s*元/.test(summary)) defect('assignment', 'the 整单合计 of the assignment summary shows the unit with no amount');
  await shot(page, 'assignment');

  await expect(submit).toBeEnabled({ timeout: 15000 });
  await submit.click();
  await page.waitForTimeout(3000);
  ok('assignment', 'submitted the project assignment');
}

async function qaReview(page, context, state) {
  const id = state.taskId;
  await page.goto(`${BASE}/#/task/${id}/review`);
  if (!(await visible(page.getByRole('heading', { name: '整单明细确认', level: 1 }), 20000))) {
    warn('review', `the review page did not open; page shows: ${(await page.locator('h1').first().innerText().catch(() => '?'))}`);
    await shot(page, 'review-blocked');
    return;
  }

  const mismatch = page.locator('section[aria-label="报销信息核对"]');
  if (await visible(mismatch, 3000)) {
    defect('review', `the catalog check reports a mismatch: ${(await mismatch.innerText()).replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  const gaps = page.locator('section[aria-label="材料包缺项"]');
  if (await visible(gaps, 3000)) {
    warn('review', `the material package reports gaps: ${(await gaps.innerText()).replace(/\s+/g, ' ').slice(0, 300)}`);
  }

  const summary = (await page.getByRole('group', { name: '确认摘要' }).innerText().catch(() => '')).replace(/\s+/g, ' ');
  ok('review', `summary: ${summary.slice(0, 300)}`);
  if (!summary.includes(HOME_CITY)) defect('review', `the home city ${HOME_CITY} is not shown in the confirmation summary`);
  if (!summary.includes(PURPOSE)) warn('review', 'the purpose is not shown in the confirmation summary');

  const table = page.getByRole('table', { name: '整单明细' });
  if (await visible(table, 8000)) {
    const headers = await table.locator('thead th').allInnerTexts();
    ok('review', `columns: ${headers.map((h) => h.trim()).join(' | ')}`);
    const rows = await table.locator('tbody tr').count();
    ok('review', `${rows} lines in the whole-list table`);
    // No file names or full invoice numbers belong in this table.
    const body = await table.locator('tbody').innerText();
    if (/\.pdf|\.jpg|\.png/i.test(body)) defect('review', 'file names leak into the whole-list table');
  } else {
    defect('review', 'the 整单明细 table is missing');
  }
  await shot(page, 'review');

  // Changing the 常驻城市 (home city, 原文 常驻城市) re-derives every line that depends on it — 市内交通 turns
  // into 外地市内交通 and back — so the app is entitled to send the task back to 项目归属 and ask for the
  // assignment again. Both the new city taking effect and the confirmation having to be re-earned are correct;
  // only a city that does not take effect, or a page that will not show it, is a defect.
  const cityBlock = page.getByTestId('review-home-city');
  if (await visible(page.getByRole('button', { name: '修改常驻城市' }), 3000)) {
    const setCity = async (city) => {
      const editCity = page.getByRole('button', { name: '修改常驻城市' });
      if (!(await visible(editCity, 10000))) {
        defect('review', `the 修改常驻城市 control is gone before setting ${city}`);
        return false;
      }
      await editCity.click();
      // The city editor is its own group; 常驻城市 also labels fields elsewhere on the page.
      const editor = page.getByRole('group', { name: '修改常驻城市' });
      await editor.getByLabel('常驻城市').fill(city);
      await editor.getByRole('button', { name: '保存', exact: true }).click();
      await page.waitForTimeout(3000);

      const snap = await (await context.request.get(`${BASE}/api/tasks/${id}`)).json().catch(() => null);
      if (snap?.task?.homeCity !== city) {
        defect('review', `changing the home city to ${city} did not take effect`);
        return false;
      }
      if (snap?.stage !== 'actions') {
        warn('review', `changing the home city sent the task back to the ${snap?.stage} stage; re-doing the assignment to reach 整单明细确认 again`);
        await qaAssignment(page, state);
        await page.goto(`${BASE}/#/task/${id}/review`);
        await page.waitForTimeout(3000);
      }
      const shown = (await cityBlock.innerText().catch(() => '')).replace(/\s+/g, ' ');
      if (!shown.includes(city)) defect('review', `the review page does not show the home city ${city}: ${shown}`);
      return true;
    };

    if (await setCity('深圳')) ok('review', 'home city can be changed from the review page');
    await setCity(HOME_CITY);
  } else {
    warn('review', 'no 修改常驻城市 control on the review page');
  }

  const confirm = page.getByRole('button', { name: '确认整单明细', exact: true });
  if (!(await visible(confirm, 30000))) {
    warn('review', 'the 确认整单明细 button never appeared (auto steps may still be running)');
    await shot(page, 'review-no-confirm');
    return;
  }
  await expect(confirm).toBeEnabled({ timeout: 60000 });
  await confirm.click();
  await page.waitForTimeout(3000);

  const confirmed = page.getByRole('region', { name: '整单确认' });
  if (await visible(confirmed.getByRole('link', { name: '去打印', exact: true }), 20000)) {
    ok('review', 'the whole list is confirmed; 去打印 and 去报销 are offered');
  } else {
    defect('review', 'after confirming, the 去打印 / 去报销 cards did not appear');
  }
  await shot(page, 'review-confirmed');

  const snap = await (await context.request.get(`${BASE}/api/tasks/${id}`)).json().catch(() => null);
  state.confirmationBefore = JSON.stringify(snap?.confirmation ?? null);
}

async function qaPrint(page, files, state) {
  const id = state.taskId;
  await page.goto(`${BASE}/#/task/${id}/print`);
  if (!(await visible(page.getByRole('heading', { name: '打印稿预览', level: 1 }), 20000))) {
    warn('print', `the print page did not open; page shows: ${(await page.locator('h1').first().innerText().catch(() => '?'))}`);
    await shot(page, 'print-blocked');
    return;
  }

  const pages = page.getByRole('list', { name: '打印稿页面' });
  if (!(await visible(pages, 120000))) {
    defect('print', 'the print sheet was not generated within 2 minutes');
    await shot(page, 'print-stuck');
    return;
  }
  const headers = await pages.locator('.page-hdr').allInnerTexts();
  ok('print', `${headers.length} print pages: ${headers.map((h) => h.replace(/\s+/g, ' ')).join(' ; ').slice(0, 400)}`);
  await shot(page, 'print-sheet');

  const reminder = page.getByRole('status', { name: '打印提醒' });
  if (await visible(reminder, 3000)) ok('print', `reminders: ${(await reminder.innerText()).replace(/\s+/g, ' ')}`);

  // Rotate: the server must re-render, so the image src has to change.
  const rotate = page.getByRole('button', { name: /^(旋转 90°|改为竖放)：/ }).first();
  if (await visible(rotate, 5000)) {
    const img = pages.locator('img.app-page-image').first();
    const before = await img.getAttribute('src');
    await rotate.click();
    await page.waitForTimeout(4000);
    const after = await img.getAttribute('src');
    if (before === after) defect('print', 'rotating a placement did not re-render the page image');
    else ok('print', 'rotate re-renders the page');
  } else {
    warn('print', 'no rotate control found');
  }

  // Crop.
  const crop = page.getByRole('button', { name: /^调整四角：/ }).first();
  if (await visible(crop, 5000)) {
    await crop.click();
    const editor = page.getByRole('region', { name: '四角裁剪' });
    if (await visible(editor, 8000)) {
      const handle = editor.getByRole('button', { name: '拖动左上角' });
      await handle.focus();
      for (let i = 0; i < 5; i += 1) await page.keyboard.press('ArrowRight');
      await shot(page, 'print-crop');
      await editor.getByRole('button', { name: '提交裁剪' }).click();
      await page.waitForTimeout(4000);
      const receipt = page.getByTestId('crop-receipt');
      if (await visible(receipt, 10000)) ok('print', `crop accepted: ${(await receipt.innerText()).replace(/\s+/g, ' ')}`);
      else defect('print', 'submitting a crop produced no receipt');
    } else {
      defect('print', '调整四角 did not open the crop editor');
    }
  } else {
    warn('print', 'no crop control found');
  }

  // Payment screenshot: a non-image must be refused, an image accepted.
  // The file input itself is hidden behind 补充支付截图, so look for its presence, not its visibility.
  const shotInput = page.getByLabel(/^选择支付截图：/).first();
  if ((await page.getByLabel(/^选择支付截图：/).count()) > 0) {
    await shotInput.setInputFiles(files.find((f) => f.endsWith('.pdf')) ?? files[0]);
    await page.waitForTimeout(2000);
    if (await visible(page.getByText('只接受图片', { exact: false }), 6000)) {
      ok('print', 'a PDF is refused as a payment screenshot');
    } else {
      defect('print', 'a PDF was accepted as a payment screenshot');
    }
    await shotInput.setInputFiles({ name: 'IMG_QA.png', mimeType: 'image/png', buffer: PNG_1X1 });
    await page.waitForTimeout(5000);
    if (await visible(page.getByRole('button', { name: /^移除支付截图：/ }), 15000)) {
      ok('print', 'a payment screenshot can be attached and removed');
    } else {
      defect('print', 'attaching a payment screenshot left no 移除 control');
    }
    await shot(page, 'print-payment-screenshot');
  } else {
    warn('print', 'no payment-screenshot upload on any page');
  }

  // Download.
  const download = page.getByRole('link', { name: '下载打印稿 PDF' });
  if (await visible(download, 15000)) {
    const [dl] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }).catch(() => null),
      download.click(),
    ]);
    if (dl) {
      const name = dl.suggestedFilename();
      if (/^打印稿_.+\.pdf$/.test(name)) ok('print', `downloaded ${name}`);
      else warn('print', `downloaded with an unexpected name: ${name}`);
      await dl.saveAs(join(OUT, 'print-sheet.pdf')).catch(() => {});
    } else {
      defect('print', 'clicking 下载打印稿 PDF produced no download');
    }
  } else {
    defect('print', 'the 下载打印稿 PDF link never became available');
  }
  void state;
}

async function qaSettings(page) {
  await page.goto(`${BASE}/#/settings`);
  await expect(page.getByRole('heading', { name: '设置', level: 1 })).toBeVisible({ timeout: 15000 });

  const region = page.getByRole('region', { name: '旧数据导入' });
  if (await visible(region, 8000)) {
    const text = (await region.innerText()).replace(/\s+/g, ' ');
    ok('settings', `legacy import: ${text.slice(0, 300)}`);
    if (!/没有找到旧数据|没有运行过|已跳过|已导入/.test(text)) {
      warn('settings', 'the legacy import section shows an unexpected state');
    }
  } else {
    defect('settings', 'the 旧数据导入 section is missing from the settings page');
  }

  if (await visible(page.getByRole('region', { name: '完全重置' }), 5000)) {
    ok('settings', 'the full reset section is present (not exercised, it would wipe the QA data)');
  } else {
    defect('settings', 'the 完全重置 section is missing');
  }
  await shot(page, 'settings');
}

async function qaAdmin(page) {
  await page.goto(`${BASE}/#/admin`);
  await expect(page.getByRole('heading', { name: '管理', level: 1 })).toBeVisible({ timeout: 15000 });

  const accounts = page.getByRole('table', { name: '应用账号' });
  if (await visible(accounts, 10000)) {
    const rows = await accounts.locator('tbody tr').count();
    ok('admin', `${rows} account rows`);
    const own = page.getByTestId(`account-row-${ACCOUNT.name}`);
    if (await visible(own, 3000)) {
      const text = (await own.innerText()).replace(/\s+/g, ' ');
      ok('admin', `own row: ${text}`);
      if (!text.includes('（你）')) warn('admin', 'the signed-in account is not marked as your own row');
      for (const label of ['停用', '取消管理员']) {
        if (await visible(own.getByRole('button', { name: label, exact: true }), 1500)) {
          defect('admin', `the admin can ${label} their own account from their own row`);
        }
      }
    } else {
      defect('admin', `no account row for ${ACCOUNT.name}`);
    }
  } else {
    defect('admin', 'the 应用账号 table is missing');
  }

  const publicBook = page.getByRole('region', { name: '公共项目簿' });
  if (await visible(publicBook, 8000)) {
    await publicBook.getByLabel('项目号').fill('P-3312');
    await publicBook.getByRole('button', { name: '核验并加入' }).click();
    await page.waitForTimeout(3000);
    const msg = (await publicBook.getByTestId('book-message').innerText().catch(() => '')).replace(/\s+/g, ' ');
    ok('admin', `public book intake: ${msg}`);
    if (!msg.includes('公共项目簿')) defect('admin', `adding to the public book did not confirm: ${msg}`);
    if (await visible(publicBook.getByRole('button', { name: '清理全部失效' }), 2000)) {
      defect('admin', 'the public book offers 清理全部失效, which belongs to the personal book only');
    }
  } else {
    defect('admin', 'the 公共项目簿 section is missing from the admin page');
  }
  await shot(page, 'admin');
}

async function qaErpOff(page, context, state) {
  const id = state.taskId;
  await page.goto(`${BASE}/#/task/${id}/review`);
  await page.waitForTimeout(2000);

  const go = page.getByRole('button', { name: '去报销', exact: true });
  if (!(await visible(go, 8000))) {
    warn('erp-off', 'no 去报销 button to exercise (the task may not be confirmed)');
    return;
  }
  await go.click();
  await page.waitForTimeout(5000);

  // With the dedicated chromium off the job must abort before touching anything.
  const deadline = Date.now() + 120000;
  let status = null;
  let reason = null;
  while (Date.now() < deadline) {
    const snap = await (await context.request.get(`${BASE}/api/tasks/${id}`)).json().catch(() => null);
    status = snap?.erp?.status ?? null;
    reason = snap?.erp?.abortReason ?? null;
    if (status === 'aborted' || status === 'done' || status === 'waiting_login') break;
    await page.waitForTimeout(3000);
  }
  await shot(page, 'erp-off');

  if (status === 'idle' || status === null) {
    // The write can also be refused before it starts (a preflight the ERP browser has nothing to do with).
    // That is a different path from the one under test, so say which one happened instead of blaming the browser.
    const refusals = await page.locator('[role=alert]').filter({ hasText: /\S/ }).allInnerTexts().catch(() => []);
    if (refusals.length > 0) {
      warn('erp-off', `去报销 was refused before the write started, so the browser-off path was not reached: ${refusals.join(' | ').replace(/\s+/g, ' ').slice(0, 300)}`);
      return;
    }
  }

  if (status === 'aborted') {
    ok('erp-off', `the ERP write stopped before any change: ${String(reason).replace(/\s+/g, ' ').slice(0, 220)}`);
    if (!/浏览器|Chrome|9333/.test(String(reason))) {
      warn('erp-off', 'the abort reason does not say the dedicated browser is unavailable');
    }
    const shown = await page.getByText('写入报销系统已停止', { exact: false }).isVisible().catch(() => false);
    const onReview = await page.getByTestId('erp-abort-reason').isVisible().catch(() => false);
    if (!shown && !onReview) defect('erp-off', 'the abort reason is not shown anywhere in the UI');
  } else {
    defect('erp-off', `with the ERP browser off the write ended in status ${status} instead of aborting cleanly`);
  }
}

await main();
