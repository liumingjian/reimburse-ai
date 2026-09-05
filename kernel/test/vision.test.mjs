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
const { ingestReadings, confirmReadings, loadReading, projectReading } = await import('../src/vision.mjs');
const { invoiceIdentity } = await import('../src/parse.mjs');

const repo = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');

// 一个只有一张图片的材料目录。图片内容用真实样本，保证格式识别走的是正常路径。
const src = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-src-'));
fs.copyFileSync(path.join(repo, 'resources', '交通', 'fengyun-1.png'), path.join(src, 'invoice.png'));

const inventory = await takeInventory(src);
const material = inventory.materials[0];
const task = createTask(src);

const submit = (reading) =>
  ingestReadings(src, inventory, task, { version: 1, readings: [reading] })[0];

const good = () => ({
  materialId: material.materialId,
  contentHash: material.contentHash,
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

test.after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});
