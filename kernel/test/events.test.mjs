import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { writeTextPdf, TEST_TRANSPORT_INVOICE_TEXT, TEST_ITINERARY_TEXT } from './fixture-pdf.mjs';

// 数据目录必须在导入内核模块之前改掉，否则会写进用户真实的工作区。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-test-'));
process.env.BAOX_HOME = home;

const { parseMaterial } = await import('../src/parse.mjs');
const { buildEvents, eventOpenItems, reconcile, splitTax, submitAllocation, linkEvidence,
  conservingSegments } = await import('../src/events.mjs');
const { createTask } = await import('../src/workspace.mjs');
const { takeInventory } = await import('../src/inventory.mjs');
const { ingestReadings, confirmReadings, loadReading, projectReading } = await import('../src/vision.mjs');

const repo = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const TEST_INV = 'test-transport-invoice.pdf';
const TEST_ITI = 'test-three-trip-itinerary.pdf';
const BLANK_LANDSCAPE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAADklEQVR4nGP4DwMMcBYAs2AR7za3GVIAAAAASUVORK5CYII=',
  'base64',
);
const TEST_PDFS = new Map([
  [TEST_INV, TEST_TRANSPORT_INVOICE_TEXT],
  [TEST_ITI, TEST_ITINERARY_TEXT],
]);
const load = (id, rel) => {
  let absPath = path.join(repo, 'resources', rel);
  if (TEST_PDFS.has(rel)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-events-pdf-'));
    absPath = path.join(dir, rel);
    writeTextPdf(absPath, TEST_PDFS.get(rel));
  }
  return {
    materialId: id, fileName: path.basename(rel), contentHash: `hash-${id}`,
    ...parseMaterial(absPath, 'pdf'),
  };
};

const AA_INV = TEST_INV;
const AA_ITI = TEST_ITI;
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

test('行程单逐段明细取得出来，段数与它自己声明的一致', () => {
  const iti = load('m-iti', AA_ITI);
  const segs = iti.candidates.find((c) => c.field === 'segments').value;
  assert.equal(segs.length, 3);
  assert.deepEqual(segs.map((s) => s.amount), ['26.69', '20.85', '21.65']);
  assert.deepEqual(segs.map((s) => s.date), ['2026-07-09', '2026-07-09', '2026-07-10']);
  assert.equal(segs[0].city, '北京市');
  // 逐段金额之和等于行程单自己的合计，也等于发票价税合计。**这才是自动定案的授权**：
  // 分毫不差意味着这几个数已经被票面自己印证过了，不是系统分摊出来的。
  assert.equal(segs.reduce((a, s) => a + Math.round(Number(s.amount) * 100), 0), 6919);
});

test('多段图片行程单确认后按逐段读数产生多条费用事件', async () => {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-visual-itinerary-'));
  const imagePath = path.join(sourceDir, '三段行程单.png');
  fs.writeFileSync(imagePath, BLANK_LANDSCAPE_PNG);
  const inventory = await takeInventory(sourceDir);
  const itineraryMaterial = inventory.materials[0];
  const task = createTask(sourceDir);

  const verdict = ingestReadings(sourceDir, inventory, task, { version: 1, readings: [{
    materialId: itineraryMaterial.materialId,
    contentHash: itineraryMaterial.contentHash,
    sighted: { shape: 'landscape' },
    docType: 'ride_itinerary',
    fields: { totalAmount: '69.19' },
    segments: [
      { travelDate: '2026-07-09', city: '北京市', origin: '海淀区', destination: '朝阳区', amount: '26.69' },
      { travelDate: '2026-07-09', city: '北京市', origin: '朝阳区', destination: '东城区', amount: '20.85' },
      { travelDate: '2026-07-10', city: '北京市', origin: '东城区', destination: '丰台区', amount: '21.65' },
    ],
    unreadable: [],
  }] })[0];
  assert.equal(verdict.verdict, 'accepted', JSON.stringify(verdict.reasons));
  assert.equal(projectReading(loadReading(task, itineraryMaterial.materialId)), null,
    '逐段读数也必须先经用户确认，不能直接投影成事件证据');
  confirmReadings(task, [itineraryMaterial.materialId]);

  const itinerary = {
    materialId: itineraryMaterial.materialId,
    fileName: itineraryMaterial.fileName,
    contentHash: itineraryMaterial.contentHash,
    ...projectReading(loadReading(task, itineraryMaterial.materialId)),
  };
  const voucher = load('m-inv', AA_INV);
  const built = buildEvents({ versionId: 'visual-itinerary', results: [voucher, itinerary], duplicates: [] }, task);

  assert.equal(built.events.length, 3);
  assert.deepEqual(built.events.map((event) => event.date),
    ['2026-07-09', '2026-07-09', '2026-07-10']);
  assert.deepEqual(built.events.map((event) => event.route),
    ['海淀区 → 朝阳区', '朝阳区 → 东城区', '东城区 → 丰台区']);
  assert.deepEqual(built.events.map((event) => event.amounts.totalCents), [2669, 2085, 2165]);
});

