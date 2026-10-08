import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pairHotelStays } from './hotel-stay';
import { lodgingEvidence, type TaskSnapshot } from '@baox/contract';
import type { ParseOutcome } from './parse/dispatch';
import { api, byFileName, fieldValues, sample, type Upload } from './test/api';
import { createTestServer, type TestClient, type TestServer } from './test/harness';
import { loadParsePresets, presetParser, sha256 } from './test/parse-presets';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';

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
    const evidence = snapshot.lodgingEvidence.find((candidate) => candidate.materialId === invoice.materialId);
    expect(evidence).toMatchObject({ state: 'associated', defaultMaterialId: folio.materialId, fields: { checkIn: { value: '2026-08-09', materialId: folio.materialId }, checkOut: { value: '2026-08-22', materialId: folio.materialId }, amount: { value: '3640.00', materialId: invoice.materialId } } });
    expect(evidence?.fields.hotelName).toMatchObject({ source: 'rule:hotel_folio/labelled', evidence: 'explicit' });
    expect(evidence?.previews).toEqual(expect.arrayContaining([{ materialId: folio.materialId, available: true }]));
    expect(lodgingEvidence({ ...snapshot, materials: snapshot.materials.map((material) => ({ ...material, fields: material.fields.filter((field) => field.key !== 'hotelName') })) }, invoice.materialId)?.fields.hotelName).toBeNull();
    const conflictingFolio = {
      ...folio,
      materialId: `${folio.materialId}-conflict`,
      linkedMaterialIds: [invoice.materialId],
      fields: folio.fields.map((field) => field.key === 'checkIn' ? { ...field, value: '2026-08-10' } : field.key === 'folioTotal' ? { ...field, value: '3600.00' } : field),
    };
    const conflictingEvidence = {
      ...snapshot,
      materials: [...snapshot.materials.map((material) => material.materialId === invoice.materialId ? { ...material, linkedMaterialIds: [...material.linkedMaterialIds, conflictingFolio.materialId] } : material), conflictingFolio],
      lines: snapshot.lines.map((line) => ({ ...line, referenceMaterialIds: [...line.referenceMaterialIds, conflictingFolio.materialId] })),
    };
    expect(lodgingEvidence(conflictingEvidence, invoice.materialId)?.fields.checkIn).toBeNull();
    expect(lodgingEvidence(conflictingEvidence, invoice.materialId)?.fields.amount).toBeNull();
    const unlinked = { ...snapshot, lines: [], materials: snapshot.materials.map((material) => ({ ...material, linkedMaterialIds: [] })) };
    expect(lodgingEvidence(unlinked, invoice.materialId)?.state).toBe('unlinked');
    expect(lodgingEvidence({ ...unlinked, materials: [unlinked.materials.find((material) => material.materialId === invoice.materialId)!] }, invoice.materialId)?.state).toBe('missing');
    const otherInvoice = { ...invoice, materialId: `${invoice.materialId}-other`, linkedMaterialIds: [folio.materialId] };
    const folioForOtherInvoice = { ...folio, linkedMaterialIds: [otherInvoice.materialId] };
    const otherStay = {
      ...snapshot,
      materials: [{ ...invoice, linkedMaterialIds: [] }, folioForOtherInvoice, otherInvoice],
      lines: snapshot.lines.map((line) => ({ ...line, voucherMaterialId: otherInvoice.materialId, referenceMaterialIds: [folioForOtherInvoice.materialId] })),
    };
    expect(lodgingEvidence(otherStay, invoice.materialId)?.state).toBe('missing');

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

