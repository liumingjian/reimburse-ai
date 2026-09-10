import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetHome, validateResetHome } from '../src/reset.mjs';
import { migrateLegacyHome } from '../src/paths.mjs';

const closed = async () => ({ ok: true });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-reset-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(root, file, contents = 'private state') {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

test('reset clears every task including ERP attempts, bindings, logs and migration copies, preserving installed dependencies', async (t) => {
  const root = fixture(t);
  const home = path.join(root, '.baox');
  const legacy = path.join(root, 'legacy');
  for (const dir of [home, legacy, `${home}.migrating`, `${legacy}.migrating`]) {
    for (const file of ['tasks/index.json', 'tasks/1/erp-attempts.json', 'identity.json',
      'steps.json', 'projects.json', 'schema.json', 'logs/private.log',
      'chrome-profile/Cookies', 'run/state', '.hidden', 'runtime-dependencies.json']) write(dir, file);
  }
  for (const dir of [home, legacy]) {
    for (const runtime of ['ocr-runtime', 'runtimes', 'runtime']) write(dir, `${runtime}/python`, 'installed');
  }
  const source = path.join(root, 'original');
  write(source, 'invoice.pdf', 'original');
  fs.symlinkSync(source, path.join(home, 'linked-materials'));
  let closes = 0;
  const result = await resetHome(home, { legacy, closeBrowser: async (homes) => {
    closes++;
    assert.deepEqual(homes, [home, legacy]);
    assert.ok(fs.existsSync(path.join(home, 'identity.json')), 'close before clearing state');
    return { ok: true };
  } });
  assert.equal(result.status, 'reset');
  assert.equal(closes, 1);
  for (const dir of [home, legacy]) {
    assert.deepEqual(fs.readdirSync(dir).sort(), ['ocr-runtime', 'runtime', 'runtimes']);
    assert.equal(fs.readFileSync(path.join(dir, 'ocr-runtime/python'), 'utf8'), 'installed');
    assert.equal(fs.existsSync(`${dir}.migrating`), false);
  }
  assert.equal(fs.readFileSync(path.join(source, 'invoice.pdf'), 'utf8'), 'original');
  assert.equal(migrateLegacyHome(home, legacy), null);
  assert.equal((await resetHome(home, { legacy, closeBrowser: closed })).status, 'reset');
});

test('missing or empty current home still clears legacy state and prevents migration', async (t) => {
  const root = fixture(t);
  const home = path.join(root, '.baox');
  const legacy = path.join(root, 'legacy');
  write(legacy, 'identity.json');
  const result = await resetHome(home, { legacy, closeBrowser: closed });
  assert.equal(result.status, 'reset');
  assert.deepEqual(fs.readdirSync(home), []);
  assert.deepEqual(fs.readdirSync(legacy), []);
  assert.equal(migrateLegacyHome(home, legacy), null);
});

test('browser cleanup failure or exception cannot report success or erase state', async (t) => {
  const home = path.join(fixture(t), 'baox');
  write(home, 'identity.json');
  for (const closeBrowser of [async () => ({ ok: false }), async () => { throw new Error('offline'); }]) {
    const result = await resetHome(home, { legacy: null, closeBrowser });
    assert.equal(result.status, 'browser_close_failed');
    assert.equal(fs.readFileSync(path.join(home, 'identity.json'), 'utf8'), 'private state');
  }
});

test('invalid homes and symlink roots are rejected before browser or file changes', async (t) => {
  const root = fixture(t);
  const link = path.join(root, 'link');
  const file = path.join(root, 'file');
  write(root, 'file');
  fs.symlinkSync(root, link);
  for (const home of [path.parse(root).root, os.homedir(), '.', file, link]) {
    assert.equal(validateResetHome(home).ok, false);
    const result = await resetHome(home, { legacy: null, closeBrowser: async () => {
      assert.fail('must not close browser for invalid home');
    } });
    assert.equal(result.status, 'invalid_home');
  }
  assert.equal(fs.readFileSync(file, 'utf8'), 'private state');
});

test('partial filesystem failure reports remaining state and allows a retry', async (t) => {
  const home = path.join(fixture(t), 'baox');
  write(home, 'identity.json');
  const remove = fs.rmSync;
  const stub = t.mock.method(fs, 'rmSync', (target, options) => {
    if (target === path.join(home, 'identity.json')) throw new Error('permission denied');
    return remove(target, options);
  });
  const result = await resetHome(home, { legacy: null, closeBrowser: closed });
  assert.equal(result.status, 'reset_failed');
  assert.ok(result.remaining.length > 0);
  stub.mock.restore();
  assert.equal((await resetHome(home, { legacy: null, closeBrowser: closed })).status, 'reset');
  assert.deepEqual(fs.readdirSync(home), []);
});
