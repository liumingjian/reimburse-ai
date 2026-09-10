import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { execFileSync } from 'node:child_process';
import { seedReadyRuntimes } from './runtime-fixture.mjs';

// 模型敲的是命令，不是模块。上面那一层测的是判定，这一层测的是**那条命令本身** ——
// 参数怎么解析、退出码是几、输出是不是一份契约里那样的 JSON。
//
// 不用真实浏览器：测试明确不给 task space，环境判定停在用户可处理的
// env_chrome_down。这验证的是 CLI 的阻断契约，不会启动 ego-browser。

const BIN = path.join(path.dirname(path.dirname(url.fileURLToPath(import.meta.url))), 'bin', 'baox.mjs');

function baox(args, env = {}) {
  const home = env.BAOX_HOME ?? fs.mkdtempSync(path.join(os.tmpdir(), 'baox-cli-'));
  const childEnv = { ...process.env, BAOX_HOME: home, ...seedReadyRuntimes(home), ...env };
  delete childEnv.BAOX_EGO_TASK_SPACE;
  delete childEnv.BAOX_EGO_BROWSER;
  delete childEnv.BAOX_CDP_PORT;
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8',
      env: childEnv,
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

test('baox next --dir：缺 task space 时返回可执行的用户处理步骤', () => {
  const dir = materials();
  const { code, json } = baox(['next', '--dir', dir], { BAOX_BROWSER: 'ego' });
  assert.equal(code, 2);
  assert.equal(json.command, 'next');
  assert.equal(json.schemaVersion, 1);
  assert.equal(json.state, 'env_chrome_down');
  assert.equal(json.step.kind, 'tell_user');
  assert.equal(json.actor, 'user');
  assert.equal(json.blockedBy[0].kind, 'ego_task_space_unavailable');
  assert.match(json.speak, /BAOX_EGO_TASK_SPACE/);
  assert.ok(json.speak, '得有一句能原样念的话');
  assert.equal(json.stepToken.length, 32);
  assert.equal(json.step.argv, undefined, 'task space 未配置时不得发出浏览器启动命令');
});

test('browser-open 默认走系统 URL 打开接口并返回 transport 结果', () => {
  const url = 'http://erp.antute.com.cn/k3cloud/html5/index.aspx';
  const { code, json } = baox(['browser-open', '--url', url], {
    BAOX_NO_AUTO_OPEN: '1',
  });
  assert.equal(code, 0);
  assert.equal(json.command, 'browser-open');
  assert.equal(json.browserMode, 'system');
  assert.equal(json.transport, 'system');
  assert.equal(json.url, url);
  assert.equal(json.status, 'skipped');
});

test('连着问三次，同一个状态、同一个凭据', () => {
  const dir = materials();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-cli-'));
  const env = { BAOX_HOME: home, BAOX_BROWSER: 'ego' };
  const a = baox(['next', '--dir', dir], env);
  const b = baox(['next', '--dir', dir], env);
  const c = baox(['next', '--dir', dir], env);
  assert.equal(b.json.state, a.json.state);
  assert.equal(c.json.state, a.json.state);
  assert.equal(b.json.stepToken, a.json.stepToken);
  assert.equal(c.json.stepToken, a.json.stepToken);
});

test('只带 --after 也答得上来：内核自己记得上次问的是哪个目录', () => {
  const dir = materials();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-cli-'));
  const env = { BAOX_HOME: home, BAOX_BROWSER: 'ego' };
  const first = baox(['next', '--dir', dir], env);
  const back = baox(['next', '--after', first.json.stepToken], env);
  assert.equal(back.code, 2);
  assert.equal(back.json.state, first.json.state);
  assert.equal(back.json.ignored, undefined, 'tell_user 不需要伪造命令结果');
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
  const env = { BAOX_HOME: home, BAOX_BROWSER: 'ego' };
  const first = baox(['next', '--dir', dir], env);
  const stale = baox(['next', '--after', 'f'.repeat(32), '--dir', dir], env);
  assert.equal(stale.code, 2, '环境硬阻塞仍然是退出码 2');
  assert.equal(stale.json.ignored.reason, 'stale_token');
  assert.equal(stale.json.stepToken, first.json.stepToken);
});

test('--result 指着一个空文件，也不能解除 task space 阻塞', () => {
  const dir = materials();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-cli-'));
  const env = { BAOX_HOME: home, BAOX_BROWSER: 'ego' };
  const first = baox(['next', '--dir', dir], env);
  const empty = path.join(home, 'empty.json');
  fs.writeFileSync(empty, '');
  const claimed = baox(['next', '--after', first.json.stepToken, '--result', empty], env);
  assert.equal(claimed.code, 2);
  assert.equal(claimed.json.ignored, undefined, 'tell_user 不接收命令结果');
  assert.equal(claimed.json.state, 'env_chrome_down');
  assert.equal(claimed.json.step.kind, 'tell_user');
});

test('这一步没有可纠正的读数时，纠正不会被悄悄收下', () => {
  const dir = materials();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-cli-'));
  const first = baox(['next', '--dir', dir], { BAOX_HOME: home, BAOX_BROWSER: 'ego' });
  const corr = path.join(home, 'c.json');
  fs.writeFileSync(corr, '{"totalAmount":"51.63"}');
  const r = baox(['next', '--after', first.json.stepToken, '--correction', corr], {
    BAOX_HOME: home, BAOX_BROWSER: 'ego',
  });
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
