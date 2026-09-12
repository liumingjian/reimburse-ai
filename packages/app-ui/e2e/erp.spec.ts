import { expect, test, type Page } from '@playwright/test';

// 写入报销系统、完成与对账。「去报销」即开始写入，没有「开始填报」：?seed=erp 是浏览器已启动、登录步等待的状态。
// mock 每步 300 ms；正常场景下 2.5 s 后服务端自己探测到登录，这里都直接点「我已登录，继续」。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

const STEP_TITLES = ['启动浏览器', '登录', '打开空白报销单', '选择不生成费用明细', '导入发票', '收票回读', '填写明细', '保存草稿', '严格回读'];
const SAVE_COMPLETED = '报销草稿已保存。请打开报销系统检查，是否提交由你决定。';
const HUMAN_REVIEW = '当前报销已暂停，材料和状态已保留。请在报销系统中核对；如无法判断，请联系报销管理员。';

const progress = (page: Page) => page.getByRole('region', { name: '填报进度' });
const stepItem = (page: Page, title: string) => progress(page).getByRole('listitem', { name: title, exact: true });
const loginButton = (page: Page) => page.getByRole('button', { name: '我已登录，继续' });
const bodyRows = (page: Page, table: string) => page.getByRole('table', { name: table }).locator('tbody tr');

async function startAndLogin(page: Page, query: string) {
  await page.goto(open(query, '#/task/T1/erp'));
  await expect(progress(page).locator('.step-title')).toHaveText(STEP_TITLES);
  await expect(page.getByRole('button', { name: '开始填报' })).toHaveCount(0);
  await expect(stepItem(page, '登录')).toContainText('等待你操作');
  await loginButton(page).click();
}

async function expectDone(page: Page) {
  await expect(page.getByRole('heading', { name: '完成' })).toBeVisible();
  await expect(page.getByTestId('draft-no')).toHaveText('BX20260911-0173');
  await expect(page.getByText('明细 9/9 一致')).toBeVisible();
  await expect(page.getByTestId('save-completed')).toHaveText(SAVE_COMPLETED);
  await expect(bodyRows(page, '逐条回读')).toHaveCount(9);
  await expect(page.locator('tr.row-err')).toHaveCount(0);
}

test('正常流程：?seed=erp 等待登录，点「我已登录，继续」后九步自动写完进入完成页', async ({ page }, testInfo) => {
  await startAndLogin(page, '?seed=erp');
  await expect(page.getByRole('link', { name: '查看完成结果' })).toBeVisible();
  await expect(progress(page).locator('li .status')).toHaveText(STEP_TITLES.map(() => '完成'));
  await page.screenshot({ path: testInfo.outputPath('erp-finished.png'), fullPage: true });
  await page.getByRole('link', { name: '查看完成结果' }).click();
  await expectDone(page);
  await page.screenshot({ path: testInfo.outputPath('done.png'), fullPage: true });
});