describe('an unlinked hotel folio', () => {
  it('keeps its own preview and original in the server lodging projection', async () => {
    const { task } = await client.createTask();
    const uploaded = await client.upload(task.taskId, [sample('m02')]);
    await client.accepted(await client.act(uploaded, 'start-inventory'));
    const snapshot = await client.settled(task.taskId);
    const folio = byFileName(snapshot, sample('m02').name);
    const evidence = snapshot.lodgingEvidence.find((candidate) => candidate.materialId === folio.materialId);

    expect(evidence).toMatchObject({
      state: 'unlinked',
      defaultMaterialId: folio.materialId,
      previews: [{ materialId: folio.materialId, available: true }],
    });
    expect(folio.originalUrl).toMatch(/^\/api\/tasks\/[^/]+\/files\//);
    expect((await signedIn.request(folio.originalUrl!)).status).toBe(200);
  });
});

describe('a hotel invoice with a photographed folio of another chain', () => {
  // #212: r210 is a folio photo whose labels and values OCR reads as separate boxes, dated 2026/08/09 and 2026年08月22日.
  it('reads the stay dates off the photo and pairs the folio with the invoice into one expense event', async () => {
    const { task } = await client.createTask();
    const uploaded = await client.upload(task.taskId, [sample('m01'), sample('r210')]);
    await client.accepted(await client.act(uploaded, 'start-inventory'));
    const inventoried = await client.settled(task.taskId, 120_000);
    // Paired, so the 住宿 trio check (#213) asks only for the payment screenshot; answered here with 确认没有.
    expect(inventoried.pendingItems.map((item) => item.itemId)).toEqual([`stay_screenshot_missing.${byFileName(inventoried, sample('m01').name).materialId}`]);
    const snapshot = await client.withoutStayGaps(inventoried);

    const invoice = byFileName(snapshot, sample('m01').name);
    const folio = byFileName(snapshot, sample('r210').name);
    expect(folio).toMatchObject({ kind: 'hotel_folio', layout: 'labelled', role: 'reference', status: 'ok', linkedMaterialIds: [invoice.materialId] });
    expect(fieldValues(folio, 'rule:hotel_folio/labelled')).toMatchObject({ checkIn: '2026-08-09', checkOut: '2026-08-22', folioTotal: '3640.00' });
    expect(snapshot.events).toEqual([expect.objectContaining({ voucherMaterialId: invoice.materialId, referenceMaterialIds: [folio.materialId], date: '2026-08-09', endDate: '2026-08-22', grossAmount: '3640.00' })]);
    expect(snapshot.pendingItems.filter((item) => item.status === 'open')).toEqual([]);
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

// #357: pairing is one-to-one by amount (the shared matcher in `amount-pairing.ts`). When two invoices, or two folios,
// carry the same amount, nothing is paired on that amount: each stays on its own and the 住宿 trio asks for what it
// lacks. Dining (#356) inherits this rule.
describe('hotel invoices and folios with duplicate amounts', () => {
  let presetServer: ScenarioServer | null = null;
  afterEach(async () => {
    await presetServer?.close();
    presetServer = null;
  });

  // A copy of sample `prefix` under another name, with its own bytes (after the PDF's %%EOF) and a preset outcome
  // whose `edits` replace candidate values (a distinct invoice number keeps it from reading as the same invoice).
  function twin(prefix: string, name: string, edits: Record<string, string>): { upload: Upload; outcome: [string, ParseOutcome] } {
    const bytes = Buffer.concat([sample(prefix).bytes, Buffer.from(`\n% ${name}\n`)]);
    const preset = Object.entries(loadParsePresets()).find(([file]) => file.startsWith(`${prefix}-`))![1].outcome;
    if (preset.outcome !== 'recognised') throw new Error(`${prefix} is not recognised`);
    const outcome = { ...preset, candidates: preset.candidates.map((candidate) => (candidate.key in edits ? { ...candidate, value: edits[candidate.key]! } : candidate)) };
    return { upload: { name, bytes, type: 'application/pdf' }, outcome: [sha256(bytes), outcome] };
  }
  async function inventory(materials: ReadonlyArray<string | Upload>, outcomes: [string, ParseOutcome][]): Promise<TaskSnapshot> {
    presetServer = await scenarioServer({ parser: presetParser(Object.fromEntries(outcomes)) });
    return (await scenario(presetServer).at('pending', { materials })).reached;
  }
  const openIds = (snapshot: TaskSnapshot) => snapshot.pendingItems.filter((item) => item.status === 'open').map((item) => item.itemId);

  it('two invoices of one amount and one folio: neither invoice pairs, and the folio waits for its invoice', async () => {
    const other = twin('m01', '全季酒店_发票2.pdf', { invoiceNumber: '26312000000098127735' });
    const start = await inventory(['m01', other.upload, 'm02'], [other.outcome]);
    const first = byFileName(start, sample('m01').name);
    const second = byFileName(start, other.upload.name);
    const folio = byFileName(start, sample('m02').name);
    expect([first, second, folio].map((material) => material.linkedMaterialIds)).toEqual([[], [], []]);
    expect(start.lines.map((line) => line.referenceMaterialIds)).toEqual([[], []]);
    expect(openIds(start).sort()).toEqual(
      [
        `stay_folio_missing.${first.materialId}`,
        `stay_screenshot_missing.${first.materialId}`,
        `stay_folio_missing.${second.materialId}`,
        `stay_screenshot_missing.${second.materialId}`,
        `stay_invoice_missing.${folio.materialId}`,
      ].sort(),
    );
  });

  it('one invoice and two folios of its amount: the invoice pairs with neither', async () => {
    const other = twin('m02', '全季酒店_结账单2.pdf', { roomNumber: '1209' });
    const start = await inventory(['m01', 'm02', other.upload], [other.outcome]);
    const invoice = byFileName(start, sample('m01').name);
    const folios = [byFileName(start, sample('m02').name), byFileName(start, other.upload.name)];
    expect([invoice, ...folios].map((material) => material.linkedMaterialIds)).toEqual([[], [], []]);
    expect(start.lines).toEqual([expect.objectContaining({ voucherMaterialId: invoice.materialId, referenceMaterialIds: [] })]);
    expect(openIds(start).sort()).toEqual(
      [
        `stay_folio_missing.${invoice.materialId}`,
        `stay_screenshot_missing.${invoice.materialId}`,
        ...folios.map((folio) => `stay_invoice_missing.${folio.materialId}`),
      ].sort(),
    );
  });

  it('two stays of different amounts each pair with their own folio', async () => {
    const invoice = twin('m01', '全季酒店_发票2.pdf', { invoiceNumber: '26312000000098127735', totalAmount: '399.00', netAmount: '376.42', taxAmount: '22.58' });
    const folio = twin('m02', '全季酒店_结账单2.pdf', { folioTotal: '399.00', paidAmount: '399.00', roomNumber: '1209' });
    const start = await inventory(['m01', 'm02', invoice.upload, folio.upload], [invoice.outcome, folio.outcome]);
    const pairs = [
      [byFileName(start, sample('m01').name), byFileName(start, sample('m02').name)],
      [byFileName(start, invoice.upload.name), byFileName(start, folio.upload.name)],
    ] as const;
    for (const [voucher, reference] of pairs) {
      expect(voucher.linkedMaterialIds).toEqual([reference.materialId]);
      expect(reference.linkedMaterialIds).toEqual([voucher.materialId]);
    }
    expect(openIds(start).sort()).toEqual(pairs.map(([voucher]) => `stay_screenshot_missing.${voucher.materialId}`).sort());
  });
});
