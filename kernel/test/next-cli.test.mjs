import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { execFileSync } from 'node:child_process';

// 模型敲的是命令，不是模块。上面那一层测的是判定，这一层测的是**那条命令本身** ——
// 参数怎么解析、退出码是几、输出是不是一份契约里那样的 JSON。
//
// 不用真 Chrome：把 CDP 端口指到一个没人监听的口子上，环境判定就停在
// env_chrome_down，一路都是确定的。这也是这套分层的意义 —— 没有 Chrome 也测得动。
const BIN = path.join(path.dirname(path.dirname(url.fileURLToPath(import.meta.url))), 'bin', 'baox.mjs');

function baox(args, env = {}) {
  const home = env.BAOX_HOME ?? fs.mkdtempSync(path.join(os.tmpdir(), 'baox-cli-'));
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8',
      env: { ...process.env, BAOX_HOME: home, BAOX_CDP_PORT: '9457' },
    });
    return { code: 0, json: JSON.parse(stdout), home };
  } catch (err) {
    return { code: err.status, json: JSON.parse(err.stdout), home };
  }
}

const materials = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-src-'));
  fs.writeFileSync(path.join(dir, 'fp.pdf'), '%PDF-1.4\n');
  return dir;
};

test('baox next --dir：一条命令拿回一个可执行的 step', () => {
  const dir = materials();
  const { code, json } = baox(['next', '--dir', dir]);
  assert.equal(code, 0);
  assert.equal(json.command, 'next');
  assert.equal(json.schemaVersion, 1);
  assert.equal(json.state, 'env_chrome_down');
  assert.equal(json.step.kind, 'run');
  assert.equal(json.actor, 'kernel');
  assert.ok(json.speak, '得有一句能原样念的话');
  assert.equal(json.stepToken.length, 32);
  assert.ok(json.step.argv.at(-1) === 'chrome-up' && json.step.argv[1].endsWith('baox.mjs'),
    'argv 是一条完整命令行，模型原样执行');
});

test('连着问三次，同一个状态、同一个凭据', () => {
  const dir = materials();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-cli-'));
  const a = baox(['next', '--dir', dir], { BAOX_HOME: home });
  const b = baox(['next', '--dir', dir], { BAOX_HOME: home });
  const c = baox(['next', '--dir', dir], { BAOX_HOME: home });
  assert.equal(b.json.state, a.json.state);
  assert.equal(c.json.state, a.json.state);
  assert.equal(b.json.stepToken, a.json.stepToken);
  assert.equal(c.json.stepToken, a.json.stepToken);
});

test('只带 --after 也答得上来：内核自己记得上次问的是哪个目录', () => {
  const dir = materials();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-cli-'));
  const first = baox(['next', '--dir', dir], { BAOX_HOME: home });
  const back = baox(['next', '--after', first.json.stepToken], { BAOX_HOME: home });
  assert.equal(back.code, 0);
  assert.equal(back.json.state, first.json.state);
  assert.equal(back.json.ignored.reason, 'no_result', '这一步是 run，没交输出就不算做过');
});

test('只带 --after 时，内核记得的是那个目录本身，不只是它的指纹', () => {
  const dir = materials();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-cli-'));
  baox(['next', '--dir', dir], { BAOX_HOME: home });
  const store = JSON.parse(fs.readFileSync(path.join(home, 'steps.json'), 'utf8'));
  assert.equal(store.steps[store.current].sourceDir, dir,
    '材料这一段每一步都要重新盘那个目录，而 sourceKey 是单向哈希，还原不回路径');
});

test('过期凭据被忽略，当前步骤原样重发，不报错', () => {
  const dir = materials();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-cli-'));
  const first = baox(['next', '--dir', dir], { BAOX_HOME: home });
  const stale = baox(['next', '--after', 'f'.repeat(32), '--dir', dir], { BAOX_HOME: home });
  assert.equal(stale.code, 0, '不可跳步是机制，不是错误');
  assert.equal(stale.json.ignored.reason, 'stale_token');
  assert.equal(stale.json.stepToken, first.json.stepToken);
});

test('--result 指着一个空文件，等于没交结果', () => {
  const dir = materials();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-cli-'));
  const first = baox(['next', '--dir', dir], { BAOX_HOME: home });
  const empty = path.join(home, 'empty.json');
  fs.writeFileSync(empty, '');
  const claimed = baox(['next', '--after', first.json.stepToken, '--result', empty], { BAOX_HOME: home });
  assert.equal(claimed.json.ignored.reason, 'no_result');
  assert.equal(claimed.json.state, 'env_chrome_down');
});

test('这一步没有可纠正的读数时，纠正不会被悄悄收下', () => {
  const dir = materials();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-cli-'));
  const first = baox(['next', '--dir', dir], { BAOX_HOME: home });
  const corr = path.join(home, 'c.json');
  fs.writeFileSync(corr, '{"totalAmount":"51.63"}');
  const r = baox(['next', '--after', first.json.stepToken, '--correction', corr], { BAOX_HOME: home });
  assert.equal(r.json.ignored.reason, 'correction_not_applicable');
});

test('数据格式比内核新时，第一时间硬停 —— 连材料都不去盘', () => {
  const dir = materials();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-cli-'));
  // 下一版 baox 写的数据目录：格式版本比这个内核认得的高。
  fs.writeFileSync(path.join(home, 'schema.json'), JSON.stringify({ schemaVersion: 99 }));

  const r = baox(['next', '--dir', dir], { BAOX_HOME: home });
  assert.equal(r.code, 2, '硬停是退出码 2；采集时抛异常会变成 1，那就不是硬停了');
  assert.equal(r.json.state, 'schema_too_new');
  assert.equal(r.json.step.kind, 'tell_user');
  assert.equal(r.json.task, null, '没去盘材料 —— 拿这一版的眼睛读下一版的文件本来就不作数');
  assert.equal(r.json.blockedBy[0].kind, 'schema_too_new');
});

test('问得不对就答不了：错的材料目录、以及第一次问不带 --dir', () => {
  const bad = baox(['next', '--dir', '/nope/nope/nope']);
  assert.equal(bad.code, 1, '这不是状态机里的状态，是这一问根本没法判');
  assert.match(bad.json.error, /材料目录不存在/);
  assert.ok(bad.json.speak, '照样给一句能念给用户听的话');
  assert.equal(bad.json.state, undefined, '不发明状态名');

  const noDir = baox(['next']);
  assert.equal(noDir.code, 1);
  assert.match(noDir.json.error, /--dir/);
});
