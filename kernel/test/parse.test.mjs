import { fixtureMaterial } from './fixture-materials.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMaterial, invoiceIdentity, checkAmounts, maskNumber } from '../src/parse.mjs';

// 使用测试生成的虚构材料验证解析字段和原文证据。
// 跑：node --test kernel/test/

const sample = (rel) => fixtureMaterial(rel);
const parse = (rel, fmt = 'pdf') => parseMaterial(sample(rel), fmt);

const CASES = [
  {
    file: '住宿/fp-jd.pdf',
    kind: 'vat_special', role: 'primary_voucher',
    masked: '1000************0001', issueDate: '2026-08-22',
    net: 343396, tax: 20604, total: 364000, amountCheck: 'balanced',
  },
  {
    file: '交通/【AA出行-69.19元-3个行程】高德打车电子发票.pdf',
    kind: 'passenger_transport', role: 'primary_voucher',
    masked: '1000************0002', issueDate: '2026-08-07',
    net: 6717, tax: 202, total: 6919, amountCheck: 'balanced',
  },
  {
    // 这张票有负数调整行，合计仍以票面"合计"和"价税合计"为准，不逐行相加。
    file: '交通/【曹操出行-51.63元-1个行程】高德打车电子发票.pdf',
    kind: 'passenger_transport', role: 'primary_voucher',
    masked: '1000************0003', issueDate: '2026-09-02',
    net: 5012, tax: 151, total: 5163, amountCheck: 'balanced',
  },
  {
    // 铁路电子客票票面只有票价：不含税金额和税额缺席是票面事实，不是解析失败。
    file: '长途/26349119423005877606.pdf',
    kind: 'rail_eticket', role: 'primary_voucher',
    masked: '1000************0004', issueDate: '2026-09-02',
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

const REFERENCES = [
  { file: '交通/【AA出行-69.19元-3个行程】高德打车电子行程单.pdf', kind: 'ride_itinerary', segments: 3 },
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
