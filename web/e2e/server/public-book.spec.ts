import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR, SAMPLE_MATERIALS } from '@baox/fixtures';
import { ProjectBookSchema, TaskSnapshotSchema, type TaskSnapshot } from '@baox/contract';
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
  await book.getByLabel('项目名称').fill(number === 'P-2307' ? '华东客户交付' : '产品调研');
  await book.getByRole('button', { name: '加入项目', exact: true }).click();
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
  const book = page.getByRole('region', { name: '公共项目簿', exact: true }).filter({ has: page.getByLabel('项目名称', { exact: true }) });
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
  await page.getByTestId('book-row-P-2307').getByRole('button', { name: '停用项目 P-2307' }).click();
  await expect(book.getByTestId('book-message')).toContainText('已停用，不能用于新的项目归属');
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
  expect((await page.request.post('/api/public-project-book/intake', { data: { number: 'P-2307', name: '华东客户交付' } })).status()).toBe(403);
});

test('public projects are read-only for members and retain lifecycle changes after reload', async ({ page, browser, serverApp }) => {
  await signIn(page, 'admin');
  const memberContext = await browser.newContext({ baseURL: serverApp.url });
  const member = await memberContext.newPage();
  await signIn(member, '成员');
  await page.goto('/#/admin');
  const publicBook = page.getByRole('region', { name: '公共项目簿', exact: true }).filter({ has: page.getByLabel('项目名称', { exact: true }) });
  await intakePublic(publicBook, 'OFFLINE-101');

  await member.goto('/#/projects');
  const readOnly = member.getByRole('table', { name: '公共项目簿' });
  await expect(readOnly.getByTestId('book-row-OFFLINE-101')).toContainText('产品调研');
  await expect(readOnly.getByRole('button')).toHaveCount(0);
  await page.getByTestId('book-row-OFFLINE-101').getByRole('button', { name: '停用项目 OFFLINE-101' }).click();
  await expect(publicBook.getByTestId('book-row-OFFLINE-101')).toContainText('已停用');
  await member.reload();
  await expect(readOnly.getByTestId('book-row-OFFLINE-101')).toContainText('已停用');

  await page.reload();
  await page.getByTestId('book-row-OFFLINE-101').getByRole('button', { name: '恢复项目 OFFLINE-101' }).click();
  await expect(publicBook.getByTestId('book-row-OFFLINE-101')).toContainText('可选');
  await member.reload();
  await expect(readOnly.getByTestId('book-row-OFFLINE-101')).toContainText('可选');
  await memberContext.close();
});

test('public conversion is explicit, cancellable, and shared across personal owners', async ({ page, browser, serverApp }) => {
  await signIn(page, 'admin');
  const firstContext = await browser.newContext({ baseURL: serverApp.url });
  const secondContext = await browser.newContext({ baseURL: serverApp.url });
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  await signIn(first, '成员甲');
  await signIn(second, '成员乙');
  for (const member of [first, second]) {
    const result = await member.request.post('/api/project-book/intake', { data: { number: 'CONVERT-101', name: '个人维护名称' } });
    expect(result.ok()).toBe(true);
  }
  const ownBook = async (member: Page) => ProjectBookSchema.parse(await (await member.request.get('/api/project-book')).json());
  await page.goto('/#/admin');
  const publicBook = page.getByRole('region', { name: '公共项目簿', exact: true }).filter({ has: page.getByLabel('项目名称', { exact: true }) });
  await publicBook.getByLabel('项目号', { exact: true }).fill('CONVERT-101');
  await publicBook.getByLabel('项目名称', { exact: true }).fill('公共维护名称');
  await publicBook.getByRole('button', { name: '加入项目', exact: true }).click();
  const conversion = page.getByRole('dialog');
  await expect(conversion).toContainText('CONVERT-101');
  await expect(publicBook.getByTestId('book-row-CONVERT-101')).toHaveCount(0);
  expect((await ownBook(first)).projects[0]?.selectable).toBe(true);
  await conversion.getByRole('button', { name: '取消', exact: true }).click();
  await expect(conversion).toHaveCount(0);
  expect((await ownBook(second)).projects[0]?.selectable).toBe(true);
  await expect(publicBook.getByLabel('项目名称', { exact: true })).toHaveValue('公共维护名称');

  await publicBook.getByRole('button', { name: '加入项目', exact: true }).click();
  await expect(conversion).toBeVisible();
  await conversion.getByRole('button', { name: /确认/ }).click();
  await expect(publicBook.getByTestId('book-row-CONVERT-101')).toContainText('公共维护名称');
  for (const member of [first, second]) {
    expect((await ownBook(member)).projects.some((project) => project.number === 'CONVERT-101' && project.selectable)).toBe(false);
    await member.goto('/#/projects');
    await expect(member.getByRole('table', { name: '公共项目簿' }).getByTestId('book-row-CONVERT-101')).toContainText('公共维护名称');
  }
  await firstContext.close();
  await secondContext.close();
});

test('renumber conversion preserves an inactive public project and edit values after cancellation', async ({ page, browser, serverApp }) => {
  await signIn(page, 'admin');
  const memberContext = await browser.newContext({ baseURL: serverApp.url });
  const member = await memberContext.newPage();
  await signIn(member, '成员');
  await member.request.post('/api/project-book/intake', { data: { number: 'RENUMBER-TARGET', name: '个人项目' } });
  await page.request.post('/api/public-project-book/intake', { data: { number: 'PUBLIC-OLD', name: '原公共名称' } });
  await page.request.post('/api/public-project-book/deactivate', { data: { number: 'PUBLIC-OLD' } });
  await page.goto('/#/admin');
  await page.getByRole('button', { name: '编辑 PUBLIC-OLD', exact: true }).click();
  const edit = page.getByRole('dialog', { name: '编辑项目', exact: true });
  await edit.getByLabel('项目号', { exact: true }).fill('RENUMBER-TARGET');
  await edit.getByLabel('项目名称', { exact: true }).fill('修正公共名称');
  await edit.getByRole('button', { name: '保存', exact: true }).click();
  const conversion = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: /确认/ }) });
  await expect(conversion).toContainText('RENUMBER-TARGET');
  await conversion.getByRole('button', { name: '取消', exact: true }).click();
  await expect(edit.getByLabel('项目号', { exact: true })).toHaveValue('RENUMBER-TARGET');
  await expect(edit.getByLabel('项目名称', { exact: true })).toHaveValue('修正公共名称');
  const prior = ProjectBookSchema.parse(await (await page.request.get('/api/public-project-book')).json());
  expect(prior.projects).toEqual([expect.objectContaining({ number: 'PUBLIC-OLD', name: '原公共名称', active: false })]);
  await edit.getByRole('button', { name: '保存', exact: true }).click();
  await conversion.getByRole('button', { name: /确认/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('book-row-PUBLIC-OLD')).toHaveCount(0);
  await expect(page.getByTestId('book-row-RENUMBER-TARGET')).toContainText('已停用');
  await page.reload();
  await expect(page.getByTestId('book-row-RENUMBER-TARGET')).toContainText('修正公共名称');
  const personal = ProjectBookSchema.parse(await (await member.request.get('/api/project-book')).json());
  expect(personal.projects.some((project) => project.number === 'RENUMBER-TARGET' && project.selectable)).toBe(false);
  await memberContext.close();
});
