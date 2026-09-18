import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { GENERATED_DIR } from '@baox/fixtures';
import { type TaskSnapshot } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureCatalog } from './catalog/project-catalog';
import { blobPath } from './data-dir';
import { api, sample } from './test/api';
import { createTestServer, type TestClient, type TestServer } from './test/harness';

// Slice 11 (#190): 去打印 (print). One merged A4 PDF, one page per 主要报销凭证 (primary voucher), built from the
// confirmed lines; rotate, 4-corner crop and 支付截图 (payment screenshots) are print settings only.

const CATALOG = fixtureCatalog([{ number: 'P-2307', name: '华东客户交付', audited: true, forbidden: false }]);

let server: TestServer;
let alice: TestClient;
beforeEach(async () => {
  server = await createTestServer({ projectCatalog: CATALOG });
  alice = await server.signIn('alice');
  expect((await alice.post('/api/project-book/intake', { number: 'P-2307' })).status).toBe(200);
});
afterEach(() => server.close());
const client = api(() => alice);

// Inventoried, every line on P-2307, confirmed: stage actions / choose_action.
async function confirmed(prefixes: readonly string[]): Promise<TaskSnapshot> {
  const { task } = await client.createTask('杭州');
  const uploaded = await client.upload(task.taskId, prefixes.map(sample));
  await client.accepted(await client.act(uploaded, 'start-inventory'));
  const done = await client.settled(task.taskId, 120_000);
  expect(done.pendingItems.filter((item) => item.status === 'open')).toEqual([]);
  const review = await client.accepted(await client.act(done, 'submit-project-assignment', { purpose: '上海产品评审出差', projects: Object.fromEntries(done.lines.map((line) => [line.lineId, 'P-2307'])) }));
  const confirmedTask = await client.accepted(await client.act(review, 'confirm-review', { digest: review.confirmation.digest }));
  expect(confirmedTask).toMatchObject({ stage: 'actions', step: { kind: 'choose_action' }, confirmation: { status: 'confirmed' } });
  return confirmedTask;
}

// Print actions carry no stepToken.
function print(snapshot: TaskSnapshot, name: string, body: Record<string, unknown> = {}): Promise<Response> {
  return alice.post(`/api/tasks/${snapshot.task.taskId}/actions/${name}`, body);
}

