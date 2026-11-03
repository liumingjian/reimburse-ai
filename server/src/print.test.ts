import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { GENERATED_DIR } from '@baox/fixtures';
import { type TaskSnapshot } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blobPath } from './data-dir';
import { api, byFileName, sample } from './test/api';
import { presetParser } from './test/parse-presets';
import { paymentScreenshots, postStayScreenshots, seedTableScreenshots } from './test/payment-screenshots';
import type { TestClient } from './test/harness';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';

// Slice 11 (#190): 去打印 (print). One merged A4 PDF, one page per 主要报销凭证 (primary voucher), built from the
// confirmed lines; rotate, 4-corner crop and 支付截图 (payment screenshots) are print settings only.

let server: ScenarioServer;
let alice: TestClient;
beforeEach(async () => {
  server = await scenarioServer();
  alice = await server.signIn('alice');
});
afterEach(() => server.close());
const client = api(() => alice);

// Inventoried, every line on P-2307, confirmed: stage actions / choose_action.
const atActions = async (materials: readonly string[]) => (await scenario(server, alice).at('actions', { materials })).reached;

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
    const task = await atActions(['m01', 'm02', 'm03', 'm04', 'm07', 'm08', 'm09', 'm10']);
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
    // Only the hotel page, whose screenshot absence was confirmed at inventory (#213), says so.
    expect(sheet.notices).toEqual(['No.8 住宿发票在盘点时已确认没有支付截图，这一页不放支付截图。']);
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
    const task = await atActions(['m01', 'm02']);
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
    const task = await atActions(['m01', 'm02']);
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
  it('rotate and crop re-render the sheet and leave the confirmation alone', async () => {
    const task = await atActions(['m01', 'm02', 'm09']);
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
    // Only a 住宿 invoice takes a 支付截图 (#330): the folio and the taxi voucher are refused on a generated sheet too.
    const upload = async (materialId: string) => postStayScreenshots(alice, await client.current(task.task.taskId), materialId, [new File([png], 'IMG_5011.png', { type: 'image/png' })]);
    await refused(await upload(hotel.bottom.materialId), 'screenshot_not_applicable');
    await refused(await upload(taxi.top.materialId), 'screenshot_not_applicable');
    // The hotel invoice's screenshots are locked with the confirmed list (#331).
    await refused(await upload(hotel.top.materialId), 'screenshot_locked');
    const removed = await client.current(task.task.taskId);
    expect(removed.stage).toBe(task.stage);
    expect(removed.erp).toEqual(task.erp);
    expect(removed.lines).toEqual(task.lines);
    expect(removed.projectAssignment).toEqual(task.projectAssignment);
    expect(removed.confirmation).toEqual(task.confirmation);
    expect(removed.printSheet.notices).toEqual(['No.2 住宿发票在盘点时已确认没有支付截图，这一页不放支付截图。']);
    expect((await download(removed.printSheet.url ?? '')).getPageCount()).toBe(2);
    await refused(await print(removed, 'remove-payment-screenshot', { screenshotId: 'gone' }), 'screenshot_not_found');
    // The settings survive: the folio keeps its rotation and the photo its corners.
    expect(removed.printSheet.pages[1]?.bottom?.rotate).toBe(!hotel.bottom.rotate);
    expect(removed.printSheet.pages[0]?.top?.corners).toEqual(nudged);

    // Files are served only to the task's own account.
    const bob = await server.signIn('bob');
    expect((await bob.request(removed.printSheet.url ?? '')).status).toBe(404);
  }, 240_000);
});

