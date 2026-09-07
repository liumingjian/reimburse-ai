import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { execFileSync } from 'node:child_process';
import { writeTextPdf, TEST_INVOICE_TEXT } from './fixture-pdf.mjs';

// 纠正与争议：**用户改的值不直接落库**。
//
// 这一层测的是那件最容易被做错的事 —— 用户说"这个数是 18 不是 10"的时候，
// 系统照改。照改看起来最顺从，实际上是把一个没有来源的值写进了事实链：
// 两边都可能错，而内核没有任何理由偏信哪一个。
//
// 所以这里逐条钉的是：值不落库、证据摆得出来（**只给路径**，不代替用户开原件）、
// 重读在干净上下文里只读那一个字段、三种收敛各有确定的说法、
// 守恒式破了报差额而**绝不反算**、每个字段带来源。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-dispute-home-'));
process.env.BAOX_HOME = home;

const { observeTask } = await import('../src/observe.mjs');
const { nextResponse } = await import('../src/next.mjs');
const { sourceKeyOf, findLiveTaskForSource } = await import('../src/workspace.mjs');
const { SCHEMA_VERSION, STATE_ORDER, determineState } = await import('../src/state.mjs');
const { applyTerminalVerdict } = await import('../src/confirm.mjs');
const { CONVERGENCE, openDisputes } = await import('../src/dispute.mjs');
const { loadReading, loadUnreadable } = await import('../src/vision.mjs');
const { takeInventory } = await import('../src/inventory.mjs');

const repo = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const me = { displayName: '刘明建', account: 'luo.liu', tenant: '5f1f13f6dde29e' };
const READY = {
  schemaVersion: SCHEMA_VERSION,
  nodeVersion: process.versions.node,
  nodeMajor: Number(process.versions.node.split('.')[0]),
  cdpUp: true,
  probe: { status: 'matched', identity: me },
  binding: { ...me, confirmedAt: '2026-09-06T00:00:00.000Z' },
};

const IMAGE = '交通/fengyun-1.png';

/** fengyun-1.png 的真实票面。18.25 + 0.55 = 18.80，守恒式在这三个数上。 */
const FENGYUN = {
  docType: 'invoice',
  fields: {
    invoiceNumber: '26427000000640558021',
    issueDate: '2026-09-04',
    netAmount: '18.25', taxAmount: '0.55', totalAmount: '18.80',
  },
  unreadable: [],
  clarity: { issueDate: 'blurry', totalAmount: 'clear' },
};

function materials() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-dispute-'));
  fs.copyFileSync(path.join(repo, 'resources', IMAGE), path.join(dir, 'fengyun-1.png'));
  return dir;
}

const ask = async (dir, over = {}) => nextResponse({
  observation: { ...READY, ...await observeTask(dir) },
  sourceKey: sourceKeyOf(dir),
  ...over,
});

/** 把内核给的那条命令原样执行 —— 一个字都不改。 */
function runStep(r) {
  assert.ok(Array.isArray(r.step.argv), `${r.state}/${r.step.phase ?? ''} 这一步没有可执行的 argv`);
  try {
    return execFileSync(r.step.argv[0], r.step.argv.slice(1), { encoding: 'utf8' });
  } catch (err) {
    if (err.status === 2) return err.stdout;
    throw err;
  }
}

function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v));
}

/** 走到「读数等你过目」为止：盘点 -> 分类 -> 看图 -> 提交。 */
async function upToConfirmation(dir, over = {}) {
  runStep(await ask(dir));
  runStep(await ask(dir));
  let r = await ask(dir);
  assert.equal(r.state, 'image_awaiting_reading', `实际停在 ${r.state}：${r.speak}`);
  writeJson(r.step.readingsPath, { version: 1, readings: r.step.images.map((img) => ({
    materialId: img.materialId, contentHash: img.contentHash,
    sighted: { shape: 'landscape' }, ...FENGYUN, ...over,
  })) });
  const verdicts = JSON.parse(runStep(r));
  assert.equal(verdicts.rejected, 0, JSON.stringify(verdicts.verdicts));
  r = await ask(dir, { after: r.stepToken, hasResult: true });
  assert.equal(r.state, 'reading_awaiting_confirmation', `实际停在 ${r.state}：${r.speak}`);
  return r;
}

