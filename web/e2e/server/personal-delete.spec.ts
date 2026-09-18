import { expect, signIn, test } from './fixture';

for (const active of [true, false]) {
  test(`personal project deletion confirms, preserves cancellation, and releases its number (active=${active})`, async ({ page }, testInfo) => {
    await signIn(page);
    await page.request.post('/api/project-book/intake', { data: { number: 'QA-DELETE', name: '删除验证' } });
    if (!active) await page.request.post('/api/project-book/deactivate', { data: { number: 'QA-DELETE' } });
    await page.goto('/#/projects');
    const row = page.getByTestId('book-row-QA-DELETE');
    await expect(row).toBeVisible();
    await expect(row.getByRole('button')).toHaveCount(3);
    const item = row.getByRole('button', { name: '删除项目 QA-DELETE' });
    await page.screenshot({ path: testInfo.outputPath('personal-project-actions.png') });
    await page.setViewportSize({ width: 800, height: 700 });
    for (const button of await row.getByRole('button').all()) await expect(button).toBeVisible();
    const buttons = await row.getByRole('button').all();
    const boxes = await Promise.all(buttons.map((button) => button.boundingBox()));
    expect(Math.max(...boxes.map((box) => box!.y)) - Math.min(...boxes.map((box) => box!.y))).toBeLessThan(2);
    await item.click();
    const dialog = page.getByRole('dialog', { name: '删除个人项目' });
    await expect(dialog).toContainText('已有报销记录保持不变');
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(row).toBeVisible();
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