describe('print after ERP completion', () => {
  it('generates the first sheet, adjusts it and downloads it without changing the reimbursement', async () => {
    const scene = await scenario(server, alice).at('done');
    const task = scene.reached;
    expect(task.printSheet.status).toBe('not_generated');
    const generated = await client.accepted(await print(task, 'generate-print-sheet'));
    const page = generated.printSheet.pages[0];
    if (!page?.top) throw new Error('missing invoice placement');
    const rotated = await client.accepted(await print(generated, 'rotate-placement', { pageId: page.pageId, slot: 'top', rotate: !page.top.rotate }));
    expect(rotated.printSheet.pages[0]?.top?.rotate).toBe(!page.top.rotate);
    expect((await download(rotated.printSheet.url ?? '')).getPageCount()).toBe(1);
    const reopened = await client.accepted(await print(rotated, 'generate-print-sheet'));
    expect(reopened.printSheet).toEqual(rotated.printSheet);
    expect(reopened.stage).toBe('done');
    expect(reopened.erp).toEqual(task.erp);
    expect(reopened.confirmation).toEqual(task.confirmation);
    expect(reopened.lines).toEqual(task.lines);
    expect(reopened.projectAssignment).toEqual(task.projectAssignment);
  });
});

// A #331 table screenshot, seeded as tasks from before ADR-0032 hold them.
async function screenshot(snapshot: TaskSnapshot, voucherMaterialId: string, file: File): Promise<TaskSnapshot> {
  await seedTableScreenshots(server, snapshot.task.taskId, voucherMaterialId, [file]);
  return client.current(snapshot.task.taskId);
}

