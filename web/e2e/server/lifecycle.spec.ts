import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR, SAMPLE_MATERIALS } from '@baox/fixtures';
import { TaskSnapshotSchema } from '@baox/contract';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixture';

// Slice 02 (#180) on the real server: two upload batches hitting every reject code, exclude one material, start
// 材料盘点 (material inventory), then 任务作废 (void the task) and take the freed slot with a new task.

const sample = (prefix: string) => {
  const found = SAMPLE_MATERIALS.find((candidate) => candidate.file.startsWith(prefix));
  if (!found) throw new Error(`fixture ${prefix} is missing from @baox/fixtures`);
  return { name: found.fileName, mimeType: 'application/pdf', buffer: readFileSync(join(GENERATED_DIR, found.file)) };
};

const batch = (page: Page, no: number) => page.locator('section', { has: page.getByRole('heading', { name: new RegExp(`^上传批次 #${no}$`) }) });
const row = (section: Locator, fileName: string) => section.locator('li', { has: section.page().getByText(fileName, { exact: true }) });

async function createTask(page: Page) {
  await page.getByRole('button', { name: '新建报销任务' }).click();
  const dialog = page.getByRole('dialog', { name: '新建报销任务' });
  await dialog.getByLabel('常驻城市').fill('杭州');
  await dialog.getByRole('button', { name: '创建并上传材料' }).click();
  await expect(page).toHaveURL(/#\/task\/[^/]+\/upload$/);
}

test('两个上传批次逐一命中四种拒绝原因，排除一份材料后开始盘点，最后作废任务并腾出新建名额', async ({ page }) => {
  const hotel = sample('m01');
  const amap = sample('m03');
  const caocao = sample('m05');
  await page.goto('/#/tasks');
  await createTask(page);
  const taskId = /#\/task\/([^/]+)\//.exec(page.url())?.[1] ?? '';

  await page.locator('input[type=file]').setInputFiles([
    hotel,
    { name: '备注.txt', mimeType: 'text/plain', buffer: Buffer.from('not a receipt') },
    { name: 'IMG_4871.HEIC', mimeType: 'image/heic', buffer: Buffer.from('heic bytes') },
  ]);
  const first = batch(page, 1);
  await expect(first.getByText('拒绝 2 份')).toBeVisible();
  await expect(row(first, '备注.txt').getByText('类型不支持，只接受 PDF、JPG、PNG')).toBeVisible();
  await expect(row(first, 'IMG_4871.HEIC').getByText('HEIC 不支持，请在 iPhone 相册导出为 JPG')).toBeVisible();

  await page.getByRole('button', { name: '追加下一批' }).click();
  await page.locator('input[type=file]').setInputFiles([
    amap,
    { name: '扫描件.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(20 * 1024 * 1024 + 1) },
    { ...hotel, name: '全季酒店_发票（副本）.pdf' },
    caocao,
  ]);
  const second = batch(page, 2);
  await expect(second.getByText('拒绝 2 份')).toBeVisible();
  await expect(row(second, '扫描件.pdf').getByText('超过 20MB')).toBeVisible();
  await expect(row(second, '全季酒店_发票（副本）.pdf').getByText(`内容重复，与已接收的「${hotel.name}」内容相同`)).toBeVisible();
  await expect(row(second, amap.name).getByText('拒绝', { exact: true })).toHaveCount(0);

  // The upload page offers no exclusion before inventory; exclude through the action endpoint with the current token.
  const snapshot = TaskSnapshotSchema.parse(await (await page.request.get(`/api/tasks/${taskId}`)).json());
  const target = snapshot.materials.find((material) => material.fileName === amap.name);
  const excluded = await page.request.post(`/api/tasks/${taskId}/actions/exclude-material`, { data: { materialId: target?.materialId, stepToken: snapshot.step.stepToken } });
  expect(excluded.status()).toBe(200);

  // The stale token from before the exclusion is refused with the fresh snapshot.
  const stale = await page.request.post(`/api/tasks/${taskId}/actions/start-inventory`, { data: { stepToken: snapshot.step.stepToken } });
  expect(stale.status()).toBe(409);

  await page.reload();
  await page.getByRole('button', { name: '开始材料盘点' }).click();
  await expect(page).toHaveURL(/#\/task\/[^/]+\/inventory$/);
  // Three accepted materials, one excluded.
  await expect(page.getByRole('group', { name: '盘点摘要' }).getByText('2 份', { exact: true })).toBeVisible();

  await page.goto('/#/tasks');
  const listed = page.getByRole('row', { name: /新建报销/ });
  await expect(listed).toHaveCount(1);
  await listed.getByRole('button', { name: '更多' }).click();
  await page.getByRole('menuitem', { name: '作废' }).click();
  await page.getByRole('dialog', { name: '作废这个报销任务？' }).getByRole('button', { name: '作废', exact: true }).click();
  await expect(listed).toHaveCount(0);

  // The voided task stays on disk, read-only.
  const voided = TaskSnapshotSchema.parse(await (await page.request.get(`/api/tasks/${taskId}`)).json());
  expect(voided.stage).toBe('voided');

  await createTask(page);
});
