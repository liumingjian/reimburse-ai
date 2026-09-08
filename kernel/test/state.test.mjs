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
  binding: { ...me, homeCity: '广州市', confirmedAt: '2026-09-06T00:00:00.000Z' },
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

test('身份已绑定但常驻城市缺失 —— 先完成首次访谈，不进入任务主干', () => {
  const r = determineState(healthy({
    binding: { ...me, confirmedAt: '2026-09-06T00:00:00.000Z' },
  }));
  assert.equal(r.state, 'env_home_city_unbound');
  assert.equal(r.actor, 'user');
  assert.deepEqual(r.blockedBy, [], '缺城市不是硬阻塞，是下一步就能完成的首次访谈');
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

test('环境状态一个不少，且都在判定表里', () => {
  const env = ['env_node_unsupported', 'env_chrome_down', 'env_not_logged_in', 'env_identity_unknown',
    'env_identity_unbound', 'env_identity_mismatched', 'env_home_city_unbound', 'env_ready'];
  for (const s of env) assert.ok(STATE_ORDER.includes(s), `${s} 不在判定表里`);
  assert.equal(env.length, 8);
});

// —— B 表：任务主干（材料这一段）——

/** 环境全绿、材料也观测过、材料一切正常的那份观测。每个用例只拨坏自己关心的那一项。 */
const withMaterials = (over = {}) => healthy({
  taskObserved: true,
  sourceDir: '/tmp/材料',
  task: { taskId: '75dc9cbb4d', sourceLabel: '材料', workspace: '/tmp/ws',
    currentVersionId: 'v-abc', erpWriteState: null, homeCity: '广州市' },
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

test('旧任务没有明确城市快照时必须单独询问，不能套用当前个人绑定', () => {
  const r = determineState(withMaterials({
    task: { taskId: '75dc9cbb4d', sourceLabel: '材料', workspace: '/tmp/ws',
      currentVersionId: 'v-abc', erpWriteState: null, homeCity: null },
  }));
  assert.equal(r.state, 'task_home_city_unbound');
  assert.equal(r.actor, 'user');
  assert.deepEqual(r.blockedBy, [], '这是可完成的安全迁移步骤，不是硬阻塞');
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

test('上次读数没过关：还是模型自己动手，不是拿去麻烦用户', () => {
  const r = determineState(withMaterials({
    openItems: [item('reading_rejected', { fileName: '发票.png' })] }));
  assert.equal(r.state, 'reading_rejected');
  assert.equal(r.actor, 'model');
  assert.equal(r.blockedBy[0].resolvableBy, 'model',
    '守恒式不平的处置是重读，不是让用户去改一个数字');
});

test('内核自己解不开的图，是材料的问题，只有人换得了', () => {
  const r = determineState(withMaterials({
    openItems: [item('image_file_broken', { fileName: '发票.png' })] }));
  assert.equal(r.state, 'intake_open_items', '它不归看图那几个状态，模型看多少遍都一样');
  assert.equal(r.blockedBy[0].resolvableBy, 'user');
});

test('证明不了自己看过图，就不再是模型的事了', () => {
  const r = determineState(withMaterials({
    openItems: [item('sight_unproven', { fileName: '发票.png' })] }));
  assert.equal(r.state, 'intake_open_items', '再让模型读下去只是让它接着试');
  assert.equal(r.blockedBy[0].resolvableBy, 'user');
});

test('看图这几个状态的先后照着规格：先读、再重读、再等确认', () => {
  const i = (s) => STATE_ORDER.indexOf(s);
  assert.ok(i('image_awaiting_reading') < i('reading_rejected'));
  assert.ok(i('reading_rejected') < i('reading_stale'));
  assert.ok(i('reading_stale') < i('reading_awaiting_confirmation'));
});

test('这张票在别的任务里也在 —— 停整批，请用户裁决', () => {
  const r = determineState(withMaterials({
    openItems: [
      item('duplicate_across_tasks', { fileName: '发票.pdf' }),
      item('history_scope_local', { blocking: false, materialId: null, fileName: null }),
    ],
  }));
  assert.equal(r.state, 'duplicate_blocked', '跨任务重复不混进盘点待办：解决它要在两个任务之间裁决');
  assert.equal(r.actor, 'user');
  const by = Object.fromEntries(r.blockedBy.map((b) => [b.kind, b]));
  assert.equal(by.duplicate_across_tasks.resolvableBy, 'user');
  assert.equal(by.history_scope_local.resolvableBy, 'kernel', '查得到多少是内核的范围声明，不用人处理');
});

test('材料这一段全清了，才轮到费用事件', () => {
  assert.equal(determineState(withMaterials()).state, 'events_pending');
});

test('判定表的先后就是状态表的先后 —— 插错位置的状态永远轮不上', () => {
  assert.equal(STATE_ORDER.at(-1), 'env_ready', '兜底永远在最后');
  const order = ['duplicate_blocked', 'events_pending', 'allocation_required', 'allocation_stale',
    'project_unassigned', 'catalog_unverified', 'catalog_mismatch', 'ready_for_erp_write',
    'handed_off_recover'];
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(STATE_ORDER.indexOf(order[i - 1]) < STATE_ORDER.indexOf(order[i]),
      `${order[i - 1]} 要排在 ${order[i]} 前面`);
  }
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
    'image_awaiting_reading', 'reading_stale', 'reading_awaiting_confirmation',
    'duplicate_blocked', 'events_pending'];
  for (const s of b) assert.ok(STATE_ORDER.includes(s), `${s} 不在判定表里`);
});

// —— B 表后半段：事件、分摊、项目、核对、写入前确认 ——
//
// 这一段的判定全部建立在「ERP 这半段观测采过没有」之上（observe.mjs 里的 settled）。
// 没采过时它们整段跳过 —— 材料还没清完就说"该写进 ERP 了"，那是编的。

/** 后半段全绿的那份观测。每个用例只把自己关心的那一项拨坏。 */
const withErp = (over = {}) => withMaterials({
  eventsRecorded: true,
  events: { versionId: 'v-abc', events: [{ eventId: 'ev-01' }], lineItems: [], notes: [] },
  allocationRound: null,
  selectionApplied: true,
  lines: [{ lineId: 'ev-01', voucherMaterialId: 'm-1', date: '2026-07-09', city: '北京市',
    totalAmount: '69.19', project: '111454', category: 'local_city_transport' }],
  homeCity: '北京市',
  purpose: '出差',
  catalogFresh: true,
  catalogProblems: [],
  writePreview: { lines: [], homeCity: '北京市', purpose: '出差', versionId: 'v-abc' },
  writeApproved: false,
  ...over,
});

/** 一轮待问的逐段分摊。 */
const round = (over = {}) => ({
  materialId: 'm-inv', fileName: '合并发票.pdf', contentHash: 'h1',
  segmentCount: 3, totalAmount: '69.19', stale: false,
  answered: [], remaining: 3, rejection: null,
  questions: [{ id: 'm-inv#1', header: '第 1 段', question: '多少钱？', options: [] }],
  ...over,
});

test('材料清完了但这一版还没记过事件划分 —— 内核自己去划', () => {
  const r = determineState(withMaterials({ eventsRecorded: false }));
  assert.equal(r.state, 'events_pending');
  assert.equal(r.actor, 'kernel');
});

test('后半段那半份观测没采过时，一条也不判', () => {
  // 只有 eventsRecorded 为真、events 却没有：这是不可能从 observe 出来的形状，
  // 但判定必须自己站得住 —— 后面每一条都要 erpSeen 才敢开口。
  const r = determineState(withMaterials({ eventsRecorded: true }));
  assert.equal(r.state, 'env_ready', '缺 events 时不冒充成分摊、核对或"可以写了"');
});

test('各段之和对不上才有 allocation_required，而且要说清是哪一张票', () => {
  const r = determineState(withErp({ allocationRound: round() }));
  assert.equal(r.state, 'allocation_required');
  assert.equal(r.actor, 'user');
  assert.equal(r.blockedBy[0].kind, 'allocation_required');
  assert.equal(r.blockedBy[0].materialId, 'm-inv');
  assert.match(r.blockedBy[0].hint, /69\.19/);
});

test('分毫不差时根本不进分摊那两个状态 —— 内核已经定案了', () => {
  // 对得上的那张票在 events.mjs 里就自动定案了，压根不会产生 allocationRound。
  const r = determineState(withErp({ allocationRound: null }));
  assert.notEqual(r.state, 'allocation_required');
  assert.notEqual(r.state, 'allocation_stale');
});

test('发票或盘点变过 —— 是 allocation_stale，不是又问一遍', () => {
  const r = determineState(withErp({ allocationRound: round({ stale: true }) }));
  assert.equal(r.state, 'allocation_stale');
  assert.match(r.blockedBy[0].hint, /变过了/, '用户有权知道这次问他不是因为他没答过');
});

test('还没有项目号 —— 逐条报出来，一条明细一条待办', () => {
  const two = [
    { lineId: 'ev-01', voucherMaterialId: 'm-1', date: '2026-07-09', totalAmount: '26.69', project: null },
    { lineId: 'ev-02', voucherMaterialId: 'm-1', date: '2026-07-10', totalAmount: '20.85', project: '111454' },
  ];
  const r = determineState(withErp({ lines: two }));
  assert.equal(r.state, 'project_unassigned');
  assert.equal(r.blockedBy.length, 1, '只报缺的那一条');
  assert.equal(r.blockedBy[0].lineId, 'ev-01');
  assert.equal(r.blockedBy[0].resolvableBy, 'user');

  // 一次任务选择都还没做过时，整批都缺。
  const none = determineState(withErp({ selectionApplied: false }));
  assert.equal(none.state, 'project_unassigned');
  assert.equal(none.blockedBy.length, 1);
});

test('项目还没在 ERP 里核对过 —— 内核自己去查，不劳驾用户', () => {
  const r = determineState(withErp({ catalogFresh: false }));
  assert.equal(r.state, 'catalog_unverified');
  assert.equal(r.actor, 'kernel');
});

test('ERP 里查无此项目 —— 硬停，且不会再去重复核对', () => {
  const r = determineState(withErp({
    catalogProblems: [{ number: '999999', verdict: 'missing', note: '项目号 999999 在 ERP 项目目录里查不到' }],
  }));
  assert.equal(r.state, 'catalog_mismatch');
  assert.equal(r.actor, 'user');
  assert.equal(r.blockedBy[0].verdict, 'missing');
  assert.match(r.blockedBy[0].hint, /999999/);
  // 「没核对过」和「核对过、不合格」是两回事：后者不能再退回去反复核对。
  assert.notEqual(r.state, 'catalog_unverified');
});

test('以上全绿才轮到写入前确认，而且 actor 是人', () => {
  const r = determineState(withErp());
  assert.equal(r.state, 'ready_for_erp_write');
  assert.equal(r.actor, 'user');
  assert.deepEqual(r.blockedBy, []);
});

test('动过 ERP 的任务不再要一次点头，改为交接给 baox-recover', () => {
  const r = determineState(withErp({
    task: { taskId: '75dc9cbb4d', sourceLabel: '材料', workspace: '/tmp/ws',
      currentVersionId: 'v-abc', erpWriteState: 'dispatched', homeCity: '广州市' },
  }));
  assert.equal(r.state, 'handed_off_recover',
    '一份已经发出去的写入不能再要一次点头 —— 那次点头看起来像是"同意再写一遍"');
});

test('后半段的判定顺序：事件压过分摊，分摊压过项目，项目压过核对', () => {
  const all = { eventsRecorded: false, allocationRound: round(), selectionApplied: false,
    catalogFresh: false };
  assert.equal(determineState(withErp(all)).state, 'events_pending');
  assert.equal(determineState(withErp({ ...all, eventsRecorded: true })).state, 'allocation_required');
  assert.equal(determineState(withErp({ ...all, eventsRecorded: true, allocationRound: null })).state,
    'project_unassigned');
  assert.equal(determineState(withErp({ ...all, eventsRecorded: true, allocationRound: null,
    selectionApplied: true })).state, 'catalog_unverified');
});

test('事件层和选择层的待办也拦得住路，和材料待办同一个出口', () => {
  const r = determineState(withErp({
    openItems: [item('event_date_missing', { note: '这次费用没有可追溯到材料的发生日期' })],
  }));
  assert.equal(r.state, 'intake_open_items');
  assert.equal(r.blockedBy[0].resolvableBy, 'user');
  const gaveUp = determineState(withErp({ openItems: [item('allocation_given_up')] }));
  assert.equal(gaveUp.state, 'intake_open_items');
  assert.equal(gaveUp.blockedBy[0].resolvableBy, 'user');
});
