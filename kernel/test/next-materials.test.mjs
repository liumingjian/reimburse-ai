import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { execFileSync } from 'node:child_process';

// 材料这一段的走查：**真目录、真文件、真的把 step.argv 执行掉**。
//
// 上面两层（state / next）测的是判断和措辞，这一层测的是那条链子接不接得上：
// 内核给的命令跑得起来吗？跑完之后状态真的往前走了吗？往用户的目录里丢一个文件，
// 内核自己发现得了吗？这些问题只有让文件和进程真的动起来才答得了。
//
// 环境那一半（Chrome、登录、绑定）在这里是喂进去的：它只能在真机上验，
// 混进来就等于把材料这一段也搬上真机。分层的意义就在这儿。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-mat-home-'));
process.env.BAOX_HOME = home;

const { observeTask } = await import('../src/observe.mjs');
const { nextResponse } = await import('../src/next.mjs');
const { sourceKeyOf } = await import('../src/workspace.mjs');
const { SCHEMA_VERSION } = await import('../src/state.mjs');
const { applyTerminalVerdict } = await import('../src/confirm.mjs');

const repo = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const me = { displayName: '刘明建', account: 'luo.liu', tenant: '5f1f13f6dde29e' };

/** 环境已经就绪的那一半观测。它是喂进来的，不是采出来的。 */
const READY = {
  schemaVersion: SCHEMA_VERSION,
  nodeVersion: process.versions.node,
  nodeMajor: Number(process.versions.node.split('.')[0]),
  cdpUp: true,
  probe: { status: 'matched', identity: me },
  binding: { ...me, confirmedAt: '2026-09-06T00:00:00.000Z' },
};

const AA_INV = '交通/【AA出行-69.19元-3个行程】高德打车电子发票.pdf';
const IMAGE = '交通/fengyun-1.png';

/** 一个真的材料目录，里面是仓库里那些真发票。 */
function materials(rels) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-mat-'));
  for (const rel of rels) fs.copyFileSync(path.join(repo, 'resources', rel), path.join(dir, path.basename(rel)));
  return dir;
}

/** 问一句"现在该做什么"。环境那一半喂现成的，材料那一半是真采的。 */
const ask = async (dir, over = {}) => nextResponse({
  observation: { ...READY, ...await observeTask(dir) },
  sourceKey: sourceKeyOf(dir),
  ...over,
});

/** 把内核给的那条命令原样执行 —— 一个字都不改，模型也是这么做的。 */
function runStep(r) {
  assert.ok(Array.isArray(r.step.argv), `${r.state} 这一步没有可执行的 argv`);
  try {
    return execFileSync(r.step.argv[0], r.step.argv.slice(1), { encoding: 'utf8' });
  } catch (err) {
    // 退出码 2 是"还有硬阻塞"，命令本身跑成了 —— 盘点、分类都会这样收场。
    if (err.status === 2) return err.stdout;
    throw err;
  }
}

test('从环境就绪一路问到「该看图了」，全程只有 baox next 这一条命令', async () => {
  const dir = materials([AA_INV, IMAGE]);

  // 1. 这个目录还没有任务 —— 内核自己去盘点。
  let r = await ask(dir);
  assert.equal(r.state, 'task_none');
  assert.equal(r.actor, 'kernel');
  assert.equal(r.step.kind, 'run');
  assert.equal(r.task, null);
  runStep(r);

  // 2. 盘完了，这一版还没分过类 —— 内核自己去分。
  r = await ask(dir, { after: r.stepToken, hasResult: true });
  assert.equal(r.state, 'classify_pending', `实际停在 ${r.state}：${r.speak}`);
  assert.equal(r.task.sourceDir, dir);
  assert.ok(r.task.taskId, '任务建起来了，每条应答都带着它');
  runStep(r);

  // 3. 该看图了。
  r = await ask(dir, { after: r.stepToken, hasResult: true });
  assert.equal(r.state, 'image_awaiting_reading', `实际停在 ${r.state}：${r.speak}`);
  assert.equal(r.actor, 'model');
  assert.equal(r.step.kind, 'read_images');
  assert.deepEqual(r.step.images.map((i) => i.fileName), ['fengyun-1.png']);
  assert.ok(fs.existsSync(r.step.images[0].absPath), '给的绝对路径得真打得开');
  assert.ok(fs.existsSync(r.step.schemaPath));
  assert.equal(r.progress.label, '看图读数');

  // 幂等：再问一次，还是这一步，还是这个凭据。
  const again = await ask(dir);
  assert.equal(again.state, r.state);
  assert.equal(again.stepToken, r.stepToken);
});

