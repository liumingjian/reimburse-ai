import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR, SAMPLE_MATERIALS } from '@baox/fixtures';
import { TaskSnapshotSchema } from '@baox/contract';
import { expect, signIn, test } from './fixture';

// Slice 07 (#186) on the real server: upload a 出租车车费发票 (taxi receipt) photo, start 材料盘点, and the parser job
// straightens and OCRs it into a candidate line.

const taxiPhoto = SAMPLE_MATERIALS.find((sample) => sample.file.startsWith('m09'));

test('上传一张出租车票照片、开始材料盘点，识别完成后看到它的候选明细', async ({ page }) => {
  if (!taxiPhoto) throw new Error('fixture m09 is missing from @baox/fixtures');
  await signIn(page);
  await page.goto('/#/tasks');
  await page.getByRole('button', { name: '新建报销任务' }).click();
  const dialog = page.getByRole('dialog', { name: '新建报销任务' });
  await dialog.getByLabel('常驻城市').fill('杭州');
  await dialog.getByRole('button', { name: '创建并上传材料' }).click();
  await expect(page).toHaveURL(/#\/task\/[^/]+\/upload$/);
  const taskId = /#\/task\/([^/]+)\//.exec(page.url())?.[1] ?? '';

  await page.locator('input[type=file]').setInputFiles({ name: taxiPhoto.fileName, mimeType: 'image/jpeg', buffer: readFileSync(join(GENERATED_DIR, taxiPhoto.file)) });
  const batch = page.locator('section', { has: page.getByRole('heading', { name: /^上传批次 #1$/ }) });
  await expect(batch.getByText(taxiPhoto.fileName, { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '开始材料盘点' }).click();
  await expect(page).toHaveURL(/#\/task\/[^/]+\/inventory$/);

  // OCR runs in the parse worker; the summary appears over SSE once it has finished.
  const summary = page.getByRole('group', { name: '盘点摘要' });
  await expect(summary).toContainText('材料1 份', { timeout: 60_000 });
  await expect(summary).toContainText('通过1 份', { timeout: 60_000 });
  const event = page.getByRole('button', { name: '费用事件 No.1', exact: true }).locator('xpath=ancestor::tr[1]');
  // 开票地区码 3100 → 上海, not the home city 杭州.
  await expect(event).toContainText('外地市内交通');
  await expect(event).toContainText('32.00');

  const snapshot = TaskSnapshotSchema.parse(await (await page.request.get(`/api/tasks/${taskId}`)).json());
  expect(snapshot.events).toEqual([expect.objectContaining({ summary: '出租车（上海）', date: '2026-08-15' })]);
  expect(snapshot.lines).toEqual([expect.objectContaining({ grossAmount: '32.00', netAmount: '32.00', taxAmount: '0.00' })]);
  expect(snapshot.materials[0]).toMatchObject({ kind: 'taxi_receipt', layout: 'machine_printed', status: 'ok' });
});
