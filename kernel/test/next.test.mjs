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
  // `archived` 是表里唯一还没有人会打的标记（旧格式任务迁移时才打）。
  // 判定表里没有它，这里也就没有它的一步 —— 而缺一步是内核自己的 bug，
  // 不是"暂时没顾上"，所以它当场抛，不悄悄给一个 done。
  assert.throws(() => stepFor('archived', healthy()), /archived/);
});

/** 环境全绿、材料也观测过的那份观测。 */
const withMaterials = (over = {}) => healthy({
  taskObserved: true,
  sourceDir: '/tmp/材料',
  task: { taskId: '75dc9cbb4d', sourceLabel: '材料', workspace: '/tmp/ws',
    currentVersionId: 'v-abc', erpWriteState: null },
  inventoryVersionId: 'v-abc',
  inventoryStale: false,
  classificationRecorded: true,
  openItems: [],
  pendingImages: [],
  pendingReadings: [],
  ...over,
});

/** 一份读过、等着用户过目的读数。它是终端那张表格的全部内容。 */
const PENDING_READING = {
  materialId: 'm-1',
  fileName: '发票.png',
  docType: 'invoice',
  docTypeLabel: '发票',
  fields: [
    { key: 'invoiceNumber', label: '发票号码', value: '26427000000640558021' },
    { key: 'totalAmount', label: '价税合计', value: '18.80' },
  ],
  unreadable: ['税额'],
  amountCheck: 'partial',
  notes: null,
};

test('材料这一段每个状态都有一步可做，说给用户听的话全部来自内核', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const images = [{ materialId: 'm-1', fileName: '发票.png', absPath: '/tmp/材料/发票.png',
    format: 'png', contentHash: 'abc123' }];
  const cases = [
    ['task_none', 'run', withMaterials({ task: null })],
    ['inventory_stale', 'run', withMaterials({ inventoryStale: true })],
    ['classify_pending', 'run', withMaterials({ classificationRecorded: false })],
    ['image_awaiting_reading', 'read_images', withMaterials({ pendingImages: images })],
    ['reading_rejected', 'read_images', withMaterials({
      pendingImages: [{ ...images[0], rejection: { reasons: ['不含税金额 + 税额 ≠ 价税合计'] } }] })],
    ['reading_stale', 'read_images', withMaterials({ pendingImages: images })],
    ['reading_awaiting_confirmation', 'confirm_table',
      withMaterials({ pendingReadings: [PENDING_READING] })],
    ['duplicate_blocked', 'tell_user', withMaterials()],
    ['events_pending', 'run', withMaterials()],
  ];
  for (const [state, kind, observation] of cases) {
    const shaped = stepFor(state, observation);
    assert.equal(shaped.step.kind, kind, `${state} 的 step.kind`);
    assert.ok(shaped.speak && shaped.speak.length > 10, `${state} 得有一句能原样念的话`);
    assert.ok(shaped.context, `${state} 得有一句备着的解释`);
    assert.equal(shaped.exit, 0, `${state} 不是硬阻塞`);
    if (kind === 'run') {
      assert.ok(shaped.step.argv.includes('--dir') && shaped.step.argv.includes('/tmp/材料'),
        `${state} 的 argv 要指着这批材料，模型不用自己拼`);
    }
  }
});

test('要人亲手表态的那两步，明说不能外包给子 Agent', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  // 契约说 kind: "run" 的连续段可以外包。这两步的另一头是人：一个要人点确认页，
  // 一个要人对着终端表格表态。外包给一个没有用户的子 Agent，它只会挂在那里等 ——
  // 所以写进 JSON，不是只写在注释里。
  assert.equal(stepFor('env_identity_unbound', healthy({ binding: null })).step.outsourceable, false);
  assert.equal(stepFor('reading_awaiting_confirmation',
    withMaterials({ pendingReadings: [PENDING_READING] })).step.outsourceable, false);
  // 纯跑命令的那些照旧可以外包。
  assert.equal(stepFor('env_chrome_down', healthy({ cdpUp: false, probe: null })).step.outsourceable, true);
  assert.equal(stepFor('classify_pending', withMaterials({ classificationRecorded: false })).step.outsourceable,
    true);
});

