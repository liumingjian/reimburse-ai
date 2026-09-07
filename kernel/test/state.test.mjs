import { test } from 'node:test';
import assert from 'node:assert/strict';
import { determineState, STATE_ORDER, SCHEMA_VERSION, MIN_NODE_MAJOR } from '../src/state.mjs';

// 身份取自真机探测：显示名和登录账号本来就不是一回事（刘明建 / luo.liu）。
const me = { displayName: '刘明建', account: 'luo.liu', tenant: '5f1f13f6dde29e' };
const other = { displayName: '张三', account: 'zhang.san', tenant: '5f1f13f6dde29e' };

/** 一切都好的观测。每个用例只把自己关心的那一项拨坏。 */
const healthy = (over = {}) => ({
  schemaVersion: SCHEMA_VERSION,
  nodeVersion: '22.14.0',
  nodeMajor: 22,
  cdpUp: true,
  probe: { status: 'matched', identity: me },
  binding: { ...me, confirmedAt: '2026-09-06T00:00:00.000Z' },
  ...over,
});

test('环境全过就是 env_ready，没有人要动手', () => {
  const r = determineState(healthy());
  assert.equal(r.state, 'env_ready');
  assert.equal(r.actor, null);
  assert.deepEqual(r.blockedBy, []);
});

test('Node 太老 —— 只有人能装，内核装不了', () => {
  const r = determineState(healthy({ nodeMajor: 20, nodeVersion: '20.11.0' }));
  assert.equal(r.state, 'env_node_unsupported');
  assert.equal(r.actor, 'user');
  assert.equal(r.blockedBy[0].kind, 'node_unsupported');
  assert.equal(r.blockedBy[0].resolvableBy, 'user');
  assert.match(r.blockedBy[0].hint, /20\.11\.0/, '说清楚现在是哪一版，不然用户不知道该换什么');
  assert.ok(r.blockedBy[0].hint.includes(String(MIN_NODE_MAJOR)));
});

test('CDP 连不上 —— 内核自己去起 Chrome，不劳驾用户', () => {
  const r = determineState(healthy({ cdpUp: false, probe: null }));
  assert.equal(r.state, 'env_chrome_down');
  assert.equal(r.actor, 'kernel');
  assert.deepEqual(r.blockedBy, [], '这不是阻塞，是内核下一步就去做的事');
});

test('停在登录页 —— 只有本人能登', () => {
  const r = determineState(healthy({ probe: { status: 'not_logged_in' }, binding: null }));
  assert.equal(r.state, 'env_not_logged_in');
  assert.equal(r.actor, 'user');
  assert.equal(r.blockedBy[0].kind, 'not_logged_in');
});

test('页面加载中 / 读不出又没有登录表单 / 根本没开 ERP —— 都要人看一眼', () => {
  for (const status of ['loading', 'unknown', 'no_tab']) {
    const r = determineState(healthy({ probe: { status }, binding: null }));
    assert.equal(r.state, 'env_identity_unknown', `${status} 应当归到 env_identity_unknown`);
    assert.equal(r.actor, 'user');
  }
  // 读出了人，却凑不出可比的身份（account 或 tenant 缺一），同样是「说不清」。
  const incomplete = determineState(healthy({ probe: { status: 'matched', identity: { ...me, tenant: null } } }));
  assert.equal(incomplete.state, 'env_identity_unknown');
});

test('探针认得出人，但这台机器没绑过 —— 带用户去绑', () => {
  const r = determineState(healthy({ binding: null }));
  assert.equal(r.state, 'env_identity_unbound');
  assert.equal(r.actor, 'user');
  assert.deepEqual(r.blockedBy, [], '没绑不是阻塞，是下一步就能做完的事');
});

test('绑的人和登录的人对不上 —— 硬阻塞', () => {
  const r = determineState(healthy({ probe: { status: 'matched', identity: other } }));
  assert.equal(r.state, 'env_identity_mismatched');
  assert.equal(r.actor, 'user');
  assert.equal(r.blockedBy[0].kind, 'identity_mismatched');
  assert.match(r.blockedBy[0].hint, /刘明建/);
  assert.match(r.blockedBy[0].hint, /张三/, '两边都要说出来，不然用户不知道该换成谁');
});

test('换账套也算换人', () => {
  const r = determineState(healthy({ probe: { status: 'matched', identity: { ...me, tenant: '另一个账套' } } }));
  assert.equal(r.state, 'env_identity_mismatched');
});