async function download(url: string): Promise<PDFDocument> {
  const response = await alice.request(url);
  expect(response.status).toBe(200);
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect(Buffer.from(bytes.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
  return PDFDocument.load(bytes);
}

describe('generate-print-sheet', () => {
  it('one A4 page per primary voucher, in 统一业务序号 order, with the fixture print page headers', async () => {
    // Every fixture print page (fixtures/scripts/data.mjs PRINT_PAGES) except pg2: the 曹操 itinerary (m06) has no v1
    // layout, so its invoice (m05) cannot form a line on the real server. The numbers after it shift down by one.
    const task = await confirmed(['m01', 'm02', 'm03', 'm04', 'm07', 'm08', 'm09', 'm10']);
    expect(task.printSheet.status).toBe('not_generated');

    const generated = await client.accepted(await print(task, 'generate-print-sheet'));
    const sheet = generated.printSheet;
    expect(sheet.status).toBe('generated');
    expect(sheet.pages.map((page) => page.header)).toEqual([
      'No.1-3 · 08-10 · 外地市内交通 · 69.19',
      'No.4 · 08-15 · 外地市内交通 · 32.00',
      'No.5 · 08-19 · 外地市内交通 · 47.00',
      'No.6 · 08-09 · 长途交通 · 73.00',
      'No.7 · 08-22 · 长途交通 · 73.00',
      'No.8 · 08-09 · 住宿 · 3640.00',
    ]);
    const names = sheet.pages.map((page) => [page.top?.fileName ?? null, page.bottom?.fileName ?? null]);
    expect(names).toEqual([
      [sample('m03').name, sample('m04').name],
      [sample('m09').name, null],
      [sample('m10').name, null],
      [sample('m07').name, null],
      [sample('m08').name, null],
      [sample('m01').name, sample('m02').name],
    ]);
    // The placement rule picks the larger scale: the tall taxi strips turn 90°, the landscape rail ticket and the
    // wide itinerary stand upright.
    expect(sheet.pages[1]?.top?.rotate).toBe(true);
    expect(sheet.pages[2]?.top?.rotate).toBe(true);
    expect(sheet.pages[3]?.top?.rotate).toBe(false);
    expect(sheet.pages[0]?.bottom?.rotate).toBe(false);
    // Photos are croppable with detected corners; PDFs are not.
    expect(sheet.pages[1]?.top).toMatchObject({ croppable: true, cropAdjusted: false, corners: expect.any(Array) });
    expect(sheet.pages[0]?.top).toMatchObject({ croppable: false, corners: null });
    // Every voucher can take a payment screenshot (story 61); only the hotel page says so when it has none.
    expect(sheet.pages.map((page) => page.acceptsPaymentScreenshot)).toEqual([true, true, true, true, true, true]);
    expect(sheet.notices).toEqual(['No.8 住宿发票还没有支付截图。可以照常打印，该页下半页只放结账单。']);
    // Generating is print-only: the confirmation stands.
    expect(generated.confirmation).toEqual(task.confirmation);

    const pdf = await download(sheet.url ?? '');
    expect(pdf.getPageCount()).toBe(6);
    for (const page of pdf.getPages()) {
      expect(page.getWidth()).toBeCloseTo(595.28, 1);
      expect(page.getHeight()).toBeCloseTo(841.89, 1);
    }
    for (const page of sheet.pages) {
      const image = await alice.request(page.imageUrl);
      expect(image.status).toBe(200);
      expect(image.headers.get('content-type')).toBe('image/png');
    }
  }, 240_000);

  it('re-hashes every original before composing: a changed blob fails the generation', async () => {
    const task = await confirmed(['m01', 'm02']);
    const folio = task.materials.find((material) => material.fileName === sample('m02').name);
    if (!folio) throw new Error('no folio');
    writeFileSync(blobPath(server.dataDir, folio.contentHash), 'not the folio that was uploaded');
    await refused(await print(task, 'generate-print-sheet'), 'blob_mismatch');
    expect((await client.current(task.task.taskId)).printSheet.status).toBe('not_generated');
  }, 120_000);

  it('needs the confirmation', async () => {
    const { task } = await client.createTask('杭州');
    const created = await client.current(task.taskId);
    await refused(await print(created, 'generate-print-sheet'), 'not_confirmed');
    await refused(await print(created, 'rotate-placement', { pageId: 'page.x', slot: 'top', rotate: true }), 'print_not_generated');
  });
});

describe('the sheet follows the confirmation', () => {
  it('a confirmation invalidation marks the sheet stale; after a re-confirmation it must be generated again', async () => {
    const task = await confirmed(['m01', 'm02']);
    const generated = await client.accepted(await print(task, 'generate-print-sheet'));
    expect(generated.printSheet.status).toBe('generated');

    const moved = await client.accepted(await client.act(generated, 'set-home-city', { homeCity: '上海' }));
    expect(moved.confirmation.status).toBe('invalidated');
    expect(moved.printSheet).toEqual({ status: 'stale', fileName: null, url: null, pages: [], notices: [] });
    await refused(await print(moved, 'generate-print-sheet'), 'not_confirmed');
    // Reverting revives the same confirmation, and with it the sheet composed from exactly that content.
    const back = await client.accepted(await client.act(moved, 'set-home-city', { homeCity: '杭州' }));
    expect(back.printSheet).toMatchObject({ status: 'generated', url: generated.printSheet.url });

    // reopen-upload voids the confirmation for good; the re-confirmation is a new one, so the old sheet stays stale.
    const reopened = await client.accepted(await client.act(back, 'reopen-upload'));
    expect(reopened.printSheet.status).toBe('stale');
    await client.accepted(await client.act(reopened, 'start-inventory'));
    const review = await client.settled(task.task.taskId);
    expect(review.step.kind).toBe('confirm_review');
    const again = await client.accepted(await client.act(review, 'confirm-review', { digest: review.confirmation.digest }));
    expect(again.confirmation.status).toBe('confirmed');
    expect(again.printSheet.status).toBe('stale');
    expect((await client.accepted(await print(again, 'generate-print-sheet'))).printSheet.status).toBe('generated');
  }, 120_000);
});

describe('print settings', () => {
  it('rotate, crop and a payment screenshot re-render the sheet and leave the confirmation alone', async () => {
    const task = await confirmed(['m01', 'm02', 'm09']);
    const generated = await client.accepted(await print(task, 'generate-print-sheet'));
    expect(generated.printSheet.pages.map((page) => page.header)).toEqual(['No.1 · 08-15 · 外地市内交通 · 32.00', 'No.2 · 08-09 · 住宿 · 3640.00']);
    const [taxi, hotel] = generated.printSheet.pages;
    if (!taxi?.top?.corners || !taxi.top.imageUrl || !hotel?.top || !hotel.bottom) throw new Error('unexpected pages');

    const rotated = await client.accepted(await print(generated, 'rotate-placement', { pageId: hotel.pageId, slot: 'bottom', rotate: !hotel.bottom.rotate }));
    expect(rotated.printSheet.pages[1]?.bottom?.rotate).toBe(!hotel.bottom.rotate);
    expect(rotated.printSheet.pages[1]?.imageUrl).not.toBe(hotel.imageUrl);
    expect(rotated.confirmation).toEqual(task.confirmation);
    await refused(await print(rotated, 'rotate-placement', { pageId: taxi.pageId, slot: 'bottom', rotate: true }), 'slot_empty');
    await refused(await print(rotated, 'rotate-placement', { pageId: 'page.nope', slot: 'top', rotate: true }), 'page_not_found');

    const corners = taxi.top.corners;
    await refused(await print(rotated, 'crop-placement', { pageId: hotel.pageId, slot: 'top', corners }), 'not_croppable');
    await refused(await print(rotated, 'crop-placement', { pageId: taxi.pageId, slot: 'top', corners: [corners[1], corners[0], corners[2], corners[3]] }), 'invalid_corners');
    const nudged = corners.map(([x, y], index) => (index === 2 ? [x - 10, y] : [x, y]));
    const cropped = await client.accepted(await print(rotated, 'crop-placement', { pageId: taxi.pageId, slot: 'top', corners: nudged }));
    expect(cropped.printSheet.pages[0]?.top).toMatchObject({ corners: nudged, cropAdjusted: true });
    expect(cropped.printSheet.pages[0]?.imageUrl).not.toBe(taxi.imageUrl);
    const photo = await alice.request(taxi.top.imageUrl);
    expect(photo.status).toBe(200);
    expect(photo.headers.get('content-type')).toBe('image/jpeg');

    const png = readFileSync(join(GENERATED_DIR, 'print-pg1.png'));
    // A material that is not a voucher of its own page (the folio) has nowhere to put a screenshot.
    await refused(await screenshot(task, hotel.bottom.materialId, new File([png], 'IMG_5011.png', { type: 'image/png' })), 'screenshot_not_applicable');
    await refused(await screenshot(task, hotel.top.materialId, new File([Buffer.from('%PDF-1.4')], '支付记录.pdf', { type: 'application/pdf' })), 'not_image');

    // 支付截图 is not hotel-only: the taxi voucher takes one too, and it raises no notice either way (story 61).
    const onTaxi = await client.accepted(await screenshot(task, taxi.top.materialId, new File([png], 'IMG_5012.png', { type: 'image/png' })));
    expect(onTaxi.printSheet.pages[0]?.screenshotId).toEqual(expect.any(String));
    expect(onTaxi.printSheet.notices).toEqual(['No.2 住宿发票还没有支付截图。可以照常打印，该页下半页只放结账单。']);
    await client.accepted(await print(onTaxi, 'remove-payment-screenshot', { screenshotId: onTaxi.paymentScreenshots[0]?.screenshotId }));
    const shot = await client.accepted(await screenshot(task, hotel.top.materialId, new File([png], 'IMG_5011.png', { type: 'image/png' })));
    expect(shot.paymentScreenshots).toEqual([expect.objectContaining({ voucherMaterialId: hotel.top.materialId, fileName: 'IMG_5011.png' })]);
    expect(shot.printSheet.pages[1]?.screenshotId).toBe(shot.paymentScreenshots[0]?.screenshotId);
    expect(shot.printSheet.notices).toEqual([]);
    expect(shot.confirmation).toEqual(task.confirmation);
    expect((await download(shot.printSheet.url ?? '')).getPageCount()).toBe(2);

    const removed = await client.accepted(await print(shot, 'remove-payment-screenshot', { screenshotId: shot.paymentScreenshots[0]?.screenshotId }));
    expect(removed.paymentScreenshots).toEqual([]);
    expect(removed.printSheet.notices).toEqual(['No.2 住宿发票还没有支付截图。可以照常打印，该页下半页只放结账单。']);
    await refused(await print(removed, 'remove-payment-screenshot', { screenshotId: 'gone' }), 'screenshot_not_found');
    // The settings survive: the folio keeps its rotation and the photo its corners.
    expect(removed.printSheet.pages[1]?.bottom?.rotate).toBe(!hotel.bottom.rotate);
    expect(removed.printSheet.pages[0]?.top?.corners).toEqual(nudged);

    // Files are served only to the task's own account.
    const bob = await server.signIn('bob');
    expect((await bob.request(removed.printSheet.url ?? '')).status).toBe(404);
  }, 240_000);
});

function screenshot(snapshot: TaskSnapshot, voucherMaterialId: string, file: File): Promise<Response> {
  const form = new FormData();
  form.append('voucherMaterialId', voucherMaterialId);
  form.append('file', file);
  return alice.request(`/api/tasks/${snapshot.task.taskId}/payment-screenshots`, { method: 'POST', body: form });
}

async function refused(response: Response, code: string): Promise<void> {
  expect(response.status).toBe(400);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
}