test('跨任务重复：停整批，两边的任务都摆出来', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const blockedBy = [
    { kind: 'duplicate_across_tasks', fileName: '发票.pdf', hint: '这张发票在任务 abc123 里也在',
      resolvableBy: 'user', blocking: true },
    { kind: 'history_scope_local', fileName: null, hint: '只比对了本机记过的任务',
      resolvableBy: 'kernel', blocking: false },
  ];
  const shaped = stepFor('duplicate_blocked', withMaterials(), blockedBy);
  assert.equal(shaped.step.kind, 'tell_user');
  assert.match(shaped.speak, /发票\.pdf/);
  assert.match(shaped.speak, /abc123/, '另一个任务是哪个，得说出来，不然用户没法裁决');
  assert.doesNotMatch(shaped.speak, /只比对了本机记过的任务/, '范围声明留在 context 和 blockedBy 里');
});

test('待办这一步逐条说清楚谁能解决它，一条都不含糊', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const blockedBy = [
    { kind: 'read_error', fileName: '坏了.pdf', hint: '文件打不开', resolvableBy: 'user', blocking: true },
    { kind: 'no_text_in_pdf', fileName: '扫描件.pdf', hint: '取不到文字', resolvableBy: 'user', blocking: true },
    { kind: 'extension_mismatch', fileName: '其实是png.pdf', hint: '扩展名对不上',
      resolvableBy: 'kernel', blocking: false },
  ];
  const shaped = stepFor('intake_open_items', withMaterials(), blockedBy);
  assert.equal(shaped.step.kind, 'tell_user');
  assert.match(shaped.speak, /坏了\.pdf/);
  assert.match(shaped.speak, /扫描件\.pdf/);
  assert.match(shaped.speak, /要你处理/, '每条都得说清楚谁能解决它');
  assert.doesNotMatch(shaped.speak, /其实是png\.pdf/, '不拦路的那条不念给用户听，留在 blockedBy 里');
  assert.equal(shaped.exit, 0, '待办是在等人处理，不是被内核拦住');
});

test('看图这一步：图、模板、写到哪、怎么交，四样一次给全', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const images = [
    { materialId: 'm-1', fileName: '发票.png', absPath: '/tmp/材料/发票.png', format: 'png', contentHash: 'aa' },
    { materialId: 'm-2', fileName: '行程单.png', absPath: '/tmp/材料/行程单.png', format: 'png', contentHash: 'bb' },
  ];
  const { step, speak } = stepFor('image_awaiting_reading', withMaterials({ pendingImages: images }));
  assert.equal(step.images.length, 2);
  assert.equal(step.images[0].absPath, '/tmp/材料/发票.png', '模型要拿绝对路径才打得开图');
  assert.ok(step.images[0].contentHash, '读数钉在这张图当前的字节上');
  assert.ok(fs.existsSync(step.schemaPath), '模板得是一份真存在的文件，不是一句说明');
  assert.equal(step.readingsPath, path.join('/tmp/ws', 'reading-submission.json'));
  assert.ok(step.argv.includes(step.readingsPath), '写到哪、交哪个文件，是同一个路径');
  assert.ok(step.argv.includes('ocr-submit'));
  assert.match(speak, /发票\.png/, '要看哪几张图，念出来');
});

test('看过的凭据跟着这一步一起给，模型不用去别处查它', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const images = [{ materialId: 'm-1', fileName: '发票.png', absPath: '/tmp/材料/发票.png',
    format: 'png', contentHash: 'aa' }];
  const { step, context } = stepFor('image_awaiting_reading', withMaterials({ pendingImages: images }));
  assert.deepEqual(step.sightedShapes.map((s) => s.shape),
    ['tall', 'portrait', 'square', 'landscape', 'wide']);
  assert.ok(step.sightedShapes.every((s) => s.label), '每一档都得有一句人话，光给英文词没用');
  assert.match(context, /没看图就说图片读不了/);
});

test('被驳回的读数：重读时把上次没过的理由原样带上', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const images = [{ materialId: 'm-1', fileName: '发票.png', absPath: '/tmp/材料/发票.png',
    format: 'png', contentHash: 'aa',
    rejection: { reasons: ['不含税金额 + 税额 ≠ 价税合计；请重新逐字核对票面'] } }];
  const { step, speak, context } = stepFor('reading_rejected', withMaterials({ pendingImages: images }));
  assert.equal(step.kind, 'read_images');
  assert.deepEqual(step.images[0].previousRejection, images[0].rejection.reasons);
  assert.match(speak, /发票\.png/);
  assert.match(speak, /价税合计/, '为什么没过，要念给用户听');
  // 守恒式不平的处置是重读或判定读不出，绝不是把某一位数字改到平。
  assert.match(context, /凑平/);
});

