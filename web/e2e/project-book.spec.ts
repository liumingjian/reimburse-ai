import { expect, test, type Page } from '@playwright/test';

// 个人项目簿（#112）：全局页面 #/projects，录入经 mock 报销系统核验、删除、清理失效、复检全部；
// 以及项目归属的项目簿门（?book=empty）与登录会话缺失时的拒绝。直接用 file:// 打开 mock 构建产物。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

const h1 = (page: Page, name: string) => page.getByRole('heading', { name, level: 1 });
const book = (page: Page) => page.getByRole('table', { name: '个人项目簿' });
const row = (page: Page, number: string) => page.getByTestId(`book-row-${number}`);
const message = (page: Page) => page.getByTestId('book-message');

async function intake(page: Page, number: string) {
  await page.getByLabel('项目号').fill(number);
  await page.getByRole('button', { name: '核验并加入' }).click();
}

test('录入：可核验的项目号加入列表，名称来自核验结果；查不到与非法字符显示内核的拒绝文案', async ({ page }, testInfo) => {
  await page.goto(open('', '#/projects'));
  await expect(h1(page, '个人项目簿')).toBeVisible();
  await expect(book(page).getByRole('columnheader')).toHaveText(['项目号', '名称', '过期时间', '状态', '']);
  await expect(book(page).locator('tbody tr')).toHaveCount(6);
  await expect(row(page, 'P-4420')).toContainText('已过期');
  // 录入按钮与输入框同高，示例占位符提示格式。
  const input = page.getByLabel('项目号');
  await expect(input).toHaveAttribute('placeholder', '如：P-2307');
  const inputBox = await input.boundingBox();
  const buttonBox = await page.getByRole('button', { name: '核验并加入' }).boundingBox();
  expect(inputBox && buttonBox && Math.round(buttonBox.height)).toBe(inputBox && Math.round(inputBox.height));
  expect(inputBox && buttonBox && Math.round(buttonBox.y + buttonBox.height)).toBe(inputBox && Math.round(inputBox.y + inputBox.height));

  await intake(page, 'P-5108');
  await expect(message(page)).toHaveText('项目 P-5108「苏州门店巡检」已加入个人项目簿，名称取自报销系统回读值；没有设置过期时间');
  await expect(row(page, 'P-5108')).toContainText('苏州门店巡检');
  await expect(row(page, 'P-5108')).toContainText('永不过期');
  await expect(row(page, 'P-5108')).toContainText('可选');

  await intake(page, 'P-0000');
  await expect(message(page)).toHaveText('项目号 P-0000 在报销系统项目目录里查不到，没有加入个人项目簿；请核对后重新录入');
  await intake(page, 'P-12;');
  await expect(message(page)).toHaveText('项目号 "P-12;" 含有不能安全查询的字符，没有加入个人项目簿');
  await expect(book(page).locator('tbody tr')).toHaveCount(7);
  await page.screenshot({ path: testInfo.outputPath('project-book.png'), fullPage: true });
});

test('复检全部、删除、清理全部失效：结果文案照内核', async ({ page }) => {
  await page.goto(open('', '#/projects'));
  await page.getByRole('button', { name: '复检全部' }).click();
  await expect(message(page)).toHaveText('复检了 6 条项目，其中 2 条当前不可选；复检不会自动删除项目');
  await page.getByRole('button', { name: '删除 P-1180' }).click();
  await expect(message(page)).toHaveText('项目 P-1180「内部培训」已从个人项目簿删除；已选任务中的历史归属不受影响');
  await expect(row(page, 'P-1180')).toHaveCount(0);
  await page.getByRole('button', { name: '清理全部失效' }).click();
  await expect(message(page)).toHaveText('已清理 2 条失效项目；合法历史任务中的项目归属不受影响');
  await expect(book(page).locator('tbody tr')).toHaveCount(3);
  await page.getByRole('button', { name: '清理全部失效' }).click();
  await expect(message(page)).toHaveText('当前没有失效项目，一条都没删');
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
  await expect(page.getByRole('complementary', { name: '项目工作台' })).toHaveCount(0);
  await intake(page, 'P-6021');
  await expect(row(page, 'P-6021')).toContainText('年度预算评审');
  await expect(h1(page, '先维护个人项目簿')).toBeVisible();

  await continueButton.click();
  await expect(h1(page, '项目归属')).toBeVisible();
  await expect(page).toHaveURL(/#\/task\/T1\/project$/);
  await page.getByLabel('报销事由').fill('上海产品评审出差');
  await page.getByRole('checkbox', { name: '全选当前明细' }).locator('xpath=following-sibling::label[1]').click();
  await page.getByRole('region', { name: '批量操作' }).getByRole('button', { name: '归入项目' }).click();
  const picker = page.getByRole('dialog', { name: '归入项目' });
  await expect(picker.getByRole('radio', { name: /P-6021/ })).toHaveCount(1);
  await picker.getByRole('radio', { name: /P-5108/ }).locator('xpath=following-sibling::label[1]').click();
  await picker.getByRole('button', { name: '确认归入' }).click();
  await expect(page.getByTestId('project-of-1')).toHaveText('P-5108 / 苏州门店巡检');
  await expect(page.getByTestId('assign-summary')).toHaveText('已归属9 / 9 条整单合计3972.59 元');
  await page.getByRole('button', { name: '确认项目归属' }).click();
  await expect(page).toHaveURL(/#\/task\/T1\/review$/);
});

test('入口：顶栏常驻「个人项目簿」；项目归属页「归入项目」弹层里点「新增项目」就地录入，勾选的明细保持勾选，新项目可选', async ({ page }) => {
  await page.goto(open('?seed=project', '#/task/T1/project'));
  await expect(h1(page, '项目归属')).toBeVisible();
  await expect(page.getByRole('navigation', { name: '全局' }).getByRole('link', { name: '个人项目簿' })).toHaveAttribute('href', '#/projects');
  await page.getByRole('checkbox', { name: '选择明细 No.3' }).locator('xpath=following-sibling::label[1]').click();
  await page.getByRole('checkbox', { name: '选择明细 No.4' }).locator('xpath=following-sibling::label[1]').click();
  await page.getByRole('region', { name: '批量操作' }).getByRole('button', { name: '归入项目' }).click();
  const picker = page.getByRole('dialog', { name: '归入项目' });
  await expect(picker.getByRole('radio', { name: /P-6021/ })).toHaveCount(0);
  await picker.getByRole('button', { name: '新增项目' }).click();
  const dialog = page.getByRole('dialog', { name: '新增项目' });
  await expect(dialog.getByLabel('项目号')).toBeFocused();
  await intake(page, 'P-6021');
  await expect(dialog.getByTestId('book-row-P-6021')).toContainText('年度预算评审');
  await dialog.getByRole('button', { name: '完成' }).click();
  await expect(dialog).toHaveCount(0);
  // 关掉面板回到项目弹层：新项目可选，勾选的明细还在。
  await expect(picker.getByText('已选 2 条明细')).toBeVisible();
  await picker.getByRole('radio', { name: /P-6021/ }).locator('xpath=following-sibling::label[1]').click();
  await picker.getByRole('button', { name: '确认归入' }).click();
  await expect(picker).toHaveCount(0);
  await expect(page.getByTestId('project-of-3')).toHaveText('P-6021 / 年度预算评审');
  await expect(page.getByTestId('project-of-4')).toHaveText('P-6021 / 年度预算评审');
});
