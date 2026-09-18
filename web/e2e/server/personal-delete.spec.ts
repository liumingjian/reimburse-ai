import { expect, signIn, test } from './fixture';

for (const active of [true, false]) {
  test(`personal project deletion confirms, preserves cancellation, and releases its number (active=${active})`, async ({ page }, testInfo) => {
    await signIn(page);
    await page.request.post('/api/project-book/intake', { data: { number: 'QA-DELETE', name: '删除验证' } });
    if (!active) await page.request.post('/api/project-book/deactivate', { data: { number: 'QA-DELETE' } });
    await page.goto('/#/projects');
    const row = page.getByTestId('book-row-QA-DELETE');
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: '更多' }).click();
    const menu = page.getByRole('menu', { name: '项目 QA-DELETE 的更多操作' });
    const item = menu.getByRole('menuitem', { name: '删除项目 QA-DELETE' });
    const menuBox = await menu.boundingBox();
    const itemBox = await item.boundingBox();
    expect(menuBox).not.toBeNull();
    expect(itemBox).not.toBeNull();
    expect(Math.abs(menuBox!.width - itemBox!.width)).toBeLessThanOrEqual(4);
    await page.screenshot({ path: testInfo.outputPath('personal-project-menu.png') });
    await item.click();
    const dialog = page.getByRole('dialog', { name: '删除个人项目' });
    await expect(dialog).toContainText('已有报销记录保持不变');
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: '更多' }).click();
    await item.click();
    await dialog.getByRole('button', { name: '删除', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(row).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { name: '个人项目簿', exact: true })).toBeVisible();
    await expect(row).toHaveCount(0);
    const response = await page.request.post('/api/project-book/intake', { data: { number: 'QA-DELETE', name: '重新录入' } });
    expect((await response.json()).status).toBe('admitted');
  });
}