test('证据关联按合计金额相等连线，且要求唯一', () => {
  const c = classificationOf([['m-inv', CC_INV], ['m-iti', CC_ITI], ['m-hi', HOTEL_INV], ['m-hf', HOTEL_FOLIO]]);
  const vouchers = c.results.filter((r) => r.role === 'primary_voucher');
  const refs = c.results.filter((r) => r.role === 'reference');
  const { links, ambiguous, unlinked } = linkEvidence(vouchers, refs);
  assert.deepEqual(links.get('m-inv'), ['m-iti']);
  assert.deepEqual(links.get('m-hi'), ['m-hf']);
  assert.deepEqual(ambiguous, []);
  assert.deepEqual(unlinked, []);
});

test('同一份行程单对上两张同金额的发票 —— 证据归属不唯一就阻塞', () => {
  const c = classificationOf([['m-a', CC_INV], ['m-iti', CC_ITI]]);
  // 造一张金额相同的第二张发票（现实中是两次报销撞了同一个金额）。
  c.results.push({ ...load('m-b', CC_INV), materialId: 'm-b', fileName: 'other.pdf' });
  const built = buildEvents(c, null);
  const items = eventOpenItems(built);
  const bad = items.find((i) => i.kind === 'evidence_ambiguous');
  assert.ok(bad, '应该报证据归属不唯一');
  assert.equal(bad.blocking, true);
});

test('同一张发票对上两份同额行程单 —— 关联对象不唯一就阻塞且不采用任一份', () => {
  const c = classificationOf([
    ['m-inv', CC_INV], ['m-iti-a', CC_ITI], ['m-iti-b', CC_ITI],
  ]);
  const { links, ambiguous } = linkEvidence(
    c.results.filter((r) => r.role === 'primary_voucher'),
    c.results.filter((r) => r.role === 'reference'),
  );
  assert.deepEqual(links.get('m-inv'), []);
  assert.deepEqual(ambiguous, [{
    materialId: 'm-inv',
    sameKind: 'ride_itinerary',
    count: 2,
    references: [
      { materialId: 'm-iti-a', fileName: '【曹操出行-51.63元-1个行程】高德打车电子行程单.pdf' },
      { materialId: 'm-iti-b', fileName: '【曹操出行-51.63元-1个行程】高德打车电子行程单.pdf' },
    ],
  }]);

  const built = buildEvents(c, null);
  assert.equal(built.events[0].referenceMaterialIds.length, 0);
  assert.equal(built.events[0].date, null);
  const item = eventOpenItems(built).find((entry) => entry.kind === 'evidence_ambiguous');
  assert.equal(item.blocking, true);
  assert.deepEqual(item.references, ambiguous[0].references);
});

