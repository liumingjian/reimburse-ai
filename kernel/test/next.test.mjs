import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCHEMA_VERSION } from '../src/state.mjs';

// 每个用例一个独立的数据目录：凭据登记簿落在 BAOX_HOME 里，用例之间不能互相看见。
const freshHome = () => {
  process.env.BAOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-next-'));
  return process.env.BAOX_HOME;
};

const me = { displayName: '刘明建', account: 'luo.liu', tenant: '5f1f13f6dde29e' };
const other = { displayName: '张三', account: 'zhang.san', tenant: '5f1f13f6dde29e' };

const healthy = (over = {}) => ({
  schemaVersion: SCHEMA_VERSION,
  nodeVersion: '22.14.0', nodeMajor: 22,
  cdpUp: true,
  probe: { status: 'matched', identity: me },
  binding: { ...me, confirmedAt: '2026-09-06T00:00:00.000Z' },
  ...over,
});

const KEY = 'a1b2c3d4e5f60718';

test('七个环境状态各有一步可做，说给用户听的话全部来自内核', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const cases = [
    ['env_node_unsupported', 'tell_user', healthy({ nodeMajor: 20, nodeVersion: '20.11.0' })],
    ['env_chrome_down', 'run', healthy({ cdpUp: false, probe: null })],
    ['env_not_logged_in', 'tell_user', healthy({ probe: { status: 'not_logged_in' }, binding: null })],
    ['env_identity_unknown', 'tell_user', healthy({ probe: { status: 'unknown' }, binding: null })],
    ['env_identity_unbound', 'run', healthy({ binding: null })],
    ['env_identity_mismatched', 'tell_user', healthy({ probe: { status: 'matched', identity: other } })],
    ['env_ready', 'done', healthy()],
  ];
  for (const [state, kind, observation] of cases) {
    const shaped = stepFor(state, observation);
    assert.equal(shaped.step.kind, kind, `${state} 的 step.kind`);
    assert.ok(shaped.speak && shaped.speak.length > 10, `${state} 得有一句能原样念的话`);
    assert.ok(shaped.context, `${state} 得有一句备着的解释，用户追问时才用`);
    if (kind === 'run') {
      assert.ok(Array.isArray(shaped.step.argv) && shaped.step.argv.length >= 3,
        `${state} 的 argv 要是一条完整命令行，模型原样执行，不用自己拼`);
      assert.ok(shaped.step.argv[1].endsWith(path.join('bin', 'baox.mjs')));
    }
  }
});

test('硬阻塞才给 2：等人登录不是硬阻塞', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  assert.equal(stepFor('schema_too_new', healthy({ schemaVersion: SCHEMA_VERSION + 1 })).exit, 2);
  assert.equal(stepFor('env_node_unsupported', healthy({ nodeMajor: 20 })).exit, 2);
  assert.equal(stepFor('env_identity_mismatched', healthy({ probe: { status: 'matched', identity: other } })).exit, 2);
  assert.equal(stepFor('env_not_logged_in', healthy({ probe: { status: 'not_logged_in' } })).exit, 0,
    '在等人，不是被拦住');
  assert.equal(stepFor('env_ready', healthy()).exit, 0);
});

test('落成的状态都要有 step，漏一个就当场报出来', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  assert.throws(() => stepFor('task_none', healthy()), /task_none/);
});

test('幂等：连着问三次，同一个状态、同一个凭据', async () => {
  freshHome();
  const { nextResponse } = await import('../src/next.mjs');
  const observation = healthy({ probe: { status: 'not_logged_in' }, binding: null });
  const a = nextResponse({ observation, sourceKey: KEY });
  const b = nextResponse({ observation, sourceKey: KEY });
  const c = nextResponse({ observation, sourceKey: KEY });
  assert.equal(a.state, 'env_not_logged_in');
  assert.equal(b.state, a.state);
  assert.equal(c.state, a.state);
  assert.equal(b.stepToken, a.stepToken);
  assert.equal(c.stepToken, a.stepToken);
  assert.deepEqual(b.step, a.step);
  assert.equal(b.speak, a.speak);
});

test('状态一变就换新凭据，旧的当场作废', async () => {
  freshHome();
  const { nextResponse } = await import('../src/next.mjs');
  const down = nextResponse({ observation: healthy({ cdpUp: false, probe: null }), sourceKey: KEY });
  const up = nextResponse({ observation: healthy({ binding: null }), sourceKey: KEY });
  assert.equal(down.state, 'env_chrome_down');
  assert.equal(up.state, 'env_identity_unbound');
  assert.notEqual(up.stepToken, down.stepToken);

  // 拿着上一步的凭据回来：忽略回传，重发当前步骤。不报错，也不惩罚。
  const again = nextResponse({ observation: healthy({ binding: null }), sourceKey: KEY,
    after: down.stepToken, hasResult: true });
  assert.equal(again.exit, 0, '不可跳步是机制，不是错误');
  assert.equal(again.ignored.reason, 'stale_token');
  assert.equal(again.state, 'env_identity_unbound');
  assert.equal(again.stepToken, up.stepToken, '重发的就是当前那一步，凭据也还是当前那个');
});

test('过期凭据被忽略后，状态一步没动', async () => {
  freshHome();
  const { nextResponse } = await import('../src/next.mjs');
  const observation = healthy({ probe: { status: 'not_logged_in' }, binding: null });
  const first = nextResponse({ observation, sourceKey: KEY });
  const bogus = nextResponse({ observation, sourceKey: KEY, after: 'deadbeef'.repeat(4), hasResult: true });
  assert.equal(bogus.ignored.reason, 'stale_token');
  assert.equal(bogus.state, first.state);
  assert.equal(bogus.stepToken, first.stepToken);
});

