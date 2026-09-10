import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 数据目录必须在导入内核模块之前改掉，否则会写进用户真实的工作区。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-date-test-'));
process.env.BAOX_HOME = home;

const { buildEvents, eventOpenItems } = await import('../src/events.mjs');
const { createTask } = await import('../src/workspace.mjs');
const { takeInventory } = await import('../src/inventory.mjs');
const { ingestReadings } = await import('../src/vision.mjs');

const repo = path.resolve(import.meta.dirname, '..', '..');

const transportVoucher = (fields) => ({
  materialId: 'm-voucher', fileName: 'voucher.pdf', contentHash: 'hash-voucher',
  parseStatus: 'parsed', role: 'primary_voucher', kind: 'transport_invoice',
  fields: { totalAmount: { cents: 1880 }, ...fields }, candidates: [],
});

const rideItinerary = (travelDate) => ({
  materialId: 'm-itinerary', fileName: 'itinerary.png', contentHash: 'hash-itinerary',
  parseStatus: 'parsed', role: 'reference', kind: 'ride_itinerary',
  fields: { totalAmount: { cents: 1880 } },
  candidates: [{ field: 'travelDate', value: travelDate }],
});

const classification = (...results) => ({ versionId: 'date-test', results, duplicates: [] });
const fixtures = [];

async function imageReading({ fields, segments, unreadable = [] }) {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-flat-itinerary-date-'));
  fixtures.push(sourceDir);
  fs.copyFileSync(path.join(repo, 'resources', '交通', 'fengyun-1.png'),
    path.join(sourceDir, 'itinerary.png'));
  const inventory = await takeInventory(sourceDir);
  const material = inventory.materials[0];
  const task = createTask(sourceDir);
  const [verdict] = ingestReadings(sourceDir, inventory, task, { version: 1, readings: [{
    materialId: material.materialId,
    contentHash: material.contentHash,
    sighted: { shape: 'landscape' },
    docType: 'ride_itinerary',
    fields,
    ...(segments === undefined ? {} : { segments }),
    unreadable,
  }] });
  return verdict;
}

test('平铺图片行程单没有行程日期时拒绝，不能用开票日期代替', async () => {
  const verdict = await imageReading({
    fields: { totalAmount: '18.80', issueDate: '2026-09-02', origin: '海淀区', destination: '朝阳区' },
  });
  assert.equal(verdict.verdict, 'rejected');
  assert.match(verdict.reasons.join(), /fields\.travelDate|行程日期/);
});

test('平铺图片行程单明确列出不可读行程日期时落读数', async () => {
  const verdict = await imageReading({
    fields: { totalAmount: '18.80', city: '深圳', issueDate: '2026-09-02' },
    unreadable: ['travelDate'],
  });
  assert.equal(verdict.verdict, 'accepted', JSON.stringify(verdict.reasons));
  assert.deepEqual(verdict.unreadable, ['travelDate']);
});

test('多段图片行程单只提供段内日期也能通过，不要求虚构顶层日期', async () => {
  const verdict = await imageReading({
    fields: { totalAmount: '18.80' },
    segments: [{ travelDate: '2026-09-04', origin: '海淀区', destination: '朝阳区', amount: '18.80' }],
  });
  assert.equal(verdict.verdict, 'accepted', JSON.stringify(verdict.reasons));
});

test('交通凭证没有关联行程单时，费用日期回退到凭证票面的行程日期', () => {
  const built = buildEvents(classification(transportVoucher({
    travelDate: '2026-08-25', issueDate: '2026-08-26',
  })), null);
  assert.equal(built.events[0].date, '2026-08-25');
  assert.equal(built.events[0].dateEvidence, '凭证票面行程日期');
  assert.equal(eventOpenItems(built).some((item) => item.kind === 'event_date_missing'), false);
});

test('关联行程单的行程日期优先于凭证票面的行程日期', () => {
  const built = buildEvents(classification(
    transportVoucher({ travelDate: '2026-08-25', issueDate: '2026-08-26' }),
    rideItinerary('2026-08-27'),
  ), null);
  assert.equal(built.events[0].date, '2026-08-27');
  assert.equal(built.events[0].dateEvidence, '看图读取的行程单，已确认');
});

test('交通凭证只有开票日期时仍然缺少费用发生日期', () => {
  const built = buildEvents(classification(transportVoucher({ issueDate: '2026-08-26' })), null);
  assert.equal(built.events[0].date, null);
  assert.ok(eventOpenItems(built).find((item) => item.kind === 'event_date_missing' && item.blocking));
});

test('关联行程单明确不可读行程日期时仍阻断 ERP 准备', () => {
  const built = buildEvents(classification(
    transportVoucher({ issueDate: '2026-08-26' }),
    rideItinerary(null),
  ), null);
  assert.equal(built.events[0].date, null);
  const missing = eventOpenItems(built).find((item) => item.kind === 'event_date_missing');
  assert.ok(missing?.blocking, '费用日期缺失必须阻断后续 ERP 准备');
  assert.match(missing.note, /开票日期不等于费用发生日期/);
});

test.after(() => {
  for (const dir of fixtures) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});
