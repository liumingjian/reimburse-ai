import { expect, test, type Page } from '@playwright/test';
import { DRAFT_HANDOVER_NOTICE } from '@baox/contract';

// The ERP mock plays the 本地执行器 (ADR-0037): 去报销 signs in by itself and ends 暂存'd; there is no separate start
// action and nothing waits for the employee to log in. Each simulated stage takes 300 ms. `?seed=erp` is a job that is
// running, held by the mock at 报销信息核对.
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

const STEP_TITLES = ['启动后台浏览器', '登录', '报销信息核对', '打开空白报销单', '导入发票', '收票回读', '填写明细', '暂存到报销系统'];
const HUMAN_REVIEW = '当前报销已暂停，材料和状态已保留。请在报销系统中核对；如无法判断，请联系报销管理员。';

const progress = (page: Page) => page.getByRole('region', { name: '填报进度' });
const stepItem = (page: Page, title: string) => progress(page).getByRole('listitem', { name: title, exact: true });
const loginButton = (page: Page) => page.getByRole('button', { name: '我已登录，继续' });
const bodyRows = (page: Page, table: string) => page.getByRole('table', { name: table }).locator('tbody tr');

// 去报销 from the confirmed T1, `fault` choosing how the job ends.
async function startErp(page: Page, fault: string | null = null) {
  await page.goto(open(`?seed=actions${fault ? `&fault=${fault}` : ''}`, '#/task/T1/review'));
  await page.getByRole('button', { name: '去报销', exact: true }).click();
}

async function expectDone(page: Page, notice: string = DRAFT_HANDOVER_NOTICE) {
  await expect(page.getByRole('heading', { name: '完成' })).toBeVisible();
  await expect(page.getByTestId('draft-no')).toHaveText('尚无');
  await expect(page.getByText('明细 9/9 一致')).toBeVisible();
  await expect(page.getByTestId('handover-completed')).toHaveText(notice);
  await expect(bodyRows(page, '逐条回读')).toHaveCount(9);
  await expect(page.getByRole('row').filter({ hasText: '不一致' })).toHaveCount(0);
}

for (const [width, height] of [
  [1440, 900],
  [1100, 800],
] as const) {
  test(`${width}px：未开始步骤的标题比说明醒目，编号在圆里；在等什么是步骤清单之前的通知`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await page.goto(open('?seed=erp', '#/task/T1/erp'));
    await expect(stepItem(page, '报销信息核对')).toContainText('进行中');
    const todo = stepItem(page, '导入发票');
    const [titleColor, descColor] = await Promise.all([
      todo.locator('.step-title').evaluate((element) => getComputedStyle(element).color),
      todo.locator('.desc').evaluate((element) => getComputedStyle(element).color),
    ]);
    // Gray 10：标题 text-secondary #525252，说明 helper #6f6f6f。
    expect(titleColor).toBe('rgb(82, 82, 82)');
    expect(descColor).toBe('rgb(111, 111, 111)');

    const num = await todo.getByText('5', { exact: true }).boundingBox();
    const icon = await stepItem(page, '启动后台浏览器').locator('svg').first().boundingBox();
    if (!num || !icon) throw new Error('量不到编号或图标');
    expect(Math.abs(num.width - icon.width)).toBeLessThan(1);
    expect(Math.abs(num.height - icon.height)).toBeLessThan(1);

    const notice = page.getByRole('status').filter({ hasText: '正在等待报销系统返回结果。' });
    await expect(notice).toBeVisible();
    const noticeBox = await notice.boundingBox();
    const headBox = await page.getByRole('heading', { name: '填写报销单', level: 1 }).boundingBox();
    const listBox = await progress(page).boundingBox();
    if (!noticeBox || !headBox || !listBox) throw new Error('量不到位置');
    expect(noticeBox.y).toBeGreaterThan(headBox.y + headBox.height);
    expect(noticeBox.y + noticeBox.height).toBeLessThanOrEqual(listBox.y);
    await page.screenshot({ path: testInfo.outputPath(`erp-steps-${width}.png`), fullPage: true });
  });
}