test('模型声称做完但没交结果时，状态不前进', async () => {
  freshHome();
  const { nextResponse } = await import('../src/next.mjs');
  const observation = healthy({ cdpUp: false, probe: null });    // 该跑 chrome-up 的那一步
  const first = nextResponse({ observation, sourceKey: KEY });
  assert.equal(first.step.kind, 'run');

  const claimed = nextResponse({ observation, sourceKey: KEY, after: first.stepToken, hasResult: false });
  assert.equal(claimed.ignored.reason, 'no_result');
  assert.equal(claimed.state, 'env_chrome_down', '嘴上说跑完了，Chrome 还是没起来');
  assert.equal(claimed.stepToken, first.stepToken);
  assert.deepEqual(claimed.step, first.step);
});

test('交了结果也不算数：状态只认这一次的观测', async () => {
  freshHome();
  const { nextResponse } = await import('../src/next.mjs');
  const down = healthy({ cdpUp: false, probe: null });
  const first = nextResponse({ observation: down, sourceKey: KEY });
  // 结果交上来了，但 Chrome 实际还是没起来 —— 状态照旧。
  const still = nextResponse({ observation: down, sourceKey: KEY, after: first.stepToken, hasResult: true });
  assert.equal(still.state, 'env_chrome_down');
  assert.equal(still.stepToken, first.stepToken);
  assert.equal(still.ignored, undefined, '这次回传本身是合规的，只是世界没变');
});

test('tell_user 不需要结果，直接再问一次就行', async () => {
  freshHome();
  const { nextResponse } = await import('../src/next.mjs');
  const observation = healthy({ probe: { status: 'not_logged_in' }, binding: null });
  const first = nextResponse({ observation, sourceKey: KEY });
  const again = nextResponse({ observation, sourceKey: KEY, after: first.stepToken, hasResult: false });
  assert.equal(again.ignored, undefined, '等人做完的那种步骤，本来就没有结果可交');
  assert.equal(again.state, 'env_not_logged_in');
});

test('从没登录一路走到环境就绪，全程只有一条命令在动', async () => {
  freshHome();
  const { nextResponse } = await import('../src/next.mjs');
  // 一台没准备过的机器：Chrome 没起。
  let r = nextResponse({ observation: healthy({ cdpUp: false, probe: null }), sourceKey: KEY });
  assert.equal(r.step.kind, 'run');

  // 内核起完 Chrome，页面停在登录页 —— 停下等人。
  r = nextResponse({ observation: healthy({ probe: { status: 'not_logged_in' }, binding: null }),
    sourceKey: KEY, after: r.stepToken, hasResult: true });
  assert.equal(r.state, 'env_not_logged_in');
  assert.equal(r.step.kind, 'tell_user');

  // 人登进去了，但这台机器还没绑过身份 —— 带用户去绑。
  r = nextResponse({ observation: healthy({ binding: null }), sourceKey: KEY, after: r.stepToken });
  assert.equal(r.state, 'env_identity_unbound');
  assert.equal(r.step.kind, 'run');

  // 绑完，环境就绪。
  r = nextResponse({ observation: healthy(), sourceKey: KEY, after: r.stepToken, hasResult: true });
  assert.equal(r.state, 'env_ready');
  assert.equal(r.step.kind, 'done');
  assert.equal(r.exit, 0);
});

test('每一条应答都自带身份和契约字段', async () => {
  freshHome();
  const { nextResponse } = await import('../src/next.mjs');
  const r = nextResponse({ observation: healthy(), sourceKey: KEY });
  assert.equal(r.command, 'next');
  assert.equal(r.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(r.identity, { displayName: '刘明建', account: 'luo.liu' },
    '每次都带身份：绑错了人，下一句话就暴露');
  assert.equal(r.actor, null);
  assert.ok(r.stepToken.length === 32, '16 字节 hex');
  assert.deepEqual(r.blockedBy, []);
  assert.ok('task' in r);
  assert.ok('progress' in r);
});

test('还没登录时，身份退回这台机器绑过的那一个，读不出就是 null', async () => {
  freshHome();
  const { nextResponse } = await import('../src/next.mjs');
  const bound = nextResponse({ observation: healthy({ probe: { status: 'not_logged_in' } }), sourceKey: KEY });
  assert.deepEqual(bound.identity, { displayName: '刘明建', account: 'luo.liu' });

  const blank = nextResponse({ observation: healthy({ probe: { status: 'not_logged_in' }, binding: null }),
    sourceKey: KEY });
  assert.equal(blank.identity, null, '不知道就是不知道，不给一个看起来像身份的东西');
});

test('两个材料目录各记各的凭据，互不串台', async () => {
  freshHome();
  const { nextResponse } = await import('../src/next.mjs');
  const a = nextResponse({ observation: healthy({ binding: null }), sourceKey: 'aaaa1111bbbb2222' });
  const b = nextResponse({ observation: healthy({ cdpUp: false, probe: null }), sourceKey: 'cccc3333dddd4444' });
  assert.notEqual(a.stepToken, b.stepToken);
  const backToA = nextResponse({ observation: healthy({ binding: null }), sourceKey: 'aaaa1111bbbb2222' });
  assert.equal(backToA.stepToken, a.stepToken);
});
