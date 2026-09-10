import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createRecoveryCredential, readRecoveryCredential, validateRecoveryCredential,
  mapErpReceiptRowsToBindings, RECOVERY_PURPOSE, REQUIRED_ERP_WRITE_STATE,
} from '../src/recovery.mjs';

const NOW = new Date('2026-09-09T04:00:00.000Z');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-recovery-'));
const materials = [
  { materialId: 'm-rail', contentHash: 'a'.repeat(64) },
  { materialId: 'm-cao', contentHash: 'b'.repeat(64) },
  { materialId: 'm-fengyun', contentHash: 'c'.repeat(64) },
  { materialId: 'm-hotel', contentHash: 'd'.repeat(64) },
];
const receiptBindings = [
  { materialId: 'm-rail', identity: { scheme: 'einvoice-20', key: 'einvoice-20:rail' }, receiptNumber: 'SPD202609020039', totalCents: 70300 },
  { materialId: 'm-cao', identity: { scheme: 'einvoice-20', key: 'einvoice-20:cao' }, receiptNumber: 'SPD202609020037', totalCents: 5163 },
  { materialId: 'm-fengyun', identity: { scheme: 'einvoice-20', key: 'einvoice-20:fengyun' }, receiptNumber: 'SPD202609040022', totalCents: 1880 },
  { materialId: 'm-hotel', identity: { scheme: 'einvoice-20', key: 'einvoice-20:hotel' }, receiptNumber: 'SPD202608220132', totalCents: 364000 },
];
const erpBindings = [
  { materialId: 'm-rail', identity: { scheme: 'einvoice-20', key: 'einvoice-20:26349119423005877606' }, receiptNumber: 'SPD202609020039', totalCents: 70300 },
  { materialId: 'm-cao', identity: { scheme: 'einvoice-20', key: 'einvoice-20:26327000001570964156' }, receiptNumber: 'SPD202609020037', totalCents: 5163 },
  { materialId: 'm-fengyun', identity: { scheme: 'einvoice-20', key: 'einvoice-20:26427000000640558021' }, receiptNumber: 'SPD202609040022', totalCents: 1880 },
  { materialId: 'm-hotel', identity: { scheme: 'einvoice-20', key: 'einvoice-20:26342000002661673906' }, receiptNumber: 'SPD202608220132', totalCents: 364000 },
];

const erpGrid = (rows, overrides = {}) => {
  const normalizedRows = rows.map((entry) => entry.kind
    ? entry : { kind: 'data', values: entry });
  return {
    ok: true,
    columns: [{ label: '发票号码' }, { label: '收票单' }, { label: '价税合计' }],
    rowCount: normalizedRows.filter((row) => row.kind === 'data').length,
    rows: normalizedRows,
    ...overrides,
  };
};

const input = (overrides = {}) => ({
  taskId: 'b34804ed20',
  erpWriteState: REQUIRED_ERP_WRITE_STATE,
  identity: { account: 'luo.liu', tenant: 'tenant5f1f13f6dde29e' },
  inventoryVersionId: 'v-recovery-4',
  materials,
  receiptBindings,
  ego: { taskSpace: 1, tabId: 'ego-tab-1' },
  form: { formInstanceId: 'expense-form-1', mode: 'new', visibleInstances: 1, billNo: null },
  readback: {
    id: 'readback-1',
    observedAt: '2026-09-09T03:59:30.000Z',
    receipts: receiptBindings,
  },
  ...overrides,
});

const create = (name = 'local-preparation-recovery.json', overrides = {}, options = {}) =>
  createRecoveryCredential(path.join(root, name), input(overrides), { now: NOW, ...options });

const currentOf = (credential, overrides = {}) => ({
  taskId: credential.taskId,
  erpWriteState: credential.erpWriteState,
  identity: credential.identity,
  inventoryVersionId: credential.inventoryVersionId,
  materials: credential.materials,
  ego: credential.ego,
  form: credential.form,
  readback: {
    id: 'readback-fresh-2',
    observedAt: '2026-09-09T04:00:00.000Z',
    receipts: [...credential.receiptBindings].reverse(),
  },
  ...overrides,
});