test('材料目录里加一个文件，内核自己发现盘点过期并重新盘', async () => {
  const dir = materials([AA_INV]);
  let r = await ask(dir);
  assert.equal(r.state, 'task_none');
  runStep(r);

  // 盘完之后，用户往目录里又丢了一张票 —— 没有人告诉内核这件事。
  fs.copyFileSync(path.join(repo, 'resources', IMAGE), path.join(dir, 'fengyun-1.png'));

  r = await ask(dir);
  assert.equal(r.state, 'inventory_stale', '内核自己比出来的：此刻目录里的东西和上次盘的对不上');
  assert.equal(r.actor, 'kernel');
  assert.ok(r.step.argv.includes('intake'), '重新盘一遍，而不是接着用旧清单');
  runStep(r);

  r = await ask(dir);
  assert.notEqual(r.state, 'inventory_stale', '盘完就不该再喊过期');
});

test('有读不出的材料就停在待办上，且说清楚这条谁能解决', async () => {
  const dir = materials([AA_INV]);
  fs.writeFileSync(path.join(dir, '不知道是什么.pdf'), 'not a pdf at all');
  runStep(await ask(dir));                       // 建任务 + 盘点

  const r = await ask(dir);
  assert.equal(r.state, 'intake_open_items');
  assert.equal(r.actor, 'user');
  assert.equal(r.step.kind, 'tell_user');
  const bad = r.blockedBy.find((b) => b.fileName === '不知道是什么.pdf');
  assert.ok(bad, '认不出的那份材料要指名道姓');
  assert.equal(bad.resolvableBy, 'user', '换一份能读的文件，只有人做得到');
  assert.ok(bad.blocking, '带着读不出的材料往下走，等于把问题推到 ERP 那头去暴露');
  assert.match(r.speak, /不知道是什么\.pdf/, '念给用户听的那句话里就有它');

  // 有待办时，状态不越过它继续往前。
  const parked = await ask(dir, { after: r.stepToken });
  assert.equal(parked.state, 'intake_open_items');

  // 用户把它拿走了，状态才动。
  fs.rmSync(path.join(dir, '不知道是什么.pdf'));
  const moved = await ask(dir);
  assert.notEqual(moved.state, 'intake_open_items');
});

test('目录里只有图时，不会抢着说「一张凭证都没有」', async () => {
  const dir = materials([IMAGE]);
  runStep(await ask(dir));                       // 建任务 + 盘点
  runStep(await ask(dir));                       // 分类

  const r = await ask(dir);
  assert.equal(r.state, 'image_awaiting_reading',
    '图还没看就说没有凭证，是抢答 —— 一目录的发票照片，读之前一张也认不出来');
  assert.ok(!r.blockedBy.some((b) => b.kind === 'no_primary_voucher'));
});

// —— 看图读数与终端确认：从「该看图了」一路走到「读数已确认」——
//
// 这一段是 0.9.2 那次事故的正面：模型逐张打开图抄录，内核校守恒式和格式，
// 过了之后内核渲染一张定宽表格，用户在终端点头。全程不弹浏览器。

/** fengyun-1.png 的真实票面。抄错一位就过不了守恒式，这正是这条链子要的。 */
const FENGYUN = {
  docType: 'invoice',
  fields: {
    invoiceNumber: '26427000000640558021',
    issueDate: '2026-09-04',
    netAmount: '18.25', taxAmount: '0.55', totalAmount: '18.80',
  },
  unreadable: [],
};

