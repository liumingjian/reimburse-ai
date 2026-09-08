import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const TEST_BINDING = { account: 'employee.test', tenant: 'tenant-a', homeCity: '广州市' };

// 每个用例一份独立的数据目录：跨任务重复检查读的就是全局任务账，
// 用例之间共用一份账会互相干扰，测出来的也不再是这条规则本身。
let home;
const freshHome = () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-test-'));
  process.env.BAOX_HOME = home;
  return home;
};
freshHome();

const { parseMaterial, invoiceIdentity } = await import('../src/parse.mjs');
const { createTask, recordInvoiceSightings, abandonTask, loadIndex, taskDir, recordErpWrite }
  = await import('../src/workspace.mjs');
const { crossTaskDuplicates, historyOpenItems, holdsInvoices } = await import('../src/history.mjs');

const repo = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const RIDE = '交通/【曹操出行-51.63元-1个行程】高德打车电子发票.pdf';
const HOTEL = '住宿/fp-jd.pdf';

const material = (id, rel) => {
  const parsed = parseMaterial(path.join(repo, 'resources', rel), 'pdf');
  return { materialId: id, fileName: path.basename(rel), contentHash: `hash-${id}`,
    ...parsed, identity: invoiceIdentity(parsed) };
};
const classificationOf = (pairs) => ({
  versionId: 'v-test', results: pairs.map(([id, rel]) => material(id, rel)), duplicates: [],
});

const newTask = (label) => createTask(path.join(home, `src-${label}`), TEST_BINDING);

beforeEach(freshHome);
const blockingOf = (r) => historyOpenItems(r).filter((i) => i.blocking);

test('同一张发票躺在另一个进行中的任务里 —— 阻塞，并指得出是哪个任务', () => {
  const a = newTask('a');
  recordInvoiceSightings(a, classificationOf([['m1', RIDE]]));

  const b = newTask('b');
  const c = classificationOf([['m9', RIDE]]);
  const r = crossTaskDuplicates(b, c);
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].otherTask.taskId, a.taskId);

  const blocking = blockingOf(r);
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0].kind, 'duplicate_across_tasks');
  assert.match(blocking[0].note, /不能报两次/);

  // 完整的 20 位发票号码不能出现在输出里，脱敏号码要认得出是同一张票。
  const full = c.results[0].identity.number;
  assert.equal(full.length, 20);
  assert.ok(!JSON.stringify(r).includes(full), '跨任务重复的输出里不能出现完整发票号码');
  assert.match(r.hits[0].maskedNumber, /^\d{4}\*+\d{4}$/);
});

test('任务不会和自己重复 —— 同一个任务反复跑，账上还是一张票', () => {
  const a = newTask('self');
  const c = classificationOf([['m1', RIDE]]);
  recordInvoiceSightings(a, c);
  recordInvoiceSightings(a, c);
  assert.deepEqual(crossTaskDuplicates(a, c).hits, []);
});

test('把材料挪出目录，占用就跟着解除 —— 摘要是派生的，不是攒出来的', () => {
  const a = newTask('shrink');
  recordInvoiceSightings(a, classificationOf([['m1', RIDE], ['m2', HOTEL]]));
  const b = newTask('other');
  const mine = classificationOf([['m9', HOTEL]]);
  assert.equal(crossTaskDuplicates(b, mine).hits.length, 1);

  // 用户把住宿发票从 a 的目录里拿走，重跑一次分流。
  recordInvoiceSightings(a, classificationOf([['m1', RIDE]]));
  assert.deepEqual(crossTaskDuplicates(b, mine).hits, []);
});

