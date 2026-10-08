import { ActionFailureSchema, DINING_COPY, type TaskSnapshot } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ParseOutcome } from './parse/dispatch';
import { COMPANY_RULES } from './rules/company-rules';
import { api, byFileName, sample, type Upload } from './test/api';
import type { TestClient } from './test/harness';
import { loadParsePresets, presetParser, sha256 } from './test/parse-presets';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';

// 餐饮 (dining, #359, #360): a dining invoice is recognised as 招待费 (hospitality, FY009001) and blocks until it pairs
// with its 餐饮小票: one to one, the slip's amount actually paid equal to the invoice's 价税合计 to the cent, by the
// shared amount rule. The block is answered by supplying the slip or by exclusion; there is no 确认没有.

let server: ScenarioServer;
let signedIn: TestClient;
beforeEach(async () => {
  server = await scenarioServer();
  signedIn = await server.signIn();
});
afterEach(() => server.close());
const client = api(() => signedIn);

const HOSPITALITY = { code: 'hospitality', label: '招待费' };

describe('a dining invoice', () => {
  it('forms a 招待费 / FY009001 line and a blocking 缺少餐饮小票 item that offers exclusion only', async () => {
    const { reached } = await scenario(server, signedIn).at('pending', { materials: ['m11'] });
    const invoice = byFileName(reached, sample('m11').name);
    expect(invoice).toMatchObject({ kind: 'vat_invoice', layout: 'einvoice', categoryLabel: '招待费', role: 'primary_voucher', status: 'pending' });

    expect(reached.lines).toHaveLength(1);
    expect(reached.lines[0]).toMatchObject({ voucherMaterialId: invoice.materialId, category: HOSPITALITY, expenseItemCode: 'FY009001', expenseItemName: '招待费', grossAmount: '240.00' });

    const itemId = `dining_receipt_missing.${invoice.materialId}`;
    expect(invoice.pendingItemIds).toContain(itemId);
    expect(reached.pendingItems).toEqual([
      expect.objectContaining({ itemId, materialId: invoice.materialId, kind: 'choice', status: 'open', title: DINING_COPY.receiptMissing.title(sample('m11').name), choices: [{ key: 'exclude', label: '排除这份材料' }] }),
    ]);
    expect(reached.stage).toBe('pending');
  });

  it('refuses 确认没有, and excluding the invoice clears the block', async () => {
    const { reached } = await scenario(server, signedIn).at('pending', { materials: ['m11', 'm07'] });
    const id = byFileName(reached, sample('m11').name).materialId;
    const itemId = `dining_receipt_missing.${id}`;

    const refused = await client.act(reached, 'answer-pending', { itemId, answer: { choice: 'confirm_none' } });
    expect(refused.status).toBe(400);
    expect(ActionFailureSchema.parse(await refused.json()).error.code).toBe('invalid_answer');

    const done = await client.accepted(await client.act(reached, 'answer-pending', { itemId, answer: { choice: 'exclude' } }));
    expect(byFileName(done, sample('m11').name)).toMatchObject({ role: 'excluded', status: 'excluded' });
    expect(done.pendingItems.filter((item) => item.status === 'open')).toEqual([]);
    expect(done.lines.map((line) => line.category.code)).toEqual(['long_distance']);
    expect(done.stage).not.toBe('pending');
  });

  it('comes after every other category in business order', async () => {
    // Uploaded first, the dining invoice still sorts after the rail ticket (长途交通) and the hotel stay (住宿).
    const { reached } = await scenario(server, signedIn).at('pending', { materials: ['m11', 'm07', 'm01', 'm02'], stayTrio: 'answered' });
    expect(reached.lines.map((line) => line.category.code)).toEqual(['long_distance', 'accommodation', 'hospitality']);
    expect(reached.lines.map((line) => line.no)).toEqual([1, 2, 3]);
  });
});

const openIds = (snapshot: TaskSnapshot) => snapshot.pendingItems.filter((item) => item.status === 'open').map((item) => item.itemId);