/** 用户对着表格指错。他给的值到此为止 —— 后面的每一步都在验证它不会被直接采纳。 */
async function correct(dir, table, fields) {
  writeJson(table.step.correctionPath,
    { corrections: [{ materialId: table.step.materialIds[0], fields }] });
  const applied = await applyTerminalVerdict({ sourceDir: dir, sourceKey: sourceKeyOf(dir),
    after: table.stepToken, correctionFile: table.step.correctionPath });
  assert.equal(applied.verdict, 'corrected');
  return ask(dir);
}

/** 子 Agent 只消费派发契约，按模板写文件，再原样执行其中的 argv。 */
function submitReread(r, fields, over = {}) {
  const submission = r.step.subagent.submission;
  const template = JSON.parse(fs.readFileSync(submission.schemaPath, 'utf8'));
  writeJson(submission.rereadPath, {
    version: template.version,
    materialId: submission.materialId,
    contentHash: submission.contentHash,
    sighted: { shape: 'landscape' },          // 1816×1396，横着的
    fields,
    ...over,
  });
  try {
    return JSON.parse(execFileSync(submission.argv[0], submission.argv.slice(1), { encoding: 'utf8' }));
  } catch (err) {
    if (err.status === 2) return JSON.parse(err.stdout);
    throw err;
  }
}

/** 用户拍板。终值仍然要过格式闸和守恒式。 */
async function rule(dir, r, correction) {
  writeJson(r.step.rulingPath, { corrections: [{ materialId: r.step.materialId, ...correction }] });
  const applied = await applyTerminalVerdict({ sourceDir: dir, sourceKey: sourceKeyOf(dir),
    after: r.stepToken, correctionFile: r.step.rulingPath });
  return applied;
}

const taskOf = (dir) => findLiveTaskForSource(sourceKeyOf(dir));

// —— 一、值不落库，先进争议 ——

test('用户的纠正和机器读数不同时，值不落库，先进争议 —— 不是普通的「重读一遍」', async () => {
  const dir = materials();
  const table = await upToConfirmation(dir);
  const r = await correct(dir, table, { issueDate: '2026-09-03' });

  assert.equal(r.state, 'reading_disputed', `实际停在 ${r.state}：${r.speak}`);
  assert.notEqual(r.state, 'reading_rejected',
    '争议不是驳回：驳回的处置是重读整张票，争议的处置是只重读争的那一个字段');
  assert.equal(r.actor, 'model');
  assert.equal(r.step.kind, 'dispute');
  assert.equal(r.step.phase, 'reread');

  // 用户给的值一个都没有落库。
  const stored = loadReading(taskOf(dir), r.step.materialId);
  assert.equal(stored, null, '被推翻的那份读数已经作废，用户的值也没有顶上去');
  assert.doesNotMatch(r.speak, /已经改成|已按你说的/, '一个字都不能暗示"改好了"');
});

