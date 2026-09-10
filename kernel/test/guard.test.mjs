import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { execFileSync } from 'node:child_process';
import { guardVerdict, agentMarkers, refusalPayload, recordRefusal,
  AGENT_MARKERS, HUMAN_FLAG, REFUSAL_LOG } from '../src/guard.mjs';
import { seedReadyRuntimes } from './runtime-fixture.mjs';

// 这一层测的是「模型不拼命令」那个机制本身。判定是纯函数，所以下半场那些
// 用例连数据目录都不需要；下半场测的是那条命令**真的没跑起来**。

const AGENT = { CLAUDECODE: '1' };
const TERMINAL = {};

test('模型敲 next：放行，这是它唯一的入口', () => {
  const v = guardVerdict({ cmd: 'next', argv: ['next', '--dir', '/x'], env: AGENT });
  assert.equal(v.allowed, true);
  assert.equal(v.reason, 'model_allowed');
});

test('模型只能启动裸 reset，命令行参数不能替用户确认', () => {
  const start = guardVerdict({ cmd: 'reset', argv: ['reset'], env: AGENT });
  assert.equal(start.allowed, true);
  assert.equal(start.reason, 'model_allowed');
  for (const argv of [['reset', '--i-am-a-human'], ['reset', '--yes']]) {
    assert.equal(guardVerdict({ cmd: 'reset', argv, env: AGENT }).allowed, false);
  }
});

test('模型敲低层命令：拒', () => {
  for (const cmd of ['intake', 'classify', 'erp-fill', 'confirm-identity', 'abandon-task']) {
    const v = guardVerdict({ cmd, argv: [cmd, '--dir', '/x'], env: AGENT });
    assert.equal(v.allowed, false, `${cmd} 应该被拒`);
    assert.equal(v.reason, 'model_may_only_run_next');
  }
});

test('空命令和不存在的命令一样拒 —— 命令清单本身也不该给模型看', () => {
  assert.equal(guardVerdict({ cmd: undefined, argv: [], env: AGENT }).allowed, false);
  assert.equal(guardVerdict({ cmd: 'no-such-command', argv: ['no-such-command'], env: AGENT }).allowed, false);
});

test('人在真终端里手敲：一律放行，低层命令本来就是给他留的', () => {
  const v = guardVerdict({ cmd: 'intake', argv: ['intake', '--dir', '/x'], env: TERMINAL });
  assert.equal(v.allowed, true);
  assert.equal(v.reason, 'no_agent_markers');
  assert.deepEqual(v.markers, []);
});

test(`人在 Claude Code 里手敲：加 ${HUMAN_FLAG} 才放行`, () => {
  const argv = ['intake', '--dir', '/x'];
  assert.equal(guardVerdict({ cmd: 'intake', argv, env: AGENT }).allowed, false);
  const v = guardVerdict({ cmd: 'intake', argv: [...argv, HUMAN_FLAG], env: AGENT });
  assert.equal(v.allowed, true);
  assert.equal(v.reason, 'human_flag');
});

test('四个痕迹各自单独出现都算数 —— 少认一个就是漏一条路', () => {
  for (const marker of AGENT_MARKERS) {
    const env = { [marker]: 'x' };
    assert.deepEqual(agentMarkers(env), [marker]);
    assert.equal(guardVerdict({ cmd: 'intake', argv: ['intake'], env }).allowed, false,
      `${marker} 在场时应该拒`);
  }
});

test('空字符串的环境变量不算痕迹', () => {
  assert.deepEqual(agentMarkers({ CLAUDECODE: '' }), []);
  assert.equal(guardVerdict({ cmd: 'intake', argv: ['intake'], env: { CLAUDECODE: '' } }).allowed, true);
});

// —— step.argv 白名单 ——
// 契约的原话是「拦下**不在 argv 里**的越权命令」。内核自己发出去的那一条要放行，
// 否则 kind: "run" 这一步永远走不动，整套设计当场停摆。

const issued = ['/usr/bin/node', '/opt/baox/kernel/bin/baox.mjs', 'intake', '--dir', '/materials'];

