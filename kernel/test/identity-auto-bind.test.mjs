import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { seedReadyRuntimes } from './runtime-fixture.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BIN = path.join(ROOT, 'bin', 'baox.mjs');
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'baox-identity-auto-bind-'));
const currentIdentity = {
  displayName: '测试用户', account: 'test.account', tenant: 'test-tenant',
};

function fakeEgoBrowser(home) {
  const command = path.join(home, 'fake-ego.mjs');
  fs.writeFileSync(command, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const listing = input.includes('return (await listTabs()).map');
  const value = listing
    ? [{ targetId: 'fixture-tab', id: 'fixture-tab',
        url: 'http://erp.antute.com.cn/k3cloud/html5/index.aspx', title: 'ERP' }]
    : { ready: 'complete', title: 'ERP', displayName: '测试用户', account: 'test.account',
        tenant: 'test-tenant', onMainConsole: true, loginFormVisible: false };
  process.stdout.write('__BAOX_EGO_RESULT__' + JSON.stringify({ ok: true, value }) + '\\n');
});
`, { mode: 0o700 });
  return command;
}

function fakeLocationCurl(home, payload) {
  const command = path.join(home, 'fake-location-curl.mjs');
  fs.writeFileSync(command, `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(JSON.stringify(payload))});
`, { mode: 0o700 });
  return command;
}

function fixture({ binding = null, location = null } = {}) {
  const home = tempDir();
  const materials = tempDir();
  fs.writeFileSync(path.join(materials, 'placeholder.txt'), 'fixture material\n');
  const env = {
    ...process.env,
    ...seedReadyRuntimes(home),
    BAOX_BROWSER: 'ego',
    BAOX_EGO_TASK_SPACE: '1',
    BAOX_EGO_BROWSER: fakeEgoBrowser(home),
    BAOX_NO_AUTO_OPEN: '1',
    BAOX_LOCATION_MODE: location ? 'auto' : 'off',
  };
  if (location) env.BAOX_LOCATION_CURL = fakeLocationCurl(home, location);
  if (binding) fs.writeFileSync(path.join(home, 'identity.json'), JSON.stringify(binding));
  return { env, home, materials };
}

function runBaox(args, env) {
  try {
    return { code: 0, json: JSON.parse(execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8', env,
    })) };
  } catch (error) {
    return { code: error.status, json: JSON.parse(error.stdout) };
  }
}

test('首次已登录身份自动绑定并继续材料阶段', () => {
  const { env, home, materials } = fixture();
  const first = runBaox(['next', '--dir', materials, '--home-city-suggestion', '北京市'], env);

  assert.equal(first.json.state, 'home_city_required');
  assert.equal(first.json.step.kind, 'ask_user');
  assert.match(first.json.speak, /北京市/);
  assert.notEqual(first.json.step.kind, 'confirm_table');
  const adopted = JSON.parse(fs.readFileSync(path.join(home, 'identity.json')));
  assert.equal(adopted.account, currentIdentity.account);
  assert.equal(adopted.tenant, currentIdentity.tenant);
  assert.equal(adopted.displayName, currentIdentity.displayName);
  assert.ok(adopted.confirmedAt);

  fs.writeFileSync(first.json.step.answersPath, JSON.stringify({ homeCity: '确认' }));
  const materialsStep = runBaox(['next', '--after', first.json.stepToken,
    '--result', first.json.step.answersPath], env);
  assert.equal(materialsStep.json.state, 'task_none');
  assert.equal(materialsStep.json.step.argv[2], 'intake');
});

test('首次没有城市时先获取网络位置，再展示城市确认', () => {
  const { env, home, materials } = fixture({
    location: { city: '北京市', latitude: 39.9042, longitude: 116.4074 },
  });
  const first = runBaox(['next', '--dir', materials], env);

  assert.equal(first.json.state, 'home_city_required');
  assert.equal(first.json.step.suggestedHomeCity, '北京市');
  assert.equal(first.json.step.suggestedHomeCitySource, 'ip');
  assert.match(first.json.speak, /网络位置推测/);
  assert.match(first.json.step.prompt, /北京市/);

  fs.writeFileSync(first.json.step.answersPath, JSON.stringify({ homeCity: '确认' }));
  const next = runBaox(['next', '--after', first.json.stepToken,
    '--result', first.json.step.answersPath], env);
  assert.equal(next.json.state, 'task_none');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'home-cities.json')))[
    JSON.stringify([currentIdentity.tenant, currentIdentity.account])].homeCity, '北京市');
});

test('网络位置不可用时回退为手动填写城市', () => {
  const { env, materials } = fixture({
    location: { city: 'unknown', latitude: 0, longitude: 0 },
  });
  const first = runBaox(['next', '--dir', materials], env);

  assert.equal(first.json.state, 'home_city_required');
  assert.equal(first.json.step.suggestedHomeCity, undefined);
  assert.match(first.json.speak, /直接输入你的常驻城市/);
  assert.doesNotMatch(first.json.speak, /网络位置推测/);
});

test('已有 binding 与当前登录身份不一致时仍硬阻断且不改 binding', () => {
  const previous = {
    displayName: '原用户', account: 'previous.account', tenant: 'previous-tenant',
    confirmedAt: '2026-09-01T00:00:00.000Z',
  };
  const { env, home, materials } = fixture({ binding: previous });
  const result = runBaox(['next', '--dir', materials], env);

  assert.equal(result.code, 2);
  assert.equal(result.json.state, 'env_identity_mismatched');
  assert.equal(result.json.step.kind, 'tell_user');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'identity.json'))), previous);
});

test('再次报销先确认报销人和常驻城市，直接输入城市会覆盖默认值', () => {
  const { env, home, materials } = fixture({ binding: currentIdentity });
  const key = JSON.stringify([currentIdentity.tenant, currentIdentity.account]);
  fs.writeFileSync(path.join(home, 'home-cities.json'), JSON.stringify({
    [key]: { homeCity: '北京市', confirmedAt: '2026-09-10T00:00:00.000Z' },
  }));

  const first = runBaox(['next', '--dir', materials], env);
  assert.equal(first.json.state, 'task_none');
  const intakeOutput = (() => {
    try {
      return execFileSync(first.json.step.argv[0], first.json.step.argv.slice(1), {
        encoding: 'utf8', env,
      });
    } catch (error) {
      if (error.status === 2) return error.stdout;
      throw error;
    }
  })();
  const intakeResult = path.join(home, 'intake-result.json');
  fs.writeFileSync(intakeResult, intakeOutput);
  const afterIntake = runBaox(['next', '--after', first.json.stepToken,
    '--result', intakeResult], env);
  assert.notEqual(afterIntake.json.state, 'task_none');

  const secondMaterials = tempDir();
  fs.writeFileSync(path.join(secondMaterials, 'placeholder.txt'), 'second fixture\n');
  const profile = runBaox(['next', '--dir', secondMaterials], env);
  assert.equal(profile.json.state, 'profile_confirmation');
  assert.match(profile.json.step.prompt, /报销人/);
  assert.match(profile.json.step.prompt, /北京市/);

  fs.writeFileSync(profile.json.step.answersPath, JSON.stringify({ homeCity: '广州市' }));
  const next = runBaox(['next', '--after', profile.json.stepToken,
    '--result', profile.json.step.answersPath], env);
  assert.equal(next.json.state, 'task_none');
  const remembered = JSON.parse(fs.readFileSync(path.join(home, 'home-cities.json')))[key];
  assert.equal(remembered.homeCity, '广州市');
});
