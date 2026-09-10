import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const kernel = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const kernels = [kernel];
// Installed copies can be ahead of the repository; exercise them when present.
for (const name of ['baox', 'baox-setup', 'baox-recover']) {
  const installed = path.join(kernel, '..', '.claude', 'skills', name, 'kernel');
  if (fs.existsSync(installed)) kernels.push(installed);
}

for (const entry of kernels) {
  test(`reset clears state immediately and remains repeatable: ${path.relative(kernel, entry) || 'source'}`, (t) => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-reset-cli-'));
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    const home = path.join(fixture, 'baox');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, 'identity.json'), '{}');
    fs.writeFileSync(path.join(home, 'steps.json'), 'broken state must not block reset');
    const material = path.join(fixture, 'invoice.pdf');
    fs.writeFileSync(material, 'original');
    const env = { ...process.env, BAOX_HOME: home, AI_AGENT: '1',
      BAOX_EGO_TASK_SPACE: '', BAOX_CDP_PORT: '1' };
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = spawnSync(process.execPath, [path.join(entry, 'bin', 'baox.mjs'), 'reset'],
        { env, encoding: 'utf8', timeout: 25000 });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.ok(['reset', 'already_reset'].includes(JSON.parse(result.stdout).status));
      assert.deepEqual(fs.readdirSync(home), []);
      assert.equal(result.stderr, '', 'no confirmation page');
      assert.equal(fs.readFileSync(material, 'utf8'), 'original');
    }
  });

  test(`reset closes only the assigned browser space: ${path.relative(kernel, entry) || 'source'}`, (t) => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-reset-browser-'));
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    const home = path.join(fixture, 'baox');
    fs.mkdirSync(home);
    const browserState = path.join(fixture, 'browser.json');
    const fakeBrowser = path.join(fixture, 'ego.mjs');
    fs.writeFileSync(browserState, JSON.stringify([{ id: 7, name: 'baox' }, { id: 8, name: 'personal' }]));
    fs.writeFileSync(fakeBrowser, `#!/usr/bin/env node
import fs from 'node:fs';
let script = '';
for await (const chunk of process.stdin) script += chunk;
const file = process.env.TEST_BROWSER_STATE;
const listTaskSpaces = async () => JSON.parse(fs.readFileSync(file, 'utf8'));
const completeTaskSpace = async (id, { keep }) => {
  if (keep !== false || process.env.TEST_CLOSE_FAIL === '1') return { done: false };
  const remaining = (await listTaskSpaces()).filter((s) => s.id !== id);
  setTimeout(() => fs.writeFileSync(file, JSON.stringify(remaining)), 150);
  return { done: true };
};
await new (Object.getPrototypeOf(async () => {}).constructor)(
  'listTaskSpaces', 'completeTaskSpace', 'cliLog', script)(listTaskSpaces, completeTaskSpace, console.log);
`, { mode: 0o700 });
    const env = { ...process.env, BAOX_HOME: home, AI_AGENT: '1', BAOX_CDP_PORT: '1',
      BAOX_EGO_TASK_SPACE: '7', BAOX_EGO_BROWSER: fakeBrowser, TEST_BROWSER_STATE: browserState };
    fs.writeFileSync(path.join(home, 'identity.json'), '{}');
    const run = (extra = {}) => spawnSync(process.execPath, [path.join(entry, 'bin', 'baox.mjs'), 'reset'],
      { env: { ...env, ...extra }, encoding: 'utf8', timeout: 25000 });
    const failed = run({ TEST_CLOSE_FAIL: '1' });
    assert.equal(failed.status, 2, failed.stdout + failed.stderr);
    assert.equal(JSON.parse(failed.stdout).status, 'browser_close_failed');
    assert.ok(fs.existsSync(path.join(home, 'identity.json')));
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = run();
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual(fs.readdirSync(home), []);
      assert.deepEqual(JSON.parse(fs.readFileSync(browserState, 'utf8')), [{ id: 8, name: 'personal' }]);
    }
  });
}
