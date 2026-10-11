// 新建报销任务 → 上传材料 → 开始材料盘点, all through the page, from a first run (创建管理员 on the page).
export const fake = null;

export default async function newTaskUpload(v) {
  const { page, expect } = v;
  await v.step('create the first administrator on the page', async () => {
    await page.goto('/#/tasks');
    await expect(page.getByRole('heading', { name: '创建管理员' })).toBeVisible();
    await page.getByLabel('用户名').fill('admin');
    await page.getByLabel('密码').fill('verify-password');
    await page.getByRole('button', { name: '创建管理员' }).click();
    await expect(page.getByRole('button', { name: '新建报销任务' })).toBeVisible();
  });
  await v.step('新建报销任务 with 常驻城市 杭州', async () => {
    await page.getByRole('button', { name: '新建报销任务' }).click();
    const dialog = page.getByRole('dialog', { name: '新建报销任务' });
    await dialog.getByLabel('常驻城市').fill('杭州');
    await dialog.getByRole('button', { name: '创建并上传材料' }).click();
    await expect(page).toHaveURL(/#\/task\/[^/]+\/upload$/);
  });
  const taskId = /#\/task\/([^/]+)\/upload$/.exec(page.url())[1];
  await v.step('upload the hotel invoice and folio', async () => {
    await page.getByLabel('拖入文件，或点击选择', { exact: true }).setInputFiles([v.fixture('m01-hotel-invoice.pdf'), v.fixture('m02-hotel-folio.pdf')]);
    const batch = page.locator('section', { has: page.getByRole('heading', { name: /^上传批次 #1$/ }) });
    await expect(batch.getByText('m01-hotel-invoice.pdf', { exact: true })).toBeVisible();
    await expect(batch.getByText('m02-hotel-folio.pdf', { exact: true })).toBeVisible();
    await v.shot('uploaded');
  });
  await v.step('开始材料盘点 and wait for the summary', async () => {
    await page.getByRole('button', { name: '开始材料盘点' }).click();
    await expect(page.getByRole('group', { name: '盘点摘要' })).toBeVisible({ timeout: 90_000 });
    await v.shot('inventory');
  });
  const snapshot = await v.record('after-inventory', taskId);
  expect(snapshot.inventory.status).toBe('done');
  expect(snapshot.lines.length).toBeGreaterThan(0);
}
