import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR } from '@baox/fixtures';
import { STAY_TRIO_COPY, type PendingItem, type TaskSnapshot } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pairHotelStays } from './hotel-stay';
import { checkStayTrios, type TrioVoucher } from './stay-trio';
import { api, byFileName, sample } from './test/api';
import { type TestClient } from './test/harness';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';

// #213: the 住宿 (accommodation) trio — 发票 (invoice), 结账单 (hotel folio), 支付截图 (payment screenshot) — is checked
// at 盘点 (inventory), where a missing element can still be fetched, and the print stage reads what was recorded there.

describe('checkStayTrios', () => {
  const invoice: TrioVoucher = { materialId: 'inv', fileName: '全季酒店_发票.pdf', values: { totalAmount: '3640.00' } };
  const folio: TrioVoucher = { materialId: 'fol', fileName: '全季酒店_结账单.pdf', values: { folioTotal: '3640.00', checkIn: '2026-08-09', checkOut: '2026-08-22' } };
  const otherFolio: TrioVoucher = { ...folio, materialId: 'fol2', fileName: '汉庭_结账单.jpg', values: { ...folio.values, folioTotal: '399.00' } };
  const check = (invoices: TrioVoucher[], folios: TrioVoucher[], screenshots: string[], answers = new Map()) =>
    checkStayTrios(invoices, folios, pairHotelStays(invoices, folios), new Set(screenshots), answers);
  const items = (result: ReturnType<typeof check>): PendingItem[] => [...result.items.values()].flat();

  it('raises nothing for a complete trio', () => {
    const result = check([invoice], [folio], ['inv']);
    expect(items(result)).toEqual([]);
    expect(result.trios).toEqual([
      { invoiceId: 'inv', folioId: 'fol', invoice: { present: true, noneConfirmed: false }, folio: { present: true, noneConfirmed: false }, screenshot: { present: true, noneConfirmed: false } },
    ]);
  });

  it('a missing folio: one item on the invoice that names the 结账单 and the invoice', () => {
    const result = check([invoice], [], ['inv']);
    expect(items(result)).toEqual([
      expect.objectContaining({ itemId: 'stay_folio_missing.inv', materialId: 'inv', kind: 'choice', status: 'open', title: '住宿发票「全季酒店_发票.pdf」缺少结账单', why: expect.stringContaining('价税合计 3640.00 元') }),
    ]);
    expect(items(result)[0]?.choices).toEqual([
      { key: 'confirm_none', label: '确认没有结账单' },
      { key: 'exclude', label: '排除这份材料' },
    ]);
  });

  it('a folio of another amount is not this invoice’s folio: nothing is inferred from its presence', () => {
    const result = check([invoice], [otherFolio], ['inv']);
    expect(items(result).map((item) => item.itemId)).toEqual(['stay_folio_missing.inv', 'stay_invoice_missing.fol2']);
  });

  it('a missing screenshot: one item on the invoice that names the 支付截图', () => {
    const result = check([invoice], [folio], []);
    expect(items(result)).toEqual([expect.objectContaining({ itemId: 'stay_screenshot_missing.inv', materialId: 'inv', title: '住宿发票「全季酒店_发票.pdf」缺少支付截图' })]);
    expect(items(result)[0]?.choices.map((choice) => choice.label)).toEqual(['确认没有支付截图', '排除这份材料']);
  });

  it('a missing invoice: one item on the folio that names the 住宿发票, and no screenshot is asked of it', () => {
    const result = check([], [folio], []);
    expect(items(result)).toEqual([expect.objectContaining({ itemId: 'stay_invoice_missing.fol', materialId: 'fol', title: '结账单「全季酒店_结账单.pdf」缺少住宿发票', why: expect.stringContaining('消费合计 3640.00 元') })]);
    expect(result.trios).toEqual([expect.objectContaining({ invoiceId: null, folioId: 'fol', screenshot: null })]);
  });

  it('确认没有 settles the item and records the absence; the record outlives a screenshot supplied later', () => {
    const answers = new Map([['stay_screenshot_missing.inv', { choice: 'confirm_none' }]]);
    const confirmed = check([invoice], [folio], [], answers);
    expect(items(confirmed)).toEqual([expect.objectContaining({ itemId: 'stay_screenshot_missing.inv', status: 'resolved', answer: { choice: 'confirm_none' } })]);
    expect(confirmed.trios[0]?.screenshot).toEqual({ present: false, noneConfirmed: true });

    const supplied = check([invoice], [folio], ['inv'], answers);
    expect(items(supplied)).toEqual([]);
    expect(supplied.trios[0]?.screenshot).toEqual({ present: true, noneConfirmed: true });
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

const png = () => new File([readFileSync(join(GENERATED_DIR, 'print-pg1.png'))], 'IMG_5011.png', { type: 'image/png' });

function screenshot(snapshot: TaskSnapshot, voucherMaterialId: string): Promise<Response> {
  const form = new FormData();
  form.append('voucherMaterialId', voucherMaterialId);
  form.append('file', png());
  return alice.request(`/api/tasks/${snapshot.task.taskId}/payment-screenshots`, { method: 'POST', body: form });
}

const answer = async (snapshot: TaskSnapshot, itemId: string, choice: string) => client.accepted(await client.act(snapshot, 'answer-pending', { itemId, answer: { choice } }));

async function refused(response: Response, code: string): Promise<string> {
  expect(response.status).toBe(400);
  const body = (await response.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe(code);
  return body.error.message;
}

const openIds = (snapshot: TaskSnapshot) => snapshot.pendingItems.filter((item) => item.status === 'open').map((item) => item.itemId);

describe('the 住宿 trio at inventory', () => {
  it('invoice and folio without a screenshot: the queue names the screenshot; attaching one at inventory resolves it', async () => {
    const start = (await scenario(server, alice).at('pending', { materials: ['m01', 'm02'] })).reached;
    const invoice = byFileName(start, sample('m01').name);
    expect(openIds(start)).toEqual([`stay_screenshot_missing.${invoice.materialId}`]);
    expect(start.pendingItems[0]).toMatchObject({ title: STAY_TRIO_COPY.screenshot.title(invoice.fileName), materialId: invoice.materialId });
    expect(invoice).toMatchObject({ role: 'primary_voucher', status: 'pending', pendingItemIds: [`stay_screenshot_missing.${invoice.materialId}`] });
    // The event still forms; only the list waits.
    expect(start.events).toHaveLength(1);
    expect(start).toMatchObject({ stage: 'pending', step: { kind: 'answer_pending' } });

    // No sheet exists yet: the print-stage precondition is relaxed for a 住宿 invoice.
    const supplied = await client.accepted(await screenshot(start, invoice.materialId));
    expect(supplied.paymentScreenshots).toEqual([expect.objectContaining({ voucherMaterialId: invoice.materialId })]);
    expect(supplied.pendingItems).toEqual([]);
    expect(byFileName(supplied, invoice.fileName)).toMatchObject({ status: 'ok', pendingItemIds: [] });
    expect(supplied.stage).toBe('project');
    expect(supplied.printSheet.status).toBe('not_generated');
  });

  it('the complete trio raises no item', async () => {
    const start = (await scenario(server, alice).at('pending', { materials: ['m01', 'm02'] })).reached;
    const invoice = byFileName(start, sample('m01').name);
    const supplied = await client.accepted(await screenshot(start, invoice.materialId));
    // Re-derived from scratch by a later read: still nothing.
    const again = await client.current(supplied.task.taskId);
    expect(again.pendingItems).toEqual([]);
    expect(again.inventory.summary).toMatchObject({ openPendingItemCount: 0, pendingMaterialCount: 0 });
  });

  it('an invoice without its folio: the queue names the 结账单; 确认没有 lets the list proceed with the absence recorded', async () => {
    const start = (await scenario(server, alice).at('pending', { materials: ['m01'] })).reached;
    const invoice = byFileName(start, sample('m01').name);
    const supplied = await client.accepted(await screenshot(start, invoice.materialId));
    expect(openIds(supplied)).toEqual([`stay_folio_missing.${invoice.materialId}`]);
    expect(supplied.pendingItems[0]).toMatchObject({ title: '住宿发票「全季酒店_发票.pdf」缺少结账单' });

    const done = await answer(supplied, `stay_folio_missing.${invoice.materialId}`, 'confirm_none');
    expect(done.pendingItems).toEqual([expect.objectContaining({ status: 'resolved', answer: { choice: 'confirm_none' } })]);
    expect(done.stage).toBe('project');
    // Nothing is inferred: without a folio the line keeps the invoice's own date and no reference material.
    expect(done.lines).toEqual([expect.objectContaining({ voucherMaterialId: invoice.materialId, referenceMaterialIds: [] })]);
  });

  it('a folio without an invoice: the queue names the 住宿发票 on the folio', async () => {
    const start = (await scenario(server, alice).at('pending', { materials: ['m02'] })).reached;
    const folio = byFileName(start, sample('m02').name);
    expect(openIds(start)).toEqual([`stay_invoice_missing.${folio.materialId}`]);
    expect(start.pendingItems[0]).toMatchObject({ materialId: folio.materialId, title: STAY_TRIO_COPY.invoice.title(folio.fileName) });
    // A folio has no page of its own, so there is nowhere to attach a screenshot.
    await refused(await screenshot(start, folio.materialId), 'print_not_generated');

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

  it('a voucher that is not a 住宿 invoice still takes a screenshot only on a generated sheet', async () => {
    const start = (await scenario(server, alice).at('project', { materials: ['m07'] })).reached;
    await refused(await screenshot(start, byFileName(start, sample('m07').name).materialId), 'print_not_generated');
  });
});

describe('the print stage reads the absence recorded at inventory', () => {
  it('a confirmed absence is the print notice; a screenshot added at print clears it and can be removed again', async () => {
    // Reaching `actions` answers the missing screenshot with 确认没有.
    const ready = (await scenario(server, alice).at('actions', { materials: ['m01', 'm02'] })).reached;
    const invoice = byFileName(ready, sample('m01').name);
    expect(ready.pendingItems).toEqual([expect.objectContaining({ itemId: `stay_screenshot_missing.${invoice.materialId}`, status: 'resolved', answer: { choice: 'confirm_none' } })]);
    const generated = await client.accepted(await alice.post(`/api/tasks/${ready.task.taskId}/actions/generate-print-sheet`, {}));
    expect(generated.printSheet.notices).toEqual([STAY_TRIO_COPY.printNotice('No.1', '住宿')]);

    const shot = await client.accepted(await screenshot(generated, invoice.materialId));
    expect(shot.printSheet.notices).toEqual([]);
    const removed = await client.accepted(await alice.post(`/api/tasks/${ready.task.taskId}/actions/remove-payment-screenshot`, { screenshotId: shot.paymentScreenshots[0]?.screenshotId }));
    expect(removed.printSheet.notices).toEqual([STAY_TRIO_COPY.printNotice('No.1', '住宿')]);
    expect(removed.confirmation.status).toBe('confirmed');
  }, 120_000);

  it('a screenshot supplied at inventory raises no print notice, and cannot be removed from a confirmed list', async () => {
    const scene = await scenario(server, alice).at('pending', { materials: ['m01', 'm02'] });
    const invoice = byFileName(scene.reached, sample('m01').name);
    const supplied = await client.accepted(await screenshot(scene.reached, invoice.materialId));
    const review = await scene.accept('submit-project-assignment', { purpose: '上海产品评审出差', projects: Object.fromEntries(supplied.lines.map((line) => [line.lineId, 'P-2307'])) });
    const ready = await scene.accept('confirm-review', { digest: review.confirmation.digest });
    const generated = await client.accepted(await alice.post(`/api/tasks/${ready.task.taskId}/actions/generate-print-sheet`, {}));
    expect(generated.printSheet.pages[0]?.screenshotId).toBe(generated.paymentScreenshots[0]?.screenshotId);
    expect(generated.printSheet.notices).toEqual([]);

    const message = await refused(await alice.post(`/api/tasks/${ready.task.taskId}/actions/remove-payment-screenshot`, { screenshotId: generated.paymentScreenshots[0]?.screenshotId }), 'screenshot_required');
    expect(message).toBe(STAY_TRIO_COPY.removeLocked);
    // A replacement is still fine.
    const replaced = await client.accepted(await screenshot(generated, invoice.materialId));
    expect(replaced.paymentScreenshots).toHaveLength(1);
    expect(replaced.confirmation.status).toBe('confirmed');
  }, 120_000);
});