test('证据摆得出来：材料路径、机器读到的原文、当时清不清楚', async () => {
  const dir = materials();
  const table = await upToConfirmation(dir);
  const r = await correct(dir, table, { issueDate: '2026-09-03' });
  const e = r.step.evidence;

  // 路径。而且**只给路径** —— 内核不替用户打开原件。
  assert.ok(path.isAbsolute(e.materialPath), '要给绝对路径，用户拿它自己打开');
  assert.ok(fs.existsSync(e.materialPath), '给的路径得真打得开');
  assert.match(r.speak, new RegExp(e.materialPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    '路径要念给用户听，不然他不知道去哪儿看');
  assert.match(r.speak, /你自己打开|请你自己/, '内核不代替用户开原件');

  const f = e.fields[0];
  assert.equal(f.field, 'issueDate');
  assert.equal(f.machineValue, '2026-09-04', '机器读到的原文');
  assert.equal(f.userValue, '2026-09-03', '用户说的值');
  assert.equal(f.machineClarity.verdict, 'blurry', '模型当时对这一处的清晰度判断');
  assert.equal(f.machineClarity.statedBy, 'model');
  assert.match(r.speak, /发虚/, '清晰度也要念出来 —— 它是用户判断该信谁的依据之一');

  // 没被争的那几个字段一并摆出来供对照。
  assert.ok(e.otherFields.some((x) => x.key === 'totalAmount'));
});

test('清晰度模型没说时，内核明说是没人说过，不替它补一个判断', async () => {
  const dir = materials();
  const table = await upToConfirmation(dir, { clarity: {} });
  const r = await correct(dir, table, { issueDate: '2026-09-03' });
  const c = r.step.evidence.fields[0].machineClarity;
  assert.equal(c.verdict, null);
  assert.equal(c.statedBy, null);
  assert.match(c.label, /没说/);
});

// —— 二、重读：干净上下文，只读那一个字段 ——

test('重读必须外包给干净上下文的子 Agent，而且只读那一个字段', async () => {
  const dir = materials();
  const table = await upToConfirmation(dir);
  const r = await correct(dir, table, { issueDate: '2026-09-03' });

  assert.equal(r.step.outsourceable, false, '和用户对话的这一半在子 Agent 里做不了');
  assert.equal(r.step.subagent.required, true, '但重读那一下**必须**外包');
  assert.equal(r.step.subagent.context, 'clean');
  assert.equal(r.step.field, 'issueDate', '契约里的 step.field：这一趟只重读它');
  assert.deepEqual(r.step.fields, ['issueDate']);
  assert.match(r.step.subagent.instruction, /不要把用户说的值/);
  assert.ok(r.step.subagent.forbidden.some((x) => /自己重读一遍/.test(x)),
    '模型自己读一遍冒充子 Agent，正是这一步要挡的');
  assert.ok(fs.existsSync(r.step.schemaPath), '重读的模板跟着内核走');
  assert.ok(r.step.argv.includes('reread-submit'));
});

test('独立重读的派发契约一次给齐提交所需数据，不用反查任务或源码', async () => {
  const dir = materials();
  const table = await upToConfirmation(dir);
  const r = await correct(dir, table, { issueDate: '2026-09-03' });
  const { step } = r;

  assert.equal(step.evidence.contentHash, step.contentHash, '模板写的取值路径必须真有数据');
  assert.deepEqual(step.subagent.submission, {
    materialId: step.materialId,
    contentHash: step.contentHash,
    fields: step.fields,
    sightedShapes: step.sightedShapes,
    schemaPath: step.schemaPath,
    rereadPath: step.rereadPath,
    argv: step.argv,
  });
  assert.ok(step.subagent.submission.sightedShapes.length > 0, '形状凭据的允许值不能让子 Agent 自己查');
  assert.match(step.subagent.instruction, new RegExp(step.materialId));
  assert.match(step.subagent.instruction, new RegExp(step.contentHash));
});

test('重读顺手多抄了别的字段，整次不收 —— 它就该只看那一处', async () => {
  const dir = materials();
  const table = await upToConfirmation(dir);
  const r = await correct(dir, table, { issueDate: '2026-09-03' });
  const out = submitReread(r, { issueDate: '2026-09-03', totalAmount: '18.80' });
  assert.equal(out.verdict, 'rejected');
  assert.match(JSON.stringify(out.reasons), /只重读/);
});

test('重读也要先证明图真的被打开过', async () => {
  const dir = materials();
  const table = await upToConfirmation(dir);
  const r = await correct(dir, table, { issueDate: '2026-09-03' });
  const out = submitReread(r, { issueDate: '2026-09-03' }, { sighted: { shape: 'portrait' } });
  assert.equal(out.verdict, 'rejected');
  assert.match(JSON.stringify(out.reasons), /sighted\.shape/);
  assert.equal((await ask(dir)).step.phase, 'reread', '没收下就还停在「该重读了」');
});

// —— 三、三种收敛，各有确定的措辞 ——

test('收敛一：重读和用户一致 —— 接受，并说明第二次也读出这个', async () => {
  const dir = materials();
  const table = await upToConfirmation(dir);
  let r = await correct(dir, table, { issueDate: '2026-09-03' });

  const out = submitReread(r, { issueDate: '2026-09-03' });
  assert.equal(out.verdict, 'accepted');
  assert.equal(out.convergence.issueDate, CONVERGENCE.agrees_with_user);
  assert.equal(out.settled.verdict, 'settled', '重读印证了用户，内核自己就收下了');

  // 收下之后仍然是**未确认**：用户还要在整张表上点最后那一下。
  r = await ask(dir, { after: r.stepToken, hasResult: true });
  assert.equal(r.state, 'reading_awaiting_confirmation', `实际停在 ${r.state}：${r.speak}`);
  assert.match(r.speak, /重读读到「2026-09-03」/, '第二次读出什么，明说');
  assert.match(r.speak, /我第一次读到「2026-09-04」/, '第一次读到什么，也明说');
  assert.match(r.speak, /第二次也读出你说的这个值/, '收敛一那句话，一字不改地念出来');
  assert.match(r.speak, /是我第一次看错了/);

  const stored = loadReading(taskOf(dir), table.step.materialIds[0]);
  assert.equal(stored.fields.issueDate, '2026-09-03');
  assert.equal(stored.fieldSources.issueDate, 'user', '这个值是用户给的，来源就记用户');
  assert.equal(stored.confirmedAt, null, '争议收场不等于确认 —— 最终判定还是用户那一下');
});

test('收敛二：重读和原读数一致 —— 两次机器读数和用户的值一并摆出，请用户拍板', async () => {
  const dir = materials();
  const table = await upToConfirmation(dir);
  let r = await correct(dir, table, { issueDate: '2026-09-03' });

  const out = submitReread(r, { issueDate: '2026-09-04' });
  assert.equal(out.convergence.issueDate, CONVERGENCE.agrees_with_machine);
  assert.equal(out.settled, null, '两次机器读数一致也不能自己拍板');

  r = await ask(dir, { after: r.stepToken, hasResult: true });
  assert.equal(r.state, 'reading_disputed');
  assert.equal(r.step.phase, 'ruling');
  assert.match(r.speak, /还是「2026-09-04」/);
  assert.match(r.speak, /你说是「2026-09-03」/);
  assert.match(r.speak, /并不等于机器就对/, '两次一致也可能是同一个错，这一句不能省');
  assert.match(r.speak, /你说是多少就是多少/);
  assert.equal(r.step.ruling.fields[0].suggested, null, '还没定 —— 内核不预填一个值');

  // 用户对着原件拍板：还是他说的那个。
  const applied = await rule(dir, r, { fields: { issueDate: '2026-09-03' } });
  assert.equal(applied.verdict, 'ruled');
  const stored = loadReading(taskOf(dir), r.step.materialId);
  assert.equal(stored.fields.issueDate, '2026-09-03');
  assert.equal(stored.fieldSources.issueDate, 'user');
  assert.equal((await ask(dir)).state, 'reading_awaiting_confirmation');
});

test('收敛三：重读给出第三个值 —— 直说这个字段读不可靠，以原件为准', async () => {
  const dir = materials();
  const table = await upToConfirmation(dir);
  let r = await correct(dir, table, { issueDate: '2026-09-03' });

  const out = submitReread(r, { issueDate: '2026-09-02' });
  assert.equal(out.convergence.issueDate, CONVERGENCE.third_value);

  r = await ask(dir, { after: r.stepToken, hasResult: true });
  assert.equal(r.step.phase, 'ruling');
  assert.match(r.speak, /三个说法互不相同/);
  assert.match(r.speak, /读不可靠/, '读不准这件事要直说，不能含混过去');
  assert.match(r.speak, /以原件为准/);
  assert.match(r.speak, /不会替你填一个数/);
});

test('重读干脆读不出来，也是第三种收敛 —— null 是正当结果，不是没交', async () => {
  const dir = materials();
  const table = await upToConfirmation(dir);
  let r = await correct(dir, table, { issueDate: '2026-09-03' });

  const out = submitReread(r, { issueDate: null });
  assert.equal(out.verdict, 'accepted');
  assert.equal(out.convergence.issueDate, CONVERGENCE.third_value);
  r = await ask(dir, { after: r.stepToken, hasResult: true });
  assert.match(r.speak, /重读读到读不出来/);
});

// —— 四、守恒式：报差额，绝不反算 ——

test('纠正打破守恒式：报出差额、说清还差什么，绝不反算另外两个值', async () => {
  const dir = materials();
  const table = await upToConfirmation(dir);
  let r = await correct(dir, table, { totalAmount: '19.80' });

  submitReread(r, { totalAmount: '19.80' });          // 重读印证了用户
  r = await ask(dir, { after: r.stepToken, hasResult: true });

  assert.equal(r.state, 'reading_disputed');
  assert.equal(r.step.phase, 'conservation_gap', `实际是 ${r.step.phase}：${r.speak}`);
  assert.equal(r.step.gap.delta, '1.00', '差额是内核算出来的一个事实');
  assert.equal(r.step.gap.sum, '18.80');
  assert.match(r.speak, /差 1\.00 元/);
  assert.match(r.speak, /18\.25 \+ 税额 0\.55/, '不平在哪里要摆出来，不能只说"不平"');
  assert.match(r.speak, /不会去反算/);

  // 关键：一个字段都没落库，另外两个值一个都没被改动。
  const stored = loadReading(taskOf(dir), r.step.materialId);
  assert.equal(stored, null, '式子不平的读数不进事实链');
  const inv = await takeInventory(dir);
  const [d] = openDisputes(taskOf(dir), inv, dir);
  assert.equal(d.gap.netAmount, '18.25', '内核没有把不含税金额反算成 19.25');
  assert.equal(d.gap.taxAmount, '0.55');
});

test('缺口补齐了、分毫不差，才落库，且补的那几个也记成用户给的', async () => {
  const dir = materials();
  const table = await upToConfirmation(dir);
  let r = await correct(dir, table, { totalAmount: '19.80' });
  submitReread(r, { totalAmount: '19.80' });
  r = await ask(dir, { after: r.stepToken, hasResult: true });

  // 先给一组还是不平的：照样不收。
  let applied = await rule(dir, r, { fields: { netAmount: '19.00', taxAmount: '0.55', totalAmount: '19.80' } });
  assert.equal(applied.rulings[0].verdict, 'conservation_gap', '差一分也是不平');
  assert.equal(loadReading(taskOf(dir), r.step.materialId), null);

  r = await ask(dir);
  applied = await rule(dir, r, { fields: { netAmount: '19.25', taxAmount: '0.55', totalAmount: '19.80' } });
  assert.equal(applied.rulings[0].verdict, 'settled');

  const stored = loadReading(taskOf(dir), r.step.materialId);
  assert.equal(stored.amountCheck, 'balanced');
  assert.equal(stored.fieldSources.netAmount, 'user');
  assert.equal(stored.fieldSources.totalAmount, 'user');
  assert.equal(stored.fieldSources.invoiceNumber, 'vision', '没被动过的字段还是我看图读的');
  assert.equal(stored.confirmedAt, null);
});

test('缺口补不上：整条读数退回待办，而且不再派模型去重读同一张图', async () => {
  const dir = materials();
  const table = await upToConfirmation(dir);
  let r = await correct(dir, table, { totalAmount: '19.80' });
  submitReread(r, { totalAmount: '19.80' });
  r = await ask(dir, { after: r.stepToken, hasResult: true });
  assert.equal(r.step.phase, 'conservation_gap');

  const applied = await rule(dir, r, { unreadable: true });
  assert.equal(applied.rulings[0].verdict, 'parked_unreadable');

  const parked = loadUnreadable(taskOf(dir), r.step.materialId);
  assert.ok(parked, '退回待办这件事要落盘，不然下一轮就忘了');
  assert.match(parked.reason, /不反算/);
  // 证据不能跟着结论一起被删掉：事后问"这条为什么读不出来"，
  // 答案不能只剩一句结论。
  assert.ok(parked.machineReading, '被推翻的那次机器读数留着');
  assert.ok(parked.reread, '那次独立重读也留着');
  assert.equal(parked.gap.delta, '1.00', '差额差在哪里，留着');
  assert.equal(parked.disputed[0].userValue, '19.80', '用户当时说的值，留着');

  const back = await ask(dir);
  assert.equal(back.state, 'intake_open_items', `实际停在 ${back.state}：${back.speak}`);
  const item = back.blockedBy.find((b) => b.kind === 'reading_unreadable');
  assert.ok(item, '它是一条摆给用户的待办');
  assert.equal(item.resolvableBy, 'user', '换一份看得清的原件，只有人做得到');
  assert.match(back.speak, /换一份看得清的原件/);

  // 转不出去的圈：不能又把同一张图派回给模型读。
  assert.notEqual(back.state, 'image_awaiting_reading');
  assert.notEqual(back.state, 'reading_disputed');

  // 用户换了一份原件，字节一变，这张图重新回到正常流程。
  fs.copyFileSync(path.join(repo, 'resources', '交通', '行程单.png'), path.join(dir, 'fengyun-1.png'));
  const moved = await ask(dir);
  assert.equal(moved.state, 'inventory_stale');
  runStep(moved);
  assert.notEqual((await ask(dir)).state, 'intake_open_items');
});

test('用户对着原件也认不出：这条读数整条退回待办是一个正当的结局', async () => {
  const dir = materials();
  const table = await upToConfirmation(dir);
  let r = await correct(dir, table, { issueDate: '2026-09-03' });
  submitReread(r, { issueDate: '2026-09-02' });
  r = await ask(dir, { after: r.stepToken, hasResult: true });

  const applied = await rule(dir, r, { unreadable: true });
  assert.equal(applied.rulings[0].verdict, 'parked_unreadable');
  assert.match(loadUnreadable(taskOf(dir), r.step.materialId).reason, /认不出/);
});

test('用户口述的值走和模型抄写同一道格式闸 —— 人也会漏一位小数', async () => {
  const dir = materials();
  const table = await upToConfirmation(dir);
  let r = await correct(dir, table, { totalAmount: '19.80' });
  submitReread(r, { totalAmount: '18.80' });          // 重读维持原读数
  r = await ask(dir, { after: r.stepToken, hasResult: true });
  assert.equal(r.step.phase, 'ruling');

  const applied = await rule(dir, r, { fields: { totalAmount: '19.8' } });
  assert.equal(applied.rulings[0].verdict, 'rejected');
  assert.match(JSON.stringify(applied.rulings[0].reasons), /两位小数/);
  assert.equal(loadReading(taskOf(dir), r.step.materialId), null);
  assert.match((await ask(dir)).speak, /上一次你给的值我没收下/);
});

test('拍板只定争的那几个字段 —— 夹带一个没争过的字段进不来', async () => {
  const dir = materials();
  const table = await upToConfirmation(dir);
  let r = await correct(dir, table, { issueDate: '2026-09-03' });
  submitReread(r, { issueDate: '2026-09-04' });          // 维持原读数，要用户拍板
  r = await ask(dir, { after: r.stepToken, hasResult: true });
  assert.equal(r.step.phase, 'ruling');

  // 终值里夹带一个没争过的字段。它没走过摆证据、没走过独立重读 ——
  // 收下它等于给"用户改的值不直接落库"开了一个后门。
  const applied = await rule(dir, r, { fields: {
    issueDate: '2026-09-03', sellerName: '我顺手改的销售方',
  } });
  assert.equal(applied.rulings[0].verdict, 'rejected');
  assert.match(JSON.stringify(applied.rulings[0].reasons), /不在这场争议里/);
  assert.equal(loadReading(taskOf(dir), r.step.materialId), null, '整份都没落库');
});

test('补缺口那一步只放宽到守恒式那三个金额，不是随便什么字段都能搭这趟车', async () => {
  const dir = materials();
  const table = await upToConfirmation(dir);
  let r = await correct(dir, table, { totalAmount: '19.80' });
  submitReread(r, { totalAmount: '19.80' });
  r = await ask(dir, { after: r.stepToken, hasResult: true });
  assert.equal(r.step.phase, 'conservation_gap');

  // 三个金额可以一起给（这一步问的本来就是它们）。
  let applied = await rule(dir, r, { fields: {
    netAmount: '19.25', taxAmount: '0.55', totalAmount: '19.80', invoiceNumber: '26427000000640558099',
  } });
  assert.equal(applied.rulings[0].verdict, 'rejected', '发票号码没争过，搭不了这趟车');
  assert.match(JSON.stringify(applied.rulings[0].reasons), /不在这场争议里/);

  r = await ask(dir);
  applied = await rule(dir, r, { fields: { netAmount: '19.25', taxAmount: '0.55', totalAmount: '19.80' } });
  assert.equal(applied.rulings[0].verdict, 'settled');
});

// —— 五、来源 ——

test('每个字段带来源：机器看的、用户给的、还是内核算的', async () => {
  const dir = materials();
  const table = await upToConfirmation(dir);

  // 看图读的那一份，每个字段都是 vision，而且表上就写着。
  assert.ok(table.step.table.includes('这个值哪来的'), '来源单独占一列，不藏在脚注里');
  assert.ok(table.step.table.includes('我看图读的'));
  const before = loadReading(taskOf(dir), table.step.materialIds[0]);
  assert.deepEqual(new Set(Object.values(before.fieldSources)), new Set(['vision']));

  // 争议收场之后，改过的那个字段来源变成 user，别的不变。
  let r = await correct(dir, table, { issueDate: '2026-09-03' });
  submitReread(r, { issueDate: '2026-09-03' });
  r = await ask(dir, { after: r.stepToken, hasResult: true });
  assert.ok(r.step.table.includes('你给的'), '用户给的那个值，表上标明是他给的');

  const after = loadReading(taskOf(dir), table.step.materialIds[0]);
  assert.equal(after.fieldSources.issueDate, 'user');
  assert.equal(after.fieldSources.invoiceNumber, 'vision');
});

test('PDF 那条路上的字段来源记内核 —— 那是内核自己从文字层解出来的', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-dispute-pdf-'));
  writeTextPdf(path.join(dir, 'test-invoice.pdf'), TEST_INVOICE_TEXT);
  runStep(await ask(dir));
  runStep(await ask(dir));
  const { classifyInventory } = await import('../src/classify.mjs');
  const inv = await takeInventory(dir);
  const c = classifyInventory(dir, inv, taskOf(dir));
  const parsed = c.results.find((r) => r.parseStatus === 'parsed');
  assert.ok(parsed, '这份 PDF 该解析得出来');
  assert.deepEqual(new Set(Object.values(parsed.fieldSources)), new Set(['kernel']));
});

