import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR, SAMPLE_MATERIALS } from '@baox/fixtures';
import { TaskSnapshotSchema } from '@baox/contract';
import { expect, test } from './fixture';

// Slice 04 (#183) on the real server: upload a 全电发票 (e-invoice), start 材料盘点, and the background parser job
// turns it into a candidate line, pushed to the page over SSE.

const hotelInvoice = SAMPLE_MATERIALS.find((sample) => sample.file.startsWith('m01'));

test('上传一张全电发票、开始材料盘点，解析完成后看到它的候选明细', async ({ page }) => {
  if (!hotelInvoice) throw new Error('fixture m01 is missing from @baox/fixtures');
  await page.goto('/#/tasks');
  await page.getByRole('button', { name: '新建报销任务' }).click();
  const dialog = page.getByRole('dialog', { name: '新建报销任务' });
  await dialog.getByLabel('常驻城市').fill('杭州');
  await dialog.getByRole('button', { name: '创建并上传材料' }).click();
  await expect(page).toHaveURL(/#\/task\/[^/]+\/upload$/);
  const taskId = /#\/task\/([^/]+)\//.exec(page.url())?.[1] ?? '';

  await page.locator('input[type=file]').setInputFiles({ name: hotelInvoice.fileName, mimeType: 'application/pdf', buffer: readFileSync(join(GENERATED_DIR, hotelInvoice.file)) });
  const batch = page.locator('section', { has: page.getByRole('heading', { name: /^上传批次 #1$/ }) });
  await expect(batch.getByText(hotelInvoice.fileName, { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '开始材料盘点' }).click();
  await expect(page).toHaveURL(/#\/task\/[^/]+\/inventory$/);

  // The summary appears once the parser job has finished; no reload needed.
  const summary = page.getByRole('group', { name: '盘点摘要' });
  await expect(summary).toContainText('材料1 份');
  await expect(summary).toContainText('通过1 份');
  const event = page.getByRole('button', { name: '费用事件 No.1', exact: true }).locator('xpath=ancestor::tr[1]');
  await expect(event).toContainText('住宿');
  await expect(event).toContainText('3640.00');

  const snapshot = TaskSnapshotSchema.parse(await (await page.request.get(`/api/tasks/${taskId}`)).json());
  expect(snapshot.lines).toEqual([expect.objectContaining({ invoiceLabel: '发票1', grossAmount: '3640.00', netAmount: '3433.96', taxAmount: '206.04' })]);
  expect(snapshot.materials[0]).toMatchObject({ kind: 'vat_invoice', layout: 'einvoice', status: 'ok' });
});
