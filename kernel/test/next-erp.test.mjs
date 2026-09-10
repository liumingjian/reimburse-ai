import { fixtureMaterial } from './fixture-materials.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// 主干后半段的走查：**真目录、真发票、真的把 step.argv 执行掉**。
//
// 从读数确认之后一路走到写入前的那次点头，全程只调 `baox next`。
// 环境那一半（Chrome、登录、绑定）照旧是喂进去的，ERP 的只读核对同样 ——
// 它们只能在真机上验，混进来就等于把这一段也搬上真机。核对**结果**怎么影响状态，
// 是这里要钉的；核对本身查得对不对，不是。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-erp-home-'));
process.env.BAOX_HOME = home;

const { observeTask, erpSnapshot } = await import('../src/observe.mjs');
const { nextResponse } = await import('../src/next.mjs');
const { sourceKeyOf, findLiveTaskForSource, recordCatalogVerification, liveTasks, abandonTask }
  = await import('../src/workspace.mjs');
const { SCHEMA_VERSION } = await import('../src/state.mjs');
const { applyTerminalVerdict } = await import('../src/confirm.mjs');
const { submitSelection, linesDigest } = await import('../src/selection.mjs');

const me = { displayName: '刘明建', account: 'luo.liu', tenant: '5f1f13f6dde29e' };

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
const AA_INV = '交通/【AA出行-69.19元-3个行程】高德打车电子发票.pdf';
const AA_ITI = '交通/【AA出行-69.19元-3个行程】高德打车电子行程单.pdf';

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
  for (const rel of rels) fs.copyFileSync(fixtureMaterial(rel), path.join(dir, path.basename(rel)));
  return dir;
}

const ask = async (dir, over = {}) => nextResponse({
  observation: { ...READY, ...await observeTask(dir) },
  sourceKey: sourceKeyOf(dir),
  ...over,
});

function runStep(r) {
  assert.ok(Array.isArray(r.step.argv), `${r.state} 这一步没有可执行的 argv`);
  try {
    return execFileSync(r.step.argv[0], r.step.argv.slice(1), { encoding: 'utf8' });
  } catch (err) {
    if (err.status === 2) return err.stdout;
    throw err;
  }
}

/** 一路问到"该做什么"不再是内核自己跑命令为止，把走过的状态记下来。 */
async function walk(dir, { max = 12 } = {}) {
  const seen = [];
  let r = await ask(dir);
  for (let i = 0; i < max && r.step.kind === 'run'; i += 1) {
    seen.push(r.state);
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

  assert.deepEqual(seen, ['task_none', 'classify_pending', 'events_pending'],
    '盘点、分类、划事件三条命令，全是内核自己跑的');
  assert.equal(r.state, 'project_unassigned',
    `分摊那一步压根没出现过，实际停在 ${r.state}：${r.speak}`);

  // 三段确实拆出来了，金额来源是"行程单，与票面核对上了"，不是用户报的。
  const snap = await erpSnapshot(dir, findLiveTaskForSource(sourceKeyOf(dir)));
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
  assert.equal(r.step.kind, 'tell_user', '这一趟没走完，只是停在这里等一个人');
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
  const snap = await erpSnapshot(dir, task);
  const built = snap.events;

  // 项目选择：本票不做它的交互，但它落盘之后的样子是确定的（select-task 写的就是它）。
  const chosen = Object.fromEntries(built.lineItems.map((l, i) =>
    [l.lineId, projects[i % projects.length]]));
  const s = submitSelection(task, built, { homeCity: '北京市', purpose: '七月出差交通费', projects: chosen });
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
  linesDigest: linesDigest(built),
  versionId: built.versionId,
  verifiedAt: new Date().toISOString(),
  identity: me,
  projects,
  problems,
});