test('正常流程：去报销后八个事实阶段自己完成，没有要你登录的一步，进入完成页', async ({ page }, testInfo) => {
  await startErp(page);
  await expect(progress(page).locator('.step-title')).toHaveText(STEP_TITLES);
  await expect(page.getByRole('button', { name: '开始填报' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '查看完成结果' })).toBeVisible();
  await expect(loginButton(page)).toHaveCount(0);
  await expect(progress(page).locator('li .status')).toHaveText(STEP_TITLES.map(() => '完成'));
  await page.screenshot({ path: testInfo.outputPath('erp-finished.png'), fullPage: true });
  await page.getByRole('link', { name: '查看完成结果' }).click();
  await expectDone(page);
  await page.screenshot({ path: testInfo.outputPath('done.png'), fullPage: true });
});

// 步骤文案 (#423, ADR-0037): the 本地执行器's list, no login wait, and the run ends 暂存'd.
test('去报销：在整单确认页点去报销，启动后台浏览器起步，暂存到报销系统收尾，完成页可去报销系统查看暂存单', async ({ page }) => {
  await page.goto(open('?seed=actions', '#/task/T1/review'));
  await page.getByRole('button', { name: '去报销', exact: true }).click();
  await expect(page).toHaveURL(/#\/task\/T1\/erp$/);
  await expect(progress(page).locator('.step-title')).toHaveText(STEP_TITLES);
  await expect(stepItem(page, '启动后台浏览器')).toContainText('在你的电脑上启动一个看不见的浏览器，专门用于这次报销。');
  await expect(stepItem(page, '登录')).toContainText('用你在设置页保存的报销系统账号登录。');
  await expect(stepItem(page, '暂存到报销系统')).toContainText('你检查后自己提交');
  await expect(page.getByTestId('erp-progress-percent')).toHaveText('100%');
  await expect(page.getByTestId('erp-progress-label')).toHaveText('核对暂存单');
  await expect(progress(page).locator('li .status')).toHaveText(STEP_TITLES.map(() => '完成'));
  await expect(loginButton(page)).toHaveCount(0);
  await page.getByRole('link', { name: '查看完成结果' }).click();
  await expect(page.getByTestId('handover-completed')).toHaveText('已暂存到报销系统，请打开检查，确认无误后由你自己提交。');
  await expect(page.getByRole('link', { name: '去报销系统查看' })).toBeVisible();
});

test('?seed=done 直接打开完成页：固定句逐字一致', async ({ page }) => {
  await page.goto(open('?seed=done', '#/task/T1/done'));
  await expectDone(page);
});

// 严格回读停下：结果不确定，先停在对账等第一次对账（服务端同此）。对账读到已保存但逐行不一致的草稿，仍停在对账，
// 不是完成：done 只留给「已保存且逐行一致」（服务端同此）。
test('readback-mismatch：严格回读停下后自动进入对账页；开始对账后差异行高亮、只能转人工；No.6 展开后显示对不上的字段与原因；转人工后任务列表显示已转人工', async ({ page }, testInfo) => {
  await startErp(page, 'readback-mismatch');
  await expect(page).toHaveURL(/#\/task\/T1\/reconcile$/);
  await expect(page.getByRole('heading', { name: '对账', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '中止原因' })).toContainText('合计 3999.59 与任务合计 3972.59 不一致');
  await expect(page.getByTestId('reconcile-bucket')).toHaveText('尚未判定');
  await expect(page.getByRole('region', { name: '处置' }).getByRole('button')).toHaveText(['开始对账', '转人工']);
  await page.getByRole('button', { name: '开始对账' }).click();
  await expect(page.getByTestId('reconcile-draft-no')).toHaveText('BX20260911-0173');
  await expect(page.getByTestId('reconcile-bucket')).toHaveText('已保存');
  await expect(bodyRows(page, '逐行比对')).toHaveCount(9);
  await expect(page.getByTestId('readback-6')).toContainText('不一致');
  await expect(page.getByTestId('readback-6')).toContainText('74.00');
  await expect(page.getByRole('row').filter({ hasText: '不一致' })).toHaveCount(1);
  await expect(page.getByTestId('human-review')).toHaveText(HUMAN_REVIEW);
  await expect(page.getByRole('region', { name: '处置' }).getByRole('button')).toHaveText(['转人工']);

  await page.getByRole('button', { name: '展开 No.6' }).click();
  const detail = page.getByTestId('readback-detail-6');
  await expect(detail.getByRole('list', { name: 'No.6 对不上的字段' })).toHaveText('申请报销金额 本地 47.00 / 报销系统 74.00');
  await expect(detail.getByRole('list', { name: 'No.6 原因' })).toContainText('任务第 6 行没有一条同时匹配项目、费用项目、日期、金额和收票关联的报销系统明细');
  await page.screenshot({ path: testInfo.outputPath('readback-mismatch.png'), fullPage: true });

  await page.getByRole('button', { name: '转人工' }).click();
  await expect(page.getByText(/已转人工处理：应用不再写入报销系统/)).toBeVisible();
  await expect(page.getByRole('button', { name: '转人工' })).toHaveCount(0);
  await page.getByRole('link', { name: '报销任务' }).click();
  await expect(page.getByRole('row', { name: /2026-08 上海出差（产品评审）/ }).getByText('已转人工')).toBeVisible();
});

test('erp-write-aborted：交接时没有读到结果后自动进入对账（还没对过账：开始对账或转人工）；读到填好没保存的单据也不算完成，仍停在对账', async ({ page }, testInfo) => {
  await startErp(page, 'erp-write-aborted');
  await expect(page).toHaveURL(/#\/task\/T1\/reconcile$/);
  await expect(page.getByRole('region', { name: '中止原因' })).toContainText('保存后没有读到报销系统的结果');
  await expect(page.getByTestId('reconcile-bucket')).toHaveText('尚未判定');
  // 还没对过账：先对账，也可以直接转人工（与服务端一致）。
  await expect(page.getByRole('region', { name: '处置' }).getByRole('button')).toHaveText(['开始对账', '转人工']);
  await expect(page.getByTestId('human-review')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('reconcile-aborted.png'), fullPage: true });
  await page.getByRole('button', { name: '开始对账' }).click();
  // 没有暂存就没有交接（ADR-0037）：对账之后仍在对账页。
  await expect(page.getByText(/已重新对账（第 1 次）/)).toBeVisible();
  await expect(page).toHaveURL(/#\/task\/T1\/reconcile$/);
});

test('对账页 T2：1440 与 1100 下「转人工」都在首屏内，顶部只有一条错误通知；附截图', async ({ page }, testInfo) => {
  for (const [width, height] of [[1440, 900], [1100, 700]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(open('', '#/task/T2/reconcile'));
    const handOff = page.getByRole('region', { name: '处置' }).getByRole('button', { name: '转人工' });
    await expect(handOff).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(1);
    const box = await handOff.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(height);
    await page.screenshot({ path: testInfo.outputPath(`reconcile-t2-${width}.png`) });
  }
});

test('对账页直接打开：T2（已保存、逐行不一致 ⇒ 转人工）显示固定句且没有重新对账；?seed=reconcile 打开 T1 的中止对账，填写报销单页保留进入对账入口', async ({ page }) => {
  await page.goto(open('', '#/task/T2/reconcile'));
  await expect(bodyRows(page, '逐行比对')).toHaveCount(5);
  await expect(page.getByTestId('readback-3')).toContainText('不一致');
  await expect(page.getByTestId('readback-local-total')).toHaveText('1264.00');
  await expect(page.getByTestId('human-review')).toHaveText(HUMAN_REVIEW);
  await expect(page.getByRole('button', { name: '重新对账' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '处置' }).getByRole('button')).toHaveText(['转人工']);

  await page.goto(open('?seed=reconcile', '#/task/T1/reconcile'));
  await expect(page.getByRole('region', { name: '中止原因' })).toBeVisible();
  // 还没对过账：先对账，也能直接转人工。
  await expect(page.getByRole('region', { name: '处置' }).getByRole('button')).toHaveText(['开始对账', '转人工']);

  await page.goto(open('?seed=reconcile', '#/task/T1/erp'));
  await expect(stepItem(page, '暂存到报销系统')).toContainText('已中止');
  await page.getByRole('link', { name: '进入对账' }).click();
  await expect(page.getByRole('heading', { name: '对账', exact: true })).toBeVisible();
});
