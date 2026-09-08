import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-material-association-'));
process.env.BAOX_HOME = home;

const { takeInventory } = await import('../src/inventory.mjs');
const { createTask } = await import('../src/workspace.mjs');
const { ingestReadings, confirmReadings, loadReading, projectReading } = await import('../src/vision.mjs');
const { buildEvents, eventOpenItems } = await import('../src/events.mjs');

const BLANK_LANDSCAPE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAADklEQVR4nGP4DwMMcBYAs2AR7za3GVIAAAAASUVORK5CYII=',
  'base64',
);

const voucher = (materialId = 'm-invoice') => ({
  materialId,
  fileName: `${materialId}.pdf`,
  contentHash: `hash-${materialId}`,
  parseStatus: 'parsed',
  kind: 'transport_invoice',
  kindLabel: '运输服务发票',
  role: 'primary_voucher',
  fields: {
    invoiceNumber: '12345678901234567890',
    netAmount: { text: '18.25', cents: 1825 },
    taxAmount: { text: '0.55', cents: 55 },
    totalAmount: { text: '18.80', cents: 1880 },
  },
  candidates: [],
});

const fixtureDirs = [];

async function readItinerary({ fields, unreadable = [] }) {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-itinerary-'));
  fixtureDirs.push(sourceDir);
  fs.writeFileSync(path.join(sourceDir, 'itinerary.png'), BLANK_LANDSCAPE_PNG);
  const inventory = await takeInventory(sourceDir);
  const material = inventory.materials[0];
  const task = createTask(sourceDir);
  const verdict = ingestReadings(sourceDir, inventory, task, { version: 1, readings: [{
    materialId: material.materialId,
    contentHash: material.contentHash,
    sighted: { shape: 'landscape' },
    docType: 'ride_itinerary',
    fields,
    unreadable,
  }] })[0];
  return { sourceDir, inventory, material, task, verdict };
}

function projectedItinerary(fixture) {
  confirmReadings(fixture.task, [fixture.material.materialId]);
  return {
    materialId: fixture.material.materialId,
    fileName: fixture.material.fileName,
    contentHash: fixture.material.contentHash,
    ...projectReading(loadReading(fixture.task, fixture.material.materialId)),
  };
}

test('图片行程单声明 18.80 时自动关联同额发票，并提供事件日期', async () => {
  const fixture = await readItinerary({ fields: {
    totalAmount: '18.80', travelDate: '2026-09-04', city: '深圳市',
    origin: '南山区', destination: '福田区',
  } });
  assert.equal(fixture.verdict.verdict, 'accepted', JSON.stringify(fixture.verdict.reasons));

  const itinerary = projectedItinerary(fixture);
  const built = buildEvents({ versionId: 'synthetic', results: [voucher(), itinerary], duplicates: [] });
  assert.deepEqual(built.events[0].referenceMaterialIds, [itinerary.materialId]);
  assert.equal(built.events[0].date, '2026-09-04');
  assert.equal(eventOpenItems(built).some((item) => item.kind === 'event_date_missing'), false);
});

test('图片行程单必须提供合计或明确写入 unreadable', async () => {
  const omitted = await readItinerary({ fields: {
    travelDate: '2026-09-04', origin: '南山区', destination: '福田区',
  } });
  assert.equal(omitted.verdict.verdict, 'rejected');
  assert.match(omitted.verdict.reasons.join(), /totalAmount.*unreadable|合计.*看不清/);

  const dispositioned = await readItinerary({ fields: {
    travelDate: '2026-09-04', origin: '南山区', destination: '福田区',
  }, unreadable: ['totalAmount'] });
  assert.equal(dispositioned.verdict.verdict, 'accepted', JSON.stringify(dispositioned.verdict.reasons));
  const itinerary = projectedItinerary(dispositioned);
  const item = eventOpenItems(buildEvents({
    versionId: 'synthetic', results: [voucher(), itinerary], duplicates: [],
  })).find((candidate) => candidate.materialId === itinerary.materialId);
  assert.equal(item.kind, 'reference_unlinked');
  assert.equal(item.blocking, false);
  assert.match(item.note, /合计金额没有对上/);
});

test('同额发票重复时保持证据归属歧义并阻塞，不猜关联对象', async () => {
  const fixture = await readItinerary({ fields: {
    totalAmount: '18.80', travelDate: '2026-09-04', origin: '南山区', destination: '福田区',
  } });
  const itinerary = projectedItinerary(fixture);
  const built = buildEvents({
    versionId: 'synthetic', results: [voucher('m-invoice-a'), voucher('m-invoice-b'), itinerary], duplicates: [],
  });
  const ambiguous = eventOpenItems(built).find((item) => item.kind === 'evidence_ambiguous');
  assert.ok(ambiguous);
  assert.equal(ambiguous.blocking, true);
  assert.deepEqual(new Set(ambiguous.vouchers), new Set(['m-invoice-a', 'm-invoice-b']));
  assert.ok(built.events.every((event) => event.referenceMaterialIds.length === 0));
});

test('同一发票对上两份同额行程单时阻塞，且不采用任一行程日期', async () => {
  const first = await readItinerary({ fields: {
    totalAmount: '18.80', travelDate: '2026-09-04', origin: '南山区', destination: '福田区',
  } });
  const second = await readItinerary({ fields: {
    totalAmount: '18.80', travelDate: '2026-09-05', origin: '罗湖区', destination: '南山区',
  } });
  const firstItinerary = { ...projectedItinerary(first), materialId: 'm-itinerary-a', fileName: 'itinerary-a.png' };
  const secondItinerary = { ...projectedItinerary(second), materialId: 'm-itinerary-b', fileName: 'itinerary-b.png' };
  const built = buildEvents({
    versionId: 'synthetic',
    results: [voucher(), firstItinerary, secondItinerary],
    duplicates: [],
  });
  const ambiguous = eventOpenItems(built).find((item) => item.kind === 'evidence_ambiguous');
  assert.ok(ambiguous);
  assert.equal(ambiguous.blocking, true);
  assert.equal(ambiguous.materialId, 'm-invoice');
  assert.equal(ambiguous.sameKind, 'ride_itinerary');
  assert.deepEqual(ambiguous.references, [
    { materialId: 'm-itinerary-a', fileName: 'itinerary-a.png' },
    { materialId: 'm-itinerary-b', fileName: 'itinerary-b.png' },
  ]);
  assert.deepEqual(built.events[0].referenceMaterialIds, []);
  assert.equal(built.events[0].date, null, '歧义未处置前不能按输入顺序挑一份行程单');
});

test.after(() => {
  for (const dir of fixtureDirs) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});