test('单段交通票：一张票一个事件，日期和城市来自行程单那一行', () => {
  const built = buildEvents(classificationOf([['m-inv', CC_INV], ['m-iti', CC_ITI]]), null);
  assert.equal(built.events.length, 1);
  const e = built.events[0];
  assert.equal(e.date, '2026-08-27');
  assert.equal(e.city, '广州市');
  assert.equal(e.amountSource, 'invoice_face');
  assert.equal(e.amounts.totalCents, 5163);
  assert.deepEqual(eventOpenItems(built).filter((i) => i.blocking), []);
});

test('铁路电子客票：一张票一个事件，乘车日期来自票面', () => {
  const built = buildEvents(classificationOf([['m-rail', RAIL]]), null);
  assert.equal(built.events.length, 1);
  // 乘车日期 2026-08-22，不是开票日期 2026-09-02 —— 费用发生日期永远取乘车日。
  assert.equal(built.events[0].date, '2026-08-22');
  assert.match(built.events[0].route, /合肥南/);
  assert.deepEqual(built.events[0].amounts,
    { netCents: 70300, taxCents: 0, totalCents: 70300 });
  assert.equal(built.events[0].amountSource, 'rail_total_tax_zero_rule');
  // 票面层仍如实标记没有净额；业务默认只落在费用事件，不伪装成 OCR 结果。
  assert.equal(reconcile(built, classificationOf([['m-rail', RAIL]]))[0].net, 'not_on_face');
});

test('住宿：入住日期来自结账单，没有结账单就没有费用发生日期', () => {
  const withFolio = buildEvents(classificationOf([['m-hi', HOTEL_INV], ['m-hf', HOTEL_FOLIO]]), null);
  assert.equal(withFolio.events[0].date, '2026-08-09');
  assert.equal(withFolio.events[0].checkOut, '2026-08-22');
  assert.equal(withFolio.lineItems[0].checkOut, '2026-08-22');
  assert.equal(withFolio.lineItems[0].endDate, '2026-08-22');

  const alone = buildEvents(classificationOf([['m-hi', HOTEL_INV]]), null);
  assert.equal(alone.events[0].date, null);
  // 开票日期不是费用发生日期，绝不拿来顶替。
  const item = eventOpenItems(alone).find((i) => i.kind === 'event_date_missing');
  assert.ok(item && item.blocking);
});

/** 把行程单某一段的金额改掉，让逐段之和不再等于票面价税合计。 */
function skewItinerary(c, delta = '0.01') {
  const segs = c.results.find((r) => r.materialId === 'm-iti')
    .candidates.find((x) => x.field === 'segments').value;
  segs[0] = { ...segs[0], amount: (Number(segs[0].amount) + Number(delta)).toFixed(2) };
  return c;
}

test('合并交通票：各段之和与价税合计分毫不差时，内核直接定案，一个字都不问', () => {
  const c = classificationOf([['m-inv', AA_INV], ['m-iti', AA_ITI]]);
  const built = buildEvents(c, null);          // 注意：没有 task，也就没有任何用户分摊
  assert.equal(built.events.length, 3, '26.69 + 20.85 + 21.65 = 69.19，正好是票面价税合计');
  assert.deepEqual(built.events.map((e) => e.amounts.totalCents), [2669, 2085, 2165]);
  assert.deepEqual(built.events.map((e) => e.amountSource), Array(3).fill('itinerary_conserved'),
    '来源要认得出是"和票面核对上的行程单"，不是"用户报的"');
  // 三项分别守恒，而且没有任何一条待办 —— 这一整张票没有惊动用户。
  const rec = reconcile(built, c)[0];
  assert.deepEqual([rec.net, rec.tax, rec.total], ['ok', 'ok', 'ok']);
  assert.deepEqual(eventOpenItems(built).filter((i) => i.blocking), []);
});