test('另一个任务作废之后，它占的发票才放出来 —— 而且是状态变更，不是删除', () => {
  const a = newTask('abandon');
  recordInvoiceSightings(a, classificationOf([['m1', RIDE]]));
  const b = newTask('taker');
  const mine = classificationOf([['m9', RIDE]]);
  assert.equal(crossTaskDuplicates(b, mine).hits.length, 1);

  const r = abandonTask(a.taskId, '这批材料改走别的目录');
  assert.equal(r.verdict, 'abandoned');
  assert.deepEqual(crossTaskDuplicates(b, mine).hits, []);
  assert.equal(holdsInvoices(loadIndex().tasks.find((t) => t.taskId === a.taskId)), false);
  // 工作区一份不动：作废不是清理。
  assert.ok(fs.existsSync(path.join(taskDir(a), 'invoices.json')));
  assert.equal(r.task.abandonReason, '这批材料改走别的目录');
});

test('动过 ERP 的任务不能靠作废把发票放出来', () => {
  const a = newTask('erp');
  // 这里必须走真正的写入方。以前这个用例是手改 index.json 造出 erpWriteState 的，
  // 于是它钉住了"给定这个字段时守卫怎么做"，却没人发现根本没有代码会产生这个字段 ——
  // 绿灯给在了错误的地方。
  recordErpWrite(a, 'erp-fill');

  const r = abandonTask(a.taskId, '想赶紧解锁');
  assert.equal(r.verdict, 'rejected');
  assert.match(r.reason, /只读对账/);
  assert.equal(holdsInvoices(loadIndex().tasks.find((t) => t.taskId === a.taskId)), true);
});

test('recordErpWrite 落盘到任务账和任务目录，首次时间戳不被后来的状态改写', () => {
  const a = newTask('mark');
  assert.equal(holdsInvoices(loadIndex().tasks.find((t) => t.taskId === a.taskId)), true,
    '进行中的任务本来就占着发票；这一条是为了让下面的断言测的是 erpWriteState 而不是 status');

  const first = recordErpWrite(a, 'erp-fill');
  assert.equal(first.erpWriteState, 'erp-fill');
  assert.ok(first.erpWriteAt, '第一次碰 ERP 的时间必须落下来');

  const meta = JSON.parse(fs.readFileSync(path.join(taskDir(first), 'meta.json'), 'utf8'));
  assert.equal(meta.erpWriteState, 'erp-fill', '任务目录里的 meta.json 也要跟着更新');
  assert.equal(loadIndex().tasks.find((t) => t.taskId === a.taskId).erpWriteState, 'erp-fill');

  const second = recordErpWrite(a, 'saved');
  assert.equal(second.erpWriteState, 'saved', '后来的命令可以细化状态');
  assert.equal(second.erpWriteAt, first.erpWriteAt, '但第一次碰 ERP 的时间是不变的事实');
});

test('作废之后仍然动不了：标记过 ERP 的任务连状态都改不动', () => {
  const a = newTask('mark2');
  recordErpWrite(a, 'erp-fill');
  const r1 = abandonTask(a.taskId, '第一次');
  const r2 = abandonTask(a.taskId, '再试一次');
  assert.equal(r1.verdict, 'rejected');
  assert.equal(r2.verdict, 'rejected', '重试不是绕过的办法');
  assert.equal(loadIndex().tasks.find((t) => t.taskId === a.taskId).status, 'open',
    '被拒的作废不能留下任何痕迹');
});

test('查过不等于没报过 —— 范围声明始终跟着结果走，而且不阻塞', () => {
  const b = newTask('scope');
  const items = historyOpenItems(crossTaskDuplicates(b, classificationOf([['m9', RIDE]])));
  const scope = items.find((i) => i.kind === 'history_scope_local');
  assert.ok(scope);
  assert.equal(scope.blocking, false);
  assert.match(scope.note, /ERP 外部既有记录的只读查询还没有实现/);
});

// —— 0.9.x 在途任务的存档 ——
// 存档要挡的是一件很具体的事：旧读数没有本版要求的看图凭据，接着往下走就会
// 绕过"没看图就不算读数"被投影成事实。所以这几条测的都是"标了之后还剩什么"。