test('数据格式比内核新 —— 硬停，且永远排在最前', () => {
  const r = determineState(healthy({ schemaVersion: SCHEMA_VERSION + 1 }));
  assert.equal(r.state, 'schema_too_new');
  assert.equal(r.blockedBy[0].kind, 'schema_too_new');
  assert.equal(STATE_ORDER[0], 'schema_too_new');
});

test('判定顺序：同时满足多个判据时，越靠前的先报', () => {
  // 一台什么都不对的机器：格式太新、Node 太老、Chrome 没起、没登录、没绑定。
  const broken = {
    schemaVersion: SCHEMA_VERSION + 1,
    nodeVersion: '18.0.0', nodeMajor: 18,
    cdpUp: false,
    probe: { status: 'not_logged_in' },
    binding: null,
  };
  assert.equal(determineState(broken).state, 'schema_too_new',
    '格式太新的时候，后面每一条判据都是拿旧眼睛看新数据');

  const { schemaVersion, ...noSchema } = broken;
  assert.equal(determineState({ ...noSchema, schemaVersion: SCHEMA_VERSION }).state, 'env_node_unsupported');

  assert.equal(determineState({ ...broken, schemaVersion: SCHEMA_VERSION, nodeMajor: 22 }).state,
    'env_chrome_down', 'Chrome 都没起来的时候，探针那句「没登录」是上一轮的旧话');

  assert.equal(determineState(healthy({ probe: { status: 'not_logged_in' }, binding: other })).state,
    'env_not_logged_in', '没登录排在身份不符前面：没人登录着就无所谓对不对得上');
});

test('判定是纯的：同一份观测判两次结果一模一样，且不碰外面的世界', () => {
  const o = healthy({ binding: null });
  assert.deepEqual(determineState(o), determineState(o));
  // 观测对象本身不被改写 —— 判定只读它。
  assert.deepEqual(o, healthy({ binding: null }));
});

test('缺省观测不崩：什么都没采到时给最保守的结论', () => {
  // nodeMajor 缺失时 undefined < 21 是 false，所以落到 Chrome 那一条 —— 不会假装环境就绪。
  assert.equal(determineState({}).state, 'env_chrome_down');
  assert.equal(determineState(undefined).state, 'env_chrome_down');
});

test('环境七态一个不少，且都在判定表里', () => {
  const env = ['env_node_unsupported', 'env_chrome_down', 'env_not_logged_in', 'env_identity_unknown',
    'env_identity_unbound', 'env_identity_mismatched', 'env_ready'];
  for (const s of env) assert.ok(STATE_ORDER.includes(s), `${s} 不在判定表里`);
  assert.equal(env.length, 7);
});

// —— B 表：任务主干（材料这一段）——

/** 环境全绿、材料也观测过、材料一切正常的那份观测。每个用例只拨坏自己关心的那一项。 */
const withMaterials = (over = {}) => healthy({
  taskObserved: true,
  sourceDir: '/tmp/材料',
  task: { taskId: '75dc9cbb4d', sourceLabel: '材料', workspace: '/tmp/ws',
    currentVersionId: 'v-abc', erpWriteState: null },
  inventoryVersionId: 'v-abc',
  materialCount: 2,
  inventoryStale: false,
  classificationRecorded: true,
  openItems: [],
  pendingImages: [],
  ...over,
});

const item = (kind, over = {}) => ({ kind, materialId: 'm-1', fileName: '发票.pdf',
  note: '说明', blocking: true, ...over });

test('材料那一侧没观测过，就只答环境那半张表', () => {
  const r = determineState(healthy());
  assert.equal(r.state, 'env_ready', '没看过材料就说材料怎么样，那是编的');
});

test('这个目录还没有进行中的任务 —— 内核自己去盘点', () => {
  const r = determineState(withMaterials({ task: null, classificationRecorded: false }));
  assert.equal(r.state, 'task_none');
  assert.equal(r.actor, 'kernel');
});

test('材料目录变过了 —— 内核自己发现盘点过期，不靠谁记得说一声', () => {
  // 版本对不对得上是采集那一侧比出来的（observe），这里判的是比完的结论。
  const r = determineState(withMaterials({ inventoryVersionId: 'v-新的', inventoryStale: true }));
  assert.equal(r.state, 'inventory_stale', '任务上记的版本和此刻目录里的对不上');
  assert.equal(r.actor, 'kernel');
});

