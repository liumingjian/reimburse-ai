import { ActionFailureSchema, OCCUPANCY_COPY, type PendingItem, type TaskSnapshot } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inlineExecutor } from './parse/executor';
import { einvoice } from './parse/layouts/einvoice';
import { LAYOUTS } from './parse/layouts';
import { api, byFileName, sample, type Upload } from './test/api';
import { createTestServer, type TestClient, type TestServer } from './test/harness';

// Slice 08 (#187): 待确认项 (pending items) answered through `answer-pending`, edit classes, 重复发票 (duplicate
// invoices) inside a task, and cross-task 发票占用 (invoice occupancy), all through `app.request()`.

let server: TestServer;
let signedIn: TestClient;
beforeEach(async () => {
  server = await createTestServer();
  signedIn = await server.signIn();
});
afterEach(() => server.close());
const client = api(() => signedIn);

async function inventoriedFiles(files: readonly Upload[], who = client) {
  const { task } = await who.createTask();
  const uploaded = await who.upload(task.taskId, files);
  await who.accepted(await who.act(uploaded, 'start-inventory'));
  // The 住宿 trio (#213) is tested in stay-trio.test.ts; here its items are answered with 确认没有.
  return who.withoutStayGaps(await who.settled(task.taskId));
}
const inventoried = (prefixes: readonly string[]) => inventoriedFiles(prefixes.map(sample));

const item = (snapshot: TaskSnapshot, itemId: string): PendingItem => {
  const found = snapshot.pendingItems.find((candidate) => candidate.itemId === itemId);
  if (!found) throw new Error(`no pending item ${itemId} in ${snapshot.pendingItems.map((i) => i.itemId).join(', ')}`);
  return found;
};
const answer = (snapshot: TaskSnapshot, itemId: string, value: unknown) => client.act(snapshot, 'answer-pending', { itemId, answer: value });
const answered = async (snapshot: TaskSnapshot, itemId: string, value: unknown) => client.accepted(await answer(snapshot, itemId, value));
async function refused(response: Response, code: string) {
  expect(response.status).toBe(400);
  const failure = ActionFailureSchema.parse(await response.json());
  expect(failure.error.code).toBe(code);
  return failure;
}

// The 餐饮 (catering) e-invoice m11 as printed; no v1 layout recognises it.
const M11 = {
  invoiceNumber: '26312000000103317790',
  issueDate: '2026-08-14',
  invoiceType: '普票',
  sellerName: '上海某某餐饮有限公司',
  itemName: '*餐饮服务*餐费',
  netAmount: '226.42',
  taxAmount: '13.58',
  totalAmount: '240.00',
};