test('普通发票只要关联完整行程单，也按逐段证据拆分而不是误作住宿', () => {
  const c = classificationOf([['m-inv', AA_INV], ['m-iti', AA_ITI]]);
  const voucher = c.results.find((r) => r.materialId === 'm-inv');
  voucher.kind = 'vat_common';
  const built = buildEvents(c, null);
  assert.equal(built.events.length, 3);
  assert.deepEqual(built.events.map((event) => event.amounts.totalCents), [2669, 2085, 2165]);
  assert.deepEqual(built.events.map((event) => event.amountSource), Array(3).fill('itinerary_conserved'));
  assert.deepEqual(eventOpenItems(built).filter((i) => i.blocking), []);
});

test('合并交通票：差一分钱就得问用户，行程单金额只作候选', () => {
  const c = skewItinerary(classificationOf([['m-inv', AA_INV], ['m-iti', AA_ITI]]));
  const built = buildEvents(c, null);
  // 对不上时不产生任何事件 —— 不能先按票面总额建一个事件再"回头修"。
  assert.equal(built.events.length, 0);
  const item = eventOpenItems(built).find((i) => i.kind === 'allocation_required');
  assert.ok(item);
  assert.equal(item.blocking, true);
  assert.equal(item.segmentCount, 3);
  assert.equal(item.totalAmount, '69.19');
  // 行程单金额只作候选摆出来，没有被自动采用 —— 它自己就不平。
  assert.deepEqual(item.candidateFromItinerary, ['26.70', '20.85', '21.65']);
});

test('起终点坐标归并失败时形成 route_incomplete 阻塞，不保留半截路线', () => {
  const c = classificationOf([['m-inv', AA_INV], ['m-iti', AA_ITI]]);
  const itinerary = c.results.find((r) => r.materialId === 'm-iti');
  const segments = itinerary.candidates.find((x) => x.field === 'segments').value;
  segments[0] = { ...segments[0], origin: null, destination: null, route: null, routeComplete: false };
  const built = buildEvents(c, null);
  const item = eventOpenItems(built).find((x) => x.kind === 'route_incomplete');
  assert.ok(item);
  assert.equal(item.blocking, true);
  assert.equal(built.events.find((x) => x.index === 1).route, null);
});

test('分毫不差的判据不给一分钱的容差，也不认缺金额的行程单', () => {
  assert.deepEqual(conservingSegments([{ amount: '26.69' }, { amount: '42.50' }], 6919), [2669, 4250]);
  assert.equal(conservingSegments([{ amount: '26.69' }, { amount: '42.51' }], 6919), null, '差一分就不算');
  assert.equal(conservingSegments([{ amount: '26.69' }, { amount: null }], 6919), null, '缺一段就不算');
  assert.equal(conservingSegments(null, 6919), null);
});

test('用户提交逐段金额之后才拆出三条候选明细，且三项金额分别守恒', () => {
  const c = skewItinerary(classificationOf([['m-inv', AA_INV], ['m-iti', AA_ITI]]));
  const task = createTask(fs.mkdtempSync(path.join(os.tmpdir(), 'baox-src-')));
  const voucher = c.results.find((r) => r.materialId === 'm-inv');

  const r = submitAllocation(task, voucher, ['26.69', '20.85', '21.65'], 3);
  assert.equal(r.verdict, 'accepted');

  const built = buildEvents(c, task);
  assert.equal(built.events.length, 3);
  assert.deepEqual(built.events.map((e) => e.amounts.totalCents), [2669, 2085, 2165]);
  assert.deepEqual(built.events.map((e) => e.amounts.netCents), [2591, 2024, 2102]);
  assert.deepEqual(built.events.map((e) => e.amounts.taxCents), [78, 61, 63]);
  assert.deepEqual(built.events.map((e) => e.amountSource), Array(3).fill('user_allocation'));
  assert.deepEqual(built.events.map((e) => e.date), ['2026-07-09', '2026-07-09', '2026-07-10']);

  const rec = reconcile(built, c)[0];
  assert.deepEqual([rec.net, rec.tax, rec.total], ['ok', 'ok', 'ok']);
  assert.deepEqual(eventOpenItems(built).filter((i) => i.blocking), []);
  assert.equal(built.lineItems.length, 3);
  assert.equal(built.lineItems[0].category, null, '费用类别不在这一层推断');
});

