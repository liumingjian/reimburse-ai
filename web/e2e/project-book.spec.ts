import { expect, test, type Page } from '@playwright/test';

// Offline personal project book (个人项目簿) journeys in the mock build, including the assignment gate and inline intake.
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

const h1 = (page: Page, name: string) => page.getByRole('heading', { name, level: 1 });
const book = (page: Page) => page.getByRole('table', { name: '个人项目簿' });
const row = (page: Page, number: string) => page.getByTestId(`book-row-${number}`);
const message = (page: Page) => page.getByTestId('book-message');

async function intake(page: Page, number: string, name = number === 'P-6021' ? '年度预算评审' : '苏州门店巡检') {
  await page.getByLabel('项目号', { exact: true }).fill(number);
  await page.getByLabel('项目名称', { exact: true }).fill(name);
  await page.getByRole('button', { name: '加入项目', exact: true }).click();
}

test('offline intake preserves names and retains input on duplicate or unsafe numbers', async ({ page }, testInfo) => {
  await page.goto(open('', '#/projects'));
  await expect(h1(page, '个人项目簿')).toBeVisible();
  await expect(book(page).getByRole('columnheader')).toHaveText(['项目号', '名称', '截止日期', '状态', '']);
  await intake(page, 'LOCAL-5108', '本地维护项目');
  await expect(row(page, 'LOCAL-5108')).toContainText('本地维护项目');
  await expect(row(page, 'LOCAL-5108')).toContainText('可选');
  await intake(page, 'LOCAL-5108', '重复名称');
  await expect(message(page)).toContainText('已');
  await expect(page.getByLabel('项目号', { exact: true })).toHaveValue('LOCAL-5108');
  await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue('重复名称');
  await expect(row(page, 'LOCAL-5108')).toContainText('本地维护项目');
  await intake(page, 'P-12;', '不安全项目');
  await expect(message(page)).toContainText('不能安全');
  await expect(row(page, 'P-12;')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('project-book.png'), fullPage: true });
});

test('?book=empty：从待确认项走到项目归属时被引导进维护入口，录完两个项目再点开始归属，两个项目都可选', async ({ page }, testInfo) => {
  await page.goto(open('?seed=pending&book=empty', '#/task/T1/pending'));
  const detail = page.getByLabel('待确认项详情');
  await detail.getByLabel('起点 *').fill('张江高科');
  await detail.getByLabel('终点 *').fill('漕河泾开发区');
  await detail.getByRole('button', { name: '保存并标记已处理' }).click();
  await expect(detail.getByRole('heading', { name: '下车时间不合法，并补填起点与终点' })).toBeVisible();
  await detail.getByLabel('下车时间 *').fill('19:06');
  await detail.getByLabel('起点 *').fill('静安寺');
  await detail.getByLabel('终点 *').fill('虹桥枢纽');
  await detail.getByRole('button', { name: '保存并标记已处理' }).click();
  await detail.getByRole('button', { name: '排除此材料' }).click();
  await detail.getByRole('button', { name: '确认没有支付截图' }).click();
  await page.getByRole('link', { name: '进入项目归属' }).click();

  await expect(h1(page, '先维护个人项目簿')).toBeVisible();
  await expect(page.getByText('当前项目簿为空，请录入第一个项目。')).toBeVisible();
  await expect(page.getByRole('button', { name: '确认项目归属' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('project-book-gate.png'), fullPage: true });

  const continueButton = page.getByRole('button', { name: '项目录完了，开始归属' });
  await expect(continueButton).toBeDisabled();
  await expect(page.getByText('至少录入一个可用项目后才能开始归属')).toBeVisible();

  await intake(page, 'P-5108');
  await expect(row(page, 'P-5108')).toContainText('苏州门店巡检');
  await expect(continueButton).toBeEnabled();
  // 录入一个后仍留在维护门：报销材料可能归属不同项目。
  await expect(h1(page, '先维护个人项目簿')).toBeVisible();
  await expect(page.getByRole('complementary', { name: '归入项目' })).toHaveCount(0);
  await intake(page, 'P-6021');
  await expect(row(page, 'P-6021')).toContainText('年度预算评审');
  await expect(h1(page, '先维护个人项目簿')).toBeVisible();

  await continueButton.click();
  await expect(h1(page, '项目归属')).toBeVisible();
  await expect(page).toHaveURL(/#\/task\/T1\/project$/);
  await page.getByLabel('报销事由').fill('上海产品评审出差');
  await page.getByRole('checkbox', { name: '全选当前明细' }).locator('xpath=following-sibling::label[1]').click();
  const panel = page.getByRole('complementary', { name: '归入项目' });
  await expect(panel.getByRole('button', { name: /P-6021/ })).toHaveCount(1);
  await panel.getByRole('button', { name: /P-5108/ }).click();
  await expect(page.getByTestId('project-of-1')).toHaveText('P-5108 / 苏州门店巡检');
  await expect(page.getByTestId('assign-summary')).toHaveText('已归属9 / 9 条整单合计3972.59 元');
  await page.getByRole('button', { name: '确认项目归属' }).click();
  await expect(page).toHaveURL(/#\/task\/T1\/review$/);
});

test('入口：顶栏常驻「项目簿」；项目归属页「归入项目」面板里点「新增项目」就地录入，勾选的明细保持勾选，新项目可直接归入', async ({ page }) => {
  await page.goto(open('?seed=project', '#/task/T1/project'));
  await expect(h1(page, '项目归属')).toBeVisible();
  await expect(page.getByRole('navigation', { name: '全局' }).getByRole('link', { name: '项目簿' })).toHaveAttribute('href', '#/projects');
  await page.getByRole('checkbox', { name: '选择明细 No.3' }).locator('xpath=following-sibling::label[1]').click();
  await page.getByRole('checkbox', { name: '选择明细 No.4' }).locator('xpath=following-sibling::label[1]').click();
  const panel = page.getByRole('complementary', { name: '归入项目' });
  await expect(panel.getByRole('button', { name: /P-6021/ })).toHaveCount(0);
  await panel.getByRole('button', { name: '新增项目' }).click();
  const dialog = page.getByRole('dialog', { name: '新增项目' });
  await expect(dialog.getByLabel('项目号')).toBeFocused();
  await intake(page, 'P-6021');
  await expect(dialog.getByTestId('book-row-P-6021')).toContainText('年度预算评审');
  await dialog.getByRole('button', { name: '完成' }).click();
  await expect(dialog).toHaveCount(0);
  // 关掉弹层：新项目出现在面板里，勾选的明细还在。
  await expect(page.getByTestId('assign-selection')).toHaveText('已选 2 条，点右侧项目归入');
  await expect(panel.getByText('已选 2 条', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: /P-6021/ }).click();
  await expect(page.getByTestId('project-of-3')).toHaveText('P-6021 / 年度预算评审');
  await expect(page.getByTestId('project-of-4')).toHaveText('P-6021 / 年度预算评审');
});
