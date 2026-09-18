import { expect, signIn, test } from './fixture';

for (const active of [true, false]) {
  test(`public deletion is administrator-only and preserves cancellation (active=${active})`, async ({ page, browser, serverApp }, testInfo) => {
    await signIn(page);
    await page.request.post('/api/public-project-book/intake', { data: { number: 'PUBLIC-DELETE', name: '公共删除验证' } });
    if (!active) await page.request.post('/api/public-project-book/deactivate', { data: { number: 'PUBLIC-DELETE' } });
    const memberContext = await browser.newContext({ baseURL: serverApp.url });
    const member = await memberContext.newPage();
    await signIn(member, 'member');
    expect((await member.request.post('/api/public-project-book/delete', { data: { number: 'PUBLIC-DELETE' } })).status()).toBe(403);
    await member.goto('/#/projects');
    const memberRow = member.getByTestId('book-row-PUBLIC-DELETE');
    await expect(memberRow).toBeVisible();
    await expect(memberRow.getByRole('button')).toHaveCount(0);

    await page.goto('/#/admin');
    const row = page.getByTestId('book-row-PUBLIC-DELETE');
    await expect(row.getByRole('button')).toHaveCount(3);
    await expect(row.getByRole('button', { name: '编辑 PUBLIC-DELETE' })).toHaveText('编辑');
    const remove = row.getByRole('button', { name: '删除项目 PUBLIC-DELETE' });
    await page.screenshot({ path: testInfo.outputPath('public-project-actions.png') });
    await remove.click();
    const dialog = page.getByRole('dialog', { name: '删除公共项目' });
    await expect(dialog).toContainText('所有成员将无法再选择该公共项目');
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(row).toBeVisible();
    await remove.click();
    await dialog.getByRole('button', { name: '删除', exact: true }).click();
    await expect(row).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { name: '管理', exact: true })).toBeVisible();
    await expect(row).toHaveCount(0);
    await member.reload();
    await expect(member.getByRole('heading', { name: '个人项目簿', exact: true })).toBeVisible();
    await expect(memberRow).toHaveCount(0);
    const response = await member.request.post('/api/project-book/intake', { data: { number: 'PUBLIC-DELETE', name: '重新录入个人项目' } });
    expect((await response.json()).status).toBe('admitted');
    await memberContext.close();
  });
}
