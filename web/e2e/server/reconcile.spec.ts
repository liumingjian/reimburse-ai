import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR, SAMPLE_MATERIALS } from '@baox/fixtures';
import { HUMAN_REVIEW_NOTICE, TaskListSchema, TaskSnapshotSchema, type TaskSnapshot } from '@baox/contract';
import type { Page } from '@playwright/test';
import { answerStayGaps, expect, signIn, test } from './fixture';

// Slice 13 (#192) on the real server: a forced uncertain save (`BAOX_ERP_FAKE=uncertain_save`: the fill job ends in
// ERP 写入结果未知 after its save attempt, with ERP's own dialog text and a screenshot) reaches reconcile; the page
// offers only 开始对账 and 转人工; the read-only reconcile finds no form (未知); 转人工 ends the task as handed off.

test.use({ serverEnv: { BAOX_ERP_FAKE: 'uncertain_save' } });

async function snapshotOf(page: Page, taskId: string): Promise<TaskSnapshot> {
  return TaskSnapshotSchema.parse(await (await page.request.get(`/api/tasks/${taskId}`)).json());
}

async function act(page: Page, snapshot: TaskSnapshot, name: string, body: Record<string, unknown> = {}): Promise<TaskSnapshot> {
  const response = await page.request.post(`/api/tasks/${snapshot.task.taskId}/actions/${name}`, { data: { ...body, stepToken: snapshot.step.stepToken } });
  if (!response.ok()) throw new Error(`${name} failed: ${response.status()} ${await response.text()}`);
  return TaskSnapshotSchema.parse(await response.json());
}

// Hotel e-invoice + its 全季 folio on P-2307, confirmed through the API: actions / choose_action.
async function confirmedTask(page: Page): Promise<string> {
  const created = TaskSnapshotSchema.parse(await (await page.request.post('/api/tasks', { data: { homeCity: '杭州' } })).json());
  const taskId = created.task.taskId;
  for (const prefix of ['m01', 'm02']) {
    const sample = SAMPLE_MATERIALS.find((candidate) => candidate.file.startsWith(prefix))!;
    const uploaded = await page.request.post(`/api/tasks/${taskId}/batches`, { multipart: { files: { name: sample.fileName, mimeType: 'application/pdf', buffer: readFileSync(join(GENERATED_DIR, sample.file)) } } });
    expect(uploaded.ok()).toBe(true);
  }
  await act(page, await snapshotOf(page, taskId), 'start-inventory');
  // Waits out inventory and answers the 住宿 trio gap it raises; this test is about 对账 (reconciliation).
  await answerStayGaps(page, taskId);
  expect((await page.request.post('/api/project-book/intake', { data: { number: 'P-2307', name: '华东客户交付' } })).ok()).toBe(true);
  const ready = await snapshotOf(page, taskId);
  const review = await act(page, ready, 'submit-project-assignment', { purpose: '上海产品评审出差', projects: Object.fromEntries(ready.lines.map((line) => [line.lineId, 'P-2307'])) });
  const confirmed = await act(page, review, 'confirm-review', { digest: review.confirmation.digest });
  expect(confirmed).toMatchObject({ stage: 'actions', step: { kind: 'choose_action' } });
  return taskId;
}

test('写入结果不确定：进入对账，只给开始对账与转人工；只读对账后转人工，任务结束', async ({ page }) => {
  await signIn(page);
  const taskId = await confirmedTask(page);
  await page.goto(`/#/task/${taskId}/review`);
  await page.getByRole('button', { name: '去报销', exact: true }).click();
  await expect.poll(async () => (await snapshotOf(page, taskId)).stage).toBe('reconcile');

  await page.goto(`/#/task/${taskId}/reconcile`);
  await expect(page.getByRole('heading', { name: '对账' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('写入结果不确定');
  // ERP's own words, verbatim, and the cropped screenshot.
  await expect(page.getByTestId('erp-text')).toHaveText('保存超时：服务器繁忙，请稍后重试。');
  const shot = page.getByRole('img', { name: '报销系统截图' });
  await expect(shot).toBeVisible();
  expect(await shot.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  const bar = page.getByRole('region', { name: '处置' });
  await expect(bar.getByRole('button')).toHaveText(['开始对账', '转人工']);

  await bar.getByRole('button', { name: '开始对账' }).click();
  await expect(page.getByTestId('reconcile-bucket')).toHaveText('未知');
  await expect(bar.getByRole('button')).toHaveText(['重新对账', '转人工']);

  await bar.getByRole('button', { name: '转人工' }).click();
  await expect(page.getByTestId('reconcile-status')).toHaveText('已转人工');
  await expect(page.getByRole('region', { name: '处置' })).toHaveCount(0);
  await expect(page.getByTestId('reconcile-banner')).toHaveText(HUMAN_REVIEW_NOTICE);

  expect(await snapshotOf(page, taskId)).toMatchObject({ stage: 'reconcile', step: { kind: 'none' }, reconcile: { status: 'handed_off' } });
  const list = TaskListSchema.parse(await (await page.request.get('/api/tasks')).json());
  expect(list.tasks.find((task) => task.taskId === taskId)).toMatchObject({ erpOutcome: 'handed_off', abandonable: false });
  // 转人工 is terminal: the account may start its next task.
  expect((await page.request.post('/api/tasks', { data: { homeCity: '杭州' } })).ok()).toBe(true);
});