test('内核刚发出的那条 step.argv：放行', () => {
  const v = guardVerdict({ cmd: 'intake', argv: ['intake', '--dir', '/materials'],
    env: AGENT, issuedArgv: issued });
  assert.equal(v.allowed, true);
  assert.equal(v.reason, 'issued_by_kernel');
});

test('在内核发的那条上多加一个参数：拒 —— 多一个少一个都是另一条命令', () => {
  assert.equal(guardVerdict({ cmd: 'intake',
    argv: ['intake', '--dir', '/materials', '--force'], env: AGENT, issuedArgv: issued }).allowed, false);
  assert.equal(guardVerdict({ cmd: 'intake',
    argv: ['intake', '--dir'], env: AGENT, issuedArgv: issued }).allowed, false);
  assert.equal(guardVerdict({ cmd: 'intake',
    argv: ['intake', '--dir', '/somewhere-else'], env: AGENT, issuedArgv: issued }).allowed, false);
});

test('登记簿里没有命令行（这一步不跑命令）时，什么都放不行', () => {
  for (const issuedArgv of [null, undefined, [], ['/usr/bin/node']]) {
    assert.equal(guardVerdict({ cmd: 'intake', argv: ['intake'], env: AGENT, issuedArgv }).allowed,
      false, `issuedArgv=${JSON.stringify(issuedArgv)} 不该放行任何东西`);
  }
});

// —— 拒绝的样子 ——

test('拒绝的那份 JSON 带着能原样念的一句话和给人的出路', () => {
  const p = refusalPayload({ cmd: 'erp-fill', markers: ['CLAUDECODE'],
    reason: 'model_may_only_run_next' });
  assert.equal(p.status, 'refused');
  assert.equal(p.refused.command, 'erp-fill');
  assert.deepEqual(p.refused.allowed, ['next', 'reset', 'erp-reconcile']);
  assert.ok(p.speak, '得有一句能原样念给用户的话');
  assert.ok(p.hint.includes(HUMAN_FLAG), '得告诉人怎么手敲');
});

test('拒绝写进 refused.jsonl，一次一行；验收就是看它空不空', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-guard-'));
  const logs = path.join(dir, 'logs');
  assert.equal(recordRefusal({ cmd: 'intake', markers: ['CLAUDECODE'], logsDir: logs }), true);
  assert.equal(recordRefusal({ cmd: 'classify', markers: ['AI_AGENT'], logsDir: logs }), true);
  const lines = fs.readFileSync(path.join(logs, REFUSAL_LOG), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).command, 'intake');
  assert.deepEqual(JSON.parse(lines[1]).markers, ['AI_AGENT']);
});

// —— 命令这一层 ——
// 拒绝的意义在于那条命令**没有跑过**，所以这里验的是退出码和副作用，不是措辞。

const BIN = path.join(path.dirname(path.dirname(url.fileURLToPath(import.meta.url))), 'bin', 'baox.mjs');

function baox(args, extraEnv = {}, home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-guard-cli-'))) {
  // 基线环境先把痕迹清干净：测试自己就可能跑在 Claude Code 里，
  // 那样「人在真终端」这一支永远测不到。
  const env = { ...process.env, BAOX_HOME: home, ...seedReadyRuntimes(home) };
  for (const k of AGENT_MARKERS) delete env[k];
  // CLI tests must never inherit the real QA task space or invoke ego-browser.
  delete env.BAOX_EGO_TASK_SPACE;
  delete env.BAOX_EGO_BROWSER;
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args],
      { encoding: 'utf8', env: { ...env, ...extraEnv } });
    return { code: 0, json: JSON.parse(stdout), home };
  } catch (err) {
    return { code: err.status, json: JSON.parse(err.stdout), home };
  }
}

