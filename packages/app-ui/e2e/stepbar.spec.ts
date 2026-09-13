import { expect, test, type Page } from '@playwright/test';

// 步骤条：任务页工作面顶部一行横排的 7 步（没有侧栏），工作面铺满宽度。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;
const ACCENT = 'rgb(94, 106, 210)';

async function stepBoxes(page: Page) {
  const items = page.getByRole('list', { name: '流程阶段' }).locator('.stepbar-step');
  const count = await items.count();
  const boxes = [];
  for (let index = 0; index < count; index += 1) {
    const box = await items.nth(index).boundingBox();
    if (!box) throw new Error('步骤不可见');
    boxes.push(box);
  }
  return boxes;
}

for (const [width, height] of [
  [1440, 900],
  [1100, 800],
] as const) {
  test(`${width}px：7 步横排在一行、标签不折行、步骤条不横向滚动；没有侧栏，工作面铺满宽度`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto(open('?seed=review', '#/task/T1/review'));
    await expect(page.getByRole('heading', { name: '整单明细确认', level: 1 })).toBeVisible();
    await expect(page.locator('aside')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /侧栏/ })).toHaveCount(0);

    const boxes = await stepBoxes(page);
    expect(boxes).toHaveLength(7);
    const first = boxes[0];
    if (!first) throw new Error('没有步骤');
    for (const box of boxes) {
      // 同一行，且每步只有一行高（不折行）。
      expect(Math.abs(box.y - first.y)).toBeLessThan(2);
      expect(Math.abs(box.height - first.height)).toBeLessThan(2);
    }
    for (let index = 1; index < boxes.length; index += 1) {
      const previous = boxes[index - 1];
      const box = boxes[index];
      if (previous && box) expect(box.x).toBeGreaterThan(previous.x + previous.width);
    }
    const bar = page.locator('.stepbar');
    const [scrollWidth, clientWidth] = await bar.evaluate((element) => [element.scrollWidth, element.clientWidth]);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
    const lastLabel = page.getByRole('list', { name: '流程阶段' }).locator('.stepbar-label').last();
    const [labelBox, barBox] = await Promise.all([lastLabel.boundingBox(), bar.boundingBox()]);
    expect(labelBox && barBox && labelBox.x + labelBox.width <= barBox.x + barBox.width).toBe(true);

    // 工作面只留框架缝：宽度接近窗口宽。
    const mainBox = await page.locator('main').boundingBox();
    expect(mainBox && mainBox.width > width - 24).toBe(true);
    // 步骤条在页面标题之上。
    const titleBox = await page.getByRole('heading', { name: '整单明细确认', level: 1 }).boundingBox();
    expect(barBox && titleBox && barBox.y + barBox.height <= titleBox.y).toBe(true);
  });
}

test('样式：已完成是强调色细圈里的勾、后面的连线是强调色；当前是强调色实心圆、标签 600；未到是三级灰', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(open('?seed=review', '#/task/T1/review'));
  const stages = page.getByRole('list', { name: '流程阶段' });

  const current = stages.getByRole('link', { name: '整单明细确认' });
  await expect(current).toHaveAttribute('aria-current', 'step');
  await expect(current).toHaveCSS('font-weight', '600');
  await expect(current.locator('.stepbar-marker')).toHaveCSS('background-color', ACCENT);
  await expect(current.locator('.stepbar-marker')).toHaveCSS('color', 'rgb(255, 255, 255)');

  const done = stages.getByRole('link', { name: '上传材料' });
  await expect(done.locator('.stepbar-marker svg')).toHaveCount(1);
  await expect(done.locator('.stepbar-marker')).toHaveCSS('border-top-color', ACCENT);
  const doneConnector = await stages.locator('li').first().evaluate((element) => getComputedStyle(element, '::after').backgroundColor);
  expect(doneConnector).toBe(ACCENT);

  const locked = stages.getByRole('button', { name: '去打印 / 去报销' });
  await expect(locked).toHaveAttribute('aria-disabled', 'true');
  await expect(locked).toHaveCSS('color', 'rgb(177, 181, 189)');
  await expect(locked.locator('svg')).toHaveCount(0);
  const lockedConnector = await stages.locator('li').nth(5).evaluate((element) => getComputedStyle(element, '::after').backgroundColor);
  expect(lockedConnector).not.toBe(ACCENT);
  await expect(page.locator('main')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
});

test('被守卫拦下时对应步骤不显示为当前；点未到的步骤出现一句说明', async ({ page }) => {
  await page.goto(open('?seed=inventory', '#/task/T1/review'));
  await expect(page.getByRole('heading', { name: '还不能进入这一步', level: 1 })).toBeVisible();
  const stages = page.getByRole('list', { name: '流程阶段' });
  await expect(stages.locator('[aria-current="step"]')).toHaveCount(0);
  // 未到的步骤带 aria-disabled，仍可点出说明。
  await stages.getByRole('button', { name: '整单明细确认' }).click({ force: true });
  await expect(page.getByRole('status').filter({ hasText: '阶段不可跳过，请按顺序完成。' })).toBeVisible();
});

test('对账中的任务：步骤条是任务名加状态标签与说明，不列步骤', async ({ page }) => {
  await page.goto(open('', '#/task/T2/reconcile'));
  await expect(page.getByRole('heading', { name: '对账', level: 1 })).toBeVisible();
  const bar = page.locator('.stepbar');
  await expect(bar).toContainText('写入结果待对账。');
  await expect(bar.locator('.tag-warning')).toBeVisible();
  await expect(page.getByRole('list', { name: '流程阶段' })).toHaveCount(0);
});
