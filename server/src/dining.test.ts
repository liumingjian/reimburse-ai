import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { byFileName, sample } from './test/api';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';

let server: ScenarioServer;
beforeEach(async () => {
  server = await scenarioServer();
});
afterEach(() => server.close());

describe('dining invoice evidence', () => {
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
