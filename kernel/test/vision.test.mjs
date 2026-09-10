import { fixtureMaterial } from './fixture-materials.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

// 必须在导入内核模块之前改掉数据目录，否则会写进用户真实的工作区。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-test-'));
process.env.BAOX_HOME = home;

const { takeInventory } = await import('../src/inventory.mjs');
const { createTask } = await import('../src/workspace.mjs');
const { ingestReadings, confirmReadings, disputeReading, loadReading, loadRejection,
  pendingConfirmations, projectReading, MAX_EMPTY_READINGS } = await import('../src/vision.mjs');
const { invoiceIdentity } = await import('../src/parse.mjs');

const repo = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');

// 一个只有一张图片的材料目录。图片由测试生成，保证格式识别走的是正常路径。
const src = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-src-'));
fs.copyFileSync(fixtureMaterial('交通', 'fengyun-1.png'), path.join(src, 'invoice.png'));

const inventory = await takeInventory(src);
const material = inventory.materials[0];
const task = createTask(src);

const submit = (reading) =>
  ingestReadings(src, inventory, task, { version: 1, readings: [reading] })[0];

// fengyun-1.png 是 1816×1396，宽高比 1.30 —— 横着的。
// 这个值是**看着图才答得上**的，所以它在每一份合法读数里都必须在。
const good = () => ({
  materialId: material.materialId,
  contentHash: material.contentHash,
  sighted: { shape: 'landscape' },
  docType: 'invoice',
  fields: {
    invoiceNumber: '26427000000640558021',
    issueDate: '2026-09-04',
    netAmount: '18.25', taxAmount: '0.55', totalAmount: '18.80',
  },
  unreadable: [],
});

test('逐字抄对了就收下，并且金额守恒', () => {
  const v = submit(good());
  assert.equal(v.verdict, 'accepted');
  assert.equal(v.amountCheck, 'balanced');
});

test('本机 OCR 来源不冒充模型看图凭据，但仍要过哈希和金额守恒', () => {
  const reading = good();
  delete reading.sighted;
  reading.source = 'ocr';
  const accepted = submit(reading);
  assert.equal(accepted.verdict, 'accepted');
  assert.equal(loadReading(task, material.materialId).source, 'ocr');

  const wrong = { ...reading, fields: { ...reading.fields, netAmount: '18.30' } };
  const rejected = submit(wrong);
  assert.equal(rejected.verdict, 'rejected');
  assert.match(rejected.reasons.join(), /不含税金额 \+ 税额/);
});

test('内容哈希对不上就作废 —— 读数必须绑定在确定的字节上', () => {
  const v = submit({ ...good(), contentHash: '0'.repeat(64) });
  assert.equal(v.verdict, 'rejected');
  assert.match(v.reasons.join(), /内容哈希/);
});

test('金额凑不平就打回，不给"接近就行"的余地', () => {
  const r = good();
  r.fields.netAmount = '18.30';
  const v = submit(r);
  assert.equal(v.verdict, 'rejected');
  assert.match(v.reasons.join(), /不含税金额 \+ 税额/);
});

test('发票号码不是 20 位就打回', () => {
  const r = good();
  r.fields.invoiceNumber = '2642700000064055802';
  assert.equal(submit(r).verdict, 'rejected');
});

test('未来的开票日期一定是读错了', () => {
  const r = good();
  r.fields.issueDate = '2031-01-01';
  assert.equal(submit(r).verdict, 'rejected');
});

test('表外的字段一律拒收，不给自由发挥留缝', () => {
  const r = good();
  r.fields.projectCode = '111454';
  const v = submit(r);
  assert.equal(v.verdict, 'rejected');
  assert.match(v.reasons.join(), /不认识的字段/);
});

test('说是发票却给不出发票号码，无法做重复检查', () => {
  const r = good();
  delete r.fields.invoiceNumber;
  const v = submit(r);
  assert.equal(v.verdict, 'rejected');
  assert.match(v.reasons.join(), /重复检查/);
});

test('被拒的提交不会覆盖已经存下来的合法读数', () => {
  submit(good());
  submit({ ...good(), contentHash: '0'.repeat(64) });
  assert.equal(loadReading(task, material.materialId).fields.invoiceNumber, '26427000000640558021');
});

test('没确认的读数不投影成事实，确认之后才投影', () => {
  submit(good());
  assert.equal(projectReading(loadReading(task, material.materialId)), null);

  confirmReadings(task, [material.materialId]);
  const projected = projectReading(loadReading(task, material.materialId));
  assert.equal(projected.role, 'primary_voucher');
  assert.equal(projected.fields.totalAmount.cents, 1880);
  // 确认之后它和 PDF 解析出来的发票一样参与重复检查。
  assert.equal(invoiceIdentity(projected).scheme, 'einvoice-20');
  assert.match(projected.evidence.invoiceNumber, /确认于/);
});

test('重新提交同一份字节的读数会保留原有确认', () => {
  submit(good());
  assert.ok(loadReading(task, material.materialId).confirmedAt, '内容没变，确认不该被冲掉');
});