describe('an unrecognised material', () => {
  it('manual fill: pick a 材料种类 (material kind), fill its form, and the values become `user` candidates', async () => {
    const start = await inventoried(['m11']);
    const m11 = byFileName(start, sample('m11').name);
    const id = m11.materialId;
    expect(item(start, `unrecognised.${id}`).choices.map((c) => c.key)).toEqual(['exclude', 'reference', 'manual_fill']);

    const picking = await answered(start, `unrecognised.${id}`, { choice: 'manual_fill' });
    expect(item(picking, `unrecognised.${id}`)).toMatchObject({ status: 'resolved', answer: { choice: 'manual_fill' } });
    const kindItem = item(picking, `manual_kind.${id}`);
    expect(kindItem).toMatchObject({ kind: 'choice', status: 'open' });
    expect(kindItem.choices).toContainEqual({ key: 'kind:vat_invoice', label: '全电发票' });

    const filling = await answered(picking, `manual_kind.${id}`, { choice: 'kind:vat_invoice' });
    const form = item(filling, `manual_fill.${id}`);
    expect(form).toMatchObject({ kind: 'form', status: 'open' });
    expect(form.fields.find((f) => f.key === 'totalAmount')).toMatchObject({ format: 'money', required: true });
    expect(form.fields.find((f) => f.key === 'issueDate')).toMatchObject({ format: 'date' });

    const done = await answered(filling, `manual_fill.${id}`, M11);
    const material = byFileName(done, sample('m11').name);
    expect(material).toMatchObject({ kind: 'vat_invoice', layout: null, status: 'ok', role: 'primary_voucher' });
    expect(Object.fromEntries(material.fields.map((f) => [f.key, f.value]))).toMatchObject(M11);
    for (const field of material.fields) expect(field).toMatchObject({ source: 'user', parserVersion: null, editClass: 'fact_correctable' });
    expect(done.pendingItems.every((i) => i.status === 'resolved')).toBe(true);
    expect(done.inventory.summary?.openPendingItemCount).toBe(0);
    expect(done.stage).toBe('inventory');
  });

  it('manual fill refuses values that fail the kind check, and back-calculates nothing', async () => {
    const start = await inventoried(['m11']);
    const id = byFileName(start, sample('m11').name).materialId;
    const picking = await answered(start, `unrecognised.${id}`, { choice: 'manual_fill' });
    const filling = await answered(picking, `manual_kind.${id}`, { choice: 'kind:vat_invoice' });
    const failure = await refused(await answer(filling, `manual_fill.${id}`, { ...M11, totalAmount: '241.00' }), 'check_failed');
    expect(failure.error.message).toContain('不会倒算');
    expect(item(failure.snapshot ?? filling, `manual_fill.${id}`).status).toBe('open');
    await refused(await answer(filling, `manual_fill.${id}`, { ...M11, totalAmount: '240' }), 'invalid_answer');
  });

  it('mark as reference: resolved, the material becomes a 参考材料 and forms no line', async () => {
    const start = await inventoried(['m01', 'm11']);
    const id = byFileName(start, sample('m11').name).materialId;
    const done = await answered(start, `unrecognised.${id}`, { choice: 'reference' });
    expect(byFileName(done, sample('m11').name)).toMatchObject({ role: 'reference', status: 'ok' });
    expect(done.inventory.summary).toMatchObject({ referenceCount: 1, openPendingItemCount: 0 });
    expect(done.lines.map((line) => line.voucherMaterialId)).toEqual([byFileName(done, sample('m01').name).materialId]);
  });

  it('exclude: the answer excludes the material', async () => {
    const start = await inventoried(['m11']);
    const id = byFileName(start, sample('m11').name).materialId;
    const done = await answered(start, `unrecognised.${id}`, { choice: 'exclude' });
    expect(byFileName(done, sample('m11').name)).toMatchObject({ role: 'excluded', status: 'excluded' });
    expect(done.pendingItems).toEqual([]);
  });

  it('refuses a choice the item does not offer, and a second answer to a resolved item', async () => {
    const start = await inventoried(['m11']);
    const id = byFileName(start, sample('m11').name).materialId;
    await refused(await answer(start, `unrecognised.${id}`, { choice: 'guess' }), 'invalid_answer');
    const done = await answered(start, `unrecognised.${id}`, { choice: 'reference' });
    await refused(await answer(done, `unrecognised.${id}`, { choice: 'manual_fill' }), 'item_not_open');
    await refused(await answer(done, `nothing.${id}`, { choice: 'exclude' }), 'item_not_found');
  });
});

describe('a recognised material with gaps', () => {
  it('missing_required uses the same form for just the gaps; the values join as `user` candidates', async () => {
    await server.close();
    // The e-invoice layout, minus the seller's name.
    const gappy = { ...einvoice, parse: (doc: Parameters<typeof einvoice.parse>[0]) => ({ ...einvoice.parse(doc), candidates: einvoice.parse(doc).candidates.filter((c) => c.key !== 'sellerName') }) };
    server = await createTestServer({ parser: inlineExecutor([gappy]) });
    signedIn = await server.signIn();
    const start = await inventoried(['m01']);
    const id = byFileName(start, sample('m01').name).materialId;
    const gap = item(start, `missing_required.${id}`);
    expect(gap).toMatchObject({ kind: 'form', status: 'open' });
    expect(gap.fields.map((f) => f.key)).toEqual(['sellerName']);
    expect(start.lines).toEqual([]);
    // The 校验 column used to be empty here, which the inventory renders as 无; it now names the slot that is missing.
    expect(byFileName(start, sample('m01').name).checkText.split('；')).toContain('缺少必填字段：销售方名称');

    // Clean now, so the 住宿 trio (#213) asks for its folio and screenshot: answered with 确认没有.
    const done = await client.withoutStayGaps(await answered(start, gap.itemId, { sellerName: '上海某某酒店管理有限公司' }));
    const hotel = byFileName(done, sample('m01').name);
    expect(hotel).toMatchObject({ status: 'ok', role: 'primary_voucher' });
    expect(hotel.fields.find((f) => f.key === 'sellerName')).toMatchObject({ source: 'user', editClass: 'fact_correctable' });
    expect(hotel.fields.find((f) => f.key === 'totalAmount')).toMatchObject({ source: 'rule:vat_invoice/einvoice', editClass: 'fact_locked' });
    expect(hotel.checkText).not.toContain('缺少必填字段');
    expect(done.lines).toHaveLength(1);
  });
});