test('创建并读取恢复凭据，保留 marker 且只持有本地准备权限', () => {
  const file = path.join(root, 'round-trip.json');
  const record = createRecoveryCredential(file, input(), { now: NOW });
  const read = readRecoveryCredential(file);

  assert.deepEqual(read, record);
  assert.equal(record.purpose, RECOVERY_PURPOSE);
  assert.equal(record.erpWriteState, 'upload_dispatched');
  assert.equal(record.readback.receiptDigest.length, 32);
  assert.ok(record.credentialDigest);
  assert.ok(!JSON.stringify(record).includes('homeCity'));
  assert.ok(!JSON.stringify(record).includes('category'));
  assert.ok(!JSON.stringify(record).includes('project'));
  assert.ok(!JSON.stringify(record).includes('purposeInput'));
});

test('本地可变的城市、类别、项目和业务事由不进入恢复摘要', () => {
  const first = create('mutable-fields-a.json', {
    credentialId: 'same-credential', homeCity: '广州', category: '住宿', project: 'P-1', purpose: '原事由',
  });
  const second = create('mutable-fields-b.json', {
    credentialId: 'same-credential', homeCity: '深圳', category: '交通', project: 'P-2', purpose: '新事由',
  });

  assert.equal(first.materialsDigest, second.materialsDigest);
  assert.equal(first.receiptDigest, second.receiptDigest);
  assert.equal(first.formDigest, second.formDigest);
  assert.equal(first.credentialDigest, second.credentialDigest);
});

test('ERP 收票原始行按完整发票号码派生 materialId，并逐票校验收票号和金额', () => {
  const result = mapErpReceiptRowsToBindings(erpBindings, erpGrid([
    { 发票号码: '26342000002661673906', 收票单: 'SPD202608220132', 价税合计: '¥3,640.00' },
    { 发票号码: '26349119423005877606', 收票单: 'SPD202609020039', 价税合计: '703.00' },
    { 发票号码: '26327000001570964156', 收票单: 'SPD202609020037', 价税合计: '51.63' },
    { 发票号码: '26427000000640558021', 收票单: 'SPD202609040022', 价税合计: '18.80' },
    { kind: 'total', values: { 发票号码: '', 收票单: '', 价税合计: '¥4,413.43' } },
  ]));

  assert.equal(result.ok, true);
  assert.deepEqual(result.bindings, [...erpBindings].sort((a, b) => a.materialId.localeCompare(b.materialId)));
});

test('ERP 收票映射拒绝未知同额发票、重复行、同号换票和缺列', () => {
  const validRows = erpBindings.map((binding) => ({
    发票号码: binding.identity.key.slice('einvoice-20:'.length),
    收票单: binding.receiptNumber,
    价税合计: (binding.totalCents / 100).toFixed(2),
  }));
  const cases = [
    validRows.map((row, index) => index === 0
      ? { ...row, 发票号码: '26349119423005877607' } : row),
    [...validRows, validRows[0]],
    validRows.map((row, index) => index === 0
      ? { ...row, 收票单: validRows[1].收票单 } : row),
    validRows.map((row, index) => index === 0
      ? { ...row, 价税合计: '51.63' } : row),
  ];
  for (const rows of cases) {
    const result = mapErpReceiptRowsToBindings(erpBindings, erpGrid(rows));
    assert.equal(result.ok, false);
    assert.deepEqual(result.bindings, []);
  }

  const missingColumn = mapErpReceiptRowsToBindings(erpBindings, erpGrid(validRows, {
    columns: [{ label: '发票号码' }, { label: '价税合计' }],
  }));
  assert.equal(missingColumn.ok, false);
  assert.ok(missingColumn.reasons.some((reason) => reason.includes('收票单')));
});

test('fresh readback 按逐票身份、receiptNumber、金额精确匹配，顺序不影响结果', () => {
  const record = create('valid.json');
  const result = validateRecoveryCredential(record, currentOf(record), { now: NOW });

  assert.equal(result.valid, true);
  assert.equal(result.status, 'accepted');
  assert.equal(result.receiptCount, 4);
  assert.equal(result.capabilities.localPreparation, true);
  assert.equal(result.capabilities.erpWrite, false);
  assert.equal(result.capabilities.upload, false);
  assert.equal(result.capabilities.newTask, false);
  assert.equal(result.capabilities.reset, false);
});

test('只有总额没有逐票身份时拒绝，即使总额相等', () => {
  const record = create('aggregate-only.json');
  const current = currentOf(record, {
    readback: { id: 'aggregate', observedAt: '2026-09-09T04:00:00.000Z', receipts: [{ totalCents: 441343 }] },
  });
  const result = validateRecoveryCredential(record, current, { now: NOW });

  assert.equal(result.valid, false);
  assert.ok(result.reasons.some((reason) => /逐票|总额/.test(reason)));
  assert.equal(result.capabilities.erpWrite, false);
});