/** 按内核给的那一步写读数文件，再原样执行 step.argv 交上去。 */
function submitReadings(r, over = {}) {
  const doc = { version: 1, readings: r.step.images.map((img) => ({
    materialId: img.materialId,
    contentHash: img.contentHash,
    sighted: { shape: 'landscape' },              // 1816×1396，横着的
    ...FENGYUN,
    ...over,
  })) };
  fs.mkdirSync(path.dirname(r.step.readingsPath), { recursive: true });
  fs.writeFileSync(r.step.readingsPath, JSON.stringify(doc));
  return JSON.parse(runStep(r));
}

/** 走到「该看图了」为止。前面几步都是内核自己跑命令。 */
async function upToReading(dir) {
  runStep(await ask(dir));                       // 建任务 + 盘点
  runStep(await ask(dir));                       // 分类
  const r = await ask(dir);
  assert.equal(r.state, 'image_awaiting_reading', `实际停在 ${r.state}：${r.speak}`);
  return r;
}

test('看图 → 内核校验 → 终端表格 → 用户点头，全程不弹浏览器', async () => {
  const dir = materials([IMAGE]);
  let r = await upToReading(dir);

  const verdicts = submitReadings(r);
  assert.equal(verdicts.rejected, 0, JSON.stringify(verdicts.verdicts));

  // 读完了，轮到用户过目。这一步是一张内核渲染好的表格，不是一个网址。
  r = await ask(dir, { after: r.stepToken, hasResult: true });
  assert.equal(r.state, 'reading_awaiting_confirmation', `实际停在 ${r.state}：${r.speak}`);
  assert.equal(r.actor, 'user');
  assert.equal(r.step.kind, 'confirm_table');
  assert.ok(r.step.table.includes('26427000000640558021'), '要比对的值完整摆在表里');
  assert.equal(r.step.argv, undefined, '没有命令要跑 —— 这一步的另一头是人');
  assert.equal(r.step.outsourceable, false);
  assert.doesNotMatch(JSON.stringify(r), /http:\/\/127|localhost/, '全程不弹浏览器');

  // 用户在终端上点了头。凭据一次性，回传就是那个动作。
  const applied = await applyTerminalVerdict({ sourceDir: dir, sourceKey: sourceKeyOf(dir), after: r.stepToken });
  assert.equal(applied.verdict, 'confirmed');
  assert.deepEqual(applied.materialIds.length, 1);

  const moved = await ask(dir, { after: r.stepToken });
  assert.notEqual(moved.state, 'reading_awaiting_confirmation', '点过头就不该再问同一张表');
});

test('聊天里的「对的」不构成确认：没有凭据，什么都不会落盘', async () => {
  const dir = materials([IMAGE]);
  const r = await upToReading(dir);
  submitReadings(r);
  const table = await ask(dir, { after: r.stepToken, hasResult: true });
  assert.equal(table.state, 'reading_awaiting_confirmation');

  // 拿一个不是内核此刻挂着的凭据回来 —— 那正是「模型替用户点头」的样子。
  const forged = await applyTerminalVerdict({ sourceDir: dir, sourceKey: sourceKeyOf(dir), after: 'f'.repeat(32) });
  assert.equal(forged, null, '凭据不对就什么都不做');
  assert.equal((await ask(dir)).state, 'reading_awaiting_confirmation', '还是停在等你过目');
});

test('没真的打开过图，提交走不通 —— 字段全抄对了也一样', async () => {
  const dir = materials([IMAGE]);
  let r = await upToReading(dir);

  // 票面字段一个不差，只是形状答错了：这张图没有被真的打开过。
  const verdicts = submitReadings(r, { sighted: { shape: 'portrait' } });
  assert.equal(verdicts.rejected, 1);
  assert.match(JSON.stringify(verdicts.verdicts), /没有真的打开过/);

  // 状态不往前走，而且下一步会把上次没过的理由原样带上。
  r = await ask(dir, { after: r.stepToken, hasResult: true });
  assert.equal(r.state, 'reading_rejected', `实际停在 ${r.state}：${r.speak}`);
  assert.equal(r.actor, 'model');
  assert.equal(r.step.kind, 'read_images');
  assert.match(r.step.images[0].previousRejection.join(), /sighted\.shape/);

  // 真打开看了再交，就过了。
  assert.equal(submitReadings(r).rejected, 0);
  assert.equal((await ask(dir, { after: r.stepToken, hasResult: true })).state,
    'reading_awaiting_confirmation');
});

