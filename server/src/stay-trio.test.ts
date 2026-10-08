import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR } from '@baox/fixtures';
import { PAYMENT_COPY, PAYMENT_SCREENSHOT_ERRORS, STAY_TRIO_CONFIRM_PAID, STAY_TRIO_COPY, type PendingItem, type TaskSnapshot } from '@baox/contract';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pairHotelStays } from './hotel-stay';
import { settleLegacyScreenshots331 } from './db/migrations';
import { checkStayTrios, type ScreenshotGroup, type TrioVoucher } from './stay-trio';
import { api, byFileName, sample } from './test/api';
import { type TestClient } from './test/harness';
import { postStayScreenshots, seedTableScreenshots } from './test/payment-screenshots';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';

// #213: the 住宿 (accommodation) trio — 发票 (invoice), 结账单 (hotel folio), 支付截图 (payment screenshot) — is checked
// at 盘点 (inventory), where a missing element can still be fetched, and the print stage reads what was recorded there.

describe('checkStayTrios', () => {
  const invoice: TrioVoucher = { materialId: 'inv', fileName: '全季酒店_发票.pdf', values: { totalAmount: '3640.00' } };
  const folio: TrioVoucher = { materialId: 'fol', fileName: '全季酒店_结账单.pdf', values: { folioTotal: '3640.00', checkIn: '2026-08-09', checkOut: '2026-08-22' } };
  const otherFolio: TrioVoucher = { ...folio, materialId: 'fol2', fileName: '汉庭_结账单.jpg', values: { ...folio.values, folioTotal: '399.00' } };
  // `screenshots`: the invoices with a group of one, declared complete unless given as a group.
  const check = (invoices: TrioVoucher[], folios: TrioVoucher[], screenshots: (string | [string, ScreenshotGroup])[], answers = new Map(), paid = new Map<string, number[]>()) =>
    checkStayTrios(invoices, folios, pairHotelStays(invoices, folios), new Map(screenshots.map((entry) => (typeof entry === 'string' ? [entry, { count: 1, complete: true }] : entry))), paid, answers);
  const items = (result: ReturnType<typeof check>): PendingItem[] => [...result.items.values()].flat();

  it('a complete trio: only the screenshot item, settled on its complete group', () => {
    const result = check([invoice], [folio], ['inv']);
    expect(items(result)).toEqual([expect.objectContaining({ itemId: 'stay_screenshot_missing.inv', status: 'resolved', answer: null })]);
    expect(result.trios).toEqual([
      { invoiceId: 'inv', folioId: 'fol', invoice: { present: true, noneConfirmed: false }, folio: { present: true, noneConfirmed: false }, screenshot: { present: true, noneConfirmed: false } },
    ]);
  });

  it('a missing folio: one item on the invoice that names the 结账单 and the invoice', () => {
    const result = check([invoice], [], ['inv']);
    expect(items(result)).toEqual([
      expect.objectContaining({ itemId: 'stay_folio_missing.inv', materialId: 'inv', kind: 'choice', status: 'open', title: '住宿发票「全季酒店_发票.pdf」缺少结账单', why: expect.stringContaining('价税合计 3640.00 元') }),
      expect.objectContaining({ itemId: 'stay_screenshot_missing.inv', status: 'resolved' }),
    ]);
    expect(items(result)[0]?.choices).toEqual([
      { key: 'confirm_none', label: '确认没有结账单' },
      { key: 'exclude', label: '排除这份材料' },
    ]);
  });

  it('a folio of another amount is not this invoice’s folio: nothing is inferred from its presence', () => {
    const result = check([invoice], [otherFolio], ['inv']);
    expect(items(result).map((item) => item.itemId)).toEqual(['stay_folio_missing.inv', 'stay_screenshot_missing.inv', 'stay_invoice_missing.fol2']);
  });

  it('a missing screenshot: one item on the invoice that names the 支付截图', () => {
    const result = check([invoice], [folio], []);
    expect(items(result)).toEqual([expect.objectContaining({ itemId: 'stay_screenshot_missing.inv', materialId: 'inv', title: '住宿发票「全季酒店_发票.pdf」缺少支付截图' })]);
    expect(items(result)[0]?.choices.map((choice) => choice.label)).toEqual(['确认没有支付截图', '排除这份材料']);
  });

  it('a group not yet declared complete keeps the screenshot item open (#331)', () => {
    const result = check([invoice], [folio], [['inv', { count: 3, complete: false }]]);
    expect(items(result)).toEqual([expect.objectContaining({ itemId: 'stay_screenshot_missing.inv', status: 'open' })]);
    expect(result.trios[0]?.screenshot).toEqual({ present: true, noneConfirmed: false });
  });

  it('a missing invoice: one item on the folio that names the 住宿发票, and no screenshot is asked of it', () => {
    const result = check([], [folio], []);
    expect(items(result)).toEqual([expect.objectContaining({ itemId: 'stay_invoice_missing.fol', materialId: 'fol', title: '结账单「全季酒店_结账单.pdf」缺少住宿发票', why: expect.stringContaining('消费合计 3640.00 元') })]);
    expect(result.trios).toEqual([expect.objectContaining({ invoiceId: null, folioId: 'fol', screenshot: null })]);
  });

  it('确认没有 settles the item and records the absence while the group is empty', () => {
    const answers = new Map([['stay_screenshot_missing.inv', { choice: 'confirm_none' }]]);
    const confirmed = check([invoice], [folio], [], answers);
    expect(items(confirmed)).toEqual([expect.objectContaining({ itemId: 'stay_screenshot_missing.inv', status: 'resolved', answer: { choice: 'confirm_none' } })]);
    expect(confirmed.trios[0]?.screenshot).toEqual({ present: false, noneConfirmed: true });
  });

  it('a screenshot supersedes 确认没有: the item waits for 「已传齐」 and records no absence (#332)', () => {
    const answers = new Map([['stay_screenshot_missing.inv', { choice: 'confirm_none' }]]);
    const pending = check([invoice], [folio], [['inv', { count: 1, complete: false }]], answers);
    expect(items(pending)).toEqual([expect.objectContaining({ status: 'open', answer: null })]);
    expect(pending.trios[0]?.screenshot).toEqual({ present: true, noneConfirmed: false });

    const declared = check([invoice], [folio], ['inv'], answers);
    expect(items(declared)).toEqual([expect.objectContaining({ status: 'resolved', answer: null })]);
    expect(declared.trios[0]?.screenshot).toEqual({ present: true, noneConfirmed: false });
  });
});

