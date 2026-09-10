import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { parseMaterial, invoiceIdentity, checkAmounts, maskNumber } from '../src/parse.mjs';
import { writeTextPdf, TEST_INVOICE_TEXT, TEST_LEGACY_INVOICE_TEXT } from './fixture-pdf.mjs';

// 用 resources/ 里的真实样本做回归。断言一律用**脱敏后的**发票号码，
// 完整号码不写进仓库里的任何文本（原始 PDF 本身另说）。
// 跑：node --test kernel/test/

const repo = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const sample = (rel) => path.join(repo, 'resources', rel);
const parse = (rel, fmt = 'pdf') => parseMaterial(sample(rel), fmt);

const CASES = [
  {
    file: '住宿/fp-jd.pdf',
    kind: 'vat_special', role: 'primary_voucher',
    masked: '2634************3906', issueDate: '2026-08-22',
    net: 343396, tax: 20604, total: 364000, amountCheck: 'balanced',
  },
  {
    // 这张票有负数调整行，合计仍以票面"合计"和"价税合计"为准，不逐行相加。
    file: '交通/【曹操出行-51.63元-1个行程】高德打车电子发票.pdf',
    kind: 'passenger_transport', role: 'primary_voucher',
    masked: '2632************4156', issueDate: '2026-09-02',
    net: 5012, tax: 151, total: 5163, amountCheck: 'balanced',
  },
  {
    // 铁路电子客票票面只有票价：不含税金额和税额缺席是票面事实，不是解析失败。
    file: '长途/26349119423005877606.pdf',
    kind: 'rail_eticket', role: 'primary_voucher',
    masked: '2634************7606', issueDate: '2026-09-02',
    net: null, tax: null, total: 70300, amountCheck: 'partial',
  },
];

for (const c of CASES) {
  test(`主要报销凭证：${c.file}`, () => {
    const r = parse(c.file);
    assert.equal(r.parseStatus, 'parsed');
    assert.equal(r.kind, c.kind);
    assert.equal(r.role, c.role);
    assert.equal(maskNumber(r.fields.invoiceNumber), c.masked);
    assert.equal(r.fields.issueDate, c.issueDate);
    assert.equal(r.fields.netAmount?.cents ?? null, c.net);
    assert.equal(r.fields.taxAmount?.cents ?? null, c.tax);
    assert.equal(r.fields.totalAmount?.cents ?? null, c.total);
    assert.equal(checkAmounts(r.fields).status, c.amountCheck);
    assert.equal(invoiceIdentity(r).scheme, 'einvoice-20');
    assert.ok(r.evidence.invoiceNumber, '发票号码必须有证据行');
  });
}

test('自包含普通发票 fixture：文字层字段、金额守恒和身份都解析出来', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-parse-pdf-'));
  const file = path.join(dir, 'test-invoice.pdf');
  writeTextPdf(file, TEST_INVOICE_TEXT);
  const r = parseMaterial(file, 'pdf');
  assert.equal(r.parseStatus, 'parsed');
  assert.equal(r.kind, 'vat_common');
  assert.equal(maskNumber(r.fields.invoiceNumber), '1234************7890');
  assert.equal(r.fields.issueDate, '2026-09-01');
  assert.equal(checkAmounts(r.fields).status, 'balanced');
  assert.equal(invoiceIdentity(r).scheme, 'einvoice-20');
  assert.ok(r.evidence.invoiceNumber);
});

test('传统增值税电子普通发票交通票：代码与 8 位号码组成独立身份', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-parse-legacy-pdf-'));
  const file = path.join(dir, 'legacy-invoice.pdf');
  writeTextPdf(file, TEST_LEGACY_INVOICE_TEXT);
  const r = parseMaterial(file, 'pdf');
  assert.equal(r.parseStatus, 'parsed');
  assert.equal(r.kind, 'passenger_transport');
  assert.equal(r.role, 'primary_voucher');
  assert.equal(r.fields.invoiceCode, '011002301811');
  assert.equal(r.fields.invoiceNumber, '25627655');
  assert.equal(r.fields.issueDate, '2024-07-04');
  assert.equal(r.fields.netAmount?.cents, 10974);
  assert.equal(r.fields.taxAmount?.cents, 658);
  assert.equal(r.fields.totalAmount?.cents, 11632);
  assert.equal(checkAmounts(r.fields).status, 'balanced');
  assert.equal(maskNumber(r.fields.invoiceNumber), '25****55');
  assert.deepEqual(invoiceIdentity(r), {
    scheme: 'vat-legacy',
    key: 'vat-legacy:011002301811:25627655',
    code: '011002301811',
    number: '25627655',
  });
  assert.ok(r.evidence.invoiceCode);
  assert.ok(r.evidence.invoiceNumber);
});

test('传统票身份也接受 10 位代码，但没有代码不能把 8 位号码伪装成全电身份', () => {
  assert.deepEqual(invoiceIdentity({ role: 'primary_voucher', fields: {
    invoiceCode: '1234567890', invoiceNumber: '12345678',
  } }), {
    scheme: 'vat-legacy', key: 'vat-legacy:1234567890:12345678',
    code: '1234567890', number: '12345678',
  });
  assert.equal(invoiceIdentity({ role: 'primary_voucher', fields: {
    invoiceNumber: '12345678',
  } }), null);
});

const REFERENCES = [
  { file: '交通/【曹操出行-51.63元-1个行程】高德打车电子行程单.pdf', kind: 'ride_itinerary', segments: 1 },
  { file: '住宿/zd-jd.pdf', kind: 'hotel_folio', segments: null },
];

for (const c of REFERENCES) {
  test(`参考材料：${c.file}`, () => {
    const r = parse(c.file);
    assert.equal(r.parseStatus, 'parsed');
    assert.equal(r.kind, c.kind);
    assert.equal(r.role, 'reference');
    // 参考材料没有发票身份，也不参与重复发票判定。
    assert.equal(invoiceIdentity(r), null);
    assert.deepEqual(r.fields, {});
    if (c.segments !== null) {
      assert.equal(r.candidates.find((x) => x.field === 'segmentCount')?.value, c.segments);
    }
  });
}

test('图片材料落到需要 OCR，绝不猜票面事实', () => {
  const r = parse('交通/fengyun-1.png', 'png');
  assert.equal(r.parseStatus, 'needs_ocr');
  assert.equal(r.role, null);
  assert.deepEqual(r.fields, {});
});

test('购买方税号候选不会误取发票号码的一段', () => {
  for (const c of CASES) {
    const r = parse(c.file);
    const buyer = r.candidates.find((x) => x.field === 'buyerTaxId');
    if (!buyer) continue;
    assert.ok(!r.fields.invoiceNumber.includes(buyer.value),
      `${c.file} 的购买方税号候选落在发票号码里了`);
  }
});
