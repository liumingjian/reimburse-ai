import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, byFileName, sample } from './test/api';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';
import { loadParsePresets, presetParser, sha256 } from './test/parse-presets';

const secondInvoice = { name: '第二顿餐饮_发票.pdf', bytes: new TextEncoder().encode('%PDF-second-dining-invoice') };
const wrongSlip = sample('m15');
const otherInvoice = { name: '另一金额餐饮_发票.pdf', bytes: new TextEncoder().encode('%PDF-other-dining-invoice') };
const anotherWrongSlip = { name: '另一金额餐饮_小票.pdf', bytes: new TextEncoder().encode('%PDF-another-wrong-dining-slip') };
const duplicateWrongSlip = { name: '同金额餐饮_小票.pdf', bytes: new TextEncoder().encode('%PDF-duplicate-wrong-dining-slip') };
const incompleteSlip = { name: '缺少实付餐饮_小票.pdf', bytes: new TextEncoder().encode('%PDF-incomplete-dining-slip') };

let server: ScenarioServer;
beforeEach(async () => {
  const invoice = loadParsePresets()['m11-other-invoice.pdf']?.outcome;
  const slip = loadParsePresets()['m13-dining-receipt.pdf']?.outcome;
  if (invoice?.outcome !== 'recognised') throw new Error('dining invoice preset is missing');
  if (slip?.outcome !== 'recognised') throw new Error('dining receipt preset is missing');
  server = await scenarioServer({ parser: presetParser({
    [sha256(secondInvoice.bytes)]: { ...invoice, candidates: invoice.candidates.map((candidate) => candidate.key === 'invoiceNumber' ? { ...candidate, value: '26312000000103317792' } : candidate) },
    [sha256(otherInvoice.bytes)]: { ...invoice, candidates: invoice.candidates.map((candidate) => candidate.key === 'invoiceNumber' ? { ...candidate, value: '26312000000103317793' } : candidate.key === 'totalAmount' ? { ...candidate, value: '300.00' } : candidate) },
    [sha256(anotherWrongSlip.bytes)]: { ...slip, candidates: slip.candidates.map((candidate) => candidate.key === 'paidAmount' || candidate.key === 'originalTotal' ? { ...candidate, value: '230.00' } : candidate) },
    [sha256(duplicateWrongSlip.bytes)]: { ...slip, candidates: slip.candidates.map((candidate) => candidate.key === 'paidAmount' || candidate.key === 'originalTotal' ? { ...candidate, value: '239.99' } : candidate) },
    [sha256(incompleteSlip.bytes)]: { ...slip, candidates: slip.candidates.filter((candidate) => candidate.key !== 'paidAmount') },
  }) });
});
afterEach(() => server.close());

describe('dining invoice evidence', () => {
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

  it('shows a hospitality line last and requires a receipt with exclude as its only answer', async () => {
    const scene = await scenario(server).at('pending', { materials: ['m11', 'm07', 'm01', 'm02'], stayTrio: 'answered' });
    const snapshot = scene.reached;
    const invoice = byFileName(snapshot, sample('m11').name);
    expect(invoice).toMatchObject({ kind: 'vat_invoice', categoryLabel: '招待费', status: 'pending' });
    expect(snapshot.lines.map((line) => line.category.code)).toEqual(['long_distance', 'accommodation', 'hospitality']);
    expect(snapshot.lines.at(-1)).toMatchObject({ voucherMaterialId: invoice.materialId, expenseItemCode: 'FY009001', expenseItemName: '招待费', grossAmount: '240.00' });
    const itemId = `dining_receipt_missing.${invoice.materialId}`;
    expect(snapshot.pendingItems.filter((item) => item.status === 'open')).toEqual([
      expect.objectContaining({ itemId, materialId: invoice.materialId, title: '餐饮发票「餐饮_发票.pdf」缺少餐饮小票', choices: [{ key: 'exclude', label: '排除这份材料' }] }),
    ]);
    expect(await scene.refused('answer-pending', { itemId, answer: { choice: 'confirm_none' } })).toMatchObject({ code: 'invalid_answer' });
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
