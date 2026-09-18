import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR, SAMPLE_MATERIALS } from '@baox/fixtures';
import { TaskSnapshotSchema, type TaskSnapshot } from '@baox/contract';
import type { Locator, Page } from '@playwright/test';
import { answerStayGaps, expect, signIn, test } from './fixture';

// Slice 14b (#194) on the real server: the admin adds a 公共项目簿 (public project book) entry on the 管理 page; a user
// assigns a line to it; the admin deactivates it before the user submits, which forces a re-select; the submission
// pins the public source.

const hotelInvoice = SAMPLE_MATERIALS.find((sample) => sample.file.startsWith('m01'));

async function snapshotOf(page: Page, taskId: string): Promise<TaskSnapshot> {
  return TaskSnapshotSchema.parse(await (await page.request.get(`/api/tasks/${taskId}`)).json());
}

async function assignAllTo(page: Page, number: string) {
  await page.getByRole('checkbox', { name: '全选当前明细' }).locator('xpath=following-sibling::label[1]').click();
  const target = page.getByRole('complementary', { name: '归入项目' }).getByRole('button', { name: new RegExp(number) });
  await expect(target).toContainText('公共');
  await target.click();
}

async function intakePublic(book: Locator, number: string) {
  await book.getByLabel('项目号').fill(number);
  await book.getByRole('button', { name: '核验并加入' }).click();
  await expect(book.getByTestId(`book-row-${number}`)).toContainText('可选');
}

test('管理员添加公共项目，用户把明细归入它；提交前停用迫使重新选择，提交钉住公共来源', async ({ page, browser, serverApp }) => {
  if (!hotelInvoice) throw new Error('fixture m01 is missing from @baox/fixtures');
  await signIn(page, 'admin');
  const userContext = await browser.newContext({ baseURL: serverApp.url });
  const user = await userContext.newPage();
  await signIn(user, '张三');

  // The admin adds P-2307 to the public book on the 管理 page.
  await page.goto('/#/admin');
  await expect(page.getByRole('heading', { name: '管理', level: 1 })).toBeVisible();
  await expect(page.getByTestId('account-row-张三')).toContainText('用户');
  const book = page.getByRole('region', { name: '公共项目簿' });
  await intakePublic(book, 'P-2307');
  await expect(book.getByTestId('book-message')).toContainText('已加入公共项目簿');
  // A second public project stays selectable after the deactivation below.
  await intakePublic(book, 'P-3312');

  // The user (no personal project at all) goes straight to assignment and picks the public project.
  await user.goto('/#/tasks');
  await expect(user.getByRole('banner')).not.toContainText('管理');
  await user.getByRole('button', { name: '新建报销任务' }).click();
  const dialog = user.getByRole('dialog', { name: '新建报销任务' });
  await dialog.getByLabel('常驻城市').fill('杭州');
  await dialog.getByRole('button', { name: '创建并上传材料' }).click();
  await expect(user).toHaveURL(/#\/task\/[^/]+\/upload$/);
  const taskId = /#\/task\/([^/]+)\//.exec(user.url())?.[1] ?? '';
  await user.locator('input[type=file]').setInputFiles({ name: hotelInvoice.fileName, mimeType: 'application/pdf', buffer: readFileSync(join(GENERATED_DIR, hotelInvoice.file)) });
  await expect(user.getByText(hotelInvoice.fileName, { exact: true })).toBeVisible();
  await user.getByRole('button', { name: '开始材料盘点' }).click();
  // #213: the 住宿 invoice comes alone, so inventory asks for its 结账单 and 支付截图; answered with 确认没有, since this
  // test is about the public project book.
  await answerStayGaps(user, taskId);
  await expect.poll(async () => (await snapshotOf(user, taskId)).step.kind).toBe('assign_projects');
  await user.goto(`/#/task/${taskId}/project`);
  await expect(user.getByRole('heading', { name: '项目归属' })).toBeVisible();
  await assignAllTo(user, 'P-2307');
  await expect(user.getByTestId('project-of-1')).toHaveText('P-2307 / 华东客户交付');

  // The admin deactivates it before the user submits: the user's page drops the line back to 未归属 and says why.
  await book.getByRole('button', { name: '停用 P-2307' }).click();
  await expect(book.getByTestId('book-message')).toContainText('已在公共项目簿停用');
  await expect(book.getByTestId('book-row-P-2307')).toContainText('已停用');
  await expect(user.getByTestId('project-reselect')).toContainText('原项目 P-2307 华东客户交付');
  await expect(user.getByTestId('project-of-1')).toContainText('未归属');
  await user.getByLabel('报销事由').fill('上海产品评审出差');
  await expect(user.getByRole('button', { name: '确认项目归属' })).toBeDisabled();

  // Re-select: the user assigns the line to P-3312 and submits.
  await assignAllTo(user, 'P-3312');
  await expect(user.getByTestId('project-reselect')).toHaveCount(0);
  await user.getByRole('button', { name: '确认项目归属' }).click();
  await expect(user).toHaveURL(/#\/task\/[^/]+\/review$/);

  const submitted = await snapshotOf(user, taskId);
  expect(submitted.projectAssignment).toMatchObject({ status: 'submitted', reselect: [] });
  expect(submitted.projectAssignment.assignments.map((a) => [a.projectNumber, a.projectSource])).toEqual([['P-3312', 'public']]);
  await userContext.close();
});

test('非管理员打不开管理页，也改不了公共项目簿', async ({ page }) => {
  await signIn(page, 'admin');
  await page.request.post('/api/auth/logout');
  await signIn(page, '张三');
  await page.goto('/#/admin');
  await expect(page.getByText('只有管理员可以打开这个页面。')).toBeVisible();
  expect((await page.request.post('/api/public-project-book/intake', { data: { number: 'P-2307' } })).status()).toBe(403);
});
