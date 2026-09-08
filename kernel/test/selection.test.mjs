import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-test-'));
process.env.BAOX_HOME = home;

const { parseMaterial } = await import('../src/parse.mjs');
const { buildEvents } = await import('../src/events.mjs');
const { deriveCategory, applySelection, submitSelection, loadSelection, linesDigest }
  = await import('../src/selection.mjs');
const { normalizeCity, CATEGORIES } = await import('../src/categories.mjs');
const { createTask } = await import('../src/workspace.mjs');
const binding = { account: 'employee.test', tenant: 'tenant-a', homeCity: '广州市' };
const createBoundTask = (dir) => createTask(dir, binding);

const repo = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const load = (id, rel) => ({
  materialId: id, fileName: path.basename(rel), contentHash: `hash-${id}`,
  ...parseMaterial(path.join(repo, 'resources', rel), 'pdf'),
});

const CC_INV = '交通/【曹操出行-51.63元-1个行程】高德打车电子发票.pdf';
const CC_ITI = '交通/【曹操出行-51.63元-1个行程】高德打车电子行程单.pdf';
const HOTEL_INV = '住宿/fp-jd.pdf';
const HOTEL_FOLIO = '住宿/zd-jd.pdf';
const RAIL = '长途/26349119423005877606.pdf';

const classificationOf = (pairs) => ({
  versionId: 'v-test',
  results: pairs.map(([id, rel]) => load(id, rel)),
  duplicates: [],
});

const rideCase = () => {
  const c = classificationOf([['m-inv', CC_INV], ['m-iti', CC_ITI]]);
  return { c, built: buildEvents(c) };
};

test('常驻城市决定市内交通算本地还是外地', () => {
  const { c, built } = rideCase();
  const ev = built.events[0];
  assert.ok(ev.city, '这个样本的行程单要能取到城市，否则这条规则无从谈起');

  const here = deriveCategory(ev, c, ev.city);
  assert.equal(here.category, 'local_city_transport');
  assert.equal(CATEGORIES[here.category].expenseItemCode, 'FY008001');

  const away = deriveCategory(ev, c, '与它不同的另一个城市');
  assert.equal(away.category, 'remote_city_transport');
});

test('城市名的"市"字只是写法差异，不是两个城市', () => {
  const { c, built } = rideCase();
  const bare = normalizeCity(built.events[0].city);
  assert.equal(deriveCategory(built.events[0], c, bare).category, 'local_city_transport');
  assert.equal(deriveCategory(built.events[0], c, `${bare}市`).category, 'local_city_transport');
});

test('铁路客票按票种归入长途交通，与常驻城市无关', () => {
  const c = classificationOf([['m-rail', RAIL]]);
  const built = buildEvents(c);
  const d = deriveCategory(built.events[0], c, '广州市');
  assert.equal(d.category, 'long_distance');
  assert.equal(CATEGORIES[d.category].expenseItemCode, 'FY010003');
});

test('住宿的依据是关联上的酒店结账单，不是票种', () => {
  const c = classificationOf([['m-hi', HOTEL_INV], ['m-hf', HOTEL_FOLIO]]);
  const built = buildEvents(c);
  const d = deriveCategory(built.events[0], c, '广州市');
  assert.equal(d.category, 'accommodation');
  assert.equal(CATEGORIES[d.category].expenseItemCode, 'FY010001');

  // 同一张发票，去掉结账单证据就推不出来了 —— 这时候必须阻塞，不能默认按住宿走。
  const alone = classificationOf([['m-hi', HOTEL_INV]]);
  const d2 = deriveCategory(buildEvents(alone).events[0], alone, '广州市');
  assert.equal(d2.category, null);
  assert.equal(d2.reason, 'category_undecidable');
});

test('取不到费用发生城市时不拿常驻城市顶替', () => {
  const { c, built } = rideCase();
  const d = deriveCategory({ ...built.events[0], city: null }, c, '广州市');
  assert.equal(d.category, null);
  assert.equal(d.reason, 'category_city_missing');
});