test('确认这一步：内核渲染好一整块表格，模型只负责搬运', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const { displayWidth } = await import('../src/table.mjs');
  const { step, speak, context } = stepFor('reading_awaiting_confirmation',
    withMaterials({ pendingReadings: [PENDING_READING] }));

  assert.equal(step.kind, 'confirm_table');
  assert.ok(step.table.includes('26427000000640558021'), '要比对的值必须完整出现在表里');
  assert.ok(step.table.includes('发票号码'), '给用户看中文名，不给键名');
  assert.ok(step.table.includes('看不清'), '认不出的字段也要让用户知道，不是留白');
  const widths = new Set(step.table.split('\n').map(displayWidth));
  assert.equal(widths.size, 1, '定宽表格：每一行显示宽度一致');

  assert.deepEqual(step.materialIds, ['m-1'], '这一次点头覆盖哪几份材料，说死');
  assert.ok(step.correctionPath.endsWith('reading-correction.json'));
  assert.ok(step.correctionPath !== step.readingsPath);
  // 全程不弹浏览器：这一步里不该有任何一条要跑的命令，也不该有地址要念。
  assert.equal(step.argv, undefined);
  assert.doesNotMatch(speak + context, /打开一个本地|http:\/\/|127\.0\.0\.1|localhost/);
  assert.match(context, /确认只来自你在这里的表态/);
  assert.match(context, /不需要你打开任何网页/, '这件事要明说，不是让用户自己发现');
});

test('确认这一步收得下纠正 —— 用户指错不该被悄悄丢掉', async () => {
  freshHome();
  const { nextResponse } = await import('../src/next.mjs');
  const observation = withMaterials({
    openItems: [{ kind: 'reading_awaiting_confirmation', materialId: 'm-1',
      fileName: '发票.png', blocking: true }],
    pendingReadings: [PENDING_READING],
  });
  const first = nextResponse({ observation, sourceKey: KEY });
  assert.equal(first.state, 'reading_awaiting_confirmation');
  assert.equal(first.actor, 'user');

  const back = nextResponse({ observation, sourceKey: KEY, after: first.stepToken, hasCorrection: true });
  assert.equal(back.ignored, undefined, 'confirm_table 上的纠正是有处安放的');
});

test('图没读完不算读完：交不出结果，状态一步不动', async () => {
  freshHome();
  const { nextResponse } = await import('../src/next.mjs');
  const images = [{ materialId: 'm-1', fileName: '发票.png', absPath: '/tmp/材料/发票.png',
    format: 'png', contentHash: 'aa' }];
  const observation = withMaterials({
    openItems: [{ kind: 'image_awaiting_reading', materialId: 'm-1', fileName: '发票.png', blocking: true }],
    pendingImages: images,
  });
  const first = nextResponse({ observation, sourceKey: KEY });
  assert.equal(first.state, 'image_awaiting_reading');
  assert.equal(first.actor, 'model');

  const claimed = nextResponse({ observation, sourceKey: KEY, after: first.stepToken, hasResult: false });
  assert.equal(claimed.ignored.reason, 'no_result', '说看过了不算看过了');
  assert.equal(claimed.state, 'image_awaiting_reading');
  assert.deepEqual(claimed.step, first.step);
});

