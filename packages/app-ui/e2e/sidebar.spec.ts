import { expect, test } from '@playwright/test';

// 侧栏可收起：收起状态是界面偏好，刷新后仍在（localStorage），默认展开。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

test('侧栏收起成窄栏，刷新后保持；再展开恢复任务名', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(open('?seed=inventory', '#/task/T1/inventory'));
  const sidebar = page.locator('aside.sidebar');
  await expect(sidebar.getByTitle('2026-08 上海出差（产品评审）')).toBeVisible();
  await page.getByRole('button', { name: '收起侧栏' }).click();
  await expect(page.getByRole('button', { name: '展开侧栏' })).toHaveAttribute('aria-expanded', 'false');
  await expect(sidebar.getByTitle('2026-08 上海出差（产品评审）')).toBeHidden();
  await expect(page.getByRole('list', { name: '流程阶段' }).getByRole('link', { name: '材料盘点' })).toHaveAttribute('aria-current', 'step');
  // 宽度有一段很短的过渡，等它落定。
  await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBeLessThan(80);

  await page.reload();
  await expect(page.getByRole('button', { name: '展开侧栏' })).toHaveAttribute('aria-expanded', 'false');

  await page.getByRole('button', { name: '展开侧栏' }).click();
  await expect(page.getByRole('button', { name: '收起侧栏' })).toHaveAttribute('aria-expanded', 'true');
  await expect(sidebar.getByTitle('2026-08 上海出差（产品评审）')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '收起侧栏' })).toBeVisible();
});

test('被守卫拦下时对应步骤不显示为当前；点未到的步骤出现一句说明', async ({ page }) => {
  await page.goto(open('?seed=inventory', '#/task/T1/review'));
  await expect(page.getByRole('heading', { name: '还不能进入这一步', level: 1 })).toBeVisible();
  const stages = page.getByRole('list', { name: '流程阶段' });
  await expect(stages.locator('[aria-current="step"]')).toHaveCount(0);
  // 未到的步骤带 aria-disabled，仍可点出说明。
  await stages.getByRole('button', { name: '整单明细确认' }).click({ force: true });
  await expect(page.getByText('阶段不可跳过，请按顺序完成。')).toBeVisible();
});

test('步骤样式沿用上一版：已完成灰字加细勾，当前强调色字加左侧 2px 细条（无白底块），未到三级灰；侧栏在着色框架上', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(open('?seed=review', '#/task/T1/review'));
  const stages = page.getByRole('list', { name: '流程阶段' });
  const current = stages.getByRole('link', { name: '整单明细确认' });
  await expect(current).toHaveAttribute('aria-current', 'step');
  await expect(current).toHaveCSS('color', 'rgb(94, 106, 210)');
  await expect(current).toHaveCSS('border-left-width', '2px');
  await expect(current).toHaveCSS('border-left-color', 'rgb(94, 106, 210)');
  await expect(current).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const done = stages.getByRole('link', { name: '上传材料' });
  await expect(done).toHaveCSS('color', 'rgb(75, 79, 87)');
  await expect(done.locator('svg')).toHaveCount(1);
  await expect(done).toHaveCSS('border-left-color', 'rgba(0, 0, 0, 0)');
  const locked = stages.getByRole('button', { name: '去打印 / 去报销' });
  await expect(locked).toHaveCSS('color', 'rgb(177, 181, 189)');
  await expect(locked.locator('svg')).toHaveCount(0);
  await expect(page.locator('aside.sidebar')).toHaveCSS('background-color', 'rgb(239, 241, 244)');
  await expect(page.locator('main')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
});