test('迁移把 0.9.x 的在途任务标成存档，材料和记录一份不动', async () => {
  const { archiveMigratedTasks } = await import('../src/workspace.mjs');
  const a = newTask('legacy');
  recordInvoiceSightings(a, classificationOf([['m1', RIDE]]));

  const archived = archiveMigratedTasks();
  assert.equal(archived.length, 1);
  assert.equal(archived[0].taskId, a.taskId);
  assert.equal(archived[0].archivedReason, 'migrated_from_0.9.x');
  assert.ok(archived[0].archivedAt);

  const onDisk = loadIndex().tasks.find((t) => t.taskId === a.taskId);
  assert.equal(onDisk.status, 'archived');
  const meta = JSON.parse(fs.readFileSync(path.join(taskDir(a), 'meta.json'), 'utf8'));
  assert.equal(meta.status, 'archived', '任务目录里的 meta.json 也要跟着改');
  assert.ok(fs.existsSync(path.join(taskDir(a), 'invoices.json')), '发票摘要不许被动');
});

test('存档任务不再被认领：同一个材料目录下次是新建任务，从头走一遍', async () => {
  const { archiveMigratedTasks, findLiveTaskForSource, sourceKeyOf } =
    await import('../src/workspace.mjs');
  const dir = path.join(home, 'src-claim');
  const a = createTask(dir, TEST_BINDING);
  archiveMigratedTasks();

  assert.equal(findLiveTaskForSource(sourceKeyOf(dir)), null,
    '认领得到就等于接着往下走，那正是存档要挡的');
  const b = createTask(dir, TEST_BINDING);
  assert.notEqual(b.taskId, a.taskId);
});

test('存档任务照样占着发票 —— 不再往下走，不等于那些票没人报', async () => {
  const { archiveMigratedTasks } = await import('../src/workspace.mjs');
  const a = newTask('holder');
  recordInvoiceSightings(a, classificationOf([['m1', RIDE]]));
  archiveMigratedTasks();

  const b = newTask('newcomer');
  const r = crossTaskDuplicates(b, classificationOf([['m2', RIDE]]));
  assert.equal(r.hits.length, 1, '同一张票在存档任务里躺着，照样要拦');
  assert.equal(r.hits[0].otherTask.status, 'archived');
  assert.match(r.hits[0].why, /0\.9\.x 留下的/);
  assert.match(r.hits[0].why, /作废/, '得告诉用户怎么解开，不能只说被占了');
  assert.equal(blockingOf(r).length, 1, '存档任务上的重复照样是硬阻塞');
});

test('存档任务可以作废 —— 否则 0.9.x 留下的票永远解不开占用', async () => {
  const { archiveMigratedTasks } = await import('../src/workspace.mjs');
  const a = newTask('release');
  recordInvoiceSightings(a, classificationOf([['m1', RIDE]]));
  archiveMigratedTasks();

  const r = abandonTask(a.taskId, '这批票不报了');
  assert.equal(r.verdict, 'abandoned');

  const b = newTask('after');
  assert.equal(blockingOf(crossTaskDuplicates(b, classificationOf([['m2', RIDE]]))).length, 0,
    '作废之后占用要真的解开');
});

test('动过 ERP 的任务不存档 —— 那条路要留给写入善后', async () => {
  const { archiveMigratedTasks } = await import('../src/workspace.mjs');
  const a = newTask('erp');
  recordErpWrite(a, 'erp-fill');

  assert.equal(archiveMigratedTasks().length, 0);
  assert.equal(loadIndex().tasks.find((t) => t.taskId === a.taskId).status, 'open',
    '标了它就走不到 handed_off_recover，等于把善后堵死');
});

test('作废过的任务不受存档影响，存档也不重复打标', async () => {
  const { archiveMigratedTasks } = await import('../src/workspace.mjs');
  const a = newTask('gone');
  abandonTask(a.taskId, '早就不报了');
  const b = newTask('live');

  assert.deepEqual(archiveMigratedTasks().map((t) => t.taskId), [b.taskId]);
  assert.equal(loadIndex().tasks.find((t) => t.taskId === a.taskId).status, 'abandoned');
  assert.equal(archiveMigratedTasks().length, 0, '再调一次没有可标的了');
});
