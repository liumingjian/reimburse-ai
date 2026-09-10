import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-preparation-confirm-'));
const modeFile = path.join(home, 'probe-mode');
const fakeEgo = path.join(home, 'fake-ego.mjs');
fs.writeFileSync(fakeEgo, `#!/usr/bin/env node
import fs from 'node:fs';
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const mode = fs.readFileSync(${JSON.stringify(modeFile)}, 'utf8').trim();
  const listing = input.includes('return (await listTabs()).map');
  const value = listing
    ? [{ targetId: 'fake-tab', id: 'fake-tab', url: 'http://erp.antute.com.cn/k3cloud/html5/index.aspx', title: 'ERP' }]
    : mode === 'login'
      ? { ready: 'complete', title: 'ERP', displayName: null, account: 'alice', tenant: 'tenant-a',
        onMainConsole: false, loginFormVisible: true }
      : { ready: 'complete', title: 'ERP', displayName: '另一个人', account: 'bob', tenant: 'tenant-a',
        onMainConsole: true, loginFormVisible: false };
  process.stdout.write('__BAOX_EGO_RESULT__' + JSON.stringify({ ok: true, value }) + '\\n');
});
`);
fs.chmodSync(fakeEgo, 0o700);
fs.writeFileSync(modeFile, 'other\n');
process.env.BAOX_HOME = home;
process.env.BAOX_EGO_TASK_SPACE = '1';
process.env.BAOX_EGO_BROWSER = fakeEgo;
process.env.BAOX_BROWSER = 'ego';

const { applyTerminalVerdict } = await import('../src/confirm.mjs');
const { writeBinding } = await import('../src/binding.mjs');
const { createTask, sourceKeyOf, taskDir } = await import('../src/workspace.mjs');
const { issueStep } = await import('../src/steptoken.mjs');

const identity = { account: 'alice', tenant: 'tenant-a', displayName: '本人' };
const sourceDir = path.join(home, 'materials');
fs.mkdirSync(sourceDir);

test('旧 ERP 写入确认凭据只回传过期，不生成写入授权', async () => {
  const sourceKey = 'legacy-source';
  const step = issueStep(sourceKey, 'ready_for_erp_write', sourceDir, { previewDigest: 'legacy' });
  const result = await applyTerminalVerdict({ sourceDir, sourceKey, after: step.token });
  assert.equal(result.verdict, 'ignored');
  assert.equal(result.status, 'legacy_write_approval_expired');
  assert.equal(fs.existsSync(path.join(home, 'write-approval.json')), false);
});

test('未登录或切换账号时，准备确认不落盘', async () => {
  writeBinding(identity);
  const task = createTask(sourceDir);
  const sourceKey = sourceKeyOf(sourceDir);
  const step = issueStep(sourceKey, 'preparation_confirmation', sourceDir, {
    preparationDigest: 'a'.repeat(64),
    taskId: task.taskId,
    account: identity.account,
    tenant: identity.tenant,
    packageManifestHash: 'manifest',
    packageBundleHash: 'bundle',
  });

  fs.writeFileSync(modeFile, 'other\n');
  assert.equal(await applyTerminalVerdict({ sourceDir, sourceKey, after: step.token }), null);
  assert.equal(fs.existsSync(path.join(taskDir(task), 'preparation-confirmation.json')), false);

  fs.writeFileSync(modeFile, 'login\n');
  assert.equal(await applyTerminalVerdict({ sourceDir, sourceKey, after: step.token }), null);
  assert.equal(fs.existsSync(path.join(taskDir(task), 'preparation-confirmation.json')), false);
});