test('外地市内交通用公司对照表里的 FY010002，但在 ERP 上落过之前一直标着未确认', () => {
  const task = createTask(path.join(home, 'src-remote'), {
    ...binding, homeCity: '与它不同的另一个城市',
  });
  const { c, built } = rideCase();
  const r = submitSelection(task, built, {
    homeCity: '与它不同的另一个城市', purpose: '客户支持',
    projects: Object.fromEntries(built.lineItems.map((l) => [l.lineId, '111454'])),
  });
  assert.equal(r.verdict, 'accepted');

  const applied = applySelection(built, c, loadSelection(task), null, task.homeCity);
  assert.equal(applied.lines[0].category, 'remote_city_transport');
  assert.equal(applied.lines[0].expenseItemCode, 'FY010002');
  assert.equal(applied.lines[0].expenseItemSource, 'user_declared');

  // 不拦，但必须出声 —— 而且说清楚第一次保存之后要核对什么。
  assert.deepEqual(applied.notes.filter((n) => n.blocking), []);
  const note = applied.notes.find((n) => n.kind === 'expense_item_unconfirmed');
  assert.ok(note);
  assert.match(note.note, /还没有在真实 ERP 上保存并回读确认过/);
});

test('对照表里每一条要么有编码和来源，要么留空并说明为什么阻塞', () => {
  for (const [key, cat] of Object.entries(CATEGORIES)) {
    if (cat.expenseItemCode) {
      assert.ok(cat.source, `${key} 有编码就必须有来源`);
      assert.ok(cat.verifiedBy, `${key} 有编码就必须说得出依据`);
      if (cat.source !== 'erp_save_readback') {
        assert.ok(cat.unconfirmedNote, `${key} 的编码还没在 ERP 上确认过，必须带提示`);
      }
    } else {
      assert.ok(cat.blockedNote, `${key} 没有编码就必须说明为什么`);
    }
  }
});

test('没有任务选择就没有费用类别，也没有项目 —— 整批停在阻塞上', () => {
  const { c, built } = rideCase();
  const applied = applySelection(built, c, null, null, '广州市');
  assert.equal(applied.applied, false);
  assert.equal(applied.lines[0].category, null);
  assert.equal(applied.lines[0].project, null);
  assert.deepEqual(applied.notes.map((n) => n.kind), ['task_selection_required']);
});

test('提交只要求任务级事实：事由和每一行的项目', () => {
  const task = createBoundTask(path.join(home, 'src-bad'));
  const { built } = rideCase();
  const lineId = built.lineItems[0].lineId;

  assert.deepEqual(
    submitSelection(task, built, { purpose: '', projects: {} }).reasons,
    ['报销事由必须填写，且不超过 100 个字', `明细 ${lineId} 还没有选项目`]);

  const extra = submitSelection(task, built, {
    homeCity: '广州市', purpose: '客户支持', projects: { [lineId]: '111454', 'ev-99': '111454' },
  });
  assert.equal(extra.verdict, 'rejected');
  assert.match(extra.reasons[0], /不存在的明细 ev-99/);

  // 一次都没收下，工作区里就不该留下选择记录。
  assert.equal(loadSelection(task), null);
});

test('明细变了，之前的项目归属就不再对应这几行', () => {
  const task = createBoundTask(path.join(home, 'src-stale'));
  const { c, built } = rideCase();
  submitSelection(task, built, {
    homeCity: built.events[0].city, purpose: '客户支持',
    projects: Object.fromEntries(built.lineItems.map((l) => [l.lineId, '111454'])),
  });
  const ok = applySelection(built, c, loadSelection(task), null, task.homeCity);
  assert.equal(ok.applied, true);
  assert.equal(ok.lines[0].expenseItemCode, 'FY008001');
  assert.equal(ok.lines[0].project, '111454');
  assert.equal(ok.lines[0].purpose, '客户支持');
  assert.equal(ok.lines[0].projectSource, 'user_input_unverified');
  assert.deepEqual(ok.notes, []);

  // 金额变一分就是另一批明细了（现实里对应重新分摊过的合并交通票）。
  const moved = { ...built, lineItems: [{ ...built.lineItems[0], totalAmount: '51.62' }] };
  assert.notEqual(linesDigest(moved), linesDigest(built));
  const stale = applySelection(moved, c, loadSelection(task), null, task.homeCity);
  assert.equal(stale.applied, false);
  assert.deepEqual(stale.notes.map((n) => n.kind), ['task_selection_stale']);
});