test('ERP 里查无此项目 —— 硬停，退出码 2，说清是哪个号跟谁对不上', async () => {
  solo();
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

test('全绿之后停在写入前那次点头上：内核绝不自己越过去', async () => {
  solo();
  const dir = materials([AA_INV, AA_ITI]);
  const { task, built } = await upToWrite(dir);
  feedCatalog(task, built, { 111454: { verdict: 'confirmed', name: '某个项目' } });

  const r = await ask(dir);
  assert.equal(r.state, 'ready_for_erp_write', `实际停在 ${r.state}：${r.speak}`);
  assert.equal(r.actor, 'user');
  assert.equal(r.step.kind, 'confirm_table');
  assert.equal(r.step.lineCount, 3);
  assert.equal(r.step.totalAmount, '69.19');
  assert.match(r.step.table, /111454/, '项目号摆在表里 —— 它正是用户要核对的东西之一');
  assert.equal(r.step.acceptsCorrection, false);
  assert.match(r.speak, /撤不回来/);

  // 没有点头之前，问多少次都停在这里 —— 状态不会自己往前走。
  assert.equal((await ask(dir, { after: r.stepToken, hasResult: true })).state, 'ready_for_erp_write');

  // 聊天里的"可以写了"不带凭据，落不下任何东西。
  const forged = await applyTerminalVerdict({ sourceDir: dir, sourceKey: sourceKeyOf(dir),
    after: 'f'.repeat(32) });
  assert.equal(forged, null);
  assert.equal((await ask(dir)).state, 'ready_for_erp_write');

  // 用户在终端上点了头。凭据一次性，且只对这一份内容有效。
  const applied = await applyTerminalVerdict({ sourceDir: dir, sourceKey: sourceKeyOf(dir),
    after: r.stepToken });
  assert.equal(applied.verdict, 'write_approved');
  assert.equal(applied.lineCount, 3);
  assert.equal(applied.totalAmount, '69.19');

  const after = await ask(dir, { after: r.stepToken });
  assert.equal(after.state, 'ready_for_erp_write');
  assert.equal(after.step.kind, 'done', '点过头就不再问同一张表');
  assert.match(after.speak, /还没有任何东西写进 ERP/, '还没写这件事要说清楚，不能让人以为写完了');
});

test('点头只对他看过的那一份有效：内容一变，那次点头当场作废', async () => {
  solo();
  const dir = materials([AA_INV, AA_ITI]);
  const { task, built } = await upToWrite(dir);
  feedCatalog(task, built, { 111454: { verdict: 'confirmed', name: '某个项目' } });

  const shown = await ask(dir);
  assert.equal(shown.state, 'ready_for_erp_write');

  // 用户在点头之前又改了事由（在这一版里只有本地页面能改，但改得动就得防）。
  submitSelection(task, built, { homeCity: '北京市', purpose: '改成了别的事由',
    projects: Object.fromEntries(built.lineItems.map((l) => [l.lineId, '111454'])) });

  const applied = await applyTerminalVerdict({ sourceDir: dir, sourceKey: sourceKeyOf(dir),
    after: shown.stepToken });
  assert.equal(applied, null, '他点的是上一份内容，那一下不能算在这一份上');

  const again = await ask(dir);
  assert.equal(again.state, 'ready_for_erp_write');
  assert.equal(again.step.kind, 'confirm_table', '重新摆一遍，请他再看');
  assert.notEqual(again.stepToken, shown.stepToken, '内容变了，凭据当场作废');
  assert.match(again.speak, /改成了别的事由/);
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
test('动过 ERP 的任务：不再问要不要写，直接交接给 baox-recover', async () => {
  solo();
  const dir = materials([AA_INV, AA_ITI]);
  const { task, built } = await upToWrite(dir);
  feedCatalog(task, built, { 111454: { verdict: 'confirmed', name: '某个项目' } });
  const { recordErpWrite } = await import('../src/workspace.mjs');
  recordErpWrite(task, 'dispatched');

  const r = await ask(dir);
  assert.equal(r.state, 'handed_off_recover', `实际停在 ${r.state}：${r.speak}`);
  assert.equal(r.step.kind, 'handoff');
  assert.equal(r.step.skill, 'baox-recover');
  assert.match(r.speak, /dispatched/);
});

test.after(() => { fs.rmSync(home, { recursive: true, force: true }); });