describe('ambiguous layouts', () => {
  it('choosing one of the matching layouts resolves the material with that layout', async () => {
    await server.close();
    server = await createTestServer({ parser: inlineExecutor([...LAYOUTS, { ...einvoice, name: 'einvoice_copy', label: '全电发票（另一版式）' }]) });
    signedIn = await server.signIn();
    const start = await inventoried(['m01']);
    const id = byFileName(start, sample('m01').name).materialId;
    const done = await client.withoutStayGaps(await answered(start, `ambiguous_layout.${id}`, { choice: 'layout:vat_invoice/einvoice_copy' }));
    expect(byFileName(done, sample('m01').name)).toMatchObject({ kind: 'vat_invoice', layout: 'einvoice_copy', status: 'ok' });
    expect(done.lines).toHaveLength(1);
  });
});

describe('edit classes', () => {
  it('fact_locked: a PDF text-layer fact refuses edits', async () => {
    const start = await inventoried(['m01']);
    const hotel = byFileName(start, sample('m01').name);
    expect(hotel.fields.every((f) => f.editClass === 'fact_locked')).toBe(true);
    const failure = await refused(await answer(start, `edit.${hotel.materialId}.totalAmount`, { value: '3000.00' }), 'fact_locked');
    expect(failure.error.message).toContain('票面事实');
    expect(failure.snapshot?.lines[0]?.grossAmount).toBe('3640.00');
  });

  it('fact_correctable: a manual value is corrected, re-checked, and nothing is back-calculated', async () => {
    const start = await inventoried(['m11']);
    const id = byFileName(start, sample('m11').name).materialId;
    const picking = await answered(start, `unrecognised.${id}`, { choice: 'manual_fill' });
    const filling = await answered(picking, `manual_kind.${id}`, { choice: 'kind:vat_invoice' });
    const filled = await answered(filling, `manual_fill.${id}`, M11);

    // Net 226.00 + tax 13.58 no longer makes 240.00; the total is not recomputed to fit.
    const failure = await refused(await answer(filled, `edit.${id}.netAmount`, { value: '226.00' }), 'check_failed');
    expect(failure.error.message).toContain('不会倒算');
    await refused(await answer(filled, `edit.${id}.issueDate`, { value: '2026-02-30' }), 'invalid_answer');

    const corrected = await answered(filled, `edit.${id}.sellerName`, { value: '上海某某餐饮管理有限公司' });
    expect(byFileName(corrected, sample('m11').name).fields.find((f) => f.key === 'sellerName')).toMatchObject({ value: '上海某某餐饮管理有限公司', source: 'user', editClass: 'fact_correctable' });
  });

  it('presentation: the line shows the 呈现值 while the resolved facts stay', async () => {
    const start = await inventoried(['m01']);
    const id = byFileName(start, sample('m01').name).materialId;
    const done = await answered(start, `edit.${id}.description`, { value: '上海出差住宿' });
    expect(done.lines[0]).toMatchObject({ description: '上海出差住宿', grossAmount: '3640.00' });
    expect(byFileName(done, sample('m01').name).fields.find((f) => f.key === 'itemName')?.value).toBe('*住宿服务*住宿费');
  });

  it('choice: only a value the rules allow', async () => {
    const start = await inventoried(['m01']);
    const id = byFileName(start, sample('m01').name).materialId;
    const failure = await refused(await answer(start, `edit.${id}.erpInvoiceType`, { value: '增值税普通发票' }), 'choice_not_allowed');
    expect(failure.error.message).toContain('增值税专用发票');
    const done = await answered(start, `edit.${id}.erpInvoiceType`, { value: '增值税专用发票' });
    expect(done.lines[0]?.invoiceType).toBe('增值税专用发票');
  });

  it('an unknown field is refused', async () => {
    const start = await inventoried(['m01']);
    const id = byFileName(start, sample('m01').name).materialId;
    await refused(await answer(start, `edit.${id}.nothing`, { value: 'x' }), 'field_not_found');
  });
});