test('有待办就停在待办上，并逐条说清楚谁能解决它', () => {
  const r = determineState(withMaterials({
    openItems: [
      item('read_error', { fileName: '坏了.pdf' }),
      item('no_text_in_pdf', { fileName: '扫描件.pdf' }),
      item('extension_mismatch', { fileName: '其实是png.pdf', blocking: false }),
    ],
  }));
  assert.equal(r.state, 'intake_open_items');
  assert.equal(r.actor, 'user');
  assert.equal(r.blockedBy.length, 3, '不拦路的那条也要有人知道');
  for (const b of r.blockedBy) {
    assert.ok(['user', 'model', 'kernel'].includes(b.resolvableBy), `${b.kind} 没说谁能解决它`);
    assert.ok(b.hint, `${b.kind} 得有一句说明`);
  }
  const by = Object.fromEntries(r.blockedBy.map((b) => [b.kind, b]));
  assert.equal(by.read_error.resolvableBy, 'user', '文件读不出来，只有人能换一份');
  assert.equal(by.extension_mismatch.resolvableBy, 'kernel', '内核已经按内容判了，报出来只为留痕');
  assert.equal(by.extension_mismatch.blocking, false);
});

test('不拦路的开放项不构成待办状态', () => {
  const r = determineState(withMaterials({
    openItems: [item('extension_mismatch', { blocking: false }), item('duplicate_content', { blocking: false })],
  }));
  assert.notEqual(r.state, 'intake_open_items');
  assert.equal(r.blockedBy.length, 2, '照样带着，只是不拦路');
});

test('这一版盘点还没分过类 —— 内核自己去分', () => {
  const r = determineState(withMaterials({ classificationRecorded: false }));
  assert.equal(r.state, 'classify_pending');
  assert.equal(r.actor, 'kernel');
});

test('该看图了：有图没读，就是模型自己动手的那一步', () => {
  const r = determineState(withMaterials({
    openItems: [item('image_awaiting_reading', { fileName: '发票.png' })],
    pendingImages: [{ materialId: 'm-1', fileName: '发票.png', absPath: '/tmp/材料/发票.png' }],
  }));
  assert.equal(r.state, 'image_awaiting_reading');
  assert.equal(r.actor, 'model');
  assert.equal(r.blockedBy[0].resolvableBy, 'model', '这一条不用麻烦用户，我自己看');
});

test('图换过了要重读，读完的读数要人确认', () => {
  const stale = determineState(withMaterials({ openItems: [item('reading_stale', { fileName: '发票.png' })] }));
  assert.equal(stale.state, 'reading_stale');
  assert.equal(stale.actor, 'model');

  const confirm = determineState(withMaterials({
    openItems: [item('reading_awaiting_confirmation', { fileName: '发票.png' })] }));
  assert.equal(confirm.state, 'reading_awaiting_confirmation');
  assert.equal(confirm.actor, 'user', '读数只是候选，认不认只有人说了算');
});

test('材料这一段全清了，才轮到费用事件', () => {
  assert.equal(determineState(withMaterials()).state, 'events_pending');
});

test('B 表的判定顺序：过期压过待办，待办压过看图', () => {
  const all = {
    inventoryStale: true,
    classificationRecorded: false,
    openItems: [item('read_error'), item('image_awaiting_reading', { fileName: '发票.png' })],
  };
  assert.equal(determineState(withMaterials(all)).state, 'inventory_stale',
    '盘点都过期了，基于它算出来的待办是上一轮的旧话');

  assert.equal(determineState(withMaterials({ ...all, inventoryStale: false })).state, 'intake_open_items',
    '有读不出的材料时，先说清楚它，而不是先去看图');

  assert.equal(determineState(withMaterials({ ...all, inventoryStale: false, task: null })).state,
    'task_none', '任务都还没建，谈不上盘点过期');

  assert.equal(determineState(withMaterials({
    ...all, inventoryStale: false, openItems: [item('image_awaiting_reading', { fileName: '发票.png' })],
  })).state, 'classify_pending', '这一版还没落盘的分类，先补上账本');
});

test('格式比内核新时，材料那一段一个字都不判', () => {
  const r = determineState(withMaterials({
    schemaVersion: SCHEMA_VERSION + 1, task: null, inventoryStale: true, openItems: [item('read_error')],
  }));
  assert.equal(r.state, 'schema_too_new', '硬停优先于其余一切判定');
  assert.equal(r.blockedBy.length, 1);
});

test('材料这一段的状态一个不少，且都在判定表里', () => {
  const b = ['task_none', 'inventory_stale', 'intake_open_items', 'classify_pending',
    'image_awaiting_reading', 'reading_stale', 'reading_awaiting_confirmation', 'events_pending'];
  for (const s of b) assert.ok(STATE_ORDER.includes(s), `${s} 不在判定表里`);
});
