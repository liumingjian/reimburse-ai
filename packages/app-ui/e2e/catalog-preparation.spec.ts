import { expect, test, type Page } from '@playwright/test';

// 报销信息核对与材料包缺项（内核 catalog_unverified / catalog_mismatch / preparation_package_pending / preparation_blocked）。
// 直接用 file:// 打开 mock 构建产物（pnpm build:mock）。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

const CATALOG_RUNNING = '正在核对报销系统中的项目和费用项目，确认它们可以用于本次报销。';
const PREPARATION_RUNNING = '材料已经整理完成，正在生成本次报销的核对材料。';

const confirmButton = (page: Page) => page.getByRole('region', { name: '整单确认' }).getByRole('button', { name: '确认整单明细', exact: true });
const packageFiles = (page: Page) => page.getByRole('list', { name: '材料包文件' }).getByRole('listitem');

// 材料包清单默认收起；收起时点开（重新准备后可能重新挂载成收起状态）。
async function openPackage(page: Page) {
  const details = page.getByRole('region', { name: '材料包' }).locator('details');
  if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await page.getByRole('region', { name: '材料包' }).getByText(/^材料包 \d+ 份文件$/).click();
  }
  await expect(page.getByRole('list', { name: '材料包文件' })).toBeVisible();
}

async function reassign(page: Page, nos: readonly number[], project: string) {
  for (const no of nos) await page.getByRole('checkbox', { name: `选择明细 No.${no}` }).locator('xpath=following-sibling::label[1]').click();
  await page.getByRole('complementary', { name: '项目工作台' }).getByRole('button', { name: `归入 ${project}` }).click();
  await page.getByRole('dialog', { name: `${nos.length} 条明细已有其他项目归属，请确认是否覆盖` }).getByRole('button', { name: '确认覆盖' }).click();
  await page.getByRole('button', { name: '确认项目归属' }).click();
}

test('正常路径：提交项目归属后自动经过报销信息核对与材料准备，进入整单确认，确认页有材料包文件清单', async ({ page }, testInfo) => {
  await page.goto(open('?seed=actions', '#/task/T1/project'));
  await expect(page.getByRole('heading', { name: '项目归属' })).toBeVisible();
  await reassign(page, [9], 'P-1180 内部培训');
  await expect(page).toHaveURL(/#\/task\/T1\/review$/);
  await expect(page.getByText(CATALOG_RUNNING)).toBeVisible();
  await expect(page.getByText(PREPARATION_RUNNING)).toBeVisible();
  await expect(confirmButton(page)).toBeEnabled();
  await expect(page.getByTestId('package-files')).toHaveText('核对材料已生成，共 13 份文件。');
  await openPackage(page);
  await expect(packageFiles(page)).toHaveCount(13);
  await expect(packageFiles(page).first()).toHaveText('发票 invoices/全季酒店_发票.pdf');
  await expect(packageFiles(page).last()).toHaveText('材料清单 manifest.json');
  await page.screenshot({ path: testInfo.outputPath('review-package-files.png'), fullPage: true });
});

test('?catalog=mismatch：显示不匹配表并阻塞确认；回到项目归属改派后重新核对通过', async ({ page }, testInfo) => {
  await page.goto(open('?seed=catalog&catalog=mismatch', '#/task/T1/review'));
  const mismatch = page.getByRole('table', { name: '不匹配项' });
  await expect(mismatch).toBeVisible();
  await expect(mismatch.locator('thead th')).toHaveText(['序号', '材料/明细', '参考材料', '待处理问题', '处理人']);
  await expect(mismatch.locator('tbody tr td')).toHaveText(['1', '项目号 P-2307', '', '项目 P-2307「华东客户交付」在报销系统里已被禁用，不能引用', '要你处理']);
  await expect(confirmButton(page)).toBeDisabled();
  await expect(page.getByTestId('package-files')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('catalog-mismatch.png'), fullPage: true });

  await page.getByRole('link', { name: '回到项目归属改派' }).click();
  await expect(page).toHaveURL(/#\/task\/T1\/project$/);
  await expect(page.getByRole('alert').filter({ hasText: 'P-2307' })).toBeVisible();
  await reassign(page, [7, 8, 9], 'P-1180 内部培训');

  await expect(page).toHaveURL(/#\/task\/T1\/review$/);
  await expect(confirmButton(page)).toBeEnabled();
  await expect(mismatch).toHaveCount(0);
  await expect(page.getByTestId('confirm-row-9').locator('td').nth(2)).toHaveText('P-1180 / 内部培训');
  await confirmButton(page).click();
  await expect(page.getByRole('link', { name: '去打印', exact: true })).toBeVisible();
});

test('?preparation=blocked：显示缺项表，确认按钮不可用；排除相关材料后恢复可用', async ({ page }, testInfo) => {
  await page.goto(open('?seed=preparation&preparation=blocked', '#/task/T1/review'));
  const problems = page.getByRole('table', { name: '准备缺项' });
  await expect(problems).toBeVisible();
  await expect(problems.locator('thead th')).toHaveText(['序号', '准备缺项', '关联材料/明细', '处理人']);
  const cells = problems.locator('tbody tr td');
  await expect(cells.nth(1)).toContainText('明细 No.4 的出发点与行程单不一致');
  await expect(cells.nth(2)).toHaveText('曹操出行_行程单.pdf');
  await expect(cells.nth(3)).toHaveText('要你处理');
  await expect(confirmButton(page)).toBeDisabled();
  await expect(page.getByTestId('package-files')).toHaveText('核对材料已生成，共 13 份文件。');
  await page.screenshot({ path: testInfo.outputPath('preparation-blocked.png'), fullPage: true });

  await page.getByRole('button', { name: '排除 曹操出行_行程单.pdf' }).click();
  await expect(confirmButton(page)).toBeEnabled();
  await expect(problems).toHaveCount(0);
  await expect(page.getByTestId('package-files')).toHaveText('核对材料已生成，共 12 份文件。');
  await openPackage(page);
  await expect(packageFiles(page)).toHaveCount(12);
  await expect(packageFiles(page).filter({ hasText: '曹操出行_行程单.pdf' })).toHaveCount(0);
});
