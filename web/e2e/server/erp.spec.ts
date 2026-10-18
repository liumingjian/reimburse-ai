import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR, SAMPLE_MATERIALS } from '@baox/fixtures';
import { DRAFT_HANDOVER_NOTICE, TaskListSchema, TaskSnapshotSchema, type TaskSnapshot } from '@baox/contract';
import type { Page } from '@playwright/test';
import { answerStayGaps, expect, signIn, test } from './fixture';

// Slice 12 (#191) on the real server: 去报销's one ending and the two ways it stops before it writes anything.
//   - drafted: the production ending (ADR-0037). The job 暂存s the bill and finds it again: ERP 草稿已交接.
//   - not_signed_in: ERP sits on its login page and the job has no 凭据 to sign in with. Nothing waits for the
//     employee: the job stops with no attempt, the task is back where it was, and it can go again.
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

test.describe('去报销暂存到报销系统', () => {
  test.use({ serverEnv: { BAOX_ERP_FAKE: 'drafted' } });

  test('去报销：一路自动写完并暂存，ERP 草稿已交接；完成页给出去报销系统查看与内码，任务列表是已交接', async ({ page }) => {
    await signIn(page);
    const taskId = await confirmedTask(page);
    await page.goto(`/#/task/${taskId}/review`);
    await page.getByRole('button', { name: '去报销', exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`#/task/${taskId}/erp$`));
    // Nothing on the way waits for the employee (ADR-0037): no login to confirm, no 去报销 to cancel.
    await expect(page.getByRole('link', { name: '查看完成结果' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: '我已登录，继续' })).toHaveCount(0);
    await expect(page.getByTestId('handover-completed')).toHaveText(DRAFT_HANDOVER_NOTICE);
    await expect(page.getByRole('link', { name: '去报销系统查看' })).toBeVisible();
    await expect(page.getByTestId('erp-review-draft-id')).toHaveText('119946');
    expect(await snapshotOf(page, taskId)).toMatchObject({
      stage: 'done',
      step: { kind: 'none' },
      erp: { status: 'done', outcome: 'drafted', draftNo: null, review: { draftId: '119946' } },
      readback: { status: 'matched' },
    });
    const list = TaskListSchema.parse(await (await page.request.get('/api/tasks')).json());
    expect(list.tasks.find((task) => task.taskId === taskId)).toMatchObject({ stage: 'done', erpTouched: true });
  });
});

test.describe('ERP 还停在登录页，又没有可用来登录的账号', () => {
  test.use({ serverEnv: { BAOX_ERP_FAKE: 'not_signed_in' } });

  test('去报销：写入之前就停下，什么都没有写；说出原因，回到确认页还能再去报销', async ({ page }) => {
    await signIn(page);
    const taskId = await confirmedTask(page);
    await page.goto(`/#/task/${taskId}/review`);
    await page.getByRole('button', { name: '去报销', exact: true }).click();

    await expect.poll(async () => (await snapshotOf(page, taskId)).stage, { timeout: 30_000 }).toBe('actions');
    const stopped = await snapshotOf(page, taskId);
    expect(stopped).toMatchObject({ step: { kind: 'choose_action' }, erp: { status: 'idle', outcome: 'none' }, confirmation: { status: 'confirmed' } });
    expect(stopped.erp.abortReason).toContain('设置页保存报销系统账号和密码');
    // Nothing was written, so the invoices are still free and the task can still be voided.
    const list = TaskListSchema.parse(await (await page.request.get('/api/tasks')).json());
    expect(list.tasks.find((task) => task.taskId === taskId)).toMatchObject({ abandonable: true });

    await page.goto(`/#/task/${taskId}/review`);
    await expect(page.getByTestId('erp-abort-reason')).toContainText('设置页保存报销系统账号和密码');
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