describe('a dining invoice with its 餐饮小票', () => {
  it('pairs with the slip whose paid amount equals its 价税合计: no pending item, one 招待费 line with the slip as reference', async () => {
    const { reached } = await scenario(server, signedIn).at('project', { materials: ['m11', 'm13'] });
    const invoice = byFileName(reached, sample('m11').name);
    const slip = byFileName(reached, sample('m13').name);
    expect(slip).toMatchObject({ kind: 'dining_receipt', layout: 'labelled', kindLabel: '餐饮小票', categoryLabel: '招待费', role: 'reference', status: 'ok', linkedMaterialIds: [invoice.materialId] });
    expect(invoice).toMatchObject({ role: 'primary_voucher', status: 'ok', pendingItemIds: [], linkedMaterialIds: [slip.materialId] });
    expect(reached.pendingItems).toEqual([]);
    expect(reached.lines).toEqual([
      expect.objectContaining({ voucherMaterialId: invoice.materialId, category: HOSPITALITY, expenseItemCode: 'FY009001', grossAmount: '240.00', referenceMaterialIds: [slip.materialId] }),
    ]);
    expect(reached.events).toEqual([expect.objectContaining({ referenceMaterialIds: [slip.materialId], evidenceNote: '餐饮发票与餐饮小票配对：金额 240.00 一致' })]);
    expect(reached.inventory.ungroupedMaterialIds).toEqual([]);
  });

  it('pairs a discounted slip by its amount actually paid, not its total before the discount', async () => {
    const { reached } = await scenario(server, signedIn).at('project', { materials: ['m11', 'm14'] });
    const slip = byFileName(reached, sample('m14').name);
    expect(Object.fromEntries(slip.fields.map((field) => [field.key, field.value]))).toMatchObject({ originalTotal: '268.00', paidAmount: '240.00' });
    expect(reached.pendingItems).toEqual([]);
    expect(reached.lines).toEqual([expect.objectContaining({ grossAmount: '240.00', referenceMaterialIds: [slip.materialId] })]);
  });

  it('supplying the slip by upload and a new inventory resolves 缺少餐饮小票', async () => {
    const scene = await scenario(server, signedIn).at('pending', { materials: ['m11'] });
    const invoice = byFileName(scene.reached, sample('m11').name);
    expect(openIds(scene.reached)).toEqual([`dining_receipt_missing.${invoice.materialId}`]);
    expect(scene.reached.pendingItems[0]?.why).toContain('请在上传页追加餐饮小票后重新盘点');
    await scene.accept('reopen-upload');
    await client.upload(scene.task.taskId, [sample('m13')]);
    const again = await scene.run('start-inventory');
    expect(again.pendingItems).toEqual([]);
    expect(again.stage).toBe('project');
    expect(byFileName(again, sample('m11').name).linkedMaterialIds).toEqual([byFileName(again, sample('m13').name).materialId]);
  });

  it('a slip of another amount does not pair, and the invoice still misses its slip', async () => {
    const other = await slipOf('另一家_结账单.pdf', '238.00');
    const { reached } = await scenario(server, signedIn).at('pending', { materials: ['m11', other.upload] });
    const invoice = byFileName(reached, sample('m11').name);
    expect(openIds(reached)).toEqual([`dining_receipt_missing.${invoice.materialId}`]);
    expect(byFileName(reached, '另一家_结账单.pdf')).toMatchObject({ kind: 'dining_receipt', role: 'reference', linkedMaterialIds: [] });
    expect(reached.lines[0]?.referenceMaterialIds).toEqual([]);
  });
});

// Story 9, decided for #356: the shared amount rule pairs an amount only when exactly one invoice and exactly one slip
// carry it. Two slips (or two invoices) of one amount pair nothing on it, whatever the upload order, and each dining
// invoice keeps its 缺少餐饮小票; the filer excludes what does not belong.
describe('dining invoices and slips of equal amounts', () => {
  it('one invoice and two slips of its amount pair nothing', async () => {
    const { reached } = await scenario(server, signedIn).at('pending', { materials: ['m11', 'm13', 'm14'] });
    const invoice = byFileName(reached, sample('m11').name);
    expect(openIds(reached)).toEqual([`dining_receipt_missing.${invoice.materialId}`]);
    for (const name of [sample('m13').name, sample('m14').name]) expect(byFileName(reached, name)).toMatchObject({ role: 'reference', linkedMaterialIds: [] });
  });

  it('two meals of equal amounts pair nothing; excluding one meal’s invoice and slip pairs the other', async () => {
    const second = await secondDiningInvoice();
    const { reached } = await scenario(server, signedIn).at('pending', { materials: ['m11', second.upload, 'm13', 'm14'] });
    const invoices = [byFileName(reached, sample('m11').name), byFileName(reached, second.upload.name)];
    expect(openIds(reached)).toEqual(invoices.map((invoice) => `dining_receipt_missing.${invoice.materialId}`));
    expect(reached.lines.map((line) => line.referenceMaterialIds)).toEqual([[], []]);

    const excluded = await client.accepted(await client.act(reached, 'answer-pending', { itemId: `dining_receipt_missing.${invoices[1]?.materialId}`, answer: { choice: 'exclude' } }));
    const slip = byFileName(excluded, sample('m14').name);
    const done = await client.accepted(await client.act(excluded, 'exclude-material', { materialId: slip.materialId }));
    expect(openIds(done)).toEqual([]);
    expect(done.lines).toEqual([expect.objectContaining({ voucherMaterialId: invoices[0]?.materialId, referenceMaterialIds: [byFileName(done, sample('m13').name).materialId] })]);
  });
});

// A test's own material: `base` bytes made unique by a trailing comment, parsed as `outcome` by the preset parser.
async function withPreset(name: string, base: Upload, outcome: ParseOutcome): Promise<{ upload: Upload }> {
  const bytes = Buffer.concat([Buffer.from(base.bytes), Buffer.from(`\n% ${name}\n`)]);
  await server.close();
  server = await scenarioServer({ parser: presetParser({ [sha256(bytes)]: outcome }) });
  signedIn = await server.signIn();
  return { upload: { ...base, name, bytes } };
}
const presetOf = (file: string) => structuredClone(loadParsePresets()[file]!.outcome);
const withValue = (outcome: ParseOutcome, key: string, value: string): ParseOutcome =>
  outcome.outcome === 'recognised' ? { ...outcome, candidates: outcome.candidates.map((c) => (c.key === key ? { ...c, value } : c)) } : outcome;

// m13 read with another amount paid.
const slipOf = (name: string, paidAmount: string) => withPreset(name, sample('m13'), withValue(presetOf('m13-dining-receipt.pdf'), 'paidAmount', paidAmount));
// A second meal's invoice: m11 with its own number, of the same 价税合计.
const secondDiningInvoice = () => withPreset('餐饮_发票_2.pdf', sample('m11'), withValue(presetOf('m11-dining-invoice.pdf'), 'invoiceNumber', '26312000000103317791'));

describe('company rules', () => {
  it('map 招待费 to FY009001, user-declared until a real ERP save reads it back', () => {
    expect(COMPANY_RULES.categories['hospitality']).toEqual({ label: '招待费', expenseItemCode: 'FY009001', expenseItemName: '招待费', source: 'user_declared' });
  });
});