// —— 六、闸门 ——

test('摆证据那一步的凭据，拿不来拍板 —— 证据还没摆出来时不存在"拍板"', async () => {
  const dir = materials();
  const table = await upToConfirmation(dir);
  const r = await correct(dir, table, { issueDate: '2026-09-03' });
  assert.equal(r.step.phase, 'reread');

  // 用摆证据那一步的凭据交一份终值。这一步压根收不下终值。
  writeJson(table.step.correctionPath, { corrections: [{ materialId: r.step.materialId,
    fields: { issueDate: '2026-09-03' } }] });
  const forged = await applyTerminalVerdict({ sourceDir: dir, sourceKey: sourceKeyOf(dir),
    after: r.stepToken, correctionFile: table.step.correctionPath });
  assert.equal(forged, null);
  assert.equal(loadReading(taskOf(dir), r.step.materialId), null, '一个值都没落库');
  assert.equal((await ask(dir)).step.phase, 'reread', '还是停在「该重读了」');

  // 而且要**明说**没收下。静悄悄丢掉一份终值，用户会以为自己已经定了。
  assert.equal(r.step.acceptsCorrection, undefined, '摆证据这一步压根收不下终值');
  const told = await ask(dir, { after: r.stepToken, hasCorrection: true });
  assert.equal(told.ignored.reason, 'correction_not_applicable');
  assert.match(told.ignored.note, /没有采纳/);
});

