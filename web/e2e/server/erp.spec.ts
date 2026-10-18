import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR, SAMPLE_MATERIALS } from '@baox/fixtures';
import { TaskListSchema, TaskSnapshotSchema, type TaskSnapshot } from '@baox/contract';
import type { Page } from '@playwright/test';
import { answerStayGaps, expect, signIn, test } from './fixture';

// Slice 12 (#191) on the real server: the two ways 去报销 stops before it writes anything. Both were covered only
// against the mock, so nothing checked that the real server projects them the same way.
//   - login_wall: ERP sits on its login page. The job pauses with no attempt; 取消去报销 puts the task back where it
//     was, and it can go again.
//   - catalog_mismatch: 报销信息核对 finds a renamed project and aborts before importing. The task goes back to
//     project assignment, and a new submission clears it.
// `test.use` is per file, so each fake gets its own describe block.

const PROJECTS = ['P-2307', 'P-3312'];

async function snapshotOf(page: Page, taskId: string): Promise<TaskSnapshot> {
  return TaskSnapshotSchema.parse(await (await page.request.get(`/api/tasks/${taskId}`)).json());
}

async function act(page: Page, snapshot: TaskSnapshot, name: string, body: Record<string, unknown> = {}): Promise<TaskSnapshot> {
  const response = await page.request.post(`/api/tasks/${snapshot.task.taskId}/actions/${name}`, { data: { ...body, stepToken: snapshot.step.stepToken } });
  if (!response.ok()) throw new Error(`${name} failed: ${response.status()} ${await response.text()}`);
  return TaskSnapshotSchema.parse(await response.json());
}

// Hotel e-invoice + its 全季 folio, confirmed on the first project: actions / choose_action.
async function confirmedTask(page: Page): Promise<string> {
  const created = TaskSnapshotSchema.parse(await (await page.request.post('/api/tasks', { data: { homeCity: '杭州' } })).json());
  const taskId = created.task.taskId;
  for (const prefix of ['m01', 'm02']) {
    const sample = SAMPLE_MATERIALS.find((candidate) => candidate.file.startsWith(prefix))!;
    const uploaded = await page.request.post(`/api/tasks/${taskId}/batches`, { multipart: { files: { name: sample.fileName, mimeType: 'application/pdf', buffer: readFileSync(join(GENERATED_DIR, sample.file)) } } });
    expect(uploaded.ok()).toBe(true);
  }
  await act(page, await snapshotOf(page, taskId), 'start-inventory');
  // Waits out inventory and answers the 住宿 trio gap it raises (no 支付截图 here); this test is about the ERP stage.
  await answerStayGaps(page, taskId);
  for (const number of PROJECTS) expect((await page.request.post('/api/project-book/intake', { data: { number, name: number === 'P-2307' ? '华东客户交付' : '产品调研' } })).ok()).toBe(true);
  const ready = await snapshotOf(page, taskId);
  const review = await act(page, ready, 'submit-project-assignment', { purpose: '上海产品评审出差', projects: Object.fromEntries(ready.lines.map((line) => [line.lineId, PROJECTS[0]])) });
  const confirmed = await act(page, review, 'confirm-review', { digest: review.confirmation.digest });
  expect(confirmed).toMatchObject({ stage: 'actions', step: { kind: 'choose_action' } });
  return taskId;
}

test('浏览器扩展不可用时，设置页返回原报销任务并保留选择', async ({ page }) => {
  await signIn(page);
  const taskId = await confirmedTask(page);
  const before = await snapshotOf(page, taskId);
  let starts = 0;
  await page.route(`**/api/tasks/${taskId}/actions/start-erp-write`, async (route) => {
    starts += 1;
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'extension_not_paired', message: '还没有配对浏览器扩展，所以现在去报销不了。' } }) });
  });

  await page.goto(`/#/task/${taskId}/review`);
  await page.getByRole('button', { name: '去报销', exact: true }).click();

  const returnTo = `#/task/${taskId}/review`;
  await expect(page).toHaveURL(new RegExp(`/#/settings\\?returnTo=${encodeURIComponent(returnTo)}$`));
  await page.getByRole('link', { name: '返回报销任务' }).click();

  await expect(page).toHaveURL(new RegExp(`/#/task/${taskId}/review\\?extensionSetup=1$`));
  await expect(page.getByRole('region', { name: '扩展连接检查' })).toContainText('扩展尚未连接');
  await expect(page.getByRole('link', { name: '设置浏览器扩展' })).toBeVisible();
  await expect(page.getByTestId('review-purpose')).toContainText(before.projectAssignment.purpose ?? '');

  const after = await snapshotOf(page, taskId);
  expect(after.projectAssignment).toEqual(before.projectAssignment);
  expect(after.confirmation).toEqual(before.confirmation);
  expect(after.erp).toEqual(before.erp);
  expect(starts).toBe(1);
});