// ADR-0032: 支付截图 materials carry amounts, so their stay is checked by sum.
describe('checkStayTrios by sum', () => {
  const invoice: TrioVoucher = { materialId: 'inv', fileName: '全季酒店_发票.pdf', values: { totalAmount: '3640.00' } };
  const folio: TrioVoucher = { materialId: 'fol', fileName: '全季酒店_结账单.pdf', values: { folioTotal: '3640.00', checkIn: '2026-08-09', checkOut: '2026-08-22' } };
  const check = (paid: number[], answers = new Map(), groups = new Map<string, ScreenshotGroup>()) =>
    checkStayTrios([invoice], [folio], pairHotelStays([invoice], [folio]), groups, new Map([['inv', paid]]), answers);
  const item = (result: ReturnType<typeof check>) => result.items.get('inv')?.[0];

  it('at least the invoice total settles the item by itself, however much more was paid', () => {
    expect(item(check([364000]))).toMatchObject({ status: 'resolved', answer: null });
    expect(item(check([200000, 170000]))).toMatchObject({ status: 'resolved', answer: null });
  });

  it('less keeps it open, says by how much, and offers 「已传齐」 in place of 确认没有', () => {
    const short = item(check([100000]));
    expect(short).toMatchObject({ status: 'open', title: PAYMENT_COPY.shortfallTitle(invoice.fileName), why: PAYMENT_COPY.shortfallWhy('1000.00', '3640.00', '2640.00') });
    expect(short?.choices.map((choice) => choice.key)).toEqual([STAY_TRIO_CONFIRM_PAID, 'exclude']);
  });

  it('「已传齐」 settles a shortfall, and does not fit once no screenshot is placed', () => {
    const answers = new Map([['stay_screenshot_missing.inv', { choice: STAY_TRIO_CONFIRM_PAID }]]);
    expect(item(check([100000], answers))).toMatchObject({ status: 'resolved', answer: { choice: STAY_TRIO_CONFIRM_PAID } });
    expect(item(check([], answers))).toMatchObject({ status: 'open' });
  });

  it('确认没有 is refused while a screenshot material is placed', () => {
    const answers = new Map([['stay_screenshot_missing.inv', { choice: 'confirm_none' }]]);
    expect(item(check([364000], answers))).toMatchObject({ status: 'resolved', answer: null });
    expect(check([364000], answers).trios[0]?.screenshot).toEqual({ present: true, noneConfirmed: false });
  });

  it('a #331 group beside them has no amount: the group rule decides, not the sum', () => {
    const groups = new Map([['inv', { count: 1, complete: false }]]);
    expect(item(check([364000], new Map(), groups))).toMatchObject({ status: 'open', title: STAY_TRIO_COPY.screenshot.title(invoice.fileName) });
  });
});