describe('re-derivation', () => {
  it('a re-derived pending item keeps its earlier answer', async () => {
    const start = await inventoried(['m01', 'm11']);
    const id = byFileName(start, sample('m11').name).materialId;
    const answeredOnce = await answered(start, `unrecognised.${id}`, { choice: 'reference' });

    // Reopen upload, add a batch, and inventory again: every item is derived anew by the next run.
    const reopened = await client.accepted(await client.act(answeredOnce, 'reopen-upload'));
    // A rail ticket: clean on its own (a ride-hailing invoice alone would wait on category_city_missing, #188).
    const uploaded = await client.upload(reopened.task.taskId, [sample('m07')]);
    await client.accepted(await client.act(uploaded, 'start-inventory'));
    const again = await client.settled(reopened.task.taskId);

    expect(item(again, `unrecognised.${id}`)).toMatchObject({ status: 'resolved', answer: { choice: 'reference' } });
    expect(byFileName(again, sample('m11').name)).toMatchObject({ role: 'reference', status: 'ok' });
    expect(again.inventory.summary?.openPendingItemCount).toBe(0);
  });
});

// A second, distinct file of the same invoice: the same PDF with a trailing comment (a different content hash).
const copyOf = (upload: Upload, name: string): Upload => ({ ...upload, name, bytes: Buffer.concat([Buffer.from(upload.bytes), Buffer.from('\n% copy\n')]) });

describe('重复发票 (duplicate invoices) inside the task', () => {
  it('the later upload gets a blocking item resolved only by exclusion', async () => {
    const hotel = sample('m01');
    const start = await inventoriedFiles([hotel, copyOf(hotel, '全季酒店_发票_副本.pdf')]);
    const copy = byFileName(start, '全季酒店_发票_副本.pdf');
    const duplicate = item(start, `duplicate_invoice.${copy.materialId}`);
    expect(duplicate).toMatchObject({ kind: 'choice', status: 'open' });
    expect(duplicate.choices.map((c) => c.key)).toEqual(['exclude']);
    expect(copy.status).toBe('pending');
    expect(start.lines).toHaveLength(1);
    expect(start.stage).toBe('pending');

    const done = await answered(start, duplicate.itemId, { choice: 'exclude' });
    expect(byFileName(done, '全季酒店_发票_副本.pdf').status).toBe('excluded');
    expect(done.pendingItems.filter((candidate) => candidate.status === 'open')).toEqual([]);
    expect(done.lines).toHaveLength(1);
  });
});

describe('cross-task 发票占用 (invoice occupancy)', () => {
  it("an invoice held by another account's non-terminal task blocks this task until excluded, naming nobody", async () => {
    const alice = await inventoried(['m01']);
    const bob = await server.signIn('bob');
    const bobs = api(() => bob);
    // m07 (rail) forms a line on its own; a ride-hailing invoice alone would wait on category_city_missing (#188).
    const blocked = await inventoriedFiles([sample('m01'), sample('m07')], bobs);
    const held = byFileName(blocked, sample('m01').name);
    expect(blocked.blockers).toEqual([{ kind: 'duplicate_across_tasks', materialId: held.materialId, fileName: held.fileName, reason: OCCUPANCY_COPY.otherAccount, resolver: '要你处理', tasks: [] }]);
    expect(JSON.stringify(blocked)).not.toContain(alice.task.taskId);
    expect(blocked).toMatchObject({ stage: 'inventory', step: { kind: 'none' }, pendingItems: [], events: [], lines: [] });
    // The holder is not blocked: its claim came first.
    expect((await client.current(alice.task.taskId)).blockers).toEqual([]);

    const answering = await bobs.act(blocked, 'answer-pending', { itemId: `edit.${held.materialId}.description`, answer: { value: 'x' } });
    await refused(answering, 'not_ready');
    const cleared = await bobs.accepted(await bobs.act(blocked, 'exclude-material', { materialId: held.materialId }));
    expect(cleared.blockers).toEqual([]);
    expect(cleared.lines).toHaveLength(1);
  });

  it('a voided task holds nothing', async () => {
    const alice = await inventoried(['m01']);
    expect((await signedIn.request(`/api/tasks/${alice.task.taskId}/abandon`, { method: 'POST' })).status).toBe(200);
    const bob = await server.signIn('bob');
    const free = await inventoriedFiles([sample('m01')], api(() => bob));
    expect(free.blockers).toEqual([]);
    expect(free.lines).toHaveLength(1);
  });
});
