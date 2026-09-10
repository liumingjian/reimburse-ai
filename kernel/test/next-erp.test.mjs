import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { execFileSync } from 'node:child_process';
import { writeTextPdf, TEST_TRANSPORT_INVOICE_TEXT, TEST_ITINERARY_TEXT } from './fixture-pdf.mjs';

// 主干后半段的走查：**真目录、真发票、真的把 step.argv 执行掉**。
//
// 从读数确认之后一路走到写入前的那次点头，全程只调 `baox next`。
// 环境那一半（Chrome、登录、绑定）照旧是喂进去的，ERP 的只读核对同样 ——
// 它们只能在真机上验，混进来就等于把这一段也搬上真机。核对**结果**怎么影响状态，
// 是这里要钉的；核对本身查得对不对，不是。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-erp-home-'));
process.env.BAOX_HOME = home;
const fakeEgo = path.join(home, 'fake-ego.mjs');
fs.writeFileSync(fakeEgo, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const listing = input.includes('return (await listTabs()).map');
  const value = listing
    ? [{ targetId: 'fixture-tab', id: 'fixture-tab', url: 'http://erp.antute.com.cn/k3cloud/html5/index.aspx', title: 'ERP' }]
    : { ready: 'complete', title: 'ERP', displayName: '刘明建', account: 'luo.liu',
        tenant: '5f1f13f6dde29e', onMainConsole: true, loginFormVisible: false };
  process.stdout.write('__BAOX_EGO_RESULT__' + JSON.stringify({ ok: true, value }) + '\\n');
});
`);
fs.chmodSync(fakeEgo, 0o700);
process.env.BAOX_EGO_TASK_SPACE = '1';
process.env.BAOX_EGO_BROWSER = fakeEgo;
process.env.BAOX_BROWSER = 'ego';

const { observeTask, erpSnapshot } = await import('../src/observe.mjs');
const { nextResponse } = await import('../src/next.mjs');
const { sourceKeyOf, findLiveTaskForSource, recordCatalogVerification, liveTasks, abandonTask,
  taskDir } = await import('../src/workspace.mjs');
const { SCHEMA_VERSION } = await import('../src/state.mjs');
const { applyTerminalVerdict } = await import('../src/confirm.mjs');
const { confirmClassifiedDetail } = await import('../src/classified-detail.mjs');
const { loadSelection, submitSelection, linesDigest } = await import('../src/selection.mjs');
const { writeBinding } = await import('../src/binding.mjs');
const { writeHomeCity } = await import('../src/home-city.mjs');
const { writeBook, selectableProjects } = await import('../src/projects.mjs');
const { CATEGORIES } = await import('../src/categories.mjs');
const { generatePreparation } = await import('../src/preparation.mjs');

const repo = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const me = { displayName: '刘明建', account: 'luo.liu', tenant: '5f1f13f6dde29e' };
writeBinding(me);
writeHomeCity(me, '北京市');
writeBook(me, { projects: [{ number: '111454', name: '测试项目', lastVerdict: 'confirmed' }] });

const READY = {
  schemaVersion: SCHEMA_VERSION,
  nodeVersion: process.versions.node,
  nodeMajor: Number(process.versions.node.split('.')[0]),
  cdpUp: true,
  probe: { status: 'matched', identity: me },
  binding: { ...me, confirmedAt: '2026-09-06T00:00:00.000Z' },
};

// 三段合并的打车发票 + 它的行程单：逐段 26.69 + 20.85 + 21.65 = 69.19，
// 正好是票面价税合计。这一票的核心断言就长在这组材料上。
const AA_INV = 'test-transport-invoice.pdf';
const AA_ITI = 'test-three-trip-itinerary.pdf';
const ROUTE_INV = '交通/【曹操出行-51.63元-1个行程】高德打车电子发票.pdf';
const ROUTE_ITI = '交通/【曹操出行-51.63元-1个行程】高德打车电子行程单.pdf';
const TEST_PDFS = new Map([
  [AA_INV, TEST_TRANSPORT_INVOICE_TEXT],
  [AA_ITI, TEST_ITINERARY_TEXT],
]);

/**
 * 把之前那些用例留下的任务作废掉。
 *
 * 跨任务查重是真的在跑：同一张发票在两个还开着的任务里出现，内核会拦下整批 ——
 * 这正是它该做的事。所以除了专门测它的那个用例，别的用例都得先清场，
 * 否则测的是"上一个用例还占着这张票"，不是它自己想测的东西。
 */
function solo() {
  for (const t of liveTasks()) abandonTask(t.taskId, '用例之间清场');
}

function materials(rels) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-erp-'));
  for (const rel of rels) {
    const dest = path.join(dir, path.basename(rel));
    if (TEST_PDFS.has(rel)) writeTextPdf(dest, TEST_PDFS.get(rel));
    else fs.copyFileSync(path.join(repo, 'resources', rel), dest);
  }
  return dir;
}

const ask = async (dir, over = {}) => nextResponse({
  observation: { ...READY, ...await observeTask(dir, { mode: 'legacy' }) },
  sourceKey: sourceKeyOf(dir),
  ...over,
});

function runStep(r) {
  assert.ok(Array.isArray(r.step.argv), `${r.state} 这一步没有可执行的 argv`);
  const legacyCommands = new Set([
    'classify', 'ocr-request', 'ocr-submit', 'reread-submit', 'events', 'select-task',
    'lines', 'history', 'catalog',
  ]);
  const argv = legacyCommands.has(r.step.argv[2])
    ? [...r.step.argv, '--legacy-comparison'] : r.step.argv;
  try {
    return execFileSync(argv[0], argv.slice(1), { encoding: 'utf8' });
  } catch (err) {
    if (err.status === 2) return err.stdout;
    throw err;
  }
}

/** 一路问到"该做什么"不再是内核自己跑命令为止，把走过的状态记下来。 */
async function walk(dir, { max = 16 } = {}) {
  const seen = [];
  let r = await ask(dir);
  for (let i = 0; i < max; i += 1) {
    seen.push(r.state);
    if (r.state === 'classified_detail_confirmation') {
      const task = findLiveTaskForSource(sourceKeyOf(dir));
      const snapshot = await observeTask(dir, { mode: 'legacy' });
      assert.ok(confirmClassifiedDetail(task, snapshot.classifiedPreview, me),
        '测试在这里显式注入分类明细确认，生产流程仍由用户通过 next --after 完成');
      r = await ask(dir);
      continue;
    }
    if (r.step.kind !== 'run') break;
    // 任务选择页需要真实用户；纯集成走查只验证内核发出的 argv，随后由用例
    // 直接注入新契约的提交结果，不伪造浏览器或 ERP 交互。
    if (r.step.argv.includes('select-task')) return { r, seen };
    runStep(r);
    r = await ask(dir, { after: r.stepToken, hasResult: true });
  }
  return { r, seen };
}

test('跨任务重复发票被拦住，而且说清跟哪个任务撞了', async () => {
  solo();
  const first = materials([AA_INV, AA_ITI]);
  await walk(first);
  const other = findLiveTaskForSource(sourceKeyOf(first));

  // 同一批材料被复制到第二个目录、分两次整理 —— 这是这类错最常见的成因。
  const second = materials([AA_INV, AA_ITI]);
  const { r } = await walk(second);

  assert.equal(r.state, 'duplicate_blocked', `实际停在 ${r.state}：${r.speak}`);
  assert.equal(r.actor, 'user');
  assert.ok(r.speak.includes(other.taskId), '撞上的是哪个任务，得说出来，不然用户没法裁决');
  const hit = r.blockedBy.find((b) => b.kind === 'duplicate_across_tasks');
  assert.equal(hit.resolvableBy, 'user');
  assert.match(hit.hint, /abandon-task/, '怎么解开也要说清楚');
});

test('分毫不差的合并发票：全程没问过用户一句，内核自己就定了案', async () => {
  solo();
  const dir = materials([AA_INV, AA_ITI]);
  const { r, seen } = await walk(dir);

  assert.deepEqual(seen, ['task_none', 'classify_pending', 'events_pending',
    'classified_detail_confirmation', 'project_unassigned'],
    '盘点、分类、划事件和分类明细确认后才进入项目选择');
  assert.equal(r.state, 'project_unassigned',
    `分摊那一步压根没出现过，实际停在 ${r.state}：${r.speak}`);

  // 三段确实拆出来了，金额来源是"行程单，与票面核对上了"，不是用户报的。
  const snap = await erpSnapshot(dir, findLiveTaskForSource(sourceKeyOf(dir)), { mode: 'legacy' });
  assert.equal(snap.events.events.length, 3);
  assert.deepEqual(snap.events.events.map((e) => e.amountSource), Array(3).fill('itinerary_conserved'));
  assert.deepEqual(snap.events.events.map((e) => e.amounts.totalCents), [2669, 2085, 2165]);
  assert.equal(snap.allocationRound, null, '对得上就不问 —— 这是这一票最要紧的一条');
});

test('项目未指定：这一版如实停在这里，并说清楚为什么', async () => {
  solo();
  const dir = materials([AA_INV, AA_ITI]);
  const { r } = await walk(dir);
  assert.equal(r.state, 'project_unassigned');
  assert.equal(r.step.kind, 'run', '这一趟停在用户项目选择页，不在对话里代填');
  assert.ok(r.step.argv.includes('select-task'));
  assert.equal(r.blockedBy.length, 1, '一条都还没有项目号时，报的是整批');
  assert.match(r.speak, /项目号/);
  assert.equal(r.progress.label, '项目归属');

  // 幂等：再问一次还是这一步，状态不会自己往前跑。
  assert.equal((await ask(dir)).state, 'project_unassigned');
});

/** 走到"项目也有了、ERP 也核对过了"那一格。ERP 那次查询在这里是喂进去的。 */
async function upToWrite(dir, { projects = ['111454'], problems = [] } = {}) {
  await walk(dir);
  const task = findLiveTaskForSource(sourceKeyOf(dir));
  const snap = await erpSnapshot(dir, task, { mode: 'legacy' });
  const built = snap.events;

  // 项目选择：本票不做它的交互，但它落盘之后的样子是确定的（select-task 写的就是它）。
  const chosen = Object.fromEntries(built.lineItems.map((l, i) =>
    [l.lineId, projects[i % projects.length]]));
  const s = submitSelection(task, built, { homeCity: task.homeCity, purpose: '七月出差交通费', projects: chosen },
    projects.map((number) => ({ number, name: '测试项目' })), me);
  assert.equal(s.verdict, 'accepted', s.reasons?.join());

  return { task, built };
}

test('项目有了但还没核对过 —— 内核自己去 ERP 只读查一遍', async () => {
  solo();
  const dir = materials([AA_INV, AA_ITI]);
  await upToWrite(dir);
  const r = await ask(dir);
  assert.equal(r.state, 'catalog_unverified', `实际停在 ${r.state}：${r.speak}`);
  assert.equal(r.actor, 'kernel');
  assert.ok(r.step.argv.includes('catalog'));
  assert.match(r.speak, /只查不写/, '这一步碰 ERP，所以要先说清楚它只读');
});

/** 把一次 ERP 只读核对的结果喂进工作区。真的查一次只有在装了 ERP 的机器上做得到。 */
const feedCatalog = (task, built, projects, problems = []) => recordCatalogVerification(task, {
  catalogSchemaVersion: 2,
  linesDigest: linesDigest(built),
  versionId: built.versionId,
  verifiedAt: new Date().toISOString(),
  identity: me,
  projects,
  projectFormId: 'BJYC_ProJect',
  expenseItems: Object.values(CATEGORIES)
    .filter((category) => category.expenseItemCode)
    .map((category) => ({ code: category.expenseItemCode, name: category.expenseItemName,
      verdict: 'confirmed' })),
  expenseItemFormId: 'BD_Expense',
  selectionSnapshot: {
    projects: Object.fromEntries(Object.entries(loadSelection(task).projects).sort(([a], [b]) =>
      a.localeCompare(b))),
    projectBook: [...new Set(Object.values(loadSelection(task).projects))].sort().map((number) => {
      const project = selectableProjects(me).find((candidate) => candidate.number === number);
      return { number, name: project?.name ?? null };
    }),
  },
  problems,
});

async function materializePreparation(dir) {
  const observed = await observeTask(dir, { mode: 'legacy' });
  assert.ok(observed.preparation && observed.taskRecord && observed.inventory,
    '测试准备包前必须已经完成材料、事件、选择和目录核对');
  return generatePreparation({ task: observed.taskRecord, sourceDir: dir,
    inventory: observed.inventory, preparation: observed.preparation });
}

test('ERP 里查无此项目 —— 硬停，退出码 2，说清是哪个号跟谁对不上', async () => {
  solo();
  // 模拟项目簿里曾经 confirmed、但 ERP 后来删掉的项目；新项目不会从全 ERP 搜索进入项目簿。
  writeBook(me, { projects: [
    { number: '111454', name: '测试项目', lastVerdict: 'confirmed' },
    { number: '999999', name: '旧项目', lastVerdict: 'confirmed' },
  ] });
  const dir = materials([AA_INV, AA_ITI]);
  const { task, built } = await upToWrite(dir, { projects: ['999999'] });
  feedCatalog(task, built, { 999999: { verdict: 'missing', name: null } },
    [{ number: '999999', verdict: 'missing', note: '项目号 999999 在 ERP 项目目录里查不到' }]);

  const r = await ask(dir);
  assert.equal(r.state, 'catalog_mismatch', `实际停在 ${r.state}：${r.speak}`);
  assert.equal(r.exit, 2, '硬停：拿一个不存在的项目号建单，错误只会在保存那一刻暴露');
  assert.match(r.speak, /999999/);
  // 而且不会退回去反复核对同一个不存在的号 —— "没核对过"和"核对过、不合格"是两回事。
  assert.equal((await ask(dir, { after: r.stepToken })).state, 'catalog_mismatch');
});

test('准备交接包完整后停在手动确认：内核绝不自己越过去', async () => {
  solo();
  const dir = materials([ROUTE_INV, ROUTE_ITI]);
  const { task, built } = await upToWrite(dir);
  feedCatalog(task, built, { 111454: { verdict: 'confirmed', name: '测试项目' } });
  await materializePreparation(dir);

  const r = await ask(dir);
  assert.equal(r.state, 'preparation_confirmation', `实际停在 ${r.state}：${r.speak}`);
  assert.equal(r.actor, 'user');
  assert.equal(r.step.kind, 'confirm_table');
  assert.ok(r.step.digest, '确认表和当前准备摘要绑定');
  assert.match(r.step.table, /111454/, '项目号摆在表里 —— 它正是用户要核对的东西之一');
  assert.equal(r.step.acceptsCorrection, false);
  assert.match(r.speak, /手动 QA/);

  // 没有点头之前，问多少次都停在这里 —— 状态不会自己往前走。
  assert.equal((await ask(dir, { after: r.stepToken, hasResult: true })).state, 'preparation_confirmation');

  // 聊天里的"可以写了"不带凭据，落不下任何东西。
  const forged = await applyTerminalVerdict({ sourceDir: dir, sourceKey: sourceKeyOf(dir),
    after: 'f'.repeat(32) });
  assert.equal(forged, null);
  assert.equal((await ask(dir)).state, 'preparation_confirmation');

  // 用户确认的是第一阶段准备包。真实确认接线会重新探测模拟的当前身份，
  // 重建摘要并校验 manifest/bundle；它不能创建旧的 ERP 写入授权。
  const applied = await applyTerminalVerdict({ sourceDir: dir, sourceKey: sourceKeyOf(dir),
    after: r.stepToken, mode: 'legacy' });
  assert.equal(applied.verdict, 'preparation_confirmed');
  assert.ok(applied.digest);
  assert.equal(fs.existsSync(path.join(taskDir(task), 'preparation-confirmation.json')), true);
  assert.equal(fs.existsSync(path.join(taskDir(task), 'write-approval.json')), false);

  const after = await ask(dir, { after: r.stepToken });
  assert.equal(after.state, 'preparation_complete');
  assert.equal(after.step.kind, 'done', '确认后停在手动 QA，不再进入 ERP 写入');
  assert.match(after.speak, /未导入发票、填写或保存 ERP 单据/);
});

test('准备确认只对他看过的那一份有效：内容一变，当场作废', async () => {
  solo();
  const dir = materials([ROUTE_INV, ROUTE_ITI]);
  const { task, built } = await upToWrite(dir);
  feedCatalog(task, built, { 111454: { verdict: 'confirmed', name: '测试项目' } });
  await materializePreparation(dir);

  const shown = await ask(dir);
  assert.equal(shown.state, 'preparation_confirmation');

  // 用户在点头之前又改了事由（在这一版里只有本地页面能改，但改得动就得防）。
  submitSelection(task, built, { homeCity: '北京市', purpose: '改成了别的事由',
    projects: Object.fromEntries(built.lineItems.map((l) => [l.lineId, '111454'])) },
  [{ number: '111454', name: '测试项目' }], me);

  const applied = await applyTerminalVerdict({ sourceDir: dir, sourceKey: sourceKeyOf(dir),
    after: shown.stepToken });
  assert.equal(applied, null, '他点的是上一份内容，那一下不能算在这一份上');

  const again = await ask(dir);
  assert.equal(again.state, 'preparation_package_pending',
    '内容变了先重新生成当前准备包');
  assert.equal(again.step.kind, 'run');
  assert.ok(again.step.argv.includes('prepare'));
  assert.notEqual(again.stepToken, shown.stepToken, '内容变了，凭据当场作废');
  assert.equal(fs.existsSync(path.join(taskDir(task), 'write-approval.json')), false);
});

// fengyun-1.png 的真实票面。它是一张要看图才读得出的客运发票，
// 用它把"读数确认"和"划费用事件"这两段接起来。
const IMAGE = '交通/fengyun-1.png';
const FENGYUN = {
  docType: 'invoice',
  fields: {
    invoiceNumber: '26427000000640558021',
    issueDate: '2026-09-04',
    netAmount: '18.25', taxAmount: '0.55', totalAmount: '18.80',
  },
  unreadable: [],
};

test('读数确认之后接着往下走：确认那一下之后，内核自己就去划费用事件', async () => {
  solo();
  const dir = materials([AA_INV, AA_ITI, IMAGE]);

  // 材料那一段：盘点、分类之后停在"该看图了"。
  let r = await ask(dir);
  while (r.step.kind === 'run') { runStep(r); r = await ask(dir, { after: r.stepToken, hasResult: true }); }
  assert.equal(r.state, 'image_awaiting_reading', `实际停在 ${r.state}：${r.speak}`);

  // 模型逐张看图、写读数、原样执行 step.argv 交上来。
  const doc = { version: 1, readings: r.step.images.map((img) => ({
    materialId: img.materialId, contentHash: img.contentHash,
    sighted: { shape: 'landscape' }, ...FENGYUN })) };
  fs.mkdirSync(path.dirname(r.step.readingsPath), { recursive: true });
  fs.writeFileSync(r.step.readingsPath, JSON.stringify(doc));
  assert.equal(JSON.parse(runStep(r)).rejected, 0);

  // 轮到用户过目那张定宽表格 —— 这一格就是本票说的"读数确认"。
  r = await ask(dir, { after: r.stepToken, hasResult: true });
  assert.equal(r.state, 'reading_awaiting_confirmation', `实际停在 ${r.state}：${r.speak}`);
  const applied = await applyTerminalVerdict({ sourceDir: dir, sourceKey: sourceKeyOf(dir),
    after: r.stepToken });
  assert.equal(applied.verdict, 'confirmed');

  // 点头之后**不需要模型再做任何判断**：内核自己就跨进了事件这一层，
  // 并且如实报出它在那里发现的东西 —— 这张图上的费用没有费用发生日期
  // （开票日期不是费用发生日期，不能拿来顶替）。
  //
  // 待办排在账本前面是照表：有拦路的东西时，先把它说清楚，
  // 而不是先去记一版注定要重记的账。
  const after = await ask(dir);
  assert.equal(after.state, 'intake_open_items', `实际停在 ${after.state}：${after.speak}`);
  const missing = after.blockedBy.find((b) => b.kind === 'event_date_missing');
  assert.ok(missing, '事件层报上来的待办，和材料层走同一个出口');
  assert.equal(missing.resolvableBy, 'user');
  assert.match(after.speak, /fengyun-1\.png/, '是哪一份材料，得指名道姓');

  // 用户把那张票拿出去了。剩下的材料一路走到项目未指定，全程只有 baox next。
  fs.rmSync(path.join(dir, 'fengyun-1.png'));
  const { r: end, seen } = await walk(dir);
  assert.ok(seen.includes('events_pending'),
    `材料清干净之后该自己去划事件，实际走了 ${seen.join(' -> ')}`);
  assert.equal(end.state, 'project_unassigned', `实际停在 ${end.state}：${end.speak}`);
});

test('分摊那一轮：题换过一批之后，上一轮的答案不算数', async () => {
  solo();
  const dir = materials([AA_INV, AA_ITI]);
  const { r } = await walk(dir);
  assert.equal(r.state, 'project_unassigned', '这批材料分毫不差，压根不会问分摊');

  // 拿一份分摊答案回来，而内核此刻挂着的根本不是分摊那一步 ——
  // 什么都不该落盘。（问出去的题变过之后，同一道闸把旧答案挡在外面。）
  const answers = path.join(os.tmpdir(), `answers-${Date.now()}.json`);
  fs.writeFileSync(answers, JSON.stringify({ answers: [{ questionId: 'm-inv#1', amount: '26.69' }] }));
  const got = await applyTerminalVerdict({ sourceDir: dir, sourceKey: sourceKeyOf(dir),
    after: r.stepToken, resultFile: answers });
  assert.equal(got, null, '凭据对得上、步骤对不上，同样是什么都不做');
  assert.equal((await ask(dir)).state, 'project_unassigned');
});

// 放在最后：这个用例会给任务打上 erpWriteState，而动过 ERP 的任务**再也作废不了**
// （它占用的发票只能靠只读对账解除）。放在中间的话，后面每个用到同一批发票的用例
// 都会被跨任务查重拦下 —— 那是内核做对了，不是用例的意图。
test('已定义的 upload_dispatched：先建立本地恢复凭据，不再次写 ERP', async () => {
  solo();
  const dir = materials([AA_INV, AA_ITI]);
  const { task, built } = await upToWrite(dir);
  feedCatalog(task, built, { 111454: { verdict: 'confirmed', name: '测试项目' } });
  const { recordErpWrite } = await import('../src/workspace.mjs');
  recordErpWrite(task, 'upload_dispatched');

  const r = await ask(dir);
  assert.equal(r.state, 'handed_off_recover', `实际停在 ${r.state}：${r.speak}`);
  assert.equal(r.step.kind, 'run');
  assert.ok(r.step.argv.includes('resume-local-preparation'));
  assert.match(r.speak, /upload_dispatched/);
});

test.after(() => { fs.rmSync(home, { recursive: true, force: true }); });
