import type { Page } from '@playwright/test';
import { expect, test } from './fixture';

// Slice 14a (#193) on the real server: 应用账号 (app accounts). Create the admin, log out, register a user, create a task;
// the user does not see the admin's task.
const h1 = (page: Page, name: string) => page.getByRole('heading', { name, level: 1 });

async function fillCredentials(page: Page, username: string, password: string) {
  await page.getByLabel('用户名').fill(username);
  await page.getByLabel('密码').fill(password);
}

async function createTask(page: Page, city: string) {
  await page.getByRole('button', { name: '新建报销任务' }).click();
  const dialog = page.getByRole('dialog', { name: '新建报销任务' });
  await dialog.getByLabel('常驻城市').fill(city);
  await dialog.getByRole('button', { name: '创建并上传材料' }).click();
  await expect(page).toHaveURL(/#\/task\/[^/]+\/upload$/);
}

test('创建管理员、退出登录、提交注册申请、批准后登录并新建报销任务；新账号看不到管理员的任务', async ({ page }, testInfo) => {
  await page.goto('/#/tasks');
  await expect(h1(page, '创建管理员')).toBeVisible();
  await expect(page.getByRole('button', { name: '新建报销任务' })).toHaveCount(0);
  await fillCredentials(page, '管理员', 'admin-password');
  await page.getByRole('button', { name: '创建管理员' }).click();
  await expect(h1(page, '报销任务')).toBeVisible();
  await expect(page.getByRole('banner')).toContainText('管理员');
  await createTask(page, '杭州');

  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(h1(page, '登录')).toBeVisible();
  // The session is gone server-side, not only in the page.
  expect((await page.request.get('/api/tasks')).status()).toBe(401);

  await page.getByRole('button', { name: '没有账号？注册' }).click();
  await expect(h1(page, '注册')).toBeVisible();
  await fillCredentials(page, '张三', 'user-password');
  await page.getByRole('button', { name: '注册', exact: true }).click();
  await expect(h1(page, '登录')).toBeVisible();
  await expect(page.getByText('注册申请已提交，请等待管理员批准后再登录。')).toBeVisible();
  expect((await page.request.get('/api/tasks')).status()).toBe(401);

  await fillCredentials(page, '张三', 'user-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByText('这个账号正在等待管理员批准。')).toBeVisible();

  await fillCredentials(page, '管理员', 'admin-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(h1(page, '报销任务')).toBeVisible();
  await page.goto('/#/admin');
  await expect(h1(page, '管理')).toBeVisible();
  const pendingRow = page.getByTestId('account-row-张三');
  await expect(pendingRow).toContainText('待审批');
  await page.screenshot({ path: testInfo.outputPath('pending-approval.png'), fullPage: true });
  await pendingRow.getByRole('button', { name: '批准' }).click();
  await expect(pendingRow).toContainText('在用');
  await expect(page.getByRole('status')).toContainText('已批准 张三 的注册申请。');
  await page.screenshot({ path: testInfo.outputPath('approved-account.png'), fullPage: true });
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(h1(page, '登录')).toBeVisible();

  await fillCredentials(page, '张三', 'user-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(h1(page, '报销任务')).toBeVisible();
  await expect(page.getByRole('banner')).toContainText('张三');
  await expect(page.getByRole('heading', { name: '还没有报销任务' })).toBeVisible();
  await createTask(page, '上海');

  await page.goto('/#/tasks');
  await expect(page.getByRole('row')).toHaveCount(2);

  // A reload keeps the session (HttpOnly cookie).
  await page.reload();
  await expect(page.getByRole('banner')).toContainText('张三');
});

test('用户名或密码不对时就地报错', async ({ page }) => {
  await page.goto('/#/tasks');
  await fillCredentials(page, '管理员', 'admin-password');
  await page.getByRole('button', { name: '创建管理员' }).click();
  await expect(h1(page, '报销任务')).toBeVisible();
  await page.getByRole('button', { name: '退出登录' }).click();

  await fillCredentials(page, '管理员', 'wrong-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByText('用户名或密码不对。')).toBeVisible();
  await fillCredentials(page, '管理员', 'admin-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(h1(page, '报销任务')).toBeVisible();
});