// #333: a 住宿 invoice's #331 table group on the sheet, seeded as tasks from before ADR-0032 hold it. The group is only
// open to change before the list is confirmed, so every case climbs from the 待确认项: 「已传齐」, then assign and confirm.
describe('支付截图 on the sheet', () => {
  const shot = (n: number) => new File([readFileSync(join(GENERATED_DIR, `print-pg${n}.png`))], `IMG_50${10 + n}.png`, { type: 'image/png' });

  async function confirmedWith(count: number) {
    const scene = await scenario(server, alice).at('pending', { materials: ['m01', 'm02'] });
    const invoice = byFileName(scene.reached, sample('m01').name);
    let latest = scene.reached;
    for (let n = 1; n <= count; n += 1) latest = await screenshot(latest, invoice.materialId, shot(n));
    const declared = await client.accepted(await print(latest, 'complete-payment-screenshots', { voucherMaterialId: invoice.materialId }));
    const review = await scene.accept('submit-project-assignment', { purpose: '上海产品评审出差', projects: Object.fromEntries(declared.lines.map((line) => [line.lineId, 'P-2307'])) });
    const ready = await scene.accept('confirm-review', { digest: review.confirmation.digest });
    const group = ready.paymentScreenshots.map((one) => one.screenshotId);
    return { scene, invoice, ready, group };
  }

  it('one screenshot: the invoice page is unchanged, the screenshot beside the folio', async () => {
    const { ready, group } = await confirmedWith(1);
    const sheet = (await client.accepted(await print(ready, 'generate-print-sheet'))).printSheet;
    expect(sheet.pages).toEqual([
      expect.objectContaining({ kind: 'voucher', header: 'No.1 · 08-09 · 住宿 · 3640.00', top: expect.objectContaining({ fileName: sample('m01').name }), bottom: expect.objectContaining({ fileName: sample('m02').name }), screenshotIds: group }),
    ]);
    expect(sheet.notices).toEqual([]);
    expect((await download(sheet.url ?? '')).getPageCount()).toBe(1);

    // A sheet composed before #333 stored one nullable `screenshotId` per page and no page kind; it still reads.
    // (print_render is append-only: the old shape is stored as a later render of the same content.)
    const stored = await server.db.selectFrom('print_render').selectAll().where('task_id', '=', ready.task.taskId).executeTakeFirstOrThrow();
    const legacy = (JSON.parse(stored.pages) as Record<string, unknown>[]).map(({ kind, screenshotIds, ...page }) => (void kind, { ...page, screenshotId: (screenshotIds as string[])[0] ?? null }));
    await server.db.insertInto('print_render').values({ ...stored, render_id: `${stored.render_id}.legacy`, pages: JSON.stringify(legacy), revision: stored.revision + 1 }).execute();
    expect((await client.current(ready.task.taskId)).printSheet).toEqual(sheet);
  }, 120_000);

  it('three: the invoice page holds the folio only, and a continuation page follows with the three in upload order', async () => {
    const { ready, group } = await confirmedWith(3);
    const generated = await client.accepted(await print(ready, 'generate-print-sheet'));
    const sheet = generated.printSheet;
    expect(group).toHaveLength(3);
    expect(sheet.pages).toEqual([
      expect.objectContaining({ kind: 'voucher', header: 'No.1 · 08-09 · 住宿 · 3640.00', top: expect.objectContaining({ fileName: sample('m01').name }), bottom: expect.objectContaining({ fileName: sample('m02').name }), screenshotIds: [] }),
      expect.objectContaining({ kind: 'screenshots', no: 1, nos: 'No.1', grossAmount: '3640.00', hotelName: '全季酒店（上海某某店）', header: 'No.1 支付截图（续） · 全季酒店（上海某某店） · 3640.00', top: null, bottom: null, screenshotIds: group }),
    ]);
    expect(sheet.notices).toEqual([]);
    expect((await download(sheet.url ?? '')).getPageCount()).toBe(sheet.pages.length);
    for (const page of sheet.pages) expect((await alice.request(page.imageUrl)).headers.get('content-type')).toBe('image/png');

    // The folio is still the invoice page's bottom placement: turning it re-renders that page and keeps the continuation.
    const [invoicePage, continuation] = sheet.pages;
    if (!invoicePage?.bottom || !continuation) throw new Error('unexpected pages');
    const turned = await client.accepted(await print(generated, 'rotate-placement', { pageId: invoicePage.pageId, slot: 'bottom', rotate: !invoicePage.bottom.rotate }));
    expect(turned.printSheet.pages.map((page) => [page.kind, page.bottom?.rotate ?? null, page.screenshotIds])).toEqual([
      ['voucher', !invoicePage.bottom.rotate, []],
      ['screenshots', null, group],
    ]);
    expect(turned.printSheet.pages[0]?.imageUrl).not.toBe(invoicePage.imageUrl);
    // A continuation page has nothing to turn or crop.
    await refused(await print(turned, 'rotate-placement', { pageId: continuation.pageId, slot: 'top', rotate: true }), 'slot_empty');
  }, 180_000);

  it('six fit one continuation page', async () => {
    const { ready, group } = await confirmedWith(6);
    const sheet = (await client.accepted(await print(ready, 'generate-print-sheet'))).printSheet;
    expect(sheet.pages.map((page) => [page.kind, page.screenshotIds])).toEqual([
      ['voucher', []],
      ['screenshots', group],
    ]);
    expect((await download(sheet.url ?? '')).getPageCount()).toBe(2);
  }, 180_000);

  it('a revived confirmation does not bring back a sheet that prints an older group', async () => {
    const { ready, invoice, group } = await confirmedWith(2);
    const generated = await client.accepted(await print(ready, 'generate-print-sheet'));
    // Invalidating the list unlocks the group; reverting the change revives the confirmation (see 'the sheet follows
    // the confirmation'), but the sheet composed under it printed two screenshots, and the invoice now has three.
    const moved = await client.accepted(await client.act(generated, 'set-home-city', { homeCity: '上海' }));
    const added = await screenshot(moved, invoice.materialId, shot(3));
    const back = await client.accepted(await client.act(added, 'set-home-city', { homeCity: '杭州' }));
    expect(back.confirmation).toEqual(generated.confirmation);
    expect(back.printSheet.status).toBe('stale');

    const again = (await client.accepted(await print(back, 'generate-print-sheet'))).printSheet;
    expect(again.pages[1]?.screenshotIds).toEqual([...group, added.paymentScreenshots[2]?.screenshotId]);
    expect((await download(again.url ?? '')).getPageCount()).toBe(2);
  }, 180_000);
});

