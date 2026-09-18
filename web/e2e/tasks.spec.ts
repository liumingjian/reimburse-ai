import { expect, test } from '@playwright/test';

// 直接用 file:// 打开 mock 构建产物（先运行 pnpm build:mock）。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;

const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

test('任务列表显示三个任务及其阶段徽标', async ({ page }, testInfo) => {
  await page.goto(open('', '#/tasks'));
  await expect(page.getByRole('heading', { name: '报销任务' })).toBeVisible();

  const t1 = page.getByRole('row', { name: /2026-08 上海出差（产品评审）/ });
  await expect(t1.getByText('3/10 材料盘点')).toBeVisible();
  await expect(t1.getByText('未确认')).toBeVisible();

  const t2 = page.getByRole('row', { name: /2026-07 深圳客户拜访/ });
  await expect(t2.getByText('对账中')).toBeVisible();
  await expect(t2.getByText('BX20260718-0142')).toBeVisible();

  const t3 = page.getByRole('row', { name: /2026-06 北京培训/ });
  await expect(t3.getByText('10/10 草稿交接')).toBeVisible();
  await expect(t3.getByText('2318.50')).toBeVisible();

  await expect(page.getByRole('banner').getByText('林颂宜', { exact: true })).toBeVisible();
  await expect(page.getByText(/部门|产品研发部/)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('tasks.png'), fullPage: true });
});

test('作废确认是危险弹层：确认按钮是红色 danger 按钮，文案仍是「作废」', async ({ page }, testInfo) => {
  await page.goto(open('', '#/tasks'));
  const t1 = page.getByRole('row', { name: /2026-08 上海出差（产品评审）/ });
  await t1.getByRole('button', { name: '作废' }).click();
  const dialog = page.getByRole('dialog', { name: '作废这个报销任务？' });
  const confirm = dialog.getByRole('button', { name: '作废', exact: true });
  await expect(confirm).toBeVisible();
  // Carbon 的 $button-danger-primary（#da1e28），与普通确认的蓝色主按钮一眼可分。
  await expect(confirm).toHaveCSS('background-color', 'rgb(218, 30, 40)');
  await page.screenshot({ path: testInfo.outputPath('abandon-danger-confirm.png') });
});

test('?seed=done 让 T1 显示为草稿交接并带草稿号', async ({ page }) => {
  await page.goto(open('?seed=done', '#/tasks'));
  const t1 = page.getByRole('row', { name: /2026-08 上海出差（产品评审）/ });
  await expect(t1.getByText('10/10 草稿交接')).toBeVisible();
  await expect(t1.getByText('3972.59')).toBeVisible();
  await expect(t1.getByText('BX20260911-0173')).toBeVisible();
});

test('点「继续」进入任务页面骨架，步骤条列出流程阶段', async ({ page }) => {
  await page.goto(open('', '#/tasks'));
  await page.getByRole('link', { name: '继续', exact: true }).click();
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
  await page.getByRole('link', { name: '报销任务' }).click();
  const t2 = page.getByRole('row', { name: /2026-07 深圳客户拜访/ });
  await expect(t2.getByText('已转人工')).toBeVisible();
  await expect(t2.getByText('对账中')).toHaveCount(0);
});

test('窄窗口：任务表不挤压列宽而是横向滚动，任务名固定在左、操作列固定在右', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 700 });
  await page.goto(open('', '#/tasks'));
  const tasks = page.getByRole('table', { name: '报销任务' });
  await expect(tasks).toBeVisible();
  const wrap = tasks.locator('xpath=..');
  const scrolled = await wrap.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    return element.scrollLeft;
  });
  expect(scrolled).toBeGreaterThan(0);
  const row = page.getByRole('row', { name: /2026-07 深圳客户拜访/ });
  const [wrapBox, nameBox, actionsBox] = await Promise.all([wrap.boundingBox(), row.locator('td').first().boundingBox(), row.locator('td').last().boundingBox()]);
  expect(wrapBox && nameBox && Math.abs(nameBox.x - wrapBox.x) < 3).toBe(true);
  expect(wrapBox && actionsBox && Math.abs(actionsBox.x + actionsBox.width - (wrapBox.x + wrapBox.width)) < 3).toBe(true);
  // 操作按钮不折行。
  const continueBox = await row.getByRole('link', { name: '查看对账' }).boundingBox();
  expect(continueBox && continueBox.height < 40).toBe(true);
});

