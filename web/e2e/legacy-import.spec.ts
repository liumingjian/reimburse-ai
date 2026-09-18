import { expect, test } from '@playwright/test';

// 旧数据导入的报告、重试与跳过（故事 81）。真实服务端上这一次导入只在创建第一个管理员时跑，
// 而且要一棵损坏的旧数据树才会失败，所以这个状态留在 mock：`?legacy=failed` 直接摆出那一次的失败结果。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

const BROKEN = 'tasks/2026-05-10-b1b2c3d4e5/invoices.json';

test('旧数据损坏：设置页逐个文件说明原因，修好后重试导入', async ({ page }, testInfo) => {
  await page.goto(open('?legacy=failed', '#/settings'));
  const panel = page.getByRole('region', { name: '旧数据导入' });
  await expect(panel.getByText('旧数据有问题，什么都没导入')).toBeVisible();
  await expect(panel.getByRole('list', { name: '旧数据里的问题' })).toContainText(BROKEN);
  await page.screenshot({ path: testInfo.outputPath('legacy-import.png'), fullPage: true });

  await panel.getByRole('button', { name: '重试导入' }).click();
  await expect(panel.getByText('已导入')).toBeVisible();
  await expect(panel.getByText('3 张发票')).toBeVisible();
  // 没有动过报销系统的旧任务不迁移。
  await expect(panel.getByRole('list', { name: '没有迁移的旧任务' })).toContainText('六月未提交');
  await expect(panel.getByRole('button', { name: '重试导入' })).toHaveCount(0);
});

test('旧数据损坏：也可以明确跳过，跳过之后不再提供重试', async ({ page }) => {
  await page.goto(open('?legacy=failed', '#/settings'));
  const panel = page.getByRole('region', { name: '旧数据导入' });
  await panel.getByRole('button', { name: '跳过导入' }).click();
  await expect(panel.getByText('已跳过')).toBeVisible();
  await expect(panel.getByRole('button', { name: '跳过导入' })).toHaveCount(0);
});