test('每条应答都带着任务，没有任务就是 null', async () => {
  freshHome();
  const { nextResponse } = await import('../src/next.mjs');
  const r = nextResponse({ observation: withMaterials(), sourceKey: KEY });
  assert.deepEqual(r.task, { taskId: '75dc9cbb4d', sourceLabel: '材料', sourceDir: '/tmp/材料' });
  assert.equal(r.progress.of, 10);

  const none = nextResponse({ observation: withMaterials({ task: null }), sourceKey: KEY });
  assert.equal(none.task, null, '不给一个看起来像任务的空壳');
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

test('环境这一段没有可纠正的读数，纠正不被悄悄收下', async () => {
  freshHome();
  const { nextResponse } = await import('../src/next.mjs');
  const observation = healthy({ probe: { status: 'not_logged_in' }, binding: null });
  const first = nextResponse({ observation, sourceKey: KEY });
  const r = nextResponse({ observation, sourceKey: KEY, after: first.stepToken, hasCorrection: true });
  assert.equal(r.ignored.reason, 'correction_not_applicable',
    '收下一份没处安放的纠正而不吭声，会让用户以为自己的改动被采纳了');
  assert.equal(r.state, 'env_not_logged_in');
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

// —— 主干后半段：事件、分摊、项目、核对、写入前确认 ——

/** 后半段观测。它比材料那一段多出事件、明细、核对和待写内容。 */
const withErp = (over = {}) => withMaterials({
  eventsRecorded: true,
  events: { versionId: 'v-abc', events: [], lineItems: [], notes: [] },
  allocationRound: null,
  selectionApplied: true,
  lines: [{ lineId: 'ev-01', voucherMaterialId: 'm-1', maskedNumber: '2642****8021',
    date: '2026-07-09', city: '北京市', route: '北京南站 → 望京', netAmount: '25.91',
    taxAmount: '0.78', totalAmount: '26.69', amountSource: 'itinerary_conserved',
    categoryLabel: '本地市内交通', project: '111454' }],
  homeCity: '北京市',
  purpose: '七月出差交通费',
  catalogFresh: true,
  catalogProblems: [],
  writePreview: { lines: [], homeCity: '北京市', purpose: '七月出差交通费', versionId: 'v-abc' },
  writeApproved: false,
  ...over,
});

const askRound = (over = {}) => ({
  materialId: 'm-inv', fileName: '合并发票.pdf', contentHash: 'h1',
  segmentCount: 3, totalAmount: '69.19', netAmount: '67.18', taxAmount: '2.01',
  stale: false, answered: [], remaining: 3, rejection: null,
  questions: [
    { id: 'm-inv#1', header: '第 1 段', question: '第 1 段（2026-07-09 北京市）的价税合计是多少？',
      options: [{ label: '26.69' }, { label: '这张票我认不出' }, { label: '其他' }], multiSelect: false },
    { id: 'm-inv#2', header: '第 2 段', question: '第 2 段的价税合计是多少？',
      options: [{ label: '20.85' }, { label: '这张票我认不出' }, { label: '其他' }], multiSelect: false },
  ],
  ...over,
});

test('后半段每个状态也各有一步可做，话仍然全部来自内核', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const cases = [
    ['events_pending', 'run', withErp({ eventsRecorded: false })],
    ['allocation_required', 'ask_user', withErp({ allocationRound: askRound() })],
    ['allocation_stale', 'ask_user', withErp({ allocationRound: askRound({ stale: true }) })],
    ['project_unassigned', 'tell_user',
      withErp({ lines: [{ lineId: 'ev-01', totalAmount: '26.69', project: null }] })],
    ['catalog_unverified', 'run', withErp({ catalogFresh: false })],
    ['ready_for_erp_write', 'confirm_table', withErp()],
    ['handed_off_recover', 'handoff', withErp({
      task: { taskId: 't', sourceLabel: '材料', workspace: '/tmp/ws', currentVersionId: 'v-abc',
        erpWriteState: 'dispatched' } })],
  ];
  for (const [state, kind, observation] of cases) {
    const shaped = stepFor(state, observation);
    assert.equal(shaped.step.kind, kind, `${state} 的 step.kind`);
    assert.ok(shaped.speak && shaped.speak.length > 10, `${state} 得有一句能原样念的话`);
    assert.ok(shaped.context, `${state} 得有一句备着的解释`);
    assert.equal(shaped.exit, 0, `${state} 不是硬阻塞`);
    if (kind === 'run') {
      assert.ok(shaped.step.argv.includes('--dir') && shaped.step.argv.includes('/tmp/材料'),
        `${state} 的 argv 要指着这批材料，模型不用自己拼`);
    }
  }
});

test('终端多选的形状是硬的：至多四题，每题二到四个选项，末项恒为「其他」', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const shaped = stepFor('allocation_required', withErp({ allocationRound: askRound() }));
  const qs = shaped.step.questions;
  assert.ok(qs.length >= 1 && qs.length <= 4, '一轮至多四题');
  for (const q of qs) {
    assert.ok(q.id && q.question, '每题要有 id 和问法');
    assert.ok(q.options.length >= 2 && q.options.length <= 4, `${q.id} 的选项要在 2–4 之间`);
    assert.equal(q.options.at(-1).label, '其他', '末项恒为「其他」，永远留一个自由输入口');
  }
  assert.equal(shaped.step.outsourceable, false, '终端多选在子 Agent 里做不了：那里没有用户');
  assert.ok(shaped.step.answersPath, '答案写到哪里由内核定，模型不选地方');
  assert.ok(shaped.step.answersFormat.answers.some((a) => a.giveUp === true),
    '「我认不出」要有一条明确的回传形状，而且和别的答案写在同一处 —— '
    + '另起一个顶层键，模型照着写就会被判成"这几段没答"');
  assert.match(shaped.speak, /69\.19/, '加起来该是多少，得摆在眼前');
  assert.match(shaped.speak, /不会平均|不会按比例/, '内核不替用户分摊这句话要说出口');
});

test('分摊问到一半：已经定下来的那几段摆出来，还剩几段也说清楚', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const shaped = stepFor('allocation_required', withErp({
    allocationRound: askRound({ answered: [{ index: 1, amount: '26.69' }], remaining: 2,
      questions: [askRound().questions[1]] }),
  }));
  assert.match(shaped.speak, /第 1 段 26\.69 元/, '他上一轮说过什么，要看得见');

  // 上一轮没收下时，理由原样念出来 —— 不说的话用户不知道自己在重答什么。
  const again = stepFor('allocation_required', withErp({
    allocationRound: askRound({ rejection: { reasons: ['逐段价税合计相加 69.20，与票面价税合计 69.19 差 0.01'] } }),
  }));
  assert.match(again.speak, /差 0\.01/);
});

test('项目未指定：如实报出来，并说清楚问法还没定 —— 不假装问了一个不存在的问题', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const shaped = stepFor('project_unassigned', withErp({
    lines: [{ lineId: 'ev-01', totalAmount: '26.69', project: null },
      { lineId: 'ev-02', totalAmount: '20.85', project: null }],
  }));
  assert.equal(shaped.step.kind, 'tell_user',
    '不是 done —— 这一趟并没有走完，它停在这里等一个人');
  assert.match(shaped.speak, /项目号/);
  assert.equal(shaped.progress.label, '项目归属');
});

