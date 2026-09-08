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
const outstanding = { meta: { account: me.account, tenant: me.tenant } };
const probeAs = (identity) => async () => ({ status: 'matched', identity });
const answerFile = (answer) => {
  const p = path.join(process.env.BAOX_HOME, 'answer.json');
  fs.writeFileSync(p, JSON.stringify({ answers: { homeCity: answer } }));
  return p;
};

test('首次城市输入经内核校验后持久化，并归属于当前 ERP 身份', async () => {
  freshHome();
  const { writeBinding, readBinding } = await import('../src/binding.mjs');
  const { receiveHomeCity } = await import('../src/confirm.mjs');
  writeBinding(me);

  const result = await receiveHomeCity(outstanding, answerFile('  广州市  '), { probe: probeAs(me) });

  assert.equal(result.verdict, 'home_city_bound');
  assert.equal(result.binding.homeCity, '广州市');
  assert.equal(readBinding().homeCity, '广州市');
  assert.equal(readBinding().account, me.account);
  assert.equal(readBinding().tenant, me.tenant);
  assert.ok(readBinding().homeCityConfirmedAt);
});

test('城市不是用户给出的合法自由文本时，一个字都不写', async () => {
  for (const answer of ['', '暂不确认', '超过二十个字的城市名称超过二十个字的城市名称', '广州\n市']) {
    freshHome();
    const { writeBinding, readBinding } = await import('../src/binding.mjs');
    const { receiveHomeCity } = await import('../src/confirm.mjs');
    writeBinding(me);
    assert.equal(await receiveHomeCity(outstanding, answerFile(answer), { probe: probeAs(me) }), null);
    assert.equal(readBinding().homeCity, undefined, `不应收下：${JSON.stringify(answer)}`);
  }
});

test('问答期间换了员工或账套，城市不能串绑', async () => {
  freshHome();
  const { writeBinding, readBinding } = await import('../src/binding.mjs');
  const { receiveHomeCity } = await import('../src/confirm.mjs');
  writeBinding(me);

  assert.equal(await receiveHomeCity(outstanding, answerFile('广州市'), { probe: probeAs(other) }), null);
  assert.equal(readBinding().homeCity, undefined);
  assert.equal(await receiveHomeCity(outstanding, answerFile('广州市'), {
    probe: probeAs({ ...me, tenant: 'tenant-b' }),
  }), null);
  assert.equal(readBinding().homeCity, undefined);
});

test('城市答案只由当前挂起的首次访谈 token 收下', async () => {
  freshHome();
  const { writeBinding, readBinding } = await import('../src/binding.mjs');
  const { issueStep } = await import('../src/steptoken.mjs');
  const { applyTerminalVerdict } = await import('../src/confirm.mjs');
  writeBinding(me);
  const sourceKey = 'home-city-source';
  const step = issueStep(sourceKey, 'env_home_city_unbound', null,
    { account: me.account, tenant: me.tenant });

  const ignored = await applyTerminalVerdict({
    sourceKey, after: 'expired-token', resultFile: answerFile('广州市'), probe: probeAs(me),
  });
  assert.equal(ignored, null);
  assert.equal(readBinding().homeCity, undefined);

  const accepted = await applyTerminalVerdict({
    sourceKey, after: step.token, resultFile: answerFile('广州市'), probe: probeAs(me),
  });
  assert.equal(accepted.verdict, 'home_city_bound');
  assert.equal(readBinding().homeCity, '广州市');
});

test('迁移保留旧任务明确记录的城市，缺失时不从个人绑定猜测', async () => {
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
  assert.deepEqual(migrated.map((task) => task.taskId), [explicit.taskId]);
  assert.equal(byId[explicit.taskId].homeCity, '旧任务明确城市');
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

  const updated = setTaskHomeCity(task.taskId, '旧任务确认城市');
  assert.equal(updated.homeCity, '旧任务确认城市');
  assert.equal(loadIndex().tasks.find((x) => x.taskId === task.taskId).homeCity, '旧任务确认城市');
  assert.equal(readBinding().homeCity, '当前个人城市');
});

test('旧任务城市答案只由当前任务和身份对应的 token 收下', async () => {
  freshHome();
  const { writeBinding, writeHomeCity, readBinding } = await import('../src/binding.mjs');
  const { createTask, taskDir, loadIndex } = await import('../src/workspace.mjs');
  const { issueStep } = await import('../src/steptoken.mjs');
  const { applyTerminalVerdict } = await import('../src/confirm.mjs');
  writeBinding(me);
  writeHomeCity(me, '当前个人城市');
  const task = createTask(path.join(process.env.BAOX_HOME, 'legacy-token-source'), readBinding());
  const indexPath = path.join(process.env.BAOX_HOME, 'tasks', 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  index.tasks = index.tasks.map(({ homeCity, ...item }) => item);
  fs.writeFileSync(indexPath, JSON.stringify(index));
  const metaPath = path.join(taskDir(task), 'meta.json');
  const { homeCity, ...legacyMeta } = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  fs.writeFileSync(metaPath, JSON.stringify(legacyMeta));

  const step = issueStep(task.sourceKey, 'task_home_city_unbound', path.join(process.env.BAOX_HOME, 'legacy-token-source'), {
    taskId: task.taskId, account: me.account, tenant: me.tenant, questions: [],
  });
  const accepted = await applyTerminalVerdict({
    sourceKey: task.sourceKey, after: step.token, resultFile: answerFile('旧任务确认城市'), probe: probeAs(me),
  });

  assert.equal(accepted.verdict, 'task_home_city_bound');
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
