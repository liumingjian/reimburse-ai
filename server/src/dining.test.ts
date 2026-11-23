import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, byFileName, sample } from './test/api';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';
import { loadParsePresets, presetParser, sha256 } from './test/parse-presets';
import type { ParseOutcome } from './parse/dispatch';

const secondInvoice = { name: '第二顿餐饮_发票.pdf', bytes: new TextEncoder().encode('%PDF-second-dining-invoice') };
const wrongSlip = sample('m15');
const otherInvoice = { name: '另一金额餐饮_发票.pdf', bytes: new TextEncoder().encode('%PDF-other-dining-invoice') };
const anotherWrongSlip = { name: '另一金额餐饮_小票.pdf', bytes: new TextEncoder().encode('%PDF-another-wrong-dining-slip') };
const duplicateWrongSlip = { name: '同金额餐饮_小票.pdf', bytes: new TextEncoder().encode('%PDF-duplicate-wrong-dining-slip') };
const incompleteSlip = { name: '缺少实付餐饮_小票.pdf', bytes: new TextEncoder().encode('%PDF-incomplete-dining-slip') };
const unknownSlip = { name: '手工餐饮_小票.pdf', bytes: new TextEncoder().encode('%PDF-unknown-itemised-dining-receipt') };

let server: ScenarioServer;
beforeEach(async () => {
  const invoice = loadParsePresets()['m11-other-invoice.pdf']?.outcome;
  const slip = loadParsePresets()['m13-dining-receipt.pdf']?.outcome;
  if (invoice?.outcome !== 'recognised') throw new Error('dining invoice preset is missing');
  if (slip?.outcome !== 'recognised') throw new Error('dining receipt preset is missing');
  server = await scenarioServer({ parser: presetParser({
    [sha256(sample('m09').bytes)]: slip,
    [sha256(unknownSlip.bytes)]: { outcome: 'unrecognised', reason: 'no_layout' },
    [sha256(secondInvoice.bytes)]: { ...invoice, candidates: invoice.candidates.map((candidate) => candidate.key === 'invoiceNumber' ? { ...candidate, value: '26312000000103317792' } : candidate) },
    [sha256(otherInvoice.bytes)]: { ...invoice, candidates: invoice.candidates.map((candidate) => candidate.key === 'invoiceNumber' ? { ...candidate, value: '26312000000103317793' } : candidate.key === 'totalAmount' ? { ...candidate, value: '300.00' } : candidate) },
    [sha256(anotherWrongSlip.bytes)]: { ...slip, candidates: slip.candidates.map((candidate) => candidate.key === 'paidAmount' || candidate.key === 'originalTotal' ? { ...candidate, value: '230.00' } : candidate) },
    [sha256(duplicateWrongSlip.bytes)]: { ...slip, candidates: slip.candidates.map((candidate) => candidate.key === 'paidAmount' || candidate.key === 'originalTotal' ? { ...candidate, value: '239.99' } : candidate) },
    [sha256(incompleteSlip.bytes)]: { ...slip, candidates: slip.candidates.filter((candidate) => candidate.key !== 'paidAmount') },
  }) });
});
afterEach(() => server.close());

