import { expect, test, type Page } from '@playwright/test';

// 启动页：报销系统登录、报销人身份绑定、身份不一致阻塞，以及按身份记住的常驻城市（mock 用 localStorage，刷新后仍在）。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

const h1 = (page: Page, name: string) => page.getByRole('heading', { name, level: 1 });

test('?erp=logged-out：先显示登录提示；「我已登录」后进入身份确认；确认后进入任务列表', async ({ page }, testInfo) => {
  await page.goto(open('?erp=logged-out', '#/tasks'));
  await expect(h1(page, '登录报销系统')).toBeVisible();
  await expect(page.getByText('请在报销系统中使用本人账号登录。')).toBeVisible();
  await expect(page.getByRole('button', { name: '新建报销任务' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('startup-login.png'), fullPage: true });

  await page.getByRole('button', { name: '我已登录' }).click();
  await expect(h1(page, '确认报销人身份')).toBeVisible();
  const table = page.getByRole('table', { name: '报销人身份' });
  await expect(table.getByRole('row', { name: /姓名 林颂宜/ })).toBeVisible();
  await expect(table.getByRole('row', { name: /登录账号 linsongyi/ })).toBeVisible();
  await expect(table.getByRole('row', { name: /账套 示例科技集团本部/ })).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('startup-identity.png'), fullPage: true });

  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(h1(page, '报销任务')).toBeVisible();
  await expect(page.getByRole('banner').getByText('林颂宜', { exact: true })).toBeVisible();
});

test('?identity=unbound：确认身份后进入任务列表；刷新后不再询问', async ({ page }) => {
  await page.goto(open('?identity=unbound', '#/tasks'));
  await expect(h1(page, '确认报销人身份')).toBeVisible();
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(h1(page, '报销任务')).toBeVisible();

  await page.reload();
  await expect(h1(page, '报销任务')).toBeVisible();
  await expect(h1(page, '确认报销人身份')).toHaveCount(0);
});

test('?identity=mismatched：整页阻塞，没有任何按钮；任务列表、新建弹层与任务页都进不去', async ({ page }, testInfo) => {
  for (const hash of ['#/tasks', '#/tasks/new', '#/task/T1/upload']) {
    await page.goto(open('?identity=mismatched', hash));
    await expect(h1(page, '报销人身份不一致')).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('当前登录身份与已登记的报销人不一致。请在报销系统切换回本人账号；已有报销不能中途更换报销人。');
    await expect(page.getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('table')).toHaveCount(0);
  }
  await page.screenshot({ path: testInfo.outputPath('startup-mismatched.png'), fullPage: true });
});

test('常驻城市按身份记住：新建任务确认苏州后刷新页面，再新建时预填苏州（上次确认）', async ({ page }) => {
  await page.goto(open('', '#/tasks/new'));
  const box = page.getByRole('dialog', { name: '新建报销任务' });
  await expect(box.getByLabel('报销人')).toHaveValue('林颂宜');
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