test('ERP 里查无此项目 —— 硬停，退出码 2，并说清是哪个号', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const blockedBy = [{ kind: 'catalog_mismatch', number: '999999', verdict: 'missing',
    hint: '项目号 999999 在 ERP 项目目录里查不到', resolvableBy: 'user', blocking: true }];
  const shaped = stepFor('catalog_mismatch', withErp(), blockedBy);
  assert.equal(shaped.step.kind, 'tell_user');
  assert.equal(shaped.exit, 2, '拿一个不存在的项目号建单，错误只会在保存那一刻暴露');
  assert.match(shaped.speak, /999999/);
});

test('写入前那张表：摆全、报总数、且收不下任何改值', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const shaped = stepFor('ready_for_erp_write', withErp());
  assert.equal(shaped.step.kind, 'confirm_table');
  assert.equal(shaped.step.acceptsCorrection, false,
    '在写入前的最后一格上改一个值，等于绕开前面每一道校验');
  assert.equal(shaped.step.outsourceable, false);
  assert.equal(shaped.step.totalAmount, '26.69');
  assert.match(shaped.step.table, /111454/, '项目号要摆在表里 —— 它就是用户要核对的东西之一');
  assert.match(shaped.step.table, /26\.69/);
  assert.match(shaped.speak, /撤不回来/, '不可撤销这件事要说在点头之前');
  assert.ok(shaped.stepMeta.previewDigest, '凭据钉在这一份待写内容上');

  // 内容变一个字，凭据的身份就变了 —— 他点的头只对他看过的那一份有效。
  const other = stepFor('ready_for_erp_write', withErp({
    writePreview: { lines: [], homeCity: '北京市', purpose: '改了事由', versionId: 'v-abc' } }));
  assert.notEqual(other.stepMeta.previewDigest, shaped.stepMeta.previewDigest);
});

test('点过头之后不再重复问，而且明说"还没写进 ERP"', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const shaped = stepFor('ready_for_erp_write', withErp({ writeApproved: true }));
  assert.equal(shaped.step.kind, 'done');
  assert.match(shaped.speak, /还没有任何东西写进 ERP/);
});

test('动过 ERP 的任务：交接给 baox-recover，并说清状态变化', async () => {
  freshHome();
  const { stepFor } = await import('../src/next.mjs');
  const shaped = stepFor('handed_off_recover', withErp({
    task: { taskId: 't', sourceLabel: '材料', workspace: '/tmp/ws', currentVersionId: 'v-abc',
      erpWriteState: 'dispatched' } }));
  assert.equal(shaped.step.skill, 'baox-recover');
  assert.match(shaped.speak, /dispatched/, '当前记的是什么状态，要说出来');
});
