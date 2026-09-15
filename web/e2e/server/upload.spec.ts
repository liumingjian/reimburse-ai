import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR, SAMPLE_MATERIALS } from '@baox/fixtures';
import { expect, test } from './fixture';

// Slice 01 (#179) walking skeleton on the real server: new task → upload one PDF → the material is listed.
const hotelInvoice = SAMPLE_MATERIALS.find((sample) => sample.file.startsWith('m01'));

test('新建报销任务、上传一份 PDF，材料列在上传批次里，刷新后仍在', async ({ page }) => {
  if (!hotelInvoice) throw new Error('fixture m01 is missing from @baox/fixtures');
  await page.goto('/#/tasks');
  await page.getByRole('button', { name: '新建报销任务' }).click();
  const dialog = page.getByRole('dialog', { name: '新建报销任务' });
  await dialog.getByLabel('常驻城市').fill('杭州');
  await dialog.getByRole('button', { name: '创建并上传材料' }).click();
  await expect(page).toHaveURL(/#\/task\/[^/]+\/upload$/);

  await page.locator('input[type=file]').setInputFiles({
    name: hotelInvoice.fileName,
    mimeType: 'application/pdf',
    buffer: readFileSync(join(GENERATED_DIR, hotelInvoice.file)),
  });
  const batch = page.locator('section', { has: page.getByRole('heading', { name: /^上传批次 #1$/ }) });
  await expect(batch.getByText(hotelInvoice.fileName, { exact: true })).toBeVisible();

  // The material is a server fact, not page state.
  await page.reload();
  await expect(batch.getByText(hotelInvoice.fileName, { exact: true })).toBeVisible();
});