let server: ScenarioServer;
let alice: TestClient;
beforeEach(async () => {
  server = await scenarioServer();
  alice = await server.signIn('alice');
});
afterEach(() => server.close());
const client = api(() => alice);

// Distinct images, so a group's order can be read back from the file names.
const png = (n = 1, name = `IMG_50${10 + n}.png`) => new File([readFileSync(join(GENERATED_DIR, `print-pg${n}.png`))], name, { type: 'image/png' });

async function screenshots(snapshot: TaskSnapshot, voucherMaterialId: string, files: File[]): Promise<TaskSnapshot> {
  await seedTableScreenshots(server, snapshot.task.taskId, voucherMaterialId, files);
  return client.current(snapshot.task.taskId);
}
const upload = (snapshot: TaskSnapshot, voucherMaterialId: string, files: File[] = [png()]) => postStayScreenshots(alice, snapshot, voucherMaterialId, files);
const printAction = (snapshot: TaskSnapshot, name: string, body: Record<string, unknown>) => alice.post(`/api/tasks/${snapshot.task.taskId}/actions/${name}`, body);
const complete = (snapshot: TaskSnapshot, voucherMaterialId: string) => printAction(snapshot, 'complete-payment-screenshots', { voucherMaterialId });
const remove = (snapshot: TaskSnapshot, screenshotId: string | undefined) => printAction(snapshot, 'remove-payment-screenshot', { screenshotId });

const answer = async (snapshot: TaskSnapshot, itemId: string, choice: string) => client.accepted(await client.act(snapshot, 'answer-pending', { itemId, answer: { choice } }));

