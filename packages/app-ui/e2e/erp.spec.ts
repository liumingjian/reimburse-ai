import { expect, test, type Page } from '@playwright/test';

// ERP 填报、完成与对账（#106）。mock 每步 300 ms；正常场景下 2.5 s 后服务端自己探测到登录，这里都直接点「我已登录，继续」。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

const STEP_TITLES = ['启动浏览器', '登录', '导入发票', '填明细', '保存', '严格回读'];

const progress = (page: Page) => page.getByRole('region', { name: '填报进度' });
const stepItem = (page: Page, title: string) => progress(page).getByRole('listitem', { name: title, exact: true });
const loginButton = (page: Page) => page.getByRole('button', { name: '我已登录，继续' });
const bodyRows = (page: Page, table: string) => page.getByRole('table', { name: table }).locator('tbody tr');

async function startAndLogin(page: Page, query: string) {
  await page.goto(open(query, '#/task/T1/erp'));
  await expect(progress(page).locator('.step-title')).toHaveText(STEP_TITLES);
  await page.getByRole('button', { name: '开始填报' }).click();
  await expect(stepItem(page, '登录')).toContainText('等待你操作');
  await loginButton(page).click();
}

async function expectDone(page: Page) {
  await expect(page.getByRole('heading', { name: '完成' })).toBeVisible();
  await expect(page.getByTestId('draft-no')).toHaveText('BX20260911-0173');
  await expect(page.getByText('明细 9/9 一致')).toBeVisible();
  await expect(bodyRows(page, '逐条回读')).toHaveCount(9);
  await expect(page.locator('tr.row-err')).toHaveCount(0);
}

test('正常流程：?seed=erp 开始填报，步骤依次推进，登录后写完进入完成页', async ({ page }, testInfo) => {
  await startAndLogin(page, '?seed=erp');
  await expect(page.getByRole('link', { name: '查看完成结果' })).toBeVisible();
  await expect(progress(page).locator('li .status')).toHaveText(STEP_TITLES.map(() => '完成'));
  await page.screenshot({ path: testInfo.outputPath('erp-finished.png'), fullPage: true });
  await page.getByRole('link', { name: '查看完成结果' }).click();
  await expectDone(page);
  await page.screenshot({ path: testInfo.outputPath('done.png'), fullPage: true });
});

test('?seed=done 直接打开完成页', async ({ page }) => {
  await page.goto(open('?seed=done', '#/task/T1/done'));
  await expectDone(page);
});

test('readback-mismatch：严格回读停下，对账页高亮不一致的行，转人工后显示已转人工', async ({ page }, testInfo) => {
  await startAndLogin(page, '?seed=erp&fault=readback-mismatch');
  await expect(stepItem(page, '严格回读')).toContainText('已中止');
  await page.getByRole('link', { name: '进入对账' }).click();
  await expect(page.getByRole('heading', { name: '对账', exact: true })).toBeVisible();
  await expect(page.getByTestId('readback-8')).toHaveClass(/row-err/);
  await expect(page.getByTestId('readback-8')).toContainText('74.00');
  await expect(page.locator('tr.row-err')).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('readback-mismatch.png'), fullPage: true });
  await page.getByRole('button', { name: '转人工' }).click();
  await expect(page.getByText(/已转人工处理：应用不再写入 ERP/)).toBeVisible();
  await expect(page.getByRole('button', { name: '重新对账' })).toHaveCount(0);
  await expect(page.locator('.sidebar')).toContainText('已转人工');
});

test('erp-write-aborted：保存步中止进入对账，重新对账读到草稿并回读一致后完成', async ({ page }, testInfo) => {
  await startAndLogin(page, '?seed=erp&fault=erp-write-aborted');
  await expect(stepItem(page, '保存')).toContainText('已中止');
  await expect(page.getByRole('alert')).toContainText('ERP 填报已停止');
  await page.getByRole('link', { name: '进入对账' }).click();
  await expect(page.getByRole('region', { name: '中止原因' })).toContainText('保存草稿时 ERP 没有在限定时间内返回结果');
  await expect(page.getByRole('region', { name: '当前对账状态' })).toContainText('未知');
  await page.screenshot({ path: testInfo.outputPath('reconcile-aborted.png'), fullPage: true });
  await page.getByRole('button', { name: '重新对账' }).click();
  await expectDone(page);
});

test('erp-write-aborted：转人工后停在对账页，显示已转人工', async ({ page }) => {
  await startAndLogin(page, '?seed=erp&fault=erp-write-aborted');
  await page.getByRole('link', { name: '进入对账' }).click();
  await page.getByRole('button', { name: '转人工' }).click();
  await expect(page.getByTestId('reconcile-status')).toHaveText('已转人工');
  await expect(page.getByText('已转人工处理：应用不再写入 ERP，对账记录已保留。请你在 ERP 中核对这次写入的结果。')).toBeVisible();
});

test('erp-login-missing：点继续后仍未检测到登录，提示保留、可再试；第三次检测到后继续写完', async ({ page }, testInfo) => {
  await startAndLogin(page, '?seed=erp&fault=erp-login-missing');
  await expect(page.getByText(/还没有检测到登录（第 1 次检测）/)).toBeVisible();
  await expect(stepItem(page, '登录')).toContainText('等待你操作');
  await expect(loginButton(page)).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('login-missing.png'), fullPage: true });
  await loginButton(page).click();
  await expect(page.getByText(/还没有检测到登录（第 2 次检测）/)).toBeVisible();
  await loginButton(page).click();
  await expect(page.getByRole('link', { name: '查看完成结果' })).toBeVisible();
});

test('对账页直接打开：T2 五行（1264.00）与两种处置；?seed=reconcile 打开 T1 的中止对账', async ({ page }) => {
  await page.goto(open('', '#/task/T2/reconcile'));
  await expect(bodyRows(page, '逐行比对')).toHaveCount(5);
  await expect(page.getByTestId('readback-3')).toHaveClass(/row-err/);
  await expect(page.getByTestId('readback-local-total')).toHaveText('1264.00');
  await expect(page.getByRole('button', { name: '重新对账' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '转人工' })).toBeEnabled();
  await page.getByRole('button', { name: '重新对账' }).click();
  await expect(page.getByText(/已重新对账（第 1 次）/)).toBeVisible();

  await page.goto(open('?seed=reconcile', '#/task/T1/reconcile'));
  await expect(page.getByRole('region', { name: '中止原因' })).toBeVisible();
});
