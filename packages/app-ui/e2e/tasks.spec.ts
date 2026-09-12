import { expect, test } from '@playwright/test';

// 直接用 file:// 打开 mock 构建产物（先运行 pnpm build:mock）。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;

const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

test('任务列表显示三个任务及其阶段徽标', async ({ page }, testInfo) => {
  await page.goto(open('', '#/tasks'));
  await expect(page.getByRole('heading', { name: '报销任务' })).toBeVisible();

  const t1 = page.getByRole('row', { name: /2026-08 上海出差（产品评审）/ });
  await expect(t1.getByText('上传材料')).toBeVisible();
  await expect(t1.getByText('未确认')).toBeVisible();

  const t2 = page.getByRole('row', { name: /2026-07 深圳客户拜访/ });
  await expect(t2.getByText('对账中')).toBeVisible();
  await expect(t2.getByText('BX20260718-0142')).toBeVisible();

  const t3 = page.getByRole('row', { name: /2026-06 北京培训/ });
  await expect(t3.getByText('已完成')).toBeVisible();
  await expect(t3.getByText('2318.50')).toBeVisible();

  await expect(page.getByText('林颂宜 · 产品研发部')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('tasks.png'), fullPage: true });
});

test('?seed=done 让 T1 显示为已完成并带草稿号', async ({ page }) => {
  await page.goto(open('?seed=done', '#/tasks'));
  const t1 = page.getByRole('row', { name: /2026-08 上海出差（产品评审）/ });
  await expect(t1.getByText('已完成')).toBeVisible();
  await expect(t1.getByText('3972.59')).toBeVisible();
  await expect(t1.getByText('BX20260911-0173')).toBeVisible();
});

test('点「继续」进入任务页面骨架，侧栏列出流程阶段', async ({ page }) => {
  await page.goto(open('', '#/tasks'));
  await page.getByRole('link', { name: '继续 →' }).click();
  await expect(page).toHaveURL(/#\/task\/T1\/upload$/);
  await expect(page.getByRole('heading', { name: '上传材料' })).toBeVisible();
  // 顺序照 Skill：项目归属在整单明细确认之前。
  await expect(page.getByRole('list', { name: '流程阶段' }).getByRole('listitem')).toHaveText([
    /上传材料/,
    /材料盘点/,
    /待确认项/,
    /项目归属/,
    /整单明细确认/,
    /去打印 \/ 去报销/,
    /完成/,
  ]);
});

test('未知路径回到任务列表', async ({ page }) => {
  await page.goto(open('', '#/nowhere'));
  await expect(page).toHaveURL(/#\/tasks$/);
  await expect(page.getByRole('heading', { name: '报销任务' })).toBeVisible();
});

test('页面里没有 undefined、NaN 或长破折号', async ({ page }) => {
  for (const hash of ['#/tasks', '#/tasks/new', '#/task/T1/upload', '#/task/T2/reconcile', '#/task/T3/done']) {
    await page.goto(open('', hash));
    await expect(page.getByRole('heading').first()).toBeVisible();
    const text = await page.locator('body').innerText();
    // 最后两个是 em-dash U+2014 与 en-dash U+2013。
    for (const forbidden of ['undefined', 'NaN', '[object', String.fromCharCode(0x2014), String.fromCharCode(0x2013)]) {
      expect(text, `${hash} 含 ${forbidden}`).not.toContain(forbidden);
    }
  }
});

test('service-disconnected：任务列表页显示全页横幅并自动重试，恢复后横幅消失、列表出现', async ({ page }, testInfo) => {
  await page.goto(open('?fault=service-disconnected', '#/tasks'));
  const banner = page.getByRole('alert').filter({ hasText: '本地服务未运行，请在终端重新执行 baox' });
  const t1 = page.getByRole('row', { name: /2026-08 上海出差（产品评审）/ });
  await expect(banner).toBeVisible();
  await expect(t1).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('tasks-disconnected.png'), fullPage: true });
  await expect(t1).toBeVisible({ timeout: 10_000 });
  await expect(banner).toHaveCount(0);
});

test('转人工后回到任务列表，该任务的徽标显示已转人工', async ({ page }) => {
  await page.goto(open('', '#/task/T2/reconcile'));
  await page.getByRole('button', { name: '转人工' }).click();
  await expect(page.getByTestId('reconcile-status')).toHaveText('已转人工');
  await page.getByRole('link', { name: '返回任务列表' }).click();
  const t2 = page.getByRole('row', { name: /2026-07 深圳客户拜访/ });
  await expect(t2.getByText('已转人工')).toBeVisible();
  await expect(t2.getByText('对账中')).toHaveCount(0);
});
