import { expect, test, type Page } from '@playwright/test';

// 步骤条：任务页工作区顶部一条，Carbon progress indicator 横排 7 步（没有侧栏），工作区铺满宽度。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;
const LABELS = ['上传材料', '材料盘点', '待确认项', '项目归属', '整单明细确认', '去打印 / 去报销', '完成'];

const stages = (page: Page) => page.getByRole('list', { name: '流程阶段' });
const bar = (page: Page) => page.getByRole('region', { name: '任务进度' });
const step = (page: Page, label: string) => stages(page).getByRole('button', { name: new RegExp(`^${label.replace(/[/]/g, '\\/')}`) });

for (const [width, height] of [
  [1440, 900],
  [1100, 800],
] as const) {
  test(`${width}px：7 步横排在一行、标签不折行、步骤条不横向滚动；没有侧栏，工作区铺满宽度`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto(open('?seed=review', '#/task/T1/review'));
    await expect(page.getByRole('heading', { name: '整单明细确认', level: 1 })).toBeVisible();
    await expect(page.locator('aside')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /侧栏/ })).toHaveCount(0);

    const labels = [];
    for (const label of LABELS) {
      const box = await stages(page).getByText(label, { exact: true }).boundingBox();
      if (!box) throw new Error(`步骤「${label}」不可见`);
      labels.push(box);
    }
    const first = labels[0];
    if (!first) throw new Error('没有步骤');
    for (const box of labels) {
      // 同一行，且每个标签只有一行高（不折行）。
      expect(Math.abs(box.y - first.y)).toBeLessThan(2);
      expect(box.height).toBeLessThan(24);
    }
    for (let index = 1; index < labels.length; index += 1) {
      const previous = labels[index - 1];
      const box = labels[index];
      if (previous && box) expect(box.x).toBeGreaterThan(previous.x + previous.width);
    }
    const [scrollWidth, clientWidth] = await bar(page).evaluate((element) => [element.scrollWidth, element.clientWidth]);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    const barBox = await bar(page).boundingBox();
    const last = labels[labels.length - 1];
    expect(last && barBox && last.x + last.width <= barBox.x + barBox.width).toBe(true);

    // 工作区铺满宽度。
    const mainBox = await page.locator('main').boundingBox();
    expect(mainBox && mainBox.width > width - 24).toBe(true);
    // 步骤条在页面标题之上。
    const titleBox = await page.getByRole('heading', { name: '整单明细确认', level: 1 }).boundingBox();
    expect(barBox && titleBox && barBox.y + barBox.height <= titleBox.y).toBe(true);
  });
}

test('Carbon Gray 10 原样：背景 #f4f4f4、主按钮 #0f62fe 直角；系统字体，没有 IBM Plex；步骤状态文字是中文', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(open('?seed=review', '#/task/T1/review'));
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(244, 244, 244)');
  const fontFamily = await page.locator('body').evaluate((element) => getComputedStyle(element).fontFamily);
  expect(fontFamily).toContain('PingFang SC');
  expect(fontFamily).not.toContain('Plex');
  const confirm = page.getByRole('region', { name: '整单确认' }).getByRole('button', { name: '确认', exact: true });
  await expect(confirm).toHaveCSS('background-color', 'rgb(15, 98, 254)');
  await expect(confirm).toHaveCSS('border-top-left-radius', '0px');

  await expect(step(page, '整单明细确认')).toHaveAttribute('aria-current', 'step');
  await expect(step(page, '整单明细确认')).toContainText('当前');
  await expect(step(page, '上传材料')).toContainText('已完成');
  await expect(step(page, '去打印 / 去报销')).toHaveAttribute('aria-disabled', 'true');
  await expect(step(page, '去打印 / 去报销')).toContainText('未开放');
  // 已到的步骤可点：进入对应页面。
  await step(page, '项目归属').click();
  await expect(page).toHaveURL(/#\/task\/T1\/project$/);
});

const HINT = '阶段不可跳过，请按顺序完成。';
const labelColor = (page: Page, label: string) =>
  stages(page).getByText(label, { exact: true }).evaluate((element) => getComputedStyle(element).color);

for (const [width, height] of [
  [1440, 900],
  [1100, 800],
] as const) {
  test(`${width}px：未开放步骤用 text-secondary（不是 disabled 色）；点它提示出现在被点步骤正下方`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await page.goto(open('?seed=inventory', '#/task/T1/inventory'));
    await expect(page.getByRole('heading', { name: '材料盘点', level: 1 })).toBeVisible();

    // Gray 10：text-secondary #525252；text-disabled 是 rgba(22, 22, 22, 0.25)。
    const locked = await labelColor(page, '整单明细确认');
    expect(locked).toBe('rgb(82, 82, 82)');
    expect(locked).not.toBe(await labelColor(page, '上传材料'));
    await expect(step(page, '整单明细确认')).toHaveAttribute('aria-disabled', 'true');

    for (const label of ['项目归属', '完成']) {
      // 未到的步骤带 aria-disabled（Playwright 视为不可用），仍可点出说明。
      await step(page, label).click({ force: true });
      const hint = page.getByRole('status').filter({ hasText: HINT });
      await expect(hint).toBeVisible();
      const hintBox = await hint.boundingBox();
      const stepBox = await step(page, label).boundingBox();
      if (!hintBox || !stepBox) throw new Error('量不到位置');
      // 在步骤下方，左边与被点步骤对齐（而不是任务名下）。
      expect(hintBox.y).toBeGreaterThanOrEqual(stepBox.y + stepBox.height - 1);
      const text = await hint.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getBoundingClientRect().left;
      });
      expect(Math.abs(text - stepBox.x)).toBeLessThan(4);
    }
    await expect(page).toHaveURL(/#\/task\/T1\/inventory$/);
    await bar(page).screenshot({ path: testInfo.outputPath(`stepbar-locked-hint-${width}.png`) });
  });
}

test('被守卫拦下时对应步骤不显示为当前；守卫页不出「阶段不可跳过」的步骤条提示', async ({ page }) => {
  await page.goto(open('?seed=inventory', '#/task/T1/review'));
  await expect(page.getByRole('heading', { name: '还不能进入这一步', level: 1 })).toBeVisible();
  await expect(stages(page).locator('[aria-current="step"]')).toHaveCount(0);
  await step(page, '整单明细确认').click({ force: true });
  await expect(bar(page).getByText(HINT)).toHaveCount(0);
  await expect(page).toHaveURL(/#\/task\/T1\/review$/);
});

test('对账中的任务：步骤条是任务名加状态标签与说明，不列步骤', async ({ page }) => {
  await page.goto(open('', '#/task/T2/reconcile'));
  await expect(page.getByRole('heading', { name: '对账', level: 1 })).toBeVisible();
  await expect(bar(page)).toContainText('写入结果待对账。');
  await expect(bar(page).getByText('对账中', { exact: true })).toBeVisible();
  await expect(stages(page)).toHaveCount(0);
});