test('争议的三步各发各的凭据 —— 状态名一样不等于是同一步', async () => {
  const dir = materials();
  const table = await upToConfirmation(dir);
  const r = await correct(dir, table, { issueDate: '2026-09-03' });
  const idempotent = await ask(dir);
  assert.equal(idempotent.stepToken, r.stepToken, '同一步连问两次，凭据不变');

  submitReread(r, { issueDate: '2026-09-04' });
  const ruling = await ask(dir, { after: r.stepToken, hasResult: true });
  assert.equal(ruling.state, r.state, '状态名还是 reading_disputed');
  assert.notEqual(ruling.stepToken, r.stepToken, '但这是另一步，凭据必须换掉');
});

test('一场争议只重读一次 —— 收场靠用户拍板，不靠再读第三遍', async () => {
  const dir = materials();
  const table = await upToConfirmation(dir);
  const r = await correct(dir, table, { issueDate: '2026-09-03' });
  submitReread(r, { issueDate: '2026-09-04' });
  const again = submitReread(r, { issueDate: '2026-09-02' });
  assert.equal(again.verdict, 'rejected');
  assert.match(JSON.stringify(again.reasons), /已经重读过一次/);
});

// —— 七、判定表 ——

test('reading_disputed 在判定表里，位置照规格：等你过目之后、跨任务查重之前', () => {
  const i = (s) => STATE_ORDER.indexOf(s);
  assert.ok(i('reading_disputed') > -1, 'reading_disputed 得在判定表里');
  assert.ok(i('reading_awaiting_confirmation') < i('reading_disputed'));
  assert.ok(i('reading_disputed') < i('duplicate_blocked'));
});

test('争议的 actor 是模型，但它一个值都定不了', () => {
  const o = {
    ...READY, taskObserved: true, task: { taskId: 't', sourceLabel: 'x', workspace: '/tmp/x' },
    classificationRecorded: true, inventoryStale: false,
    openItems: [{ kind: 'reading_disputed', blocking: true, materialId: 'm1', fileName: '发票.png' }],
  };
  const v = determineState(o);
  assert.equal(v.state, 'reading_disputed');
  assert.equal(v.actor, 'model', '摆证据、派子 Agent 是模型的活');
  assert.equal(v.blockedBy[0].resolvableBy, 'model');
});
