import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-classified-detail-'));
process.env.BAOX_HOME = home;

const { writeBinding } = await import('../src/binding.mjs');
const { createTask } = await import('../src/workspace.mjs');
const {
  classifiedDetailComplete, classifiedDetailDigest, classifiedDetailConfirmed,
  confirmClassifiedDetail, classifiedCorrectionOptions,
} = await import('../src/classified-detail.mjs');
const { writeReading } = await import('../src/vision.mjs');

const alice = { displayName: 'Alice', account: 'alice', tenant: 'tenant-a' };
const other = { displayName: 'Bob', account: 'bob', tenant: 'tenant-a' };
writeBinding(alice);

const preview = (over = {}) => ({
  versionId: 'v-1',
  homeCity: '广州',
  lines: [{
    lineId: 'ev-01', eventId: 'ev-01', voucherMaterialId: 'm-voucher',
    maskedNumber: '****1234', kind: 'passenger_transport', date: '2026-09-01',
    city: '广州', route: '天河 → 越秀', netAmount: '10.00', taxAmount: '0.60',
    totalAmount: '10.60', amountSource: 'invoice_face', referenceMaterialIds: ['m-ref'],
    category: 'local_city_transport', categoryLabel: '市内交通', categoryBasis: '城市相同',
    expenseItemCode: 'FY008001', expenseItemName: '市内交通', expenseItemSource: 'catalog',
  }],
  evidence: [{ materialId: 'm-voucher', contentHash: 'hash-voucher', role: 'primary_voucher',
    kind: 'vat_common', fields: { totalAmount: { cents: 1060 } }, segments: null }],
  ...over,
});

test('分类明细完整，且摘要不绑定项目和事由', () => {
  const base = preview();
  assert.equal(classifiedDetailComplete(base), true);
  const changedBusinessFacts = preview({
    purpose: '换一个事由',
    lines: [{ ...base.lines[0], project: 'new-project', projectSource: 'project_book' }],
  });
  assert.equal(classifiedDetailDigest(changedBusinessFacts), classifiedDetailDigest(base),
    '单纯换项目或事由不应让分类确认失效');
  assert.equal(classifiedDetailDigest(preview({
    lines: [{ ...base.lines[0], expenseItemSource: 'erp_catalog_confirmed' }],
  })), classifiedDetailDigest(base),
  'ERP 只读核对补充费用项目来源，不应让已确认的分类事实失效');
  assert.notEqual(classifiedDetailDigest(preview({
    lines: [{ ...base.lines[0], totalAmount: '10.61' }],
  })), classifiedDetailDigest(base));
  assert.notEqual(classifiedDetailDigest(preview({
    evidence: [{ ...base.evidence[0], candidates: [{ field: 'checkOut', value: '2026-08-22' }] }],
  })), classifiedDetailDigest(preview({
    evidence: [{ ...base.evidence[0], candidates: [{ field: 'checkOut', value: '2026-08-23' }] }],
  })));
});

test('住宿分类确认必须覆盖有效入住和离店日期', () => {
  const base = preview({ lines: [{ ...preview().lines[0], kind: 'vat_common', category: 'accommodation',
    categoryLabel: '住宿', date: '2026-08-09',
    checkOut: '2026-08-22', endDate: '2026-08-22' }] });
  assert.equal(classifiedDetailComplete(base), true);
  assert.notEqual(classifiedDetailDigest(base), classifiedDetailDigest({
    ...base, lines: [{ ...base.lines[0], endDate: '2026-08-23', checkOut: '2026-08-23' }],
  }));
  assert.equal(classifiedDetailComplete({
    ...base, lines: [{ ...base.lines[0], endDate: '2026-08-08', checkOut: '2026-08-08' }],
  }), false);
});

test('普通 VAT 交通明细不因票种要求离店日期', () => {
  const line = { ...preview().lines[0], kind: 'vat_common', category: 'local_city_transport',
    categoryLabel: '本地市内交通', date: '2026-09-02', checkOut: null, endDate: null };
  assert.equal(classifiedDetailComplete(preview({ lines: [line] })), true);
});

test('候选来源或 Markdown 证据变化会使分类确认摘要失效', () => {
  const base = preview({ evidence: [{ ...preview().evidence[0], source: {
    kind: 'agent_from_markdown', converter: 'markitdown', converterVersion: '0.1.7',
    markdownHash: 'md-a',
  }, markdownHash: 'md-a', fieldEvidence: {
    totalAmount: [{ line: 19, quote: '（小写）¥10.60' }],
  }, fieldStatus: { totalAmount: 'explicit' }, issues: [] }] });
  assert.notEqual(classifiedDetailDigest(base), classifiedDetailDigest({
    ...base,
    evidence: [{ ...base.evidence[0], source: { ...base.evidence[0].source, markdownHash: 'md-b' },
      markdownHash: 'md-b' }],
  }));
  assert.notEqual(classifiedDetailDigest(base), classifiedDetailDigest({
    ...base,
    evidence: [{ ...base.evidence[0], fieldEvidence: {
      totalAmount: [{ line: 20, quote: '（小写）¥10.60' }],
    } }],
  }));
});

test('确认记录绑定任务与身份，其他身份不能认领', () => {
  const source = fs.mkdtempSync(path.join(home, 'materials-'));
  const task = createTask(source);
  task.homeCity = '广州';
  const facts = preview();
  const record = confirmClassifiedDetail(task, facts, alice);
  assert.equal(record.taskId, task.taskId);
  assert.equal(classifiedDetailConfirmed(task, facts, alice), true);
  assert.equal(classifiedDetailConfirmed(task, facts, other), false);

  const changedTask = { ...task, taskId: 'different' };
  assert.equal(classifiedDetailConfirmed(changedTask, facts, alice), false);
});

test('分类纠正只暴露同 hash 看图读数，PDF 没有 override', () => {
  const source = fs.mkdtempSync(path.join(home, 'correction-materials-'));
  const task = createTask(source);
  writeReading(task, {
    materialId: 'm-image', contentHash: 'hash-image', docType: 'invoice',
    fields: { invoiceNumber: '12345678901234567890', issueDate: '2026-09-01', totalAmount: '10.60' },
  });
  const options = classifiedCorrectionOptions(task, {
    evidence: [
      { materialId: 'm-image', contentHash: 'hash-image' },
      { materialId: 'm-pdf', contentHash: 'hash-pdf' },
    ],
  });

  assert.deepEqual(options[0].fields, ['totalAmount'], '发票号码和开票日期不进入用户纠正字段');
  assert.deepEqual(options[1].fields, []);
  assert.match(options[1].reason, /替换原材料后重新解析/);
});