test('改了字段再提交，旧的确认不再算数 —— 用户没看过新的读数', () => {
  submit(good());
  assert.ok(loadReading(task, material.materialId).confirmedAt);

  const changed = good();
  changed.fields.sellerName = '某某科技有限公司';
  submit(changed);
  const after = loadReading(task, material.materialId);
  assert.equal(after.confirmedAt, null, '字节没变但读数变了，确认必须失效');
  assert.equal(projectReading(after), null);
});

// —— 看过的凭据：没打开过图就交不上读数 ——
//
// 0.9.2 真机上模型一张图没看就说「图片显示不出来」，让用户回去重新导出材料。
// 下面这几条钉的就是那件事在机制上过不去。

test('没报形状的读数一律不算数 —— 没看过图，字段对不对都无从谈起', () => {
  const r = good();
  delete r.sighted;
  const v = submit(r);
  assert.equal(v.verdict, 'rejected');
  assert.match(v.reasons.join(), /没有真的打开过/);
});

test('形状报错了就是没看过：字段全对也照样打回', () => {
  const v = submit({ ...good(), sighted: { shape: 'portrait' } });
  assert.equal(v.verdict, 'rejected');
  assert.match(v.reasons.join(), /sighted\.shape/);
});

test('说「看不清」也要先证明在看：形状照样得答对', () => {
  const v = submit({ materialId: material.materialId, contentHash: material.contentHash,
    sighted: { shape: 'tall' }, docType: 'unreadable', fields: {},
    unreadable: ['invoiceNumber', 'totalAmount'] });
  assert.equal(v.verdict, 'rejected');
  assert.match(v.reasons.join(), /没有真的打开过/);
});

test('看着图说这几个字段认不出来，是合法答案', () => {
  // 抄下来了一部分，另外几个字段认不出 —— 这才是「看不清」本来的样子：
  // 它是**这张图上的某个字段**认不出，而不是这张图没被看见。
  const v = submit({ materialId: material.materialId, contentHash: material.contentHash,
    sighted: { shape: 'landscape' }, docType: 'ride_itinerary',
    fields: { city: '深圳', travelDate: '2026-09-04' },
    unreadable: ['origin', 'destination'] });
  assert.equal(v.verdict, 'accepted', JSON.stringify(v.reasons));
});

test('整张图一个字段都没抄下来，不算「看不清」，算没看见', () => {
  // 真机 QA 里的那一份读数：形状答对了（外部工具就答得出），字段全空。
  // 它被收下之后，用户在确认表上看到的是一张什么都没有的表。
  const empty = { materialId: material.materialId, contentHash: material.contentHash,
    sighted: { shape: 'landscape' }, docType: 'unreadable', fields: {},
    unreadable: ['invoiceNumber', 'totalAmount'] };
  const first = submit(empty);
  assert.equal(first.verdict, 'rejected');
  assert.match(first.reasons.join(), /一个字段都没有/);
  // 驳回里要点名外部识图工具不算数 —— QA 现场模型正是转头去找它们的。
  assert.match(first.reasons.join(), /tesseract|OCR/);
  assert.equal(loadRejection(task, material.materialId).emptyReadings, 1);

  // 再空一次就不再是模型的事：到上限之后这张图不再派工单，变成摆给用户的开放项。
  submit(empty);
  assert.equal(loadRejection(task, material.materialId).emptyReadings, MAX_EMPTY_READINGS);
});

test('被驳回的理由要活到下一次读取 —— 那是重读唯一有用的输入', () => {
  const r = good();
  r.fields.netAmount = '18.30';                     // 守恒式不平
  submit(r);
  const rejection = loadRejection(task, material.materialId);
  assert.equal(rejection.contentHash, material.contentHash);
  assert.match(rejection.reasons.join(), /不含税金额 \+ 税额/);

  // 重读过了，上一次的理由就不再是待办。
  submit(good());
  assert.equal(loadRejection(task, material.materialId), null);
});

// —— 终端确认与纠正 ——

test('驳回不回报正解 —— 那是一道凭据，不是一道有反馈的题', () => {
  const v = submit({ ...good(), sighted: { shape: 'portrait' } });
  const why = v.reasons.join();
  assert.doesNotMatch(why, /landscape/, '说出正解，五选一就变成了送分题');
  assert.doesNotMatch(why, /portrait \/ square/, '把五个选项列在驳回里，等于教它怎么试');
});