// 固定列的分隔线：只有那一侧真有内容被盖住时才出现（Carbon 的 $border-subtle-01，inset 1px）。
const NO_DIVIDER = 'none';
const START_DIVIDER = 'rgb(224, 224, 224) -1px 0px 0px 0px inset';
const END_DIVIDER = 'rgb(224, 224, 224) 1px 0px 0px 0px inset';

test('1440：任务表不横向滚动，固定列没有分隔线；disabled abandonment explains its refusal on keyboard focus', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(open('', '#/tasks'));
  const tasks = page.getByRole('table', { name: '报销任务' });
  await expect(tasks).toBeVisible();
  const wrap = tasks.locator('xpath=..');
  const [scrollWidth, clientWidth] = await wrap.evaluate((element) => [element.scrollWidth, element.clientWidth]);
  console.log(`task table 1440: scrollWidth ${scrollWidth}, clientWidth ${clientWidth}`);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  const heads = tasks.locator('thead th');
  await expect(heads.first()).toHaveCSS('box-shadow', NO_DIVIDER);
  await expect(heads.last()).toHaveCSS('box-shadow', NO_DIVIDER);
  await expect(tasks.locator('tbody tr').first().locator('td').last()).toHaveCSS('box-shadow', NO_DIVIDER);
  await page.screenshot({ path: testInfo.outputPath('tasks-1440.png') });

  const t2 = page.getByRole('row', { name: /2026-07 深圳客户拜访/ });
  await expect(t2.getByRole('button', { name: '作废' })).toBeDisabled();
  await t2.getByLabel('无法作废的原因').focus();
  await expect(page.getByRole('tooltip')).toContainText('已开始写入报销系统，不能作废：它占用的发票要靠对账解除。');
  const tooltip = page.getByRole('tooltip');
  const unobscured = await tooltip.evaluate((element) => {
    const content = element.querySelector('.cds--popover-content') ?? element;
    const rect = content.getBoundingClientRect();
    if (content.scrollWidth > content.clientWidth) return false;
    return [0.1, 0.5, 0.9].every((fraction) => content.contains(document.elementFromPoint(rect.left + rect.width * fraction, rect.top + rect.height / 2)));
  });
  expect(unobscured).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('tasks-1440-abandon-blocked.png') });
});

test('1100：操作列变窄，价税合计完整可见；表格横向滚动，分隔线只在内容被盖住的一侧出现', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto(open('', '#/tasks'));
  const tasks = page.getByRole('table', { name: '报销任务' });
  await expect(tasks).toBeVisible();
  const heads = tasks.locator('thead th');
  const [grossBox, actionsBox] = await Promise.all([heads.filter({ hasText: '价税合计' }).boundingBox(), heads.last().boundingBox()]);
  console.log(`task table 1100: 价税合计 right ${grossBox && grossBox.x + grossBox.width}, 操作 x ${actionsBox?.x}, 操作 width ${actionsBox?.width}`);
  // 价税合计整列在固定的操作列左边，不被盖住；actions remain adjacent.
  expect(grossBox && actionsBox && grossBox.x + grossBox.width <= actionsBox.x).toBe(true);
  expect(actionsBox && actionsBox.width < 220).toBe(true);
  await expect(heads.last()).toHaveText('操作');

  const wrap = tasks.locator('xpath=..');
  const [scrollWidth, clientWidth] = await wrap.evaluate((element) => [element.scrollWidth, element.clientWidth]);
  expect(scrollWidth).toBeGreaterThan(clientWidth);
  // 还没滚：右边有内容在操作列下面，左边没有。
  await expect(heads.last()).toHaveCSS('box-shadow', END_DIVIDER);
  await expect(heads.first()).toHaveCSS('box-shadow', NO_DIVIDER);
  await page.screenshot({ path: testInfo.outputPath('tasks-1100.png') });
  // 滚到最右：左边的任务名列盖住内容，右边不再有。
  await wrap.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect(heads.first()).toHaveCSS('box-shadow', START_DIVIDER);
  await expect(heads.last()).toHaveCSS('box-shadow', NO_DIVIDER);
  await page.screenshot({ path: testInfo.outputPath('tasks-1100-scrolled.png') });
});
