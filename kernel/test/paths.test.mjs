import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir, legacyDataDir, migrateLegacyHome, MIGRATION_MARKER } from '../src/paths.mjs';

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `baox-paths-${tag}-`));

/** 造一个 0.9.x 的数据目录：三个真会用到的子目录，各放一个可核对的文件。 */
function legacyHome() {
  const root = path.join(tmp('legacy'), 'baox');
  for (const d of ['chrome-profile', 'tasks', 'logs']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'tasks', 'index.json'), '{"tasks":[]}');
  fs.writeFileSync(path.join(root, 'chrome-profile', 'Cookies'), 'session');
  fs.writeFileSync(path.join(root, 'logs', 'chrome.log'), 'hello');
  return root;
}

test('BAOX_HOME 没设时数据目录是 ~/.baox，设了就全落在它指的地方', () => {
  const saved = process.env.BAOX_HOME;
  try {
    delete process.env.BAOX_HOME;
    assert.equal(dataDir(), path.join(os.homedir(), '.baox'));
    process.env.BAOX_HOME = '/tmp/x';
    assert.equal(dataDir(), '/tmp/x');
  } finally {
    if (saved === undefined) delete process.env.BAOX_HOME; else process.env.BAOX_HOME = saved;
  }
});

test('旧目录整份搬过去，内容一字不差', () => {
  const legacy = legacyHome();
  const target = path.join(tmp('target'), '.baox');
  const r = migrateLegacyHome(target, legacy);

  assert.equal(r.from, legacy);
  assert.equal(r.to, target);
  assert.equal(fs.readFileSync(path.join(target, 'tasks', 'index.json'), 'utf8'), '{"tasks":[]}');
  assert.equal(fs.readFileSync(path.join(target, 'chrome-profile', 'Cookies'), 'utf8'), 'session');
  assert.equal(fs.readFileSync(path.join(target, 'logs', 'chrome.log'), 'utf8'), 'hello');
});

test('是拷不是搬：旧目录原样留着，用户回滚 0.9.x 还能用', () => {
  const legacy = legacyHome();
  const target = path.join(tmp('target'), '.baox');
  migrateLegacyHome(target, legacy);

  assert.equal(fs.readFileSync(path.join(legacy, 'tasks', 'index.json'), 'utf8'), '{"tasks":[]}');
  assert.equal(fs.readFileSync(path.join(legacy, 'chrome-profile', 'Cookies'), 'utf8'), 'session');
  assert.ok(fs.existsSync(path.join(legacy, 'logs', 'chrome.log')));
});

test('迁移只发生一次：新目录已在就不再动它，旧目录后来的改动不会覆盖回来', () => {
  const legacy = legacyHome();
  const target = path.join(tmp('target'), '.baox');
  migrateLegacyHome(target, legacy);

  fs.writeFileSync(path.join(target, 'tasks', 'index.json'), '{"tasks":["new"]}');
  fs.writeFileSync(path.join(legacy, 'tasks', 'index.json'), '{"tasks":["old"]}');

  assert.equal(migrateLegacyHome(target, legacy), null, '第二次调用不该再迁');
  assert.equal(fs.readFileSync(path.join(target, 'tasks', 'index.json'), 'utf8'), '{"tasks":["new"]}');
});

test('迁移完在新目录留一张字条，说清是从哪搬来的', () => {
  const legacy = legacyHome();
  const target = path.join(tmp('target'), '.baox');
  migrateLegacyHome(target, legacy);

  const marker = fs.readFileSync(path.join(target, MIGRATION_MARKER), 'utf8');
  assert.ok(marker.includes(legacy), `字条里要有旧目录的绝对路径：${marker}`);
});

test('没有旧目录就什么也不做，不留下半个空数据目录', () => {
  const legacy = path.join(tmp('legacy'), 'nope');
  const target = path.join(tmp('target'), '.baox');

  assert.equal(migrateLegacyHome(target, legacy), null);
  assert.equal(fs.existsSync(target), false);
});

test('旧目录里的 runtime/ 不搬 —— 1.0.0 没有已安装内核这回事', () => {
  const legacy = legacyHome();
  fs.mkdirSync(path.join(legacy, 'runtime', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'runtime', 'VERSION'), '0.9.3\n');
  const target = path.join(tmp('target'), '.baox');
  migrateLegacyHome(target, legacy);

  assert.equal(fs.existsSync(path.join(target, 'runtime')), false);
  assert.ok(fs.existsSync(path.join(target, 'tasks')), '其余的照搬');
});

test('半途中断留下的搬运暂存目录会被丢掉重来，不会被当成搬完了', () => {
  const legacy = legacyHome();
  const target = path.join(tmp('target'), '.baox');
  fs.mkdirSync(`${target}.migrating`, { recursive: true });
  fs.writeFileSync(path.join(`${target}.migrating`, 'garbage'), 'x');

  migrateLegacyHome(target, legacy);

  assert.equal(fs.existsSync(path.join(target, 'garbage')), false);
  assert.equal(fs.existsSync(`${target}.migrating`), false);
  assert.ok(fs.existsSync(path.join(target, 'tasks', 'index.json')));
});

test('旧目录的位置按平台算，且绝不等于新的 ~/.baox', () => {
  assert.notEqual(legacyDataDir(), path.join(os.homedir(), '.baox'));
  if (process.platform === 'darwin') {
    assert.equal(legacyDataDir(), path.join(os.homedir(), 'Library', 'Application Support', 'baox'));
  }
});