test('项目号只有在 ERP 只读核对确认之后才升级来源，且核对随明细一起失效', () => {
  const task = createBoundTask(path.join(home, 'src-catalog'));
  const { c, built } = rideCase();
  submitSelection(task, built, {
    homeCity: '广州', purpose: '客户支持',
    projects: Object.fromEntries(built.lineItems.map((l) => [l.lineId, '111454'])),
  });
  const selection = loadSelection(task);

  // 没有核对记录：如实记成用户填的、没验过。
  assert.equal(applySelection(built, c, selection, null, task.homeCity).lines[0].projectSource,
    'user_input_unverified');

  const verified = {
    linesDigest: linesDigest(built),
    versionId: built.versionId,
    projects: { 111454: { verdict: 'confirmed', name: '某某项目' } },
  };
  assert.equal(applySelection(built, c, selection, verified, task.homeCity).lines[0].projectSource,
    'erp_catalog_confirmed');

  // 核对说这个号有问题时，绝不能因为"有过一份核对记录"就升级。
  const bad = { ...verified, projects: { 111454: { verdict: 'missing' } } };
  assert.equal(applySelection(built, c, selection, bad, task.homeCity).lines[0].projectSource,
    'user_input_unverified');

  // 明细指纹变了，旧的核对结论不再适用于现在这几行。
  const stale = { ...verified, linesDigest: 'something-else' };
  assert.equal(applySelection(built, c, selection, stale, task.homeCity).lines[0].projectSource,
    'user_input_unverified');
});

test('换一张明细形状相同的发票，旧的任务选择和 ERP 核对都不能被继承', () => {
  const task = createBoundTask(path.join(home, 'src-version'));
  const { c, built } = rideCase();
  submitSelection(task, built, {
    homeCity: '广州', purpose: '客户支持',
    projects: Object.fromEntries(built.lineItems.map((l) => [l.lineId, '111454'])),
  });
  const selection = loadSelection(task);
  const verified = {
    linesDigest: linesDigest(built),
    versionId: built.versionId,
    projects: { 111454: { verdict: 'confirmed', name: '某某项目' } },
  };
  assert.equal(applySelection(built, c, selection, verified, task.homeCity).lines[0].projectSource,
    'erp_catalog_confirmed');

  // 用户换掉了发票文件，于是有了新的盘点版本 —— 但新发票的日期、城市、价税合计
  // 和旧的一模一样，所以明细指纹一动不动。指纹自己拦不住这一种，版本才拦得住。
  const rebuilt = { ...built, versionId: 'v-test-2' };
  assert.equal(linesDigest(rebuilt), linesDigest(built),
    '这个用例的前提就是指纹相同；指纹一旦也变了，它测的就不是版本这条线了');

  const after = applySelection(rebuilt, c, selection, verified, task.homeCity);
  assert.equal(after.applied, false, '换了材料之后旧的任务选择不能继续生效');
  assert.deepEqual(after.notes.map((n) => n.kind), ['task_selection_stale']);

  // 重新提交选择之后，那份旧的核对记录仍然不算数 —— 它核对的是另一批材料。
  submitSelection(task, rebuilt, {
    homeCity: '广州', purpose: '客户支持',
    projects: Object.fromEntries(rebuilt.lineItems.map((l) => [l.lineId, '111454'])),
  });
  assert.equal(applySelection(rebuilt, c, loadSelection(task), verified, task.homeCity).lines[0].projectSource,
    'user_input_unverified', '旧核对记录绑的是旧版本，不能升级新材料上的项目号');
});
