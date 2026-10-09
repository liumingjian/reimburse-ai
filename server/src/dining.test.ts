import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, byFileName, sample } from './test/api';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';
import { loadParsePresets, presetParser, sha256 } from './test/parse-presets';

const secondInvoice = { name: '第二顿餐饮_发票.pdf', bytes: new TextEncoder().encode('%PDF-second-dining-invoice') };

let server: ScenarioServer;
beforeEach(async () => {
  const invoice = loadParsePresets()['m11-other-invoice.pdf']?.outcome;
  if (invoice?.outcome !== 'recognised') throw new Error('dining invoice preset is missing');
  server = await scenarioServer({ parser: presetParser({ [sha256(secondInvoice.bytes)]: { ...invoice, candidates: invoice.candidates.map((candidate) => candidate.key === 'invoiceNumber' ? { ...candidate, value: '26312000000103317792' } : candidate) } }) });
});
afterEach(() => server.close());

describe('dining invoice evidence', () => {
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
    expect(snapshot.pendingItems.filter((item) => item.status === 'open').map((item) => item.itemId)).toEqual(snapshot.lines.map((line) => `dining_receipt_missing.${line.voucherMaterialId}`));
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
