import { ADMIN_ERRORS } from '@baox/contract';
import { E2E_PASSWORD, expect, signIn, test } from './fixture';

for (const role of ['admin', 'member']) {
  test(`${role} changes their own password from settings`, async ({ page }) => {
    await signIn(page);
    if (role === 'member') await signIn(page, 'member');
    await page.goto('/#/settings');
    await page.getByRole('link', { name: '修改密码', exact: true }).click();
    await expect(page.getByRole('heading', { name: '修改密码', exact: true })).toBeVisible();
    await page.getByLabel('当前密码', { exact: true }).fill('incorrect-password');
    await page.getByLabel('新密码', { exact: true }).fill('replacement-password');
    await page.getByRole('button', { name: '修改密码', exact: true }).click();
    await expect(page.getByText(`密码修改失败：${ADMIN_ERRORS.wrongPassword}`)).toBeVisible();

    await page.route('**/api/auth/change-password', (route) => route.fulfill({
      status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: '暂时无法修改，请重试。' } }),
    }));
    await page.getByLabel('当前密码', { exact: true }).fill(E2E_PASSWORD);
    await page.getByRole('button', { name: '修改密码', exact: true }).click();
    await expect(page.getByText('密码修改失败：暂时无法修改，请重试。')).toBeVisible();
    await page.unroute('**/api/auth/change-password');
    await page.getByRole('button', { name: '修改密码', exact: true }).click();
    await expect(page.getByText('密码已修改。下次登录请使用新密码。')).toBeVisible();
    await expect(page.getByLabel('当前密码', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('新密码', { exact: true })).toHaveValue('');
    await page.getByRole('link', { name: '返回设置' }).click();
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '退出登录' }).click();
    await page.getByLabel('用户名', { exact: true }).fill(role);
    await page.getByLabel('密码', { exact: true }).fill('replacement-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '报销任务', exact: true })).toBeVisible();
  });
}
