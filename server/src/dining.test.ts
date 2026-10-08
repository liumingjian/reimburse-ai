import { ActionFailureSchema, DINING_COPY } from '@baox/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMPANY_RULES } from './rules/company-rules';
import { api, byFileName, sample } from './test/api';
import type { TestClient } from './test/harness';
import { scenario, scenarioServer, type ScenarioServer } from './test/scenario';

// 餐饮 (dining, #359): a dining invoice is recognised as 招待费 (hospitality, FY009001) and blocks until its 餐饮小票
// arrives. Until the slip can be supplied, the block is answered by exclusion only; there is no 确认没有.

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

describe('company rules', () => {
  it('map 招待费 to FY009001, user-declared until a real ERP save reads it back', () => {
    expect(COMPANY_RULES.categories['hospitality']).toEqual({ label: '招待费', expenseItemCode: 'FY009001', expenseItemName: '招待费', source: 'user_declared' });
  });
});
