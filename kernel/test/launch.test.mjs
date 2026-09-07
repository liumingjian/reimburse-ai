import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

// 这组用例测的是分发时最容易出的那个错：Skill 更新了、数据目录里的内核没更新。
// 所以它必须真的起进程跑 launch.mjs —— 版本闸的全部意义就在于跨进程那一跳。

const repoKernel = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));

/** 造一个「拷到 ~/.claude/skills/ 之后」的 Skill 目录：自带一份内核，版本号自定。 */
function fakeSkill(version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-launch-'));
  const kernel = path.join(root, 'skill', 'kernel');
  fs.mkdirSync(kernel, { recursive: true });
  fs.cpSync(path.join(repoKernel, 'bin'), path.join(kernel, 'bin'), { recursive: true });
  fs.cpSync(path.join(repoKernel, 'src'), path.join(kernel, 'src'), { recursive: true });
  fs.writeFileSync(path.join(kernel, 'VERSION'), `${version}\n`);
  const home = path.join(root, 'home');           // BAOX_HOME：这次用例自己的数据目录
  fs.mkdirSync(home, { recursive: true });
  return { root, kernel, home };
}

function launch(skill, args) {
  const r = spawnSync(process.execPath, [path.join(skill.kernel, 'bin', 'launch.mjs'), ...args], {
    env: { ...process.env, BAOX_HOME: skill.home }, encoding: 'utf8',
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* 有些命令的输出不是给这组用例看的 */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

test('还没安装内核时，除 doctor / install-runtime 之外一律硬阻塞', () => {
  const skill = fakeSkill('9.9.9-test');
  const r = launch(skill, ['tasks']);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.equal(r.json.status, 'runtime_not_installed');
});

test('doctor 不需要已安装的内核，并且报出自己的版本号', () => {
  const skill = fakeSkill('9.9.9-test');
  const r = launch(skill, ['doctor']);
  // 有没有 Chrome 决定 doctor 是 0 还是 1，这里不关心；只要不是硬阻塞就说明放行了。
  assert.notEqual(r.code, 2, r.stdout + r.stderr);
  assert.equal(r.json.command, 'doctor');
  assert.equal(r.json.version, '9.9.9-test', '试用者报回来的问题要能钉到具体哪一版');
  assert.equal(r.json.runtime.installed, null);
  assert.equal(r.json.runtime.matchesSkill, false);
});

test('装过之后命令正常转交，且 doctor 认得出版本一致', () => {
  const skill = fakeSkill('9.9.9-test');
  assert.equal(launch(skill, ['install-runtime']).code, 0);

  const tasks = launch(skill, ['tasks']);
  assert.equal(tasks.code, 0, tasks.stdout + tasks.stderr);
  assert.equal(tasks.json.command, 'tasks');

  const doctor = launch(skill, ['doctor']);
  assert.equal(doctor.json.runtime.installed, '9.9.9-test');
  assert.equal(doctor.json.runtime.matchesSkill, true);
});

test('Skill 更新了而内核没重装：硬阻塞，且两个版本号都说出来', () => {
  const skill = fakeSkill('9.9.9-test');
  assert.equal(launch(skill, ['install-runtime']).code, 0);
  // 模拟「拷了新的 Skill 目录，但没重跑 install-runtime」
  fs.writeFileSync(path.join(skill.kernel, 'VERSION'), '9.9.10-test\n');

  const r = launch(skill, ['tasks']);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.equal(r.json.status, 'version_drift');
  assert.equal(r.json.skillVersion, '9.9.10-test');
  assert.equal(r.json.installedVersion, '9.9.9-test');
});

test('漂移状态下 install-runtime 仍然放行，否则用户没有出路', () => {
  const skill = fakeSkill('9.9.9-test');
  assert.equal(launch(skill, ['install-runtime']).code, 0);
  fs.writeFileSync(path.join(skill.kernel, 'VERSION'), '9.9.10-test\n');

  const fix = launch(skill, ['install-runtime']);
  assert.equal(fix.code, 0, fix.stdout + fix.stderr);
  assert.equal(fix.json.replaced, '9.9.9-test');
  assert.equal(fix.json.version, '9.9.10-test');
  assert.equal(launch(skill, ['tasks']).code, 0, '重装之后闸应该放行');
});