test.describe('ERP 还停在登录页', () => {
  test.use({ serverEnv: { BAOX_ERP_FAKE: 'login_wall' } });

  test('去报销：停在登录等待，没有写入任何东西；取消后回到确认页，还能再去报销', async ({ page }) => {
    await signIn(page);
    const taskId = await confirmedTask(page);
    await page.goto(`/#/task/${taskId}/review`);
    await page.getByRole('button', { name: '去报销', exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`#/task/${taskId}/erp$`));
    await expect(page.getByRole('heading', { name: '填写报销单' })).toBeVisible();
    await expect.poll(async () => (await snapshotOf(page, taskId)).step.kind).toBe('erp_login');
    const paused = await snapshotOf(page, taskId);
    expect(paused).toMatchObject({
      stage: 'erp',
      erp: {
        status: 'waiting_login',
        currentStage: 'login',
        externalWait: 'employee_login',
        outcome: 'none',
        allowedActions: ['refresh', 'confirm_login', 'cancel'],
      },
    });
    // The active ERP lease keeps cancellation unavailable while the employee login is pending.
    const list = TaskListSchema.parse(await (await page.request.get('/api/tasks')).json());
    expect(list.tasks.find((task) => task.taskId === taskId)).toMatchObject({ abandonable: false });

    await page.getByRole('button', { name: '取消去报销' }).click();
    await expect(page).toHaveURL(new RegExp(`#/task/${taskId}/review$`));
    expect(await snapshotOf(page, taskId)).toMatchObject({ stage: 'actions', step: { kind: 'choose_action' }, erp: { status: 'idle' }, confirmation: { status: 'confirmed' } });
    const afterCancel = TaskListSchema.parse(await (await page.request.get('/api/tasks')).json());
    expect(afterCancel.tasks.find((task) => task.taskId === taskId)).toMatchObject({ abandonable: true });
    // 去报销 is on offer again, because nothing about the claim changed.
    await expect(page.getByRole('button', { name: '去报销', exact: true })).toBeEnabled();
  });
});

test.describe('报销信息核对发现项目对不上', () => {
  test.use({ serverEnv: { BAOX_ERP_FAKE: 'catalog_mismatch' } });

  test('去报销：导入之前就停下，回到项目归属；改派并重新提交后回到整单确认', async ({ page }) => {
    await signIn(page);
    const taskId = await confirmedTask(page);
    await page.goto(`/#/task/${taskId}/review`);
    await page.getByRole('button', { name: '去报销', exact: true }).click();

    // The job aborts before importing, so the task goes back to project assignment with the problem shown.
    await expect.poll(async () => (await snapshotOf(page, taskId)).stage, { timeout: 30_000 }).toBe('project');
    const mismatch = await snapshotOf(page, taskId);
    expect(mismatch).toMatchObject({ step: { kind: 'assign_projects' }, erp: { status: 'idle' }, catalog: { status: 'mismatch' } });
    expect(mismatch.catalog.problems[0]).toMatchObject({ subject: `项目号 ${PROJECTS[0]}`, resolver: '要你处理' });
    // Nothing was imported, so the invoices are still free and the task can still be voided.
    const list = TaskListSchema.parse(await (await page.request.get('/api/tasks')).json());
    expect(list.tasks.find((task) => task.taskId === taskId)).toMatchObject({ abandonable: true });

    await page.goto(`/#/task/${taskId}/project`);
    // The page carries several alerts; name the one this test is about.
    await expect(page.getByRole('alert').filter({ hasText: '报销信息核对发现项目不匹配' })).toBeVisible();

    // Reassigning to the other project and submitting again leaves the mismatch behind.
    const resubmitted = await act(page, mismatch, 'submit-project-assignment', {
      purpose: '上海产品评审出差',
      projects: Object.fromEntries(mismatch.lines.map((line) => [line.lineId, PROJECTS[1]])),
    });
    expect(resubmitted).toMatchObject({ stage: 'review', step: { kind: 'confirm_review' }, catalog: { status: 'pending' } });
  });
});