test('逐段金额之和差一分也不收', () => {
  const c = skewItinerary(classificationOf([['m-inv', AA_INV], ['m-iti', AA_ITI]]));
  const task = createTask(fs.mkdtempSync(path.join(os.tmpdir(), 'baox-src-')));
  const voucher = c.results.find((r) => r.materialId === 'm-inv');
  const r = submitAllocation(task, voucher, ['26.70', '20.85', '21.65'], 3);
  assert.equal(r.verdict, 'rejected');
  assert.match(r.reasons.join(), /差 0\.01/);
});

test('段数对不上、金额格式不对、负数金额都不收', () => {
  const c = classificationOf([['m-inv', AA_INV], ['m-iti', AA_ITI]]);
  const task = createTask(fs.mkdtempSync(path.join(os.tmpdir(), 'baox-src-')));
  const v = c.results.find((r) => r.materialId === 'm-inv');
  assert.equal(submitAllocation(task, v, ['69.19'], 3).verdict, 'rejected');
  assert.equal(submitAllocation(task, v, ['26.69', '20.85', '21.6'], 3).verdict, 'rejected');
  assert.equal(submitAllocation(task, v, ['-26.69', '95.88', '0.00'], 3).verdict, 'rejected');
});

test('发票材料换了以后，之前提交的分摊立即失效', () => {
  // 行程单自己不平，所以这张票只能靠用户的分摊 —— 分摊一失效就没有别的来源顶上。
  const c = skewItinerary(classificationOf([['m-inv', AA_INV], ['m-iti', AA_ITI]]));
  const task = createTask(fs.mkdtempSync(path.join(os.tmpdir(), 'baox-src-')));
  submitAllocation(task, c.results.find((r) => r.materialId === 'm-inv'), ['26.69', '20.85', '21.65'], 3);
  assert.equal(buildEvents(c, task).events.length, 3);

  c.results.find((r) => r.materialId === 'm-inv').contentHash = 'hash-changed';
  const built = buildEvents(c, task);
  assert.equal(built.events.length, 0);
  assert.ok(eventOpenItems(built).find((i) => i.kind === 'allocation_stale' && i.blocking));
});

test('用户给过的分摊压过行程单：他是对着原件报的数', () => {
  const c = classificationOf([['m-inv', AA_INV], ['m-iti', AA_ITI]]);   // 行程单本来分毫不差
  const task = createTask(fs.mkdtempSync(path.join(os.tmpdir(), 'baox-src-')));
  submitAllocation(task, c.results.find((r) => r.materialId === 'm-inv'), ['30.00', '20.00', '19.19'], 3);
  const built = buildEvents(c, task);
  assert.deepEqual(built.events.map((e) => e.amounts.totalCents), [3000, 2000, 1919]);
  assert.deepEqual(built.events.map((e) => e.amountSource), Array(3).fill('user_allocation'));
});

test('拆税额只按票面比例把已定的价税合计切成两截，余数落在最大的一段并如实报出', () => {
  // 100.00 = 97.09 + 2.91（3% 征收率）。两段 50.00 时按比例各得 48.545 分，
  // 四舍五入后相加会多/少一分，这一分必须落在确定的一段上，而不是悄悄抹掉。
  const s = splitTax([5000, 5000], 9709, 291);
  assert.equal(s.nets.reduce((a, b) => a + b, 0), 9709);
  assert.equal(s.taxes.reduce((a, b) => a + b, 0), 291);
  assert.equal(s.residueOn, 0, '并列时取最靠前的一段');
  assert.equal(s.residueCents, -1);
  // 票面三项本身不守恒时，拆分直接放弃，不硬凑。
  assert.equal(splitTax([5000, 5000], 9709, 292), null);
});

test.after(() => { fs.rmSync(home, { recursive: true, force: true }); });