test('缺票、额外票、重复身份或 receiptNumber 都拒绝', () => {
  const record = create('receipt-set.json');
  const cases = [
    [...record.receiptBindings.slice(1)],
    [...record.receiptBindings, { ...record.receiptBindings[0], materialId: 'm-extra', receiptNumber: 'SPD-extra' }],
    record.receiptBindings.map((item, index) => index === 1
      ? { ...item, identity: record.receiptBindings[0].identity } : item),
    record.receiptBindings.map((item, index) => index === 1
      ? { ...item, receiptNumber: record.receiptBindings[0].receiptNumber } : item),
  ];
  for (const [index, receipts] of cases.entries()) {
    const result = validateRecoveryCredential(record, currentOf(record, {
      readback: { id: `bad-${index}`, observedAt: '2026-09-09T04:00:00.000Z', receipts },
    }), { now: NOW });
    assert.equal(result.valid, false, `case ${index} should reject`);
  }
});

test('task、身份、版本、材料 hash、ego 上下文或表单实例变化都拒绝', () => {
  const record = create('context.json');
  const cases = [
    { taskId: 'other-task' },
    { identity: { account: 'other', tenant: record.identity.tenant } },
    { inventoryVersionId: 'v-other' },
    { materials: [{ ...record.materials[0], contentHash: 'f'.repeat(64) }, ...record.materials.slice(1)] },
    { ego: { taskSpace: 2, tabId: record.ego.tabId } },
    { form: { ...record.form, formInstanceId: 'other-form' } },
    { form: { ...record.form, visibleInstances: 2 } },
    { form: { ...record.form, billNo: 'FYBX2026090001' } },
  ];
  for (const [index, overrides] of cases.entries()) {
    const result = validateRecoveryCredential(record, currentOf(record, overrides), { now: NOW });
    assert.equal(result.valid, false, `case ${index} should reject`);
  }
});

test('错误或自动生成的 detail 不会成为 ERP 写入依据', () => {
  const record = create('detail-ignored.json');
  const result = validateRecoveryCredential(record, currentOf(record, {
    readback: {
      id: 'detail-error',
      observedAt: '2026-09-09T04:00:00.000Z',
      receipts: record.receiptBindings,
      detail: { readable: true, totalCents: 70300, error: '自动生成明细与收票集合不一致' },
    },
    detail: { readable: true, totalCents: 70300, error: '错误默认明细' },
  }), { now: NOW });

  assert.equal(result.valid, true, 'detail 不阻止本地重新准备');
  assert.equal(result.capabilities.localPreparation, true);
  assert.equal(result.capabilities.erpWrite, false, 'detail 不能授权写 ERP');
});

test('凭据过期、旧 readback 或 marker 改变时 fail closed', () => {
  const expired = create('expired.json', {}, { ttlMs: 1000 });
  const expiredResult = validateRecoveryCredential(expired, currentOf(expired), {
    now: new Date(NOW.getTime() + 1001),
  });
  assert.equal(expiredResult.valid, false);

  const record = create('stale-readback.json');
  const stale = validateRecoveryCredential(record, currentOf(record, {
    readback: { id: 'old', observedAt: '2026-09-09T03:58:00.000Z', receipts: record.receiptBindings },
  }), { now: NOW });
  assert.equal(stale.valid, false);

  const marker = validateRecoveryCredential(record, currentOf(record, { erpWriteState: 'dispatched' }), { now: NOW });
  assert.equal(marker.valid, false);
});

test('创建拒绝不完整收票或非新增空表单，并且不覆盖既有凭据', () => {
  assert.throws(() => create('missing-receipt.json', {
    readback: { ...input().readback, receipts: [] },
  }), /逐票|非空/);
  assert.throws(() => create('multiple-forms.json', {
    form: { ...input().form, visibleInstances: 2 },
  }), /visibleInstances/);
  assert.throws(() => create('saved-form.json', {
    form: { ...input().form, billNo: 'FYBX2026090001' },
  }), /billNo/);

  const file = path.join(root, 'no-overwrite.json');
  const first = createRecoveryCredential(file, input({ credentialId: 'first' }), { now: NOW });
  assert.throws(() => createRecoveryCredential(file, input({ credentialId: 'second' }), { now: NOW }),
    (error) => error.code === 'RECOVERY_EXISTS');
  assert.equal(readRecoveryCredential(file).credentialId, first.credentialId);
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