test('去报销：在整单确认页点去报销，浏览器启动后等待登录，登录后自动写完', async ({ page }) => {
  await page.goto(open('?seed=actions', '#/task/T1/review'));
  await page.getByRole('button', { name: '去报销', exact: true }).click();
  await expect(page).toHaveURL(/#\/task\/T1\/erp$/);
  await expect(page.getByRole('heading', { name: '保存报销草稿' })).toBeVisible();
  await expect(page.getByRole('button', { name: '开始填报' })).toHaveCount(0);
  await expect(stepItem(page, '登录')).toContainText('等待你操作');
  await loginButton(page).click();
  await expect(page.getByRole('link', { name: '查看完成结果' })).toBeVisible();
  await page.getByRole('link', { name: '查看完成结果' }).click();
  await expectDone(page);
});

test('?seed=done 直接打开完成页：固定句逐字一致', async ({ page }) => {
  await page.goto(open('?seed=done', '#/task/T1/done'));
  await expectDone(page);
});

test('readback-mismatch：严格回读停下后自动进入完成页，差异行高亮、没有完成态；No.6 展开后显示对不上的字段与原因；转人工后显示已转人工', async ({ page }, testInfo) => {
  await startAndLogin(page, '?seed=erp&fault=readback-mismatch');
  await expect(page).toHaveURL(/#\/task\/T1\/done$/);
  await expect(page.getByRole('heading', { name: '完成', exact: true })).toBeVisible();
  await expect(page.getByTestId('draft-no')).toHaveText('BX20260911-0173');
  await expect(bodyRows(page, '逐条回读')).toHaveCount(9);
  await expect(page.getByTestId('readback-6')).toHaveClass(/row-err/);
  await expect(page.getByTestId('readback-6')).toContainText('74.00');
  await expect(page.locator('tr.row-err')).toHaveCount(1);
  await expect(page.getByText('明细 9/9 一致')).toHaveCount(0);
  await expect(page.getByTestId('save-completed')).toHaveCount(0);
  await expect(page.getByTestId('human-review')).toHaveText(HUMAN_REVIEW);
  await expect(page.getByRole('alert').filter({ hasText: '这份草稿不算完成' })).toBeVisible();

  await page.getByRole('button', { name: '展开 No.6' }).click();
  const detail = page.getByTestId('readback-detail-6');
  await expect(detail.getByRole('list', { name: 'No.6 对不上的字段' })).toHaveText('申请报销金额 本地 47.00 / 报销系统 74.00');
  await expect(detail.getByRole('list', { name: 'No.6 原因' })).toContainText('任务第 6 行没有一条同时匹配项目、费用项目、日期、金额和收票关联的报销系统明细');
  await page.screenshot({ path: testInfo.outputPath('readback-mismatch.png'), fullPage: true });

  await page.getByRole('button', { name: '转人工' }).click();
  await expect(page.getByText(/已转人工处理：应用不再写入报销系统/)).toBeVisible();
  await expect(page.getByRole('button', { name: '转人工' })).toHaveCount(0);
  await page.getByRole('link', { name: '返回任务列表' }).click();
  await expect(page.getByRole('row', { name: /2026-08 上海出差（产品评审）/ }).getByText('已转人工')).toBeVisible();
});

test('erp-write-aborted：保存步中止后自动进入对账（未知 ⇒ 原地等待，只有重新对账），重新对账读到草稿并回读一致后完成', async ({ page }, testInfo) => {
  await startAndLogin(page, '?seed=erp&fault=erp-write-aborted');
  await expect(page).toHaveURL(/#\/task\/T1\/reconcile$/);
  await expect(page.getByRole('region', { name: '中止原因' })).toContainText('保存草稿时报销系统没有在限定时间内返回结果');
  await expect(page.getByTestId('reconcile-bucket')).toHaveText('未知');
  await expect(page.getByRole('region', { name: '处置' }).getByRole('button')).toHaveText(['重新对账']);
  await expect(page.getByTestId('human-review')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('reconcile-aborted.png'), fullPage: true });
  await page.getByRole('button', { name: '重新对账' }).click();
  await expectDone(page);
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

test('对账页直接打开：T2（已保存、逐行不一致 ⇒ 转人工）显示固定句且没有重新对账；?seed=reconcile 打开 T1 的中止对账，保存报销草稿页保留进入对账入口', async ({ page }) => {
  await page.goto(open('', '#/task/T2/reconcile'));
  await expect(bodyRows(page, '逐行比对')).toHaveCount(5);
  await expect(page.getByTestId('readback-3')).toHaveClass(/row-err/);
  await expect(page.getByTestId('readback-local-total')).toHaveText('1264.00');
  await expect(page.getByTestId('human-review')).toHaveText(HUMAN_REVIEW);
  await expect(page.getByRole('button', { name: '重新对账' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '处置' }).getByRole('button')).toHaveText(['转人工']);

  await page.goto(open('?seed=reconcile', '#/task/T1/reconcile'));
  await expect(page.getByRole('region', { name: '中止原因' })).toBeVisible();
  await expect(page.getByRole('button', { name: '转人工' })).toHaveCount(0);

  await page.goto(open('?seed=reconcile', '#/task/T1/erp'));
  await expect(stepItem(page, '保存草稿')).toContainText('已中止');
  await page.getByRole('link', { name: '进入对账' }).click();
  await expect(page.getByRole('heading', { name: '对账', exact: true })).toBeVisible();
});
