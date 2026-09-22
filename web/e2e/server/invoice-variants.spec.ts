import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR, SAMPLE_MATERIALS } from '@baox/fixtures';
import { TaskSnapshotSchema, type TaskSnapshot } from '@baox/contract';
import type { Page } from '@playwright/test';
import { expect, signIn, test } from './fixture';

test.use({ serverEnv: { BAOX_PARSE_FIXTURE: 'invoice-variants' } });

type Upload = { name: string; mimeType: string; buffer: Buffer };

function source(prefix: string, name: string, mimeType: string): Upload {
  const found = SAMPLE_MATERIALS.find((sample) => sample.file.startsWith(prefix));
  if (!found) throw new Error(`fixture ${prefix} is missing from @baox/fixtures`);
  return { name, mimeType, buffer: readFileSync(join(GENERATED_DIR, found.file)) };
}

const snapshotOf = async (page: Page, taskId: string): Promise<TaskSnapshot> => TaskSnapshotSchema.parse(await (await page.request.get(`/api/tasks/${taskId}`)).json());

async function inventory(page: Page, files: readonly Upload[]): Promise<{ taskId: string; snapshot: TaskSnapshot }> {
  await signIn(page);
  await page.goto('/#/tasks');
  await page.getByRole('button', { name: '新建报销任务' }).click();
  const dialog = page.getByRole('dialog', { name: '新建报销任务' });
  await dialog.getByLabel('常驻城市').fill('杭州');
  await dialog.getByRole('button', { name: '创建并上传材料' }).click();
  await expect(page).toHaveURL(/#\/task\/[^/]+\/upload$/);
  const taskId = /#\/task\/([^/]+)\//.exec(page.url())?.[1] ?? '';

  await page.getByLabel('拖入文件，或点击选择').setInputFiles(files);
  const batch = page.locator('section', { has: page.getByRole('heading', { name: /^上传批次 #1$/ }) });
  for (const file of files) await expect(batch.getByText(file.name, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '开始材料盘点' }).click();
  await expect(page).toHaveURL(/#\/task\/[^/]+\/inventory$/);
  await expect.poll(async () => (await snapshotOf(page, taskId)).inventory.status).toBe('done');
  return { taskId, snapshot: await snapshotOf(page, taskId) };
}

test('匹配的 PDF 和照片显示为一个发票，照片原件仍可查看', async ({ page }) => {
  const { snapshot } = await inventory(page, [source('m07', 'variant-match.pdf', 'application/pdf'), source('m09', 'variant-match.jpg', 'image/jpeg')]);

  await expect(page.getByRole('group', { name: '盘点摘要' })).toContainText('材料1 份');
  const event = page.getByRole('button', { name: '费用事件 No.1', exact: true });
  await event.click();
  const versions = page.getByText('已合并 1 个版本', { exact: true });
  await expect(versions).toBeVisible();
  await versions.click();
  const original = page.getByRole('link', { name: '查看「variant-match.jpg」原件' });
  await expect(original).toBeVisible();
  await expect(original).toHaveAttribute('href', /^\/api\/tasks\/[^/]+\/files\/[0-9a-f]{64}$/);

  expect(snapshot.materials).toHaveLength(1);
  expect(snapshot.materials[0]).toMatchObject({ fileName: 'variant-match.pdf', mediaType: 'pdf', variants: [expect.objectContaining({ fileName: 'variant-match.jpg', mediaType: 'image' })] });
  expect(snapshot.batches[0]?.files).toHaveLength(2);
  expect((await page.request.get(snapshot.materials[0]!.variants[0]!.originalUrl!)).ok()).toBe(true);
});

test('跨格式票面内容不一致时保留两份材料并要求排除其中一份', async ({ page }) => {
  const { taskId } = await inventory(page, [source('m07', 'variant-conflict.pdf', 'application/pdf'), source('m09', 'variant-conflict.jpg', 'image/jpeg')]);

  await expect(page.getByText('票面内容不一致').first()).toBeVisible();
  await page.getByRole('link', { name: '处理 2 个待确认项' }).or(page.getByRole('button', { name: '处理 2 个待确认项' })).click();
  await expect(page).toHaveURL(/#\/task\/[^/]+\/pending$/);
  await page.getByRole('button', { name: '「variant-conflict.jpg」与「variant-conflict.pdf」票面内容不一致' }).click();
  await expect(page.getByRole('heading', { name: '「variant-conflict.jpg」与「variant-conflict.pdf」票面内容不一致' })).toBeVisible();
  await page.getByRole('button', { name: '排除这份材料' }).click();
  await expect(page.getByRole('heading', { name: '没有待确认项了' })).toBeVisible();

  const snapshot = await snapshotOf(page, taskId);
  expect(snapshot.materials.map((material) => [material.fileName, material.status])).toEqual([
    ['variant-conflict.pdf', 'ok'],
    ['variant-conflict.jpg', 'excluded'],
  ]);
  expect(snapshot.pendingItems.filter((item) => item.status === 'open')).toEqual([]);
  expect(snapshot.lines).toHaveLength(1);
});