// #312: the medium is what recognition sniffs from the bytes at upload, not what the name or MIME declares. A taxi
// photo saved as `.pdf` is listed and printed as the image it is, and does not jump the PDFs-first parse order.
// ADR-0032: 支付截图 materials print with the invoice inventory placed them with, as many continuation pages as they fill.
describe('支付截图 materials on the sheet', () => {
  async function confirmedWith(count: number) {
    const shots = paymentScreenshots();
    // Each pays an equal part of the 3640.00 stay on its first night, so the stay is complete by sum.
    const uploads = Array.from({ length: count }, (_, n) => shots.upload(`付款${n + 1}.png`, { amount: (3640 / count).toFixed(2), payDate: '2026-08-09', payTime: `12:00:${String(n).padStart(2, '0')}` }));
    await server.close();
    server = await scenarioServer({ parser: presetParser(shots.outcomes) });
    alice = await server.signIn('alice');
    const ready = (await scenario(server, alice).at('actions', { materials: ['m01', 'm02', ...uploads] })).reached;
    return { ready, group: uploads.map((upload) => byFileName(ready, upload.name).materialId) };
  }

  it('one prints beside the folio', async () => {
    const { ready, group } = await confirmedWith(1);
    const sheet = (await client.accepted(await print(ready, 'generate-print-sheet'))).printSheet;
    expect(sheet.pages.map((page) => [page.kind, page.bottom?.fileName ?? null, page.screenshotIds])).toEqual([['voucher', sample('m02').name, group]]);
    expect(sheet.notices).toEqual([]);
  }, 120_000);

  it('eight fill one continuation page and start a second, in upload order', async () => {
    const { ready, group } = await confirmedWith(8);
    expect(ready.paymentScreenshots.map((shot) => shot.screenshotId)).toEqual(group);
    const sheet = (await client.accepted(await print(ready, 'generate-print-sheet'))).printSheet;
    const header = 'No.1 支付截图（续） · 全季酒店（上海某某店） · 3640.00';
    expect(sheet.pages.map((page) => [page.kind, page.header, page.screenshotIds])).toEqual([
      ['voucher', 'No.1 · 08-09 · 住宿 · 3640.00', []],
      ['screenshots', header, group.slice(0, 6)],
      ['screenshots', header, group.slice(6)],
    ]);
    expect(sheet.notices).toEqual([]);
    expect((await download(sheet.url ?? '')).getPageCount()).toBe(3);
  }, 180_000);
});

describe('a material mislabelled as a PDF', () => {
  const photoAsPdf = () => ({ ...sample('m09'), name: '出租车票.pdf', type: 'application/pdf' });

  it('is listed and printed as an image', async () => {
    const { reached: task } = await scenario(server, alice).at('actions', { materials: ['m01', 'm02', photoAsPdf()] });
    expect(byFileName(task, '出租车票.pdf').mediaType).toBe('image');

    const generated = await client.accepted(await print(task, 'generate-print-sheet'));
    const taxi = generated.printSheet.pages.find((page) => page.header.includes('外地市内交通'));
    // An image placement: a straightened photo with its detected paper corners, which a PDF page never has.
    expect(taxi?.top?.corners).toBeTruthy();
    await download(generated.printSheet.url!);
  });

  it('is parsed after the real PDFs, in upload order', async () => {
    const presets = presetParser();
    const order: string[] = [];
    await server.close();
    server = await scenarioServer({ parser: { ...presets, parse: (input) => (order.push(input.fileName), presets.parse(input)) } });
    alice = await server.signIn('alice');

    await scenario(server, alice).at('project', { materials: [photoAsPdf(), 'm07'] });

    expect(order).toEqual(['铁路电子客票_0809.pdf', '出租车票.pdf']);
  });
});

async function refused(response: Response, code: string): Promise<void> {
  expect(response.status).toBe(400);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
}
