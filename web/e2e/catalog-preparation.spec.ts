import { expect, test, type Page } from '@playwright/test';

// 报销信息核对与材料准备（内核 catalog_unverified / catalog_mismatch / preparation_package_pending / preparation_blocked），
// as the server does them: the catalog is checked inside the ERP job (去报销), so submitting the project assignment goes
// straight to the review, and a catalog mismatch sends the task back to project assignment from the ERP job. The
// preparation has no problems or package files to show.
// 直接用 file:// 打开 mock 构建产物（pnpm build:mock）。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

const CATALOG_RUNNING = '正在核对报销系统中的项目和费用项目，确认它们可以用于本次报销。';
const PREPARATION_RUNNING = '材料已经整理完成，正在生成本次报销的核对材料。';

const confirmButton = (page: Page) => page.getByRole('region', { name: '整单确认' }).getByRole('button', { name: '确认整单明细', exact: true });

async function reassign(page: Page, nos: readonly number[], project: string) {
  for (const no of nos) await page.getByRole('checkbox', { name: `选择明细 No.${no}` }).locator('xpath=following-sibling::label[1]').click();
  await page.getByRole('complementary', { name: '归入项目' }).getByRole('button', { name: new RegExp(project.split(' ')[0]!) }).click();
  await page.getByRole('dialog', { name: `${nos.length} 条明细已有其他项目归属，请确认是否覆盖` }).getByRole('button', { name: '确认覆盖' }).click();
  await page.getByRole('button', { name: '确认项目归属' }).click();
}

test('正常路径：提交项目归属后直接进入整单确认，没有核对与材料准备的等待，确认立即可用', async ({ page }, testInfo) => {
  await page.goto(open('?seed=actions', '#/task/T1/project'));
  await expect(page.getByRole('heading', { name: '项目归属' })).toBeVisible();
  await reassign(page, [9], 'P-1180 内部培训');
  await expect(page).toHaveURL(/#\/task\/T1\/review$/);
  await expect(confirmButton(page)).toBeEnabled();
  await expect(page.getByText(CATALOG_RUNNING)).toHaveCount(0);
  await expect(page.getByText(PREPARATION_RUNNING)).toHaveCount(0);
  await expect(page.getByTestId('confirm-row-9').locator('td').nth(2)).toHaveText('P-1180 / 内部培训');
  await page.screenshot({ path: testInfo.outputPath('review-after-submit.png'), fullPage: true });
});

test('?fault=catalog-mismatch：去报销时报销信息核对发现项目查不到，导入之前停下，回到项目归属；改派后重新提交回到整单确认', async ({ page }, testInfo) => {
  await page.goto(open('?seed=actions&fault=catalog-mismatch', '#/task/T1/review'));
  await page.getByRole('button', { name: '去报销', exact: true }).click();
  // The job stops at its catalog step; the ERP page closes and points back to the task's current stage.
  await page.getByRole('link', { name: '回到当前阶段' }).click();
  await expect(page).toHaveURL(/#\/task\/T1\/project$/);
  await expect(page.getByRole('alert').filter({ hasText: '项目 P-2307「华东客户交付」在报销系统里查不到' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('catalog-mismatch.png'), fullPage: true });

  await reassign(page, [7, 8, 9], 'P-1180 内部培训');
  await expect(page).toHaveURL(/#\/task\/T1\/review$/);
  await expect(confirmButton(page)).toBeEnabled();
  await expect(page.getByRole('table', { name: '不匹配项' })).toHaveCount(0);
  await expect(page.getByTestId('confirm-row-9').locator('td').nth(2)).toHaveText('P-1180 / 内部培训');
  await confirmButton(page).click();
  await expect(page.getByRole('link', { name: '去打印', exact: true })).toBeVisible();
});

test('材料准备：服务端不给准备缺项，也不给材料包文件清单；整单确认页没有这两节，确认可用', async ({ page }, testInfo) => {
  await page.goto(open('?seed=review', '#/task/T1/review'));
  await expect(page.getByRole('heading', { name: '整单明细确认' })).toBeVisible();
  await expect(page.getByRole('table', { name: '准备缺项' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '材料包' })).toHaveCount(0);
  await expect(page.getByTestId('package-files')).toHaveCount(0);
  await expect(confirmButton(page)).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('review-no-package.png'), fullPage: true });
});
