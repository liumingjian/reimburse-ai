// @vitest-environment node
import { expect, test, vi } from 'vitest';
import { createMockAdapter } from './mock-adapter';
import { buildPrintSheet, rotatePage } from './fixtures/print';

test.each([['餐饮_小票.pdf', 'dining'], ['餐饮_优惠小票.pdf', 'dining-discounted'], ['餐饮_小票照片.jpg', 'dining-photo']])('paired dining %s mock print uses an invoice and receipt page with its own PDF and rotation images', async (receiptName, pageId) => {
  const adapter = createMockAdapter({ seed: null, fault: null, inventoryPhaseMs: 1 });
  const created = await adapter.createTask({ homeCity: '杭州' });
  if (!created.ok) throw new Error(created.error.message);
  const taskId = created.snapshot.task.taskId;
  const uploaded = await adapter.uploadBatch(taskId, ['餐饮_发票.pdf', receiptName].map((name) => new File([name], name, { type: 'application/pdf' })));
  if (!uploaded.ok) throw new Error(uploaded.error.message);
  expect((await adapter.startInventory(taskId, uploaded.snapshot.step.stepToken)).ok).toBe(true);
  await vi.waitFor(async () => expect((await adapter.getSnapshot(taskId)).inventory.status).toBe('done'));
  const sheet = buildPrintSheet(await adapter.getSnapshot(taskId));
  expect(sheet.url).toBe(`fixtures/print-${pageId}-sheet.pdf`);
  expect(sheet.pages).toHaveLength(1);
  const page = sheet.pages[0];
  expect(page).toMatchObject({ kind: 'voucher', header: 'No.1 · 08-14 · 招待费 · 240.00', imageUrl: `fixtures/print-${pageId}.png`, top: { fileName: '餐饮_发票.pdf' }, bottom: { fileName: receiptName }, screenshotIds: [] });
  expect(sheet.notices).toEqual([]);
  if (!page) throw new Error('missing dining print page');
  expect(rotatePage(page, 'bottom', true).imageUrl).toBe(`fixtures/print-${pageId}-r01.png`);
});