describe('dining invoice evidence', () => {
  it('keeps invoice facts while recording absence and correcting the actual meal date', async () => {
    const scene = await scenario(server).at('pending', { materials: ['m11'] });
    const item = scene.reached.pendingItems[0]!;
    const original = scene.reached.lines[0]!;
    const kept = await scene.accept('answer-pending', { itemId: item.itemId, answer: { choice: 'confirm_none' } });
    expect(kept.stage).toBe('project');
    expect(kept.lines[0]).toMatchObject({ date: original.date, grossAmount: '240.00', referenceMaterialIds: [] });
    const corrected = await scene.accept('answer-pending', { itemId: item.itemId, answer: { choice: 'manual_fill', date: '2026-08-12' } });
    expect(corrected.lines[0]).toMatchObject({ date: '2026-08-12', grossAmount: original.grossAmount, netAmount: original.netAmount, taxAmount: original.taxAmount });
    expect(corrected.materials[0]!.fields).toEqual(kept.materials[0]!.fields);
    expect(corrected.pendingItems[0]!.answer).toEqual({ choice: 'manual_fill', date: '2026-08-12' });
    const assigned = await scene.accept('submit-project-assignment', { purpose: '客户招待', projects: { [corrected.lines[0]!.lineId]: 'P-2307' } });
    const confirmed = await scene.accept('confirm-review', { digest: assigned.confirmation.digest });
    expect(confirmed.stage).toBe('actions');
    expect(await scene.refused('answer-pending', { itemId: item.itemId, answer: { choice: 'manual_fill', date: '2026-08-13' } })).toMatchObject({ code: 'dining_evidence_locked' });
    await scene.accept('reopen-upload');
    const inventoried = await scene.run('start-inventory');
    expect(inventoried.lines[0]!.date).toBe('2026-08-12');
    const revised = await scene.accept('answer-pending', { itemId: item.itemId, answer: { choice: 'manual_fill', date: '2026-08-13' } });
    const reassigned = await scene.accept('submit-project-assignment', { purpose: '客户招待', projects: { [revised.lines[0]!.lineId]: 'P-2307' } });
    expect((await scene.accept('confirm-review', { digest: reassigned.confirmation.digest })).lines[0]!.date).toBe('2026-08-13');
  });

  it('saves manual receipt fields without a selection and never persists the control as a fact', async () => {
    const scene = await scenario(server).at('pending', { materials: ['m11', unknownSlip] });
    const receipt = byFileName(scene.reached, unknownSlip.name);
    const itemId = `unrecognised.${receipt.materialId}`;
    const paired = await scene.accept('answer-pending', { itemId, answer: { choice: 'manual_fill', kind: 'dining_receipt', paidAmount: '240.00', diningInvoiceId: '' } });
    expect(paired.stage).toBe('project');
    const rows = await server.db.selectFrom('pending_answer').selectAll().where('task_id', '=', scene.task.taskId).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.item_id).toBe(itemId);
    expect(rows[0]?.answer).not.toContain('diningInvoiceId');
  });

  it('refuses association changes after confirmation and preserves its facts', async () => {
    const scene = await scenario(server).at('actions', { materials: ['m11', 'm13'] });
    const receipt = byFileName(scene.reached, sample('m13').name);
    const invoice = byFileName(scene.reached, sample('m11').name);
    const before = await server.db.selectFrom('pending_answer').selectAll().where('task_id', '=', scene.task.taskId).execute();
    expect(await scene.refused('answer-pending', { itemId: `edit.${receipt.materialId}.diningInvoice`, answer: { value: invoice.materialId } })).toMatchObject({ code: 'dining_evidence_locked' });
    expect(await server.db.selectFrom('pending_answer').selectAll().where('task_id', '=', scene.task.taskId).execute()).toEqual(before);
    expect((await scene.snapshot()).confirmation).toEqual(scene.reached.confirmation);
  });

  it('stores manual receipt facts and invoice intent atomically and retains stale intent after corrections', async () => {
    const scene = await scenario(server).at('pending', { materials: ['m11', secondInvoice, unknownSlip] });
    const invoice = byFileName(scene.reached, secondInvoice.name);
    const receipt = byFileName(scene.reached, unknownSlip.name);
    const itemId = `unrecognised.${receipt.materialId}`;
    const fill = { choice: 'manual_fill', kind: 'dining_receipt', paidAmount: '240.00', diningInvoiceId: invoice.materialId };
    const answers = () => server.db.selectFrom('pending_answer').selectAll().where('task_id', '=', scene.task.taskId).execute();
    const before = await answers();
    expect(await scene.refused('answer-pending', { itemId, answer: { ...fill, paidAmount: '239.99' } })).toMatchObject({ code: 'check_failed' });
    expect(await answers()).toEqual(before);
    expect(await scene.refused('answer-pending', { itemId, answer: { ...fill, diningInvoiceId: 'foreign-invoice' } })).toMatchObject({ code: 'invalid_answer' });
    expect(await answers()).toEqual(before);
    const paired = await scene.accept('answer-pending', { itemId, answer: fill });
    expect(byFileName(paired, receipt.fileName)).toMatchObject({ kind: 'dining_receipt', linkedMaterialIds: [invoice.materialId] });
    expect(byFileName(paired, receipt.fileName).fields).toContainEqual(expect.objectContaining({ key: 'paidAmount', value: '240.00', source: 'user' }));
    expect(byFileName(paired, receipt.fileName).fields.some((field) => field.key === 'diningInvoiceId')).toBe(false);
    const rows = (await answers()).slice(before.length);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.revision)).size).toBe(1);
    expect(rows.find((row) => row.item_id === itemId)?.answer).not.toContain('diningInvoiceId');
    const corrected = await scene.accept('answer-pending', { itemId: `edit.${receipt.materialId}.paidAmount`, answer: { value: '239.99' } });
    expect(byFileName(corrected, receipt.fileName).linkedMaterialIds).toEqual([]);
    expect(corrected.pendingItems.find((item) => item.itemId === `dining_association.${receipt.materialId}`)).toMatchObject({ status: 'open', why: expect.stringContaining('239.99') });
    await scene.accept('answer-pending', { itemId: `edit.${receipt.materialId}.paidAmount`, answer: { value: '240.00' } });
    const excluded = await scene.accept('exclude-material', { materialId: invoice.materialId });
    expect(byFileName(excluded, receipt.fileName)).toMatchObject({ kind: 'dining_receipt', linkedMaterialIds: [] });
    expect(excluded.pendingItems.find((item) => item.itemId === `dining_association.${receipt.materialId}`)?.status).toBe('open');
    await scene.accept('reopen-upload');
    const rerun = await scene.run('start-inventory');
    expect(byFileName(rerun, receipt.fileName)).toMatchObject({ kind: 'dining_receipt', linkedMaterialIds: [] });
    const reset = await scene.accept('answer-pending', { itemId: `edit.${receipt.materialId}.diningInvoice`, answer: { value: 'auto' } });
    expect(byFileName(reset, receipt.fileName).linkedMaterialIds).toEqual([byFileName(reset, sample('m11').name).materialId]);
  });

  it.each([['m11', 'm13'], ['m13', 'm11']])('supplements %s with %s in one accepted batch and run', async (first, second) => {
    const scene = await scenario(server).at('pending', { materials: [first] });
    const snapshot = scene.reached;
    const form = new FormData();
    const file = sample(second);
    form.append('pendingItemId', snapshot.pendingItems[0]!.itemId);
    form.append('stepToken', snapshot.step.stepToken);
    form.append('files', new File([file.bytes], file.name, { type: file.type ?? 'application/pdf' }));
    form.append('files', new File(['bad'], 'notes.txt', { type: 'text/plain' }));
    const response = await scene.client.request(`/api/tasks/${scene.task.taskId}/dining-evidence`, { method: 'POST', body: form });
    expect(response.status).toBe(200);
    const paired = await scene.settled();
    expect(paired.batches.at(-1)?.files.map((file) => file.status)).toEqual(['accepted', 'rejected']);
    expect(paired.lines[0]?.referenceMaterialIds).toEqual([byFileName(paired, sample('m13').name).materialId]);
    expect(paired.events[0]?.referenceMaterialIds).toEqual(paired.lines[0]?.referenceMaterialIds);
    expect(await server.db.selectFrom('inventory_run').selectAll().where('task_id', '=', scene.task.taskId).execute()).toHaveLength(2);
    expect((await scene.client.request(`/api/tasks/${scene.task.taskId}/dining-evidence`, { method: 'POST', body: form })).status).toBe(409);
  });

  it('supplements a dining invoice after the employee recorded the receipt as absent', async () => {
    const scene = await scenario(server).at('pending', { materials: ['m11'] });
    const itemId = scene.reached.pendingItems[0]!.itemId;
    const resolved = await scene.accept('answer-pending', { itemId, answer: { choice: 'confirm_none' } });
    const receipt = sample('m13');
    const form = new FormData();
    form.append('pendingItemId', itemId);
    form.append('stepToken', resolved.step.stepToken);
    form.append('files', new File([receipt.bytes], receipt.name, { type: 'application/pdf' }));
    const response = await scene.client.request(`/api/tasks/${scene.task.taskId}/dining-evidence`, { method: 'POST', body: form });
    expect(response.status).toBe(200);
    const paired = await scene.settled();
    expect(paired.lines[0]?.referenceMaterialIds).toEqual([byFileName(paired, receipt.name).materialId]);
    expect(paired.pendingItems.filter((item) => item.status === 'open')).toEqual([]);
  });

  it('records all-rejected supplements without starting a run, and refuses stale items before writes', async () => {
    const scene = await scenario(server).at('pending', { materials: ['m11'] });
    const post = async (itemId: string) => {
      const current = await scene.snapshot();
      const form = new FormData();
      form.append('pendingItemId', itemId);
      form.append('stepToken', current.step.stepToken);
      const file = sample('m11');
      form.append('files', new File([file.bytes], 'duplicate.pdf', { type: 'application/pdf' }));
      form.append('files', new File(['bad'], 'bad.txt'));
      return scene.client.request(`/api/tasks/${scene.task.taskId}/dining-evidence`, { method: 'POST', body: form });
    };
    const version = scene.reached.inventory.versionId;
    expect((await post(scene.reached.pendingItems[0]!.itemId)).status).toBe(200);
    const rejected = await scene.snapshot();
    expect(rejected.stage).toBe('pending');
    expect(rejected.inventory.versionId).toBe(version);
    expect(rejected.batches.at(-1)?.files.map((file) => file.reasonCode)).toEqual(['duplicate_content', 'unsupported_type']);
    expect(await server.db.selectFrom('inventory_run').selectAll().where('task_id', '=', scene.task.taskId).execute()).toHaveLength(1);
    expect((await post('dining_receipt_missing.foreign')).status).toBe(400);
    expect((await scene.snapshot()).batches).toHaveLength(2);
  });
  it('accepts an explicit receipt choice and pairs the unique equal-amount remainder', async () => {
    const scene = await scenario(server).at('pending', { materials: ['m11', secondInvoice, 'm13', 'm14'] });
    const receipt = byFileName(scene.reached, sample('m13').name);
    const invoice = byFileName(scene.reached, secondInvoice.name);
    const paired = await scene.accept('answer-pending', { itemId: `edit.${receipt.materialId}.diningInvoice`, answer: { value: invoice.materialId } });
    expect(paired.stage).toBe('project');
    expect(paired.lines.find((line) => line.voucherMaterialId === invoice.materialId)?.referenceMaterialIds).toEqual([receipt.materialId]);
    expect(paired.events.find((event) => event.voucherMaterialId === invoice.materialId)?.referenceMaterialIds).toEqual([receipt.materialId]);
    expect(paired.pendingItems.find((item) => item.itemId === `dining_association.${receipt.materialId}`)?.status).toBe('resolved');
    const remaining = byFileName(paired, sample('m14').name);
    expect(await scene.refused('answer-pending', { itemId: `edit.${remaining.materialId}.diningInvoice`, answer: { value: invoice.materialId } })).toMatchObject({ code: 'choice_not_allowed' });
    expect((await scene.snapshot()).lines).toEqual(paired.lines);
  });

  it.each<ParseOutcome>([
    { outcome: 'unrecognised', reason: 'no_layout' },
    { outcome: 'recognised', kind: 'dining_receipt', kindLabel: '餐饮小票', layout: 'labelled', parserVersion: '1', candidates: [], findings: [], missing: ['paidAmount'] },
  ])('keeps receipt intent visible after reinventory changes recognition to $outcome', async (changed) => {
    await server.close();
    const parser = presetParser();
    let receiptOutcome: ParseOutcome | null = null;
    server = await scenarioServer({ parser: {
      parse: (input) => receiptOutcome && sha256(input.bytes) === sha256(sample('m13').bytes) ? Promise.resolve(receiptOutcome) : parser.parse(input),
      close: () => parser.close(),
    } });
    const scene = await scenario(server).at('project', { materials: ['m11', 'm13'] });
    const receipt = byFileName(scene.reached, sample('m13').name);
    const invoice = byFileName(scene.reached, sample('m11').name);
    const address = `edit.${receipt.materialId}.diningInvoice`;
    await scene.accept('answer-pending', { itemId: address, answer: { value: invoice.materialId } });
    receiptOutcome = changed;
    await scene.accept('reopen-upload');
    const unavailable = await scene.run('start-inventory');
    expect(unavailable.pendingItems.find((item) => item.itemId === `dining_association.${receipt.materialId}`)).toMatchObject({ status: 'open', dining: { assignment: { selection: { kind: 'selected_stale', invoiceId: invoice.materialId } } } });
    expect(byFileName(unavailable, receipt.fileName).linkedMaterialIds).toEqual([]);
    const reset = await scene.accept('answer-pending', { itemId: address, answer: { value: 'auto' } });
    expect(reset.pendingItems.some((item) => item.itemId === `dining_association.${receipt.materialId}`)).toBe(false);
  });

  it('reserves a mismatched explicit target and frees it when its receipt is excluded', async () => {
    const scene = await scenario(server).at('pending', { materials: ['m11', secondInvoice, unknownSlip, 'm13'] });
    const invoice = byFileName(scene.reached, secondInvoice.name);
    const receipt = byFileName(scene.reached, unknownSlip.name);
    await scene.accept('answer-pending', { itemId: `unrecognised.${receipt.materialId}`, answer: { choice: 'manual_fill', kind: 'dining_receipt', paidAmount: '240.00', diningInvoiceId: invoice.materialId } });
    const stale = await scene.accept('answer-pending', { itemId: `edit.${receipt.materialId}.paidAmount`, answer: { value: '239.99' } });
    const other = byFileName(stale, sample('m13').name);
    expect(await scene.refused('answer-pending', { itemId: `edit.${other.materialId}.diningInvoice`, answer: { value: invoice.materialId } })).toMatchObject({ code: 'choice_not_allowed' });
    await scene.accept('exclude-material', { materialId: byFileName(stale, sample('m11').name).materialId });
    const blocked = await scene.snapshot();
    expect(byFileName(blocked, other.fileName).linkedMaterialIds).toEqual([]);
    const released = await scene.accept('exclude-material', { materialId: receipt.materialId });
    expect(byFileName(released, other.fileName).linkedMaterialIds).toEqual([invoice.materialId]);
  });

  it('accepts an image supplement and rejects over-limit and foreign requests without adding runs', async () => {
    const scene = await scenario(server).at('pending', { materials: ['m11'] });
    const form = new FormData();
    form.append('pendingItemId', scene.reached.pendingItems[0]!.itemId);
    form.append('stepToken', scene.reached.step.stepToken);
    const image = sample('m09');
    form.append('files', new File([image.bytes], 'receipt.jpg', { type: 'image/jpeg' }));
    form.append('files', new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'oversize.pdf', { type: 'application/pdf' }));
    const foreign = await server.signIn('bob');
    expect((await foreign.request(`/api/tasks/${scene.task.taskId}/dining-evidence`, { method: 'POST', body: form })).status).toBe(404);
    expect((await scene.snapshot()).batches).toHaveLength(1);
    expect((await scene.client.request(`/api/tasks/${scene.task.taskId}/dining-evidence`, { method: 'POST', body: form })).status).toBe(200);
    const paired = await scene.settled();
    expect(paired.batches.at(-1)?.files).toMatchObject([{ status: 'accepted' }, { status: 'rejected', reasonCode: 'too_large' }]);
    expect(paired.lines[0]?.referenceMaterialIds).toEqual([byFileName(paired, 'receipt.jpg').materialId]);
  });
  it('shows differing invoice and paid amounts and accepts only evidence or exclusion', async () => {
    const scene = await scenario(server).at('pending', { materials: ['m11', wrongSlip] });
    const invoice = byFileName(scene.reached, sample('m11').name);
    const itemId = `dining_amount_mismatch.${invoice.materialId}`;
    expect(scene.reached.pendingItems.find((item) => item.itemId === itemId)).toMatchObject({
      materialId: invoice.materialId, title: '餐饮发票「餐饮_发票.pdf」与餐饮小票金额不一致',
      why: expect.stringContaining('价税合计 240.00 元'), choices: [{ key: 'exclude', label: '排除这份材料' }],
    });
    expect(scene.reached.pendingItems.find((item) => item.itemId === itemId)?.why).toContain('实付金额 239.99 元');
    for (const choice of ['confirm_none', 'supply']) {
      expect(await scene.refused('answer-pending', { itemId, answer: { choice } })).toMatchObject({ code: 'invalid_answer' });
    }
    await scene.accept('reopen-upload');
    await api(() => scene.client).upload(scene.task.taskId, [sample('m13')]);
    const paired = await scene.run('start-inventory');
    expect(byFileName(paired, invoice.fileName)).toMatchObject({ status: 'ok', pendingItemIds: [] });
    expect(paired.lines[0]?.referenceMaterialIds).toEqual([byFileName(paired, sample('m13').name).materialId]);
    const oldSlip = byFileName(paired, wrongSlip.name);
    expect(paired.stage).toBe('pending');
    expect(paired.pendingItems.filter((item) => item.status === 'open').map((item) => item.itemId)).toEqual([`dining_invoice_missing.${oldSlip.materialId}`]);
    const resolved = await scene.accept('answer-pending', { itemId: `dining_invoice_missing.${oldSlip.materialId}`, answer: { choice: 'exclude' } });
    expect(resolved.stage).toBe('project');
  });
  it('blocks a slip alone and rejects declarations without invoice evidence', async () => {
    const scene = await scenario(server).at('pending', { materials: ['m13'] });
    const slip = byFileName(scene.reached, sample('m13').name);
    const itemId = `dining_invoice_missing.${slip.materialId}`;
    expect(slip).toMatchObject({ role: 'reference', status: 'pending', pendingItemIds: [itemId] });
    expect(scene.reached.lines).toEqual([]);
    expect(scene.reached.pendingItems).toEqual([expect.objectContaining({ itemId, materialId: slip.materialId, title: '餐饮小票「餐饮_小票.pdf」缺少发票', choices: [{ key: 'exclude', label: '排除这份材料' }] })]);
    for (const choice of ['confirm_none', 'supply']) {
      expect(await scene.refused('answer-pending', { itemId, answer: { choice } })).toMatchObject({ code: 'invalid_answer' });
    }
    const excluded = await scene.accept('answer-pending', { itemId, answer: { choice: 'exclude' } });
    expect(excluded.stage).toBe('inventory');
    expect(excluded.pendingItems.filter((item) => item.status === 'open')).toEqual([]);
    expect(byFileName(excluded, slip.fileName).status).toBe('excluded');
  });

  it('excludes a mismatched invoice while retaining its orphan slip blocker', async () => {
    const scene = await scenario(server).at('pending', { materials: ['m11', wrongSlip] });
    const invoice = byFileName(scene.reached, sample('m11').name);
    const excluded = await scene.accept('answer-pending', { itemId: `dining_amount_mismatch.${invoice.materialId}`, answer: { choice: 'exclude' } });
    expect(byFileName(excluded, invoice.fileName).status).toBe('excluded');
    expect(excluded.lines).toEqual([]);
    const slip = byFileName(excluded, wrongSlip.name);
    expect(excluded.pendingItems.filter((item) => item.status === 'open').map((item) => item.itemId)).toEqual([`dining_invoice_missing.${slip.materialId}`]);
    expect(excluded.stage).toBe('pending');
  });

  it('does not count a receipt already paired with another invoice as a mismatch candidate', async () => {
    const scene = await scenario(server).at('pending', { materials: ['m11', 'm13', otherInvoice] });
    const invoice = byFileName(scene.reached, otherInvoice.name);
    expect(scene.reached.pendingItems.filter((item) => item.status === 'open').map((item) => item.itemId)).toEqual([`dining_receipt_missing.${invoice.materialId}`]);
    expect(scene.reached.lines.find((line) => line.voucherMaterialId === invoice.materialId)?.grossAmount).toBe('300.00');
  });

  it('names each unique differing paid amount once and keeps equal-amount ambiguity as missing', async () => {
    const scene = await scenario(server).at('pending', { materials: ['m11', wrongSlip, anotherWrongSlip, duplicateWrongSlip] });
    const invoice = byFileName(scene.reached, sample('m11').name);
    const why = scene.reached.pendingItems.find((item) => item.itemId === `dining_amount_mismatch.${invoice.materialId}`)?.why;
    expect(why).toContain('实付金额 239.99、230.00 元');
    expect(why?.match(/239\.99/g)).toHaveLength(1);
    await scene.accept('reopen-upload');
    await api(() => scene.client).upload(scene.task.taskId, [sample('m13'), sample('m14')]);
    const ambiguous = await scene.run('start-inventory');
    expect(byFileName(ambiguous, invoice.fileName).pendingItemIds).toEqual([`dining_receipt_missing.${invoice.materialId}`]);
    expect(ambiguous.pendingItems.some((item) => item.itemId.startsWith('dining_amount_mismatch.'))).toBe(false);
  });

  it('ignores an incomplete receipt and an excluded wrong receipt when choosing the invoice item', async () => {
    const scene = await scenario(server).at('pending', { materials: ['m11', incompleteSlip, wrongSlip] });
    const invoice = byFileName(scene.reached, sample('m11').name);
    const wrong = byFileName(scene.reached, wrongSlip.name);
    const excluded = await scene.accept('answer-pending', { itemId: `dining_invoice_missing.${wrong.materialId}`, answer: { choice: 'exclude' } });
    expect(byFileName(excluded, invoice.fileName).pendingItemIds).toEqual([`dining_receipt_missing.${invoice.materialId}`]);
    expect(byFileName(excluded, incompleteSlip.name).status).toBe('pending');
    expect(excluded.pendingItems.some((item) => item.itemId.startsWith('dining_amount_mismatch.'))).toBe(false);
  });

  it.each(['m13', 'm14'])('pairs the invoice with %s using paid amount, independently of merchant and date', async (receipt) => {
    const scene = await scenario(server).at('project', { materials: ['m11', receipt] });
    const snapshot = scene.reached;
    const invoice = byFileName(snapshot, sample('m11').name);
    const slip = byFileName(snapshot, sample(receipt).name);
    expect(slip).toMatchObject({ kind: 'dining_receipt', role: 'reference', status: 'ok', linkedMaterialIds: [invoice.materialId] });
    expect(invoice).toMatchObject({ status: 'ok', linkedMaterialIds: [slip.materialId] });
    expect(snapshot.lines).toEqual([expect.objectContaining({ category: { code: 'hospitality', label: '招待费' }, expenseItemCode: 'FY009001', grossAmount: '240.00', date: '2026-08-14', referenceMaterialIds: [slip.materialId] })]);
    expect(snapshot.events).toEqual([expect.objectContaining({ referenceMaterialIds: [slip.materialId] })]);
    expect(snapshot.pendingItems.filter((item) => item.status === 'open')).toEqual([]);
  });

  it('leaves two meals of the same amount unpaired instead of assigning either receipt twice', async () => {
    const scene = await scenario(server).at('pending', { materials: ['m11', secondInvoice, 'm13', 'm14'] });
    const snapshot = scene.reached;
    expect(snapshot.lines).toHaveLength(2);
    expect(snapshot.lines.every((line) => line.referenceMaterialIds.length === 0)).toBe(true);
    expect(snapshot.materials.every((material) => material.linkedMaterialIds.length === 0)).toBe(true);
    expect(snapshot.pendingItems.filter((item) => item.status === 'open').map((item) => item.itemId)).toEqual([
      ...snapshot.lines.map((line) => `dining_receipt_missing.${line.voucherMaterialId}`),
      ...snapshot.materials.filter((material) => material.kind === 'dining_receipt').map((material) => `dining_invoice_missing.${material.materialId}`),
    ]);
  });

  it('clears an orphan slip when a matching invoice is uploaded and inventoried', async () => {
    const scene = await scenario(server).at('pending', { materials: ['m13'] });
    await scene.accept('reopen-upload');
    const uploaded = await api(() => scene.client).upload(scene.task.taskId, [sample('m11')]);
    expect(uploaded.batches).toHaveLength(2);
    const paired = await scene.run('start-inventory');
    const invoice = byFileName(paired, sample('m11').name);
    const slip = byFileName(paired, sample('m13').name);
    expect(paired.stage).toBe('project');
    expect(paired.pendingItems.filter((item) => item.status === 'open')).toEqual([]);
    expect(slip).toMatchObject({ status: 'ok', linkedMaterialIds: [invoice.materialId] });
    expect(paired.lines[0]?.referenceMaterialIds).toEqual([slip.materialId]);
  });

  it('keeps a slip blocked when the available invoice belongs to another category', async () => {
    const scene = await scenario(server).at('pending', { materials: ['m13', 'm07'] });
    const slip = byFileName(scene.reached, sample('m13').name);
    expect(slip).toMatchObject({ status: 'pending', linkedMaterialIds: [] });
    expect(scene.reached.pendingItems.filter((item) => item.status === 'open').map((item) => item.itemId)).toEqual([`dining_invoice_missing.${slip.materialId}`]);
  });

  it('supplies a missing slip by reopening upload, adding a new batch and inventorying again', async () => {
    const scene = await scenario(server).at('pending', { materials: ['m11'] });
    const itemId = scene.reached.pendingItems[0]?.itemId;
    expect(await scene.refused('answer-pending', { itemId, answer: { choice: 'supply' } })).toMatchObject({ code: 'invalid_answer' });
    await scene.accept('reopen-upload');
    const uploaded = await api(() => scene.client).upload(scene.task.taskId, [sample('m13')]);
    expect(uploaded.batches).toHaveLength(2);
    const paired = await scene.run('start-inventory');
    expect(paired.stage).toBe('project');
    expect(paired.pendingItems.filter((item) => item.status === 'open')).toEqual([]);
    expect(paired.lines[0]?.referenceMaterialIds).toEqual([byFileName(paired, sample('m13').name).materialId]);
  });

  it('shows a hospitality line last and offers the missing receipt workflow', async () => {
    const scene = await scenario(server).at('pending', { materials: ['m11', 'm07', 'm01', 'm02'], stayTrio: 'answered' });
    const snapshot = scene.reached;
    const invoice = byFileName(snapshot, sample('m11').name);
    expect(invoice).toMatchObject({ kind: 'vat_invoice', categoryLabel: '招待费', status: 'pending' });
    expect(snapshot.lines.map((line) => line.category.code)).toEqual(['long_distance', 'accommodation', 'hospitality']);
    expect(snapshot.lines.at(-1)).toMatchObject({ voucherMaterialId: invoice.materialId, expenseItemCode: 'FY009001', expenseItemName: '招待', grossAmount: '240.00' });
    const itemId = `dining_receipt_missing.${invoice.materialId}`;
    expect(snapshot.pendingItems.filter((item) => item.status === 'open')).toEqual([
      expect.objectContaining({ itemId, materialId: invoice.materialId, title: '餐饮发票「餐饮_发票.pdf」缺少餐饮小票', choices: [{ key: 'manual_fill', label: '手工填写' }, { key: 'confirm_none', label: '确认没有账单' }, { key: 'exclude', label: '忽略发票' }] }),
    ]);
    expect(await scene.refused('answer-pending', { itemId, answer: { choice: 'manual_fill', date: '2026-02-30' } })).toMatchObject({ code: 'invalid_answer' });
    const unchanged = await scene.snapshot();
    expect(unchanged.stage).toBe('pending');
    expect(unchanged.pendingItems.find((item) => item.itemId === itemId)?.status).toBe('open');
    const done = await scene.accept('answer-pending', { itemId, answer: { choice: 'exclude' } });
    expect(done.stage).toBe('project');
    expect(done.pendingItems.filter((item) => item.status === 'open')).toEqual([]);
    expect(byFileName(done, invoice.fileName).status).toBe('excluded');
    expect(done.lines.map((line) => line.category.code)).toEqual(['long_distance', 'accommodation']);
  });
});
