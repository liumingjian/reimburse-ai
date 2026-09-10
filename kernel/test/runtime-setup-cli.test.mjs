import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BIN = path.join(ROOT, 'bin', 'baox.mjs');
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'baox-runtime-setup-cli-'));

function runBaox(args, env) {
  try {
    return { code: 0, json: JSON.parse(execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8', env,
    })) };
  } catch (error) {
    return { code: error.status, json: JSON.parse(error.stdout) };
  }
}

function fixtureEnvironment() {
  const home = tempDir();
  const materials = tempDir();
  const uv = path.join(home, 'fake-uv');
  const installer = path.join(home, 'fake-ocr-installer.mjs');
  const requirements = path.join(home, 'requirements-rapid.txt');
  fs.writeFileSync(path.join(materials, 'placeholder.txt'), 'kept outside parsing until runtime setup completes\n');
  fs.writeFileSync(uv, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then exit 0; fi',
    'if [ "$1" = "sync" ]; then mkdir -p "$UV_PROJECT_ENVIRONMENT/bin"; : > "$UV_PROJECT_ENVIRONMENT/bin/python"; fi',
    'exit 0',
  ].join('\n'), { mode: 0o700 });
  fs.writeFileSync(installer, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const dir = path.join(process.env.BAOX_HOME, 'ocr-runtime', 'v1', 'bin');",
    "fs.mkdirSync(dir, { recursive: true });",
    "fs.writeFileSync(path.join(dir, 'python'), '');",
  ].join('\n'));
  fs.writeFileSync(requirements, 'rapidocr==3.9.2\nonnxruntime==1.23.2\n');
  const env = {
    ...process.env,
    BAOX_HOME: home,
    BAOX_BROWSER: 'system',
    BAOX_NO_AUTO_OPEN: '1',
    BAOX_UV: uv,
    BAOX_OCR_INSTALLER: installer,
    BAOX_OCR_REQUIREMENTS: requirements,
  };
  delete env.BAOX_EGO_TASK_SPACE;
  delete env.BAOX_EGO_BROWSER;
  delete env.BAOX_CDP_PORT;
  return { env, home, materials };
}

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

test('next runtime setup argv, output path, token, and retry form one advancing loop', () => {
  const { env, home, materials } = fixtureEnvironment();
  const first = runBaox(['next', '--dir', materials], env);
  assert.equal(first.code, 0);
  assert.equal(first.json.state, 'env_runtime_missing');
  assert.equal(first.json.step.kind, 'run');
  assert.equal(first.json.step.argv[2], 'runtime-setup');
  assert.equal(first.json.step.out, path.join(home, 'runtime-dependencies.json'));
  assert.equal(first.json.step.env.BAOX_HOME, home);

  const stdout = execFileSync(first.json.step.argv[0], first.json.step.argv.slice(1), {
    encoding: 'utf8', env: { ...env, ...first.json.step.env },
  });
  fs.writeFileSync(first.json.step.out, stdout);
  const setup = JSON.parse(stdout);
  assert.equal(setup.command, 'runtime-setup');
  assert.equal(setup.status, 'installed');

  const next = runBaox(['next', '--after', first.json.stepToken, '--result', first.json.step.out], env);
  assert.notEqual(next.json.state, 'env_runtime_missing');
  assert.equal(next.json.ignored, undefined);
});

test('explicit ego transport still enters runtime setup before browser configuration', () => {
  const { env, materials } = fixtureEnvironment();
  const first = runBaox(['next', '--dir', materials], {
    ...env,
    BAOX_BROWSER: 'ego',
  });
  assert.equal(first.code, 0);
  assert.equal(first.json.state, 'env_runtime_missing');
  assert.equal(first.json.step.argv[2], 'runtime-setup');
  assert.doesNotMatch(first.json.speak, /BAOX_EGO_TASK_SPACE/);
});

test('automatic identity binding after setup resumes the material stage', () => {
  const { env, home, materials } = fixtureEnvironment();
  const ego = fakeEgoBrowser(home);
  const qaEnv = {
    ...env,
    BAOX_BROWSER: 'ego',
    BAOX_EGO_TASK_SPACE: '1',
    BAOX_EGO_BROWSER: ego,
  };

  const first = runBaox(['next', '--dir', materials], qaEnv);
  assert.equal(first.json.state, 'env_runtime_missing');
  const stdout = execFileSync(first.json.step.argv[0], first.json.step.argv.slice(1), {
    encoding: 'utf8', env: { ...qaEnv, ...first.json.step.env },
  });
  fs.writeFileSync(first.json.step.out, stdout);

  const identity = runBaox(['next', '--after', first.json.stepToken,
    '--result', first.json.step.out], qaEnv);
  assert.equal(identity.json.state, 'home_city_required');
  assert.equal(identity.json.step.kind, 'ask_user');
  assert.equal(identity.json.applied, undefined);
  const adopted = JSON.parse(fs.readFileSync(path.join(home, 'identity.json')));
  assert.equal(adopted.account, 'test.account');
  assert.equal(adopted.tenant, 'test-tenant');

  fs.writeFileSync(identity.json.step.answersPath, JSON.stringify({ homeCity: '北京市' }));
  const materialsStep = runBaox(['next', '--after', identity.json.stepToken,
    '--result', identity.json.step.answersPath], qaEnv);
  assert.equal(materialsStep.json.state, 'task_none');
  assert.equal(materialsStep.json.step.argv[2], 'intake');
});