test('连着答不出凭据就不再让模型重试 —— 五选一是试得出来的', async () => {
  const { MAX_SIGHT_FAILURES } = await import('../src/vision.mjs');
  const { classifyInventory, classifyOpenItems } = await import('../src/classify.mjs');

  // 先把先前那份已被收下的读数推翻，回到「这张图还没有可用读数」的处境 ——
  // 已经有一份收下的读数时，后来交的废话本来就动不了它。
  disputeReading(task, material.materialId, { totalAmount: '99.99' });

  for (let i = 0; i < MAX_SIGHT_FAILURES; i += 1) {
    submit({ ...good(), sighted: { shape: 'tall' } });
  }
  // 计数跨提交累加：每次重来都清零的话，这道闸拦不住任何东西。
  assert.ok(loadRejection(task, material.materialId).sightFailures >= MAX_SIGHT_FAILURES);

  const items = classifyOpenItems(classifyInventory(src, inventory, task));
  const escalated = items.find((it) => it.kind === 'sight_unproven');
  assert.ok(escalated, '到了上限就该变成一条摆给用户看的开放项');
  assert.ok(escalated.blocking);

  // 从此这张图不再出现在工单里：再派一次只是再试一次。
  const { buildWorkOrder } = await import('../src/vision.mjs');
  const order = buildWorkOrder(src, inventory, classifyInventory(src, inventory, task), task);
  assert.equal(order.length, 0);

  // 用户换了一份文件，计数跟着字节走，从头开始。
  fs.copyFileSync(fixtureMaterial('交通', '行程单.png'), path.join(src, 'invoice.png'));
  const fresh = await takeInventory(src);
  const freshItems = classifyOpenItems(classifyInventory(src, fresh, task));
  assert.ok(!freshItems.some((it) => it.kind === 'sight_unproven'), '换了文件就不该还挂着上一份的账');

  // 把材料换回去，后面的测试仍然对着同一张图。
  fs.copyFileSync(fixtureMaterial('交通', 'fengyun-1.png'), path.join(src, 'invoice.png'));
  submit(good());
});

test('确认记的是终端，不是网页 —— 这条路上再没有页面了', () => {
  submit(good());
  confirmReadings(task, [material.materialId]);
  assert.equal(loadReading(task, material.materialId).confirmedVia, 'terminal');
});

test('待确认表里只有这一版字节上还没确认的读数', () => {
  // 上一条测试已经确认过了，先把它推翻，才回得到「读过、还没确认」那个状态。
  disputeReading(task, material.materialId, { totalAmount: '19.80' });
  submit(good());
  const rows = pendingConfirmations(task, inventory);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fileName, 'invoice.png');
  // 字段带中文名：表格给用户看，键名不给用户看。
  assert.ok(rows[0].fields.some((f) => f.label === '价税合计' && f.value === '18.80'));

  confirmReadings(task, [material.materialId]);
  assert.equal(pendingConfirmations(task, inventory).length, 0, '确认过的不再摆给用户');
});

test('用户改了字段：他给的值不落库，先前的确认当场作废', () => {
  submit(good());
  confirmReadings(task, [material.materialId]);
  assert.ok(loadReading(task, material.materialId).confirmedAt);

  const d = disputeReading(task, material.materialId, { invoiceNumber: '26427000000640558099' });
  assert.equal(d.disputed[0].machineValue, '26427000000640558021');
  assert.equal(d.disputed[0].userValue, '26427000000640558099');
  assert.equal(d.disputed[0].source, 'user');
  // 读数作废：既没有被用户的值改写，也不再顶着那次确认往下走。
  assert.equal(loadReading(task, material.materialId), null, '用户的值不直接落库，读数整份作废');
  const rejection = loadRejection(task, material.materialId);
  assert.match(rejection.reasons.join(), /重新打开这张图/);
  assert.match(rejection.reasons.join(), /26427000000640558099/);
  // 被推翻的那次机器读数整份留着：它不再是候选，但它是证据。
  assert.equal(rejection.machineReading.fields.invoiceNumber, '26427000000640558021');
  assert.equal(rejection.machineReading.amountCheck, 'balanced');
});

test.after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});

// —— 随包发出的读数模板必须能过内核校验（skills QA）——
//
// 旧的 SKILL.md 在示例里写了 "sellerName": ""，而 isText 拒收空字符串：
// 照着示例抄的正确读数会被 ocr-submit 打回。示例比散文更容易被仿写，所以
// 模板现在是一个真文件，并且由这条测试钉住它一直是可提交的。
test('内核自带的读数模板 src/reading-template.json 是一份能被收下的读数', () => {
  const tpl = JSON.parse(fs.readFileSync(
    path.join(repo, 'kernel', 'src', 'reading-template.json'), 'utf8'));

  assert.equal(tpl.version, 1, '模板的 version 必须和内核的 READING_VERSION 一致');

  const [reading] = tpl.readings;
  for (const [k, v] of Object.entries(reading.fields)) {
    assert.notEqual(v, '', `模板里的 ${k} 是空字符串，照抄会被内核拒收`);
  }

  // 模板里的 materialId / contentHash 是占位说明，换成这次夹具的真值再提交。
  const v = submit({ ...reading, materialId: material.materialId, contentHash: material.contentHash });
  assert.equal(v.verdict, 'accepted', `模板被拒了：${JSON.stringify(v.reasons)}`);
  assert.equal(v.amountCheck, 'balanced');
});
