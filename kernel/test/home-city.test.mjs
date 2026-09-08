import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const freshHome = () => {
  process.env.BAOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-home-city-'));
};

const me = { displayName: '测试员工', account: 'employee.test', tenant: 'tenant-a' };
const other = { displayName: '另一员工', account: 'employee.other', tenant: 'tenant-a' };

test('迁移只保留有任务身份归属的旧城市，缺失归属和值都进入确认流程', async () => {
  freshHome();
  const { createTask, taskDir, migrateTaskHomeCities, loadIndex } = await import('../src/workspace.mjs');
  const binding = { ...me, homeCity: '当前个人城市' };
  const explicit = createTask(path.join(process.env.BAOX_HOME, 'explicit'), binding);
  const missing = createTask(path.join(process.env.BAOX_HOME, 'missing'), binding);

  const makeLegacy = (task, selection = null) => {
    const indexPath = path.join(process.env.BAOX_HOME, 'tasks', 'index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    index.tasks = index.tasks.map((x) => x.taskId === task.taskId
      ? (({ homeCity, identity, ...legacy }) => legacy)(x) : x);
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
    const metaPath = path.join(taskDir(task), 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    delete meta.homeCity;
    delete meta.identity;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    if (selection) fs.writeFileSync(path.join(taskDir(task), 'selection.json'), JSON.stringify(selection));
  };
  makeLegacy(explicit, { homeCity: '旧任务明确城市', purpose: '测试事由', projects: {} });
  makeLegacy(missing);

  const migrated = migrateTaskHomeCities();
  const byId = Object.fromEntries(loadIndex().tasks.map((task) => [task.taskId, task]));
  assert.deepEqual(migrated, []);
  assert.equal(byId[explicit.taskId].homeCity, undefined, '没有 account+tenant 归属的城市不能迁成快照');
  assert.equal(byId[missing.taskId].homeCity, undefined,
    '旧任务没写过城市时不能套用当前个人绑定');
  assert.deepEqual(migrateTaskHomeCities(), [], '重复迁移不改写已经固定的快照');
});

test('缺城市的旧任务经受控问答固定快照，不改当前个人城市', async () => {
  freshHome();
  const { writeBinding, writeHomeCity, readBinding } = await import('../src/binding.mjs');
  const { createTask, taskDir, setTaskHomeCity, loadIndex } = await import('../src/workspace.mjs');
  writeBinding(me);
  writeHomeCity(me, '当前个人城市');
  const task = createTask(path.join(process.env.BAOX_HOME, 'legacy-source'), readBinding());
  const indexPath = path.join(process.env.BAOX_HOME, 'tasks', 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  index.tasks = index.tasks.map(({ homeCity, ...item }) => item);
  fs.writeFileSync(indexPath, JSON.stringify(index));
  const metaPath = path.join(taskDir(task), 'meta.json');
  const { homeCity, ...legacyMeta } = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  fs.writeFileSync(metaPath, JSON.stringify(legacyMeta));

  const updated = setTaskHomeCity(task.taskId, '旧任务确认城市', me);
  assert.equal(updated.homeCity, '旧任务确认城市');
  assert.equal(loadIndex().tasks.find((x) => x.taskId === task.taskId).homeCity, '旧任务确认城市');
  assert.equal(readBinding().homeCity, '当前个人城市');
});

test('创建任务时固定当前常驻城市快照，改绑只影响之后的新任务', async () => {
  freshHome();
  const { writeBinding, writeHomeCity, readBinding } = await import('../src/binding.mjs');
  const { createTask } = await import('../src/workspace.mjs');
  writeBinding(me);
  writeHomeCity(me, '广州市');

  const oldTask = createTask(path.join(process.env.BAOX_HOME, 'old-source'), readBinding());
  writeHomeCity(me, '北京市');
  const newTask = createTask(path.join(process.env.BAOX_HOME, 'new-source'), readBinding());

  assert.equal(oldTask.homeCity, '广州市');
  assert.equal(newTask.homeCity, '北京市');
});

test('缺少明确城市绑定时不能创建任务，也不能猜默认城市', async () => {
  freshHome();
  const { writeBinding, readBinding } = await import('../src/binding.mjs');
  const { createTask } = await import('../src/workspace.mjs');
  writeBinding(me);

  assert.throws(
    () => createTask(path.join(process.env.BAOX_HOME, 'no-city-source'), readBinding()),
    /常驻城市/,
  );
  assert.throws(
    () => createTask(path.join(process.env.BAOX_HOME, 'bad-city-source'), { ...me, homeCity: '广州\n市' }),
    /常驻城市/,
  );
});

test('城市 validator 在绑定、任务创建和状态机中统一拒绝损坏值', async () => {
  freshHome();
  const { validHomeCity, writeBinding, writeHomeCity, readBinding } = await import('../src/binding.mjs');
  const { createTask } = await import('../src/workspace.mjs');
  const { determineState } = await import('../src/state.mjs');
  writeBinding(me);
  for (const value of [null, '', '暂不确认', '广州\n市', '超过二十个字的城市名称超过二十个字的城市名称']) {
    assert.equal(validHomeCity(value), false);
    assert.equal(writeHomeCity(me, value), null);
    assert.throws(() => createTask(path.join(process.env.BAOX_HOME, `bad-${String(value)}`), { ...me, homeCity: value }));
    const state = determineState({ schemaVersion: 1, nodeMajor: 22, cdpUp: true,
      probe: { status: 'matched', identity: me }, binding: { ...me, homeCity: value } });
    assert.equal(state.state, 'env_home_city_unbound');
  }
  assert.equal(readBinding().homeCity, undefined);
});

test('旧任务补城市时持久化 account+tenant 归属', async () => {
  freshHome();
  const { createTask, taskDir, setTaskHomeCity, loadIndex } = await import('../src/workspace.mjs');
  const task = createTask(path.join(process.env.BAOX_HOME, 'owned-legacy'), { ...me, homeCity: '原城市' });
  const indexPath = path.join(process.env.BAOX_HOME, 'tasks', 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  index.tasks = index.tasks.map(({ homeCity, identity, ...item }) => item);
  fs.writeFileSync(indexPath, JSON.stringify(index));
  const metaPath = path.join(taskDir(task), 'meta.json');
  const { homeCity, identity, ...legacyMeta } = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  fs.writeFileSync(metaPath, JSON.stringify(legacyMeta));

  const updated = setTaskHomeCity(task.taskId, '旧任务城市', me);
  assert.deepEqual(updated.identity, { account: me.account, tenant: me.tenant });
  assert.deepEqual(loadIndex().tasks.find((x) => x.taskId === task.taskId).identity,
    { account: me.account, tenant: me.tenant });
});

test('用户可显式改绑常驻城市，旧任务快照保持不变', async () => {
  freshHome();
  const { writeBinding, writeHomeCity, readBinding } = await import('../src/binding.mjs');
  const { createTask, loadIndex } = await import('../src/workspace.mjs');
  writeBinding(me);
  writeHomeCity(me, '广州市');
  const oldTask = createTask(path.join(process.env.BAOX_HOME, 'old-city-task'), readBinding());
  writeHomeCity(me, '北京市');
  assert.equal(readBinding().homeCity, '北京市');
  assert.equal(loadIndex().tasks.find((x) => x.taskId === oldTask.taskId).homeCity, '广州市');
});

test('改绑到另一个员工或租户时不继承原常驻城市', async () => {
  freshHome();
  const { writeBinding, writeHomeCity, readBinding } = await import('../src/binding.mjs');
  writeBinding(me);
  writeHomeCity(me, '广州市');

  writeBinding(other);
  assert.equal(readBinding().account, other.account);
  assert.equal(readBinding().homeCity, undefined);

  writeBinding({ ...me, tenant: 'tenant-b' });
  assert.equal(readBinding().tenant, 'tenant-b');
  assert.equal(readBinding().homeCity, undefined);
});