test('守恒式不平是重读，不是把某一位数字改到平', async () => {
  const dir = materials([IMAGE]);
  let r = await upToReading(dir);

  submitReadings(r, { fields: { ...FENGYUN.fields, netAmount: '18.30' } });
  r = await ask(dir, { after: r.stepToken, hasResult: true });
  assert.equal(r.state, 'reading_rejected');
  assert.match(r.speak, /不含税金额 \+ 税额/, '为什么不平，念给用户听');
  assert.match(r.context, /凑平/, '内核不反算，也不许模型凑平');
});

test('图在读数之后被换掉，旧读数当场作废', async () => {
  const dir = materials([IMAGE]);
  const r = await upToReading(dir);
  submitReadings(r);
  assert.equal((await ask(dir, { after: r.stepToken, hasResult: true })).state,
    'reading_awaiting_confirmation');

  // 用户把那张图换成了另一张。读数钉在字节上，跟着一起作废。
  fs.copyFileSync(path.join(repo, 'resources', '交通', '行程单.png'), path.join(dir, 'fengyun-1.png'));
  const after = await ask(dir);
  assert.equal(after.state, 'inventory_stale', '文件换了，先重新盘点');
  runStep(after);
  const next = await ask(dir);
  assert.ok(['classify_pending', 'image_awaiting_reading', 'reading_stale'].includes(next.state),
    `换图之后不该还停在待确认，实际是 ${next.state}`);
  assert.notEqual(next.state, 'reading_awaiting_confirmation');
});

test('用户在表上指错：他给的值不落库，带着分歧回去重看那张图', async () => {
  const dir = materials([IMAGE]);
  const r = await upToReading(dir);
  submitReadings(r);
  const table = await ask(dir, { after: r.stepToken, hasResult: true });
  assert.equal(table.state, 'reading_awaiting_confirmation');

  // 用户对着原件说：价税合计不是 18.80。
  const correctionFile = path.join(table.step.correctionPath);
  fs.mkdirSync(path.dirname(correctionFile), { recursive: true });
  fs.writeFileSync(correctionFile, JSON.stringify({ corrections: [
    { materialId: table.step.materialIds[0], fields: { totalAmount: '19.80' } },
  ] }));

  const applied = await applyTerminalVerdict({ sourceDir: dir, sourceKey: sourceKeyOf(dir),
    after: table.stepToken, correctionFile });
  assert.equal(applied.verdict, 'corrected');

  // 用户的值没有被写进读数，这一份读数整份作废，转成一场待收场的争议。
  // （争议本身怎么收场在 dispute.test.mjs 里，这里只钉"值没落库、状态转过去了"。）
  const back = await ask(dir);
  assert.equal(back.state, 'reading_disputed', `实际停在 ${back.state}：${back.speak}`);
  const why = JSON.stringify(back.step.evidence);
  assert.match(why, /19\.80/, '用户说的值要摆出来');
  assert.match(why, /18\.80/, '机器读到的值也要摆出来，两个一起给人看');
  assert.doesNotMatch(JSON.stringify(back.blockedBy), /reading_awaiting_confirmation/,
    '被推翻的读数不再顶着「等你确认」往下走');
});

test('材料目录没了就只答环境那一半，不冒充成一个材料状态', async () => {
  const dir = materials([AA_INV]);
  runStep(await ask(dir));
  fs.rmSync(dir, { recursive: true, force: true });
  const r = nextResponse({ observation: { ...READY }, sourceKey: sourceKeyOf(dir) });
  assert.equal(r.state, 'env_ready');
  assert.equal(r.task, null);
});
