import { expect, test } from '@playwright/test';

// 常驻城市按应用账号记住（mock 用 localStorage，刷新后仍在）。登录与注册的流程在 server 项目的 e2e/server/accounts.spec.ts 里。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

test('常驻城市按账号记住：新建任务确认苏州后刷新页面，再新建时预填苏州（上次确认）', async ({ page }) => {
  await page.goto(open('', '#/tasks/new'));
  const box = page.getByRole('dialog', { name: '新建报销任务' });
  await expect(box.getByLabel('常驻城市')).toHaveValue('杭州');
  await box.getByLabel('常驻城市').fill('苏州');
  await box.getByRole('button', { name: '创建并上传材料' }).click();
  await expect(page).toHaveURL(/#\/task\/T4\/upload$/);

  await page.goto(open('', '#/tasks/new'));
  await page.reload();
  const again = page.getByRole('dialog', { name: '新建报销任务' });
  await expect(again.getByLabel('常驻城市')).toHaveValue('苏州');
  await expect(again.getByText(/上次确认的常驻城市/)).toBeVisible();
});
