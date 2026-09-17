import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pairHotelStays } from './hotel-stay';
import { api, byFileName, fieldValues, sample } from './test/api';
import { createTestServer, type TestClient, type TestServer } from './test/harness';

// Slice 06 (#185): a hotel invoice plus a 结账单 (folio) form one stay line with check-in and check-out dates.
// Ported from 50931a3:kernel/test/events.test.mjs ('住宿：入住日期来自结账单…', the with-folio half) on @baox/fixtures m01 + m02.

let server: TestServer;
let signedIn: TestClient;
beforeEach(async () => {
  server = await createTestServer();
  signedIn = await server.signIn();
});
afterEach(() => server.close());
const client = api(() => signedIn);

describe('a hotel invoice with its 全季 folio', () => {
  it('gives one line dated from check-in to check-out, the folio linked as its reference', async () => {
    const { task } = await client.createTask();
    const uploaded = await client.upload(task.taskId, [sample('m01'), sample('m02')]);
    await client.accepted(await client.act(uploaded, 'start-inventory'));
    const inventoried = await client.settled(task.taskId);
    // Paired, so the 住宿 trio check (#213) asks only for the payment screenshot; answered here with 确认没有.
    expect(inventoried.pendingItems.map((item) => item.itemId)).toEqual([`stay_screenshot_missing.${byFileName(inventoried, sample('m01').name).materialId}`]);
    const snapshot = await client.withoutStayGaps(inventoried);

    const invoice = byFileName(snapshot, sample('m01').name);
    const folio = byFileName(snapshot, sample('m02').name);
    expect(folio).toMatchObject({ kind: 'hotel_folio', layout: 'labelled', kindLabel: '酒店结账单', categoryLabel: '住宿', role: 'reference', status: 'ok', linkedMaterialIds: [invoice.materialId] });
    expect(invoice).toMatchObject({ role: 'primary_voucher', status: 'ok', linkedMaterialIds: [folio.materialId] });

    expect(snapshot.events).toEqual([
      expect.objectContaining({ voucherMaterialId: invoice.materialId, referenceMaterialIds: [folio.materialId], date: '2026-08-09', endDate: '2026-08-22', grossAmount: '3640.00', evidenceNote: expect.stringContaining('13 晚') }),
    ]);
    expect(snapshot.lines).toEqual([
      expect.objectContaining({ voucherMaterialId: invoice.materialId, referenceMaterialIds: [folio.materialId], date: '2026-08-09', endDate: '2026-08-22', category: { code: 'accommodation', label: '住宿' }, grossAmount: '3640.00' }),
    ]);
    expect(snapshot.pendingItems.filter((item) => item.status === 'open')).toEqual([]);
    expect(snapshot.inventory.ungroupedMaterialIds).toEqual([]);
    expect(snapshot.inventory.summary).toMatchObject({ materialCount: 2, okCount: 2, voucherCount: 1, referenceCount: 1 });
  });
});

describe('a hotel invoice with a photographed folio of another chain', () => {
  // #212: r210 is a folio photo whose labels and values OCR reads as separate boxes, dated 2026/08/09 and 2026年08月22日.
  it('reads the stay dates off the photo and pairs the folio with the invoice into one expense event', async () => {
    const { task } = await client.createTask();
    const uploaded = await client.upload(task.taskId, [sample('m01'), sample('r210')]);
    await client.accepted(await client.act(uploaded, 'start-inventory'));
    const snapshot = await client.settled(task.taskId, 120_000);

    const invoice = byFileName(snapshot, sample('m01').name);
    const folio = byFileName(snapshot, sample('r210').name);
    expect(folio).toMatchObject({ kind: 'hotel_folio', layout: 'labelled', role: 'reference', status: 'ok', linkedMaterialIds: [invoice.materialId] });
    expect(fieldValues(folio, 'rule:hotel_folio/labelled')).toMatchObject({ checkIn: '2026-08-09', checkOut: '2026-08-22', folioTotal: '3640.00' });
    expect(snapshot.events).toEqual([expect.objectContaining({ voucherMaterialId: invoice.materialId, referenceMaterialIds: [folio.materialId], date: '2026-08-09', endDate: '2026-08-22', grossAmount: '3640.00' })]);
    expect(snapshot.pendingItems).toEqual([]);
  }, 180_000);
});

describe('pairHotelStays', () => {
  const invoice = (materialId: string, totalAmount: string) => ({ materialId, values: { totalAmount } });
  const folio = (materialId: string, folioTotal: string) => ({ materialId, values: { folioTotal, checkIn: '2026-08-09', checkOut: '2026-08-22' } });

  it('pairs an invoice and a folio whose totals agree to the cent', () => {
    expect(pairHotelStays([invoice('a', '3640.00')], [folio('f', '3640.00')])).toEqual([expect.objectContaining({ invoiceId: 'a', folioId: 'f', checkIn: '2026-08-09', checkOut: '2026-08-22' })]);
  });

  it('pairs nothing when the totals differ or the match is not one-to-one', () => {
    expect(pairHotelStays([invoice('a', '3640.00')], [folio('f', '3639.99')])).toEqual([]);
    expect(pairHotelStays([invoice('a', '3640.00')], [folio('f', '3640.00'), folio('g', '3640.00')])).toEqual([]);
    expect(pairHotelStays([invoice('a', '3640.00'), invoice('b', '3640.00')], [folio('f', '3640.00')])).toEqual([]);
  });
});