async function refused(response: Response, code: string): Promise<string> {
  expect(response.status).toBe(400);
  const body = (await response.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe(code);
  return body.error.message;
}

const openIds = (snapshot: TaskSnapshot) => snapshot.pendingItems.filter((item) => item.status === 'open').map((item) => item.itemId);
const groupOf = (snapshot: TaskSnapshot, invoiceId: string) => snapshot.paymentScreenshots.filter((shot) => shot.voucherMaterialId === invoiceId).map((shot) => shot.fileName);
const screenshotItem = (snapshot: TaskSnapshot, invoiceId: string) => snapshot.pendingItems.find((item) => item.itemId === `stay_screenshot_missing.${invoiceId}`);

describe('the 住宿 trio at inventory', () => {
  it('invoice and folio without a screenshot: the queue names the screenshot', async () => {
    const start = (await scenario(server, alice).at('pending', { materials: ['m01', 'm02'] })).reached;
    const invoice = byFileName(start, sample('m01').name);
    expect(openIds(start)).toEqual([`stay_screenshot_missing.${invoice.materialId}`]);
    expect(start.pendingItems[0]).toMatchObject({ title: STAY_TRIO_COPY.screenshot.title(invoice.fileName), materialId: invoice.materialId });
    expect(invoice).toMatchObject({ role: 'primary_voucher', status: 'pending', pendingItemIds: [`stay_screenshot_missing.${invoice.materialId}`] });
    // The event still forms; only the list waits.
    expect(start.events).toHaveLength(1);
    expect(start).toMatchObject({ stage: 'pending', step: { kind: 'answer_pending' } });
  });

  it('an invoice without its folio: the queue names the 结账单; 确认没有 lets the list proceed with the absence recorded', async () => {
    const start = (await scenario(server, alice).at('pending', { materials: ['m01'] })).reached;
    const invoice = byFileName(start, sample('m01').name);
    const supplied = await screenshots(start, invoice.materialId, [png()]);
    const declared = await client.accepted(await complete(supplied, invoice.materialId));
    expect(openIds(declared)).toEqual([`stay_folio_missing.${invoice.materialId}`]);
    expect(declared.pendingItems[0]).toMatchObject({ title: '住宿发票「全季酒店_发票.pdf」缺少结账单' });

    const done = await answer(declared, `stay_folio_missing.${invoice.materialId}`, 'confirm_none');
    expect(done.pendingItems).toEqual([expect.objectContaining({ status: 'resolved', answer: { choice: 'confirm_none' } }), expect.objectContaining({ status: 'resolved' })]);
    expect(done.stage).toBe('project');
    // Nothing is inferred: without a folio the line keeps the invoice's own date and no reference material.
    expect(done.lines).toEqual([expect.objectContaining({ voucherMaterialId: invoice.materialId, referenceMaterialIds: [] })]);
  });

  it('a folio without an invoice: the queue names the 住宿发票 on the folio', async () => {
    const start = (await scenario(server, alice).at('pending', { materials: ['m02'] })).reached;
    const folio = byFileName(start, sample('m02').name);
    expect(openIds(start)).toEqual([`stay_invoice_missing.${folio.materialId}`]);
    expect(start.pendingItems[0]).toMatchObject({ materialId: folio.materialId, title: STAY_TRIO_COPY.invoice.title(folio.fileName) });
    // Only a 住宿 invoice takes a screenshot, never a folio.
    await refused(await upload(start, folio.materialId), 'screenshot_not_applicable');
    await refused(await complete(start, folio.materialId), 'screenshot_not_applicable');

    const done = await answer(start, `stay_invoice_missing.${folio.materialId}`, 'confirm_none');
    expect(openIds(done)).toEqual([]);
    expect(byFileName(done, folio.fileName)).toMatchObject({ role: 'reference', status: 'ok' });
  });

  it('supplying the missing folio by upload and a new inventory resolves its item', async () => {
    const scene = await scenario(server, alice).at('pending', { materials: ['m01'] });
    const invoice = byFileName(scene.reached, sample('m01').name);
    await scene.accept('reopen-upload');
    await client.upload(scene.task.taskId, [sample('m02')]);
    const again = await scene.run('start-inventory');
    expect(openIds(again)).toEqual([`stay_screenshot_missing.${invoice.materialId}`]);
  });

  it('a voucher that is not a 住宿 invoice takes no screenshot (#330)', async () => {
    const start = (await scenario(server, alice).at('project', { materials: ['m07'] })).reached;
    await refused(await upload(start, byFileName(start, sample('m07').name).materialId), 'screenshot_not_applicable');
  });
});

// #331: a 住宿 invoice's 支付截图 stored in the table form a group, and its item settles only when the filer says 「已传齐」.
describe('a group of 支付截图', () => {
  it('stays pending with three, resolves on 「已传齐」 and lists them in upload order', async () => {
    const start = (await scenario(server, alice).at('pending', { materials: ['m01', 'm02'] })).reached;
    const invoice = byFileName(start, sample('m01').name);
    await refused(await complete(start, invoice.materialId), 'screenshot_group_empty');

    const three = await screenshots(start, invoice.materialId, [png(1), png(2), png(3)]);
    expect(groupOf(three, invoice.materialId)).toEqual(['IMG_5011.png', 'IMG_5012.png', 'IMG_5013.png']);
    expect(screenshotItem(three, invoice.materialId)).toMatchObject({ status: 'open', screenshotGroup: { screenshotIds: three.paymentScreenshots.map((shot) => shot.screenshotId), locked: false } });
    // A pending screenshot item still keeps the list from ERP 就绪.
    expect(three).toMatchObject({ stage: 'pending', step: { kind: 'answer_pending' } });
    expect(byFileName(three, invoice.fileName)).toMatchObject({ status: 'pending' });
    expect(three.confirmation.digest).toBeNull();

    const declared = await client.accepted(await complete(three, invoice.materialId));
    expect(screenshotItem(declared, invoice.materialId)).toMatchObject({ status: 'resolved', answer: null });
    expect(declared.stage).toBe('project');
    expect(byFileName(declared, invoice.fileName)).toMatchObject({ status: 'ok' });
    // Declaring again changes nothing.
    expect(openIds(await client.accepted(await complete(declared, invoice.materialId)))).toEqual([]);

    // Re-derived from scratch by a later read: the same group, in the same order, still complete.
    const again = await client.current(declared.task.taskId);
    expect(groupOf(again, invoice.materialId)).toEqual(['IMG_5011.png', 'IMG_5012.png', 'IMG_5013.png']);
    expect(again.inventory.summary).toMatchObject({ openPendingItemCount: 0, pendingMaterialCount: 0 });
  });

  it('removing one from a group not yet declared complete keeps the rest in order and the item pending', async () => {
    const start = (await scenario(server, alice).at('pending', { materials: ['m01', 'm02'] })).reached;
    const invoice = byFileName(start, sample('m01').name);
    const three = await screenshots(start, invoice.materialId, [png(1), png(2), png(3)]);
    const removed = await client.accepted(await remove(three, three.paymentScreenshots[1]?.screenshotId));
    expect(groupOf(removed, invoice.materialId)).toEqual(['IMG_5011.png', 'IMG_5013.png']);
    expect(screenshotItem(removed, invoice.materialId)).toMatchObject({ status: 'open' });
    expect(removed.stage).toBe('pending');
    await refused(await remove(removed, three.paymentScreenshots[1]?.screenshotId), 'screenshot_not_found');
  });

  it('a pre-existing single screenshot reads as a resolved group of one', async () => {
    const start = (await scenario(server, alice).at('pending', { materials: ['m01', 'm02'] })).reached;
    const invoice = byFileName(start, sample('m01').name);
    // Before #331 a second upload replaced the first, and an upload alone settled the item; 0020_331 turns such rows
    // into a complete group of the one that counted.
    await screenshots(start, invoice.materialId, [png(1, 'replaced.png'), png(2, 'kept.png')]);
    await settleLegacyScreenshots331(server.db as unknown as Kysely<unknown>);

    const migrated = await client.current(start.task.taskId);
    expect(groupOf(migrated, invoice.materialId)).toEqual(['kept.png']);
    expect(screenshotItem(migrated, invoice.materialId)).toMatchObject({ status: 'resolved' });
    expect(migrated.stage).toBe('project');
  });

  it('a pre-#330 screenshot on a voucher that is not a 住宿 invoice forms no group: not in the snapshot, not printed', async () => {
    const scene = await scenario(server, alice).at('pending', { materials: ['m01', 'm02', 'm07'] });
    const invoice = byFileName(scene.reached, sample('m01').name);
    const other = byFileName(scene.reached, sample('m07').name);
    const one = await screenshots(scene.reached, invoice.materialId, [png(1)]);
    // Before #330 the print page took a screenshot for any voucher; 0020_331 settles it like any other.
    const kept = await server.db.selectFrom('payment_screenshot').selectAll().where('task_id', '=', one.task.taskId).executeTakeFirstOrThrow();
    await server.db
      .insertInto('payment_screenshot')
      .values({ ...kept, screenshot_id: 'legacy-other', voucher_material_id: other.materialId, file_name: 'legacy.png' })
      .execute();
    await settleLegacyScreenshots331(server.db as unknown as Kysely<unknown>);

    const migrated = await client.current(one.task.taskId);
    expect(migrated.paymentScreenshots.map((shot) => shot.fileName)).toEqual(['IMG_5011.png']);
    expect(screenshotItem(migrated, invoice.materialId)).toMatchObject({ status: 'resolved' });
    expect(migrated.stage).toBe('project');
    await refused(await remove(migrated, 'legacy-other'), 'screenshot_not_found');

    const review = await scene.accept('submit-project-assignment', { purpose: '上海产品评审出差', projects: Object.fromEntries(migrated.lines.map((line) => [line.lineId, 'P-2307'])) });
    const ready = await scene.accept('confirm-review', { digest: review.confirmation.digest });
    const generated = await client.accepted(await printAction(ready, 'generate-print-sheet', {}));
    expect(generated.printSheet.pages.flatMap((page) => page.screenshotIds)).toEqual(migrated.paymentScreenshots.map((shot) => shot.screenshotId));
  }, 120_000);

  it('is locked once the list is confirmed, and the sheet prints the whole group', async () => {
    const scene = await scenario(server, alice).at('pending', { materials: ['m01', 'm02'] });
    const invoice = byFileName(scene.reached, sample('m01').name);
    const two = await screenshots(scene.reached, invoice.materialId, [png(1), png(2)]);
    const declared = await client.accepted(await complete(two, invoice.materialId));
    const review = await scene.accept('submit-project-assignment', { purpose: '上海产品评审出差', projects: Object.fromEntries(declared.lines.map((line) => [line.lineId, 'P-2307'])) });
    const ready = await scene.accept('confirm-review', { digest: review.confirmation.digest });

    const generated = await client.accepted(await printAction(ready, 'generate-print-sheet', {}));
    expect(generated.printSheet.pages.flatMap((page) => page.screenshotIds)).toEqual(generated.paymentScreenshots.map((shot) => shot.screenshotId));
    expect(generated.printSheet.notices).toEqual([]);

    expect(await refused(await upload(generated, invoice.materialId, [png(3)]), 'screenshot_locked')).toBe(STAY_TRIO_COPY.changeLocked);
    await refused(await remove(generated, generated.paymentScreenshots[0]?.screenshotId), 'screenshot_locked');
    await refused(await complete(generated, invoice.materialId), 'screenshot_locked');
    const after = await client.current(ready.task.taskId);
    expect(groupOf(after, invoice.materialId)).toEqual(['IMG_5011.png', 'IMG_5012.png']);
    expect(screenshotItem(after, invoice.materialId)?.screenshotGroup).toEqual({ screenshotIds: after.paymentScreenshots.map((shot) => shot.screenshotId), locked: true });
    expect(after.confirmation.status).toBe('confirmed');
  }, 120_000);
});

// #332: a resolved screenshot item takes changes until the list is confirmed, and a screenshot supersedes 确认没有.
describe('reopening a resolved group of 支付截图', () => {
  it('after 「已传齐」 adding or removing one keeps it resolved; removing the last opens the item and clears 「已传齐」', async () => {
    const start = (await scenario(server, alice).at('pending', { materials: ['m01', 'm02'] })).reached;
    const invoice = byFileName(start, sample('m01').name);
    const declared = await client.accepted(await complete(await screenshots(start, invoice.materialId, [png(1), png(2)]), invoice.materialId));

    const added = await screenshots(declared, invoice.materialId, [png(3)]);
    expect(groupOf(added, invoice.materialId)).toEqual(['IMG_5011.png', 'IMG_5012.png', 'IMG_5013.png']);
    expect(screenshotItem(added, invoice.materialId)).toMatchObject({ status: 'resolved' });
    expect(added.stage).toBe('project');

    let latest = added;
    for (const shot of added.paymentScreenshots.slice(0, 2)) latest = await client.accepted(await remove(latest, shot.screenshotId));
    expect(groupOf(latest, invoice.materialId)).toEqual(['IMG_5013.png']);
    expect(screenshotItem(latest, invoice.materialId)).toMatchObject({ status: 'resolved' });
    expect(latest.stage).toBe('project');

    const emptied = await client.accepted(await remove(latest, latest.paymentScreenshots[0]?.screenshotId));
    expect(groupOf(emptied, invoice.materialId)).toEqual([]);
    expect(screenshotItem(emptied, invoice.materialId)).toMatchObject({ status: 'open', answer: null });
    expect(emptied).toMatchObject({ stage: 'pending', step: { kind: 'answer_pending' } });
    expect(byFileName(emptied, invoice.fileName)).toMatchObject({ status: 'pending' });

    // The declaration went with the group: a new screenshot waits for a new 「已传齐」.
    const refilled = await screenshots(emptied, invoice.materialId, [png(4)]);
    expect(screenshotItem(refilled, invoice.materialId)).toMatchObject({ status: 'open' });
    expect(screenshotItem(await client.accepted(await complete(refilled, invoice.materialId)), invoice.materialId)).toMatchObject({ status: 'resolved' });
  });

  it('an upload supersedes 确认没有 for good; with the group emptied again, 确认没有 may be chosen again', async () => {
    const start = (await scenario(server, alice).at('pending', { materials: ['m01', 'm02'] })).reached;
    const invoice = byFileName(start, sample('m01').name);
    const itemId = `stay_screenshot_missing.${invoice.materialId}`;
    const none = await answer(start, itemId, 'confirm_none');
    expect(screenshotItem(none, invoice.materialId)).toMatchObject({ status: 'resolved', answer: { choice: 'confirm_none' } });

    const supplied = await screenshots(none, invoice.materialId, [png(1)]);
    expect(screenshotItem(supplied, invoice.materialId)).toMatchObject({ status: 'open', answer: null });
    expect(supplied).toMatchObject({ stage: 'pending', step: { kind: 'answer_pending' } });
    // Not while the group holds a screenshot.
    expect(await refused(await client.act(supplied, 'answer-pending', { itemId, answer: { choice: 'confirm_none' } }), 'check_failed')).toBe(PAYMENT_SCREENSHOT_ERRORS.noneWithScreenshots);

    const emptied = await client.accepted(await remove(supplied, supplied.paymentScreenshots[0]?.screenshotId));
    expect(screenshotItem(emptied, invoice.materialId)).toMatchObject({ status: 'open', answer: null });
    const again = await answer(emptied, itemId, 'confirm_none');
    expect(screenshotItem(again, invoice.materialId)).toMatchObject({ status: 'resolved', answer: { choice: 'confirm_none' } });
    expect(again.stage).toBe('project');
  });

  it('a group declared after 确认没有 prints its screenshot, without the confirmed-none notice', async () => {
    const scene = await scenario(server, alice).at('pending', { materials: ['m01', 'm02'] });
    const invoice = byFileName(scene.reached, sample('m01').name);
    const none = await answer(scene.reached, `stay_screenshot_missing.${invoice.materialId}`, 'confirm_none');
    const declared = await client.accepted(await complete(await screenshots(none, invoice.materialId, [png(1)]), invoice.materialId));
    const review = await scene.accept('submit-project-assignment', { purpose: '上海产品评审出差', projects: Object.fromEntries(declared.lines.map((line) => [line.lineId, 'P-2307'])) });
    const ready = await scene.accept('confirm-review', { digest: review.confirmation.digest });

    const generated = await client.accepted(await printAction(ready, 'generate-print-sheet', {}));
    expect(generated.printSheet.pages[0]?.screenshotIds).toEqual(generated.paymentScreenshots.map((shot) => shot.screenshotId));
    expect(generated.printSheet.notices).toEqual([]);
  }, 120_000);
});

describe('the print stage reads the absence recorded at inventory', () => {
  it('a confirmed absence is the print notice, and no screenshot can be added to the confirmed list', async () => {
    // Reaching `actions` answers the missing screenshot with 确认没有.
    const ready = (await scenario(server, alice).at('actions', { materials: ['m01', 'm02'] })).reached;
    const invoice = byFileName(ready, sample('m01').name);
    expect(ready.pendingItems).toEqual([expect.objectContaining({ itemId: `stay_screenshot_missing.${invoice.materialId}`, status: 'resolved', answer: { choice: 'confirm_none' } })]);
    const generated = await client.accepted(await printAction(ready, 'generate-print-sheet', {}));
    expect(generated.printSheet.notices).toEqual([STAY_TRIO_COPY.printNotice('No.1', '住宿')]);
    await refused(await upload(generated, invoice.materialId), 'screenshot_locked');
  }, 120_000);
});
