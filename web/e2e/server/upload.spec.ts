import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TaskSnapshotSchema } from '@baox/contract';
import { GENERATED_DIR, SAMPLE_MATERIALS } from '@baox/fixtures';
import { expect, signIn, test } from './fixture';

// Slice 01 (#179) walking skeleton on the real server: new task → upload one PDF → the material is listed.
const hotelInvoice = SAMPLE_MATERIALS.find((sample) => sample.file.startsWith('m01'));

test('新建报销任务、上传一份 PDF，材料列在上传批次里，刷新后仍在', async ({ page }) => {
  if (!hotelInvoice) throw new Error('fixture m01 is missing from @baox/fixtures');
  await signIn(page);
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

test('目录上传保留嵌套来源路径，并把同内容副本与不支持文件逐项列出', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/tasks');
  await page.getByRole('button', { name: '新建报销任务' }).click();
  const dialog = page.getByRole('dialog', { name: '新建报销任务' });
  await dialog.getByLabel('常驻城市').fill('杭州');
  await dialog.getByRole('button', { name: '创建并上传材料' }).click();
  await expect(page).toHaveURL(/#\/task\/[^/]+\/upload$/);

  await expect(page.locator('button').filter({ hasText: '选择文件夹' })).toBeVisible();
  await expect(page.locator('input[webkitdirectory]')).toHaveCount(1);
  const dataTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    const files = [
      ['same.pdf', 'trip/receipts/same.pdf', '%PDF-1.4 invoice'],
      ['same.pdf', 'trip/notes/same.pdf', '%PDF-1.4 folio'],
      ['copy.pdf', 'trip/receipts/copy.pdf', '%PDF-1.4 invoice'],
      ['readme.txt', 'trip/notes/readme.txt', 'notes'],
    ] as const;
    for (const [name, relativePath, contents] of files) {
      const file = new File([contents], name, { type: name.endsWith('.pdf') ? 'application/pdf' : 'text/plain' });
      Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
      transfer.items.add(file);
    }
    return transfer;
  });
  await page.getByTestId('dropzone').dispatchEvent('drop', { dataTransfer });

  const batch = page.locator('section', { has: page.getByRole('heading', { name: /^上传批次 #1$/ }) });
  await expect(batch.getByText('trip/receipts/same.pdf', { exact: true })).toBeVisible();
  await expect(batch.getByText('trip/notes/same.pdf', { exact: true })).toBeVisible();
  await expect(batch.getByText('trip/receipts/copy.pdf', { exact: true })).toBeVisible();
  await expect(batch.getByText('trip/notes/readme.txt', { exact: true })).toBeVisible();
  await expect(batch.getByText(/内容重复/)).toBeVisible();
  await expect(batch.getByText('类型不支持，只接受 PDF、JPG、PNG')).toBeVisible();

  const taskId = /#\/task\/([^/]+)\//.exec(page.url())?.[1];
  if (!taskId) throw new Error('task id missing from upload URL');
  const snapshot = TaskSnapshotSchema.parse(await (await page.request.get(`/api/tasks/${taskId}`)).json());
  expect(snapshot.batches[0]?.files.map((file) => file.relativePath)).toEqual([
    'trip/receipts/same.pdf',
    'trip/notes/same.pdf',
    'trip/receipts/copy.pdf',
    'trip/notes/readme.txt',
  ]);
  expect(snapshot.materials.map((material) => material.relativePath)).toEqual(['trip/receipts/same.pdf', 'trip/notes/same.pdf']);
});