test('baox intake 被模型敲：退出码 2，命令没跑，拒绝记了一行', () => {
  const { code, json, home } = baox(['intake', '--dir', '/nope'], { CLAUDECODE: '1' });
  assert.equal(code, 2, '硬阻塞是 2');
  assert.equal(json.status, 'refused');
  assert.equal(json.refused.command, 'intake');
  assert.ok(json.speak);
  const log = path.join(home, 'logs', REFUSAL_LOG);
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1);
});

test('同一条命令，人手敲（无痕迹）就照跑，拒绝日志一行都不写', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-guard-src-'));
  fs.writeFileSync(path.join(dir, 'fp.pdf'), '%PDF-1.4\n');
  const { code, home } = baox(['intake', '--dir', dir]);
  assert.notEqual(code, 2, '人手敲不该撞上守卫');
  assert.equal(fs.existsSync(path.join(home, 'logs', REFUSAL_LOG)), false,
    '放行不记日志，否则"日志为空"就不再是个信号');
});

test('baox next 被模型敲：放行入口，但缺 task space 时由用户处理', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-guard-src2-'));
  fs.writeFileSync(path.join(dir, 'fp.pdf'), '%PDF-1.4\n');
  const { code, json } = baox(['next', '--dir', dir], { CLAUDECODE: '1', BAOX_BROWSER: 'ego' });
  assert.equal(code, 2);
  assert.equal(json.command, 'next');
  assert.equal(json.state, 'env_chrome_down');
  assert.equal(json.actor, 'user');
  assert.equal(json.step.kind, 'tell_user');
  assert.equal(json.blockedBy[0].kind, 'ego_task_space_unavailable');
  assert.match(json.speak, /报销专用浏览器空间/);
});

test('环境未准备时 next 凭据仍可幂等重发，且不发出浏览器命令', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-guard-src3-'));
  fs.writeFileSync(path.join(dir, 'fp.pdf'), '%PDF-1.4\n');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-guard-cli2-'));

  const first = baox(['next', '--dir', dir], { CLAUDECODE: '1', BAOX_BROWSER: 'ego' }, home);
  assert.equal(first.code, 2);
  assert.equal(first.json.step.kind, 'tell_user');
  assert.equal(first.json.step.argv, undefined);

  const again = baox(['next', '--after', first.json.stepToken], { CLAUDECODE: '1', BAOX_BROWSER: 'ego' }, home);
  assert.equal(again.code, 2);
  assert.equal(again.json.state, 'env_chrome_down');
  assert.equal(again.json.stepToken, first.json.stepToken);
  assert.equal(again.json.ignored, undefined, 'tell_user 不需要伪造命令结果');
});

// —— 守卫例外与迁移阻断 ——
// guard 仍允许 recover 入口被模型调用；CLI 只读路径要求显式 ego task space，
// 因此没有配置时也不会启动或接管任何浏览器。
test('erp-reconcile 放行 —— 写入善后那条路不在 step.argv 里', () => {
  const v = guardVerdict({ cmd: 'erp-reconcile',
    argv: ['erp-reconcile', '--dir', '/materials'], env: AGENT });
  assert.equal(v.allowed, true);
  assert.equal(v.reason, 'model_allowed');
});

test('例外只有这一条，别的 erp-* 照拒', () => {
  for (const cmd of ['erp-fill', 'erp-read']) {
    assert.equal(guardVerdict({ cmd, argv: [cmd, '--dir', '/x'], env: AGENT }).allowed, false,
      `${cmd} 不该跟着 erp-reconcile 一起放行`);
  }
});

test('erp-reconcile 缺 task space 时给出配置阻塞且不碰 ERP', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-guard-rec-'));
  fs.writeFileSync(path.join(dir, 'fp.pdf'), '%PDF-1.4\n');
  const { code, json } = baox(['erp-reconcile', '--dir', dir], { CLAUDECODE: '1', BAOX_BROWSER: 'ego' });
  assert.equal(code, 2);
  assert.equal(json.status, 'blocked');
  assert.equal(json.code, 'EGO_TASK_SPACE_REQUIRED');
  assert.equal(json.command, 'erp-reconcile');
  assert.match(json.note, /报销系统的浏览器环境准备/);
});
