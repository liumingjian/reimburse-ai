import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR, SAMPLE_MATERIALS } from '@baox/fixtures';
import { TaskSnapshotSchema } from '@baox/contract';
import { answerStayGaps, expect, signIn, test } from './fixture';

test('associated hotel bill leads pending review and project previews preserve selections', async ({ page }, testInfo) => {
  await signIn(page);
  const created = TaskSnapshotSchema.parse(await (await page.request.post('/api/tasks', { data: { homeCity: '杭州' } })).json());
  const taskId = created.task.taskId;
  const snapshot = async () => TaskSnapshotSchema.parse(await (await page.request.get(`/api/tasks/${taskId}`)).json());
  for (const prefix of ['m01', 'm02']) {
    const sample = SAMPLE_MATERIALS.find((material) => material.file.startsWith(prefix))!;
    expect((await page.request.post(`/api/tasks/${taskId}/batches`, { multipart: { files: { name: sample.fileName, mimeType: 'application/pdf', buffer: readFileSync(join(GENERATED_DIR, sample.file)) } } })).ok()).toBe(true);
  }
  expect((await page.request.post(`/api/tasks/${taskId}/actions/start-inventory`, { data: { stepToken: (await snapshot()).step.stepToken } })).ok()).toBe(true);
  await expect.poll(async () => (await snapshot()).pendingItems.some((item) => item.itemId.startsWith('stay_screenshot_missing.'))).toBe(true);
  await page.goto(`/#/task/${taskId}/pending`);
  const preview = page.getByRole('region', { name: '住宿材料预览' });
  await expect(preview.getByRole('tab', { name: /^结账单：/ })).toHaveAttribute('aria-selected', 'true');
  // The folio PDF is rendered to an image in the original viewer; the invoice is never offered (QA 2026-09-30).
  await expect(preview.getByRole('img', { name: '全季酒店_结账单.pdf 原件' })).toHaveAttribute('src', /^blob:/);
  await expect(preview.getByRole('toolbar', { name: '原件查看' })).toBeVisible();
  await expect(preview.getByRole('tab')).toHaveCount(1);

  await answerStayGaps(page, taskId);
  await page.request.post('/api/project-book/intake', { data: { number: 'HOTEL-101', name: '住宿项目' } });
  await page.goto(`/#/task/${taskId}/project`);
  const row = page.getByTestId('line-card-1');
  await expect(row).toContainText('2026-08-09 至 2026-08-22');
  await expect(row).toContainText('3640.00 元');
  await expect(row).toContainText('全季酒店（上海某某店）');
  await expect(row).toContainText('住宿地未提供');
  const check = page.getByRole('checkbox', { name: '选择明细 No.1' });
  await check.locator('xpath=following-sibling::label[1]').click();
  await page.getByLabel('报销事由').fill('住宿材料核对');
  const before = await snapshot();
  await page.getByRole('button', { name: '查看住宿材料 No.1' }).click();
  const dialog = page.getByRole('dialog', { name: '住宿材料 No.1' });
  await expect(dialog.getByRole('tab', { name: /^结账单：/ })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('tab', { name: /^发票：/ })).toHaveCount(0);
  await page.setViewportSize({ width: 1366, height: 768 });
  await expect(dialog.getByRole('img', { name: '全季酒店_结账单.pdf 原件' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('lodging-preview-1366.png') });
  const bill = before.materials.find((material) => material.kind === 'hotel_folio')!;
  await page.route(`**${bill.previewUrl}`, (route) => route.fulfill({ status: 404, body: 'preview unavailable' }));
  // Reopen the dialog so the preview loads again, now against the failing URL.
  await dialog.getByRole('button', { name: '关闭预览', exact: true }).click();
  await page.getByRole('button', { name: '查看住宿材料 No.1' }).click();
  await expect(dialog).toContainText('材料已在任务中，但预览暂时不可用');
  await expect(dialog.getByRole('link', { name: '打开原件', exact: true })).toBeVisible();
  expect((await snapshot()).materials.find((material) => material.materialId === bill.materialId)?.linkedMaterialIds).toEqual(bill.linkedMaterialIds);
  await page.unroute(`**${bill.previewUrl}`);
  await dialog.getByRole('button', { name: '重试预览', exact: true }).click();
  await expect(dialog.getByRole('img', { name: '全季酒店_结账单.pdf 原件' })).toHaveAttribute('src', /^blob:/);
  await dialog.getByRole('button', { name: '关闭预览', exact: true }).click();
  await expect(check).toBeChecked();
  await expect(page.getByLabel('报销事由')).toHaveValue('住宿材料核对');
  expect((await snapshot()).step.stepToken).toBe(before.step.stepToken);
  await page.getByRole('complementary', { name: '归入项目' }).getByRole('button', { name: /HOTEL-101/ }).click();
  await expect(page.getByTestId('project-of-1')).toContainText('HOTEL-101');
});

for (const state of ['missing', 'unlinked'] as const) {
  test(`hotel bill state ${state} offers its matching recovery without associating on read`, async ({ page }) => {
    await signIn(page);
    const created = TaskSnapshotSchema.parse(await (await page.request.post('/api/tasks', { data: { homeCity: '杭州' } })).json());
    const taskId = created.task.taskId;
    const snapshot = async () => TaskSnapshotSchema.parse(await (await page.request.get(`/api/tasks/${taskId}`)).json());
    const sources = state === 'missing' ? ['m01'] : ['m01', 'm02', 'm02'];
    for (const [index, prefix] of sources.entries()) {
      const sample = SAMPLE_MATERIALS.find((material) => material.file.startsWith(prefix))!;
      const bytes = readFileSync(join(GENERATED_DIR, sample.file));
      // Two distinct PDF originals with the same folio facts make automatic association ambiguous.
      const buffer = index === 2 ? Buffer.concat([bytes, Buffer.from('\n% second retained original\n')]) : bytes;
      expect((await page.request.post(`/api/tasks/${taskId}/batches`, { multipart: { files: { name: index === 2 ? '第二份结账单.pdf' : sample.fileName, mimeType: 'application/pdf', buffer } } })).ok()).toBe(true);
    }
    await page.request.post(`/api/tasks/${taskId}/actions/start-inventory`, { data: { stepToken: (await snapshot()).step.stepToken } });
    await expect.poll(async () => (await snapshot()).pendingItems.some((item) => item.itemId.startsWith('stay_folio_missing.'))).toBe(true);
    const before = await snapshot();
    await page.goto(`/#/task/${taskId}/pending`);
    const preview = page.getByRole('region', { name: '住宿材料预览' });
    await expect(preview).toContainText(state === 'missing' ? '还没有这笔住宿的结账单' : '任务中有结账单，但尚未与这笔住宿关联');
    const recovery = preview.getByRole('link', { name: state === 'missing' ? '去追加结账单' : '去核对材料关联' });
    await expect(recovery).toHaveAttribute('href', `#/task/${taskId}/${state === 'missing' ? 'upload' : 'inventory'}`);
    expect((await snapshot()).materials.map((material) => material.linkedMaterialIds)).toEqual(before.materials.map((material) => material.linkedMaterialIds));
    expect((await snapshot()).step.stepToken).toBe(before.step.stepToken);
  });
}
