import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR, SAMPLE_MATERIALS } from '@baox/fixtures';
import { TaskSnapshotSchema, type TaskSnapshot } from '@baox/contract';
import type { Page } from '@playwright/test';
import { answerStayGaps, expect, signIn, test } from './fixture';

// Slice 09 (#188) on the real server: with an empty 个人项目簿 the project page opens on the book gate; add a project
// with a manually entered name, assign every line to it and submit the reimbursement purpose (报销事由).

const hotelInvoice = SAMPLE_MATERIALS.find((sample) => sample.file.startsWith('m01'));

async function snapshotOf(page: Page, taskId: string): Promise<TaskSnapshot> {
  return TaskSnapshotSchema.parse(await (await page.request.get(`/api/tasks/${taskId}`)).json());
}

test('添加项目、全部明细归入、填写报销事由并提交', async ({ page }) => {
  if (!hotelInvoice) throw new Error('fixture m01 is missing from @baox/fixtures');
  await signIn(page);
  await page.goto('/#/tasks');
  await page.getByRole('button', { name: '新建报销任务' }).click();
  const dialog = page.getByRole('dialog', { name: '新建报销任务' });
  await dialog.getByLabel('常驻城市').fill('杭州');
  await dialog.getByRole('button', { name: '创建并上传材料' }).click();
  await expect(page).toHaveURL(/#\/task\/[^/]+\/upload$/);
  const taskId = /#\/task\/([^/]+)\//.exec(page.url())?.[1] ?? '';

  await page.locator('input[type=file]').setInputFiles({ name: hotelInvoice.fileName, mimeType: 'application/pdf', buffer: readFileSync(join(GENERATED_DIR, hotelInvoice.file)) });
  await expect(page.getByText(hotelInvoice.fileName, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '开始材料盘点' }).click();
  // #213: the 住宿 invoice comes alone, so inventory asks for its 结账单 and 支付截图 and holds the material at 待确认;
  // answered with 确认没有, after which the material passes and the task goes on to the project book.
  await expect(page.getByRole('group', { name: '盘点摘要' })).toContainText('需处理1 份');
  await answerStayGaps(page, taskId);
  await page.reload();
  await expect(page.getByRole('group', { name: '盘点摘要' })).toContainText('通过1 份');
  await expect.poll(async () => (await snapshotOf(page, taskId)).step.kind).toBe('maintain_project_book');

  // The book gate: add P-2307, then start assigning.
  await page.goto(`/#/task/${taskId}/project`);
  await page.getByLabel('项目号').fill('P-2307');
  await page.getByLabel('项目名称').fill('华东客户交付');
  await page.getByRole('button', { name: '加入项目', exact: true }).click();
  await expect(page.getByTestId('book-message')).toContainText('已加入个人项目簿');
  await expect(page.getByTestId('book-row-P-2307')).toContainText('可选');
  await page.getByRole('button', { name: '项目录完了，开始归属' }).click();

  // Assign every line to P-2307.
  await expect(page.getByRole('heading', { name: '项目归属' })).toBeVisible();
  await expect(page.getByLabel('常驻城市')).toHaveValue('杭州');
  await expect(page.getByRole('button', { name: '确认项目归属' })).toBeDisabled();
  await page.getByRole('checkbox', { name: '全选当前明细' }).locator('xpath=following-sibling::label[1]').click();
  await page.getByRole('complementary', { name: '归入项目' }).getByRole('button', { name: /P-2307/ }).click();
  await expect(page.getByTestId('project-of-1')).toHaveText('P-2307 / 华东客户交付');

  // Submit is refused (disabled) until the purpose is filled.
  await expect(page.getByRole('button', { name: '确认项目归属' })).toBeDisabled();
  await page.getByLabel('报销事由').fill('上海产品评审出差');
  await page.getByRole('button', { name: '确认项目归属' }).click();
  await expect(page).toHaveURL(/#\/task\/[^/]+\/review$/);

  const submitted = await snapshotOf(page, taskId);
  expect(submitted).toMatchObject({ stage: 'review', projectAssignment: { status: 'submitted', purpose: '上海产品评审出差' } });
  expect(submitted.lines.map((line) => [line.projectCode, line.projectName, line.expenseItemCode])).toEqual([['P-2307', '华东客户交付', 'FY010001']]);
});

test('personal project editing can be cancelled and a saved renumber survives reload', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/projects');
  await page.getByLabel('项目号', { exact: true }).fill('EDIT-101');
  await page.getByLabel('项目名称', { exact: true }).fill('原项目名称');
  await page.getByLabel('截止日期', { exact: true }).fill('2026-12-31');
  await page.getByRole('button', { name: '加入项目', exact: true }).click();
  await expect(page.getByTestId('book-row-EDIT-101')).toContainText('原项目名称');
  await expect(page.getByTestId('book-row-EDIT-101')).toContainText('2026-12-31');

  await page.getByRole('button', { name: '编辑 EDIT-101', exact: true }).click();
  const edit = page.getByRole('dialog', { name: /编辑/ });
  await expect(edit.getByLabel('项目号', { exact: true })).toHaveValue('EDIT-101');
  await edit.getByLabel('项目名称', { exact: true }).fill('取消的名称');
  await edit.getByRole('button', { name: '取消', exact: true }).click();
  await expect(edit).toHaveCount(0);
  await expect(page.getByTestId('book-row-EDIT-101')).toContainText('原项目名称');

  await page.getByRole('button', { name: '编辑 EDIT-101', exact: true }).click();
  await expect(edit.getByLabel('项目名称', { exact: true })).toHaveValue('原项目名称');
  await expect(edit.getByLabel('截止日期', { exact: true })).toHaveValue('2026-12-31');
  await edit.getByLabel('项目号', { exact: true }).fill('EDIT-102');
  await edit.getByLabel('项目名称', { exact: true }).fill('修正后的名称');
  await edit.getByLabel('截止日期', { exact: true }).fill('2027-01-31');
  await edit.getByRole('button', { name: '保存', exact: true }).click();
  await expect(edit).toHaveCount(0);
  await expect(page.getByTestId('book-row-EDIT-101')).toHaveCount(0);
  await expect(page.getByTestId('book-row-EDIT-102')).toContainText('修正后的名称');
  await expect(page.getByTestId('book-row-EDIT-102')).toContainText('2027-01-31');
  await page.reload();
  await expect(page.getByTestId('book-row-EDIT-102')).toContainText('修正后的名称');
  await expect(page.getByTestId('book-row-EDIT-102')).toContainText('2027-01-31');

  await page.getByRole('button', { name: '编辑 EDIT-102', exact: true }).click();
  await edit.getByLabel('截止日期', { exact: true }).fill('');
  await edit.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByTestId('book-row-EDIT-102')).toContainText('未设置');
  await page.reload();
  await expect(page.getByTestId('book-row-EDIT-102')).toContainText('未设置');
});
