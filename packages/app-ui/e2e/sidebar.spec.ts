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
