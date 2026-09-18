import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR, SAMPLE_MATERIALS } from '@baox/fixtures';
import { TaskSnapshotSchema, type TaskSnapshot } from '@baox/contract';
import type { Page } from '@playwright/test';
import { expect, signIn, test } from './fixture';

// Slice 10 (#189) on the real server: 整单明细确认 (whole-list detail confirmation). The task is brought to review
// through the API (upload, inventory, project book, assignment); the page then confirms and offers 去打印 / 去报销.

const samples = ['m01', 'm07'].map((prefix) => {
  const found = SAMPLE_MATERIALS.find((sample) => sample.file.startsWith(prefix));
  if (!found) throw new Error(`fixture ${prefix} is missing from @baox/fixtures`);
  return found;
});

async function snapshotOf(page: Page, taskId: string): Promise<TaskSnapshot> {
  return TaskSnapshotSchema.parse(await (await page.request.get(`/api/tasks/${taskId}`)).json());
}

async function act(page: Page, snapshot: TaskSnapshot, name: string, body: Record<string, unknown> = {}): Promise<TaskSnapshot> {
  const response = await page.request.post(`/api/tasks/${snapshot.task.taskId}/actions/${name}`, { data: { ...body, stepToken: snapshot.step.stepToken } });
  if (!response.ok()) throw new Error(`${name} failed: ${response.status()} ${await response.text()}`);
  return TaskSnapshotSchema.parse(await response.json());
}

async function reviewTask(page: Page): Promise<string> {
  const created = TaskSnapshotSchema.parse(await (await page.request.post('/api/tasks', { data: { homeCity: '杭州' } })).json());
  const taskId = created.task.taskId;
  // One batch per file: the server reads the repeated multipart field `files`, which an object cannot repeat.
  for (const sample of samples) {
    const uploaded = await page.request.post(`/api/tasks/${taskId}/batches`, { multipart: { files: { name: sample.fileName, mimeType: 'application/pdf', buffer: readFileSync(join(GENERATED_DIR, sample.file)) } } });
    expect(uploaded.ok()).toBe(true);
  }
  await act(page, await snapshotOf(page, taskId), 'start-inventory');
  await expect.poll(async () => (await snapshotOf(page, taskId)).inventory.status).toBe('done');
  expect((await page.request.post('/api/project-book/intake', { data: { number: 'P-2307' } })).ok()).toBe(true);
  const ready = await snapshotOf(page, taskId);
  const submitted = await act(page, ready, 'submit-project-assignment', { purpose: '上海产品评审出差', projects: Object.fromEntries(ready.lines.map((line) => [line.lineId, 'P-2307'])) });
  expect(submitted).toMatchObject({ stage: 'review', step: { kind: 'confirm_review' } });
  return taskId;
}

test('确认整单明细后出现去打印与去报销', async ({ page }) => {
  await signIn(page);
  const taskId = await reviewTask(page);
  await page.goto(`/#/task/${taskId}/review`);

  await expect(page.getByRole('heading', { name: '整单明细确认' })).toBeVisible();
  await expect(page.getByTestId('confirm-row-1')).toBeVisible();
  await expect(page.getByTestId('confirm-row-2')).toBeVisible();
  await expect(page.getByTestId('review-purpose')).toContainText('上海产品评审出差');
  // No internal identity in the table: no file names, no full invoice numbers.
  const table = page.getByRole('table', { name: '整单明细' });
  for (const sample of samples) await expect(table).not.toContainText(sample.fileName);

  await page.getByRole('button', { name: '确认整单明细', exact: true }).click();
  const done = page.getByRole('region', { name: '整单确认' });
  await expect(done.getByRole('link', { name: '去打印', exact: true })).toBeVisible();
  await expect(done.getByRole('button', { name: '去报销', exact: true })).toBeVisible();
  expect(await snapshotOf(page, taskId)).toMatchObject({ stage: 'actions', step: { kind: 'choose_action' }, confirmation: { status: 'confirmed' } });

  // Changing the home city invalidates the confirmation; changing it back revives it.
  const city = async (name: string) => {
    await page.getByRole('button', { name: '修改常驻城市' }).click();
    await page.getByLabel('常驻城市', { exact: true }).fill(name);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByTestId('review-home-city')).toContainText(name);
  };
  await city('上海');
  await expect(page.getByRole('button', { name: '确认整单明细', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '去打印', exact: true })).toHaveCount(0);
  expect((await snapshotOf(page, taskId)).confirmation.status).toBe('invalidated');
  await city('杭州');
  await expect(done.getByRole('link', { name: '去打印', exact: true })).toBeVisible();

  await done.getByRole('link', { name: '去打印', exact: true }).click();
  await expect(page).toHaveURL(/#\/task\/[^/]+\/print$/);
});
