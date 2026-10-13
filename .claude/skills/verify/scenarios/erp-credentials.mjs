// ERP 凭据 on the settings page (ADR-0033): saved write-only, then cleared. No ERP double is needed: with no baox
// 本地执行器 paired, the 试登录 cannot run, so the 凭据 stay saved but untested and say why (nothing is paired). Needs the server's key:
// run with BAOX_ERP_CREDENTIAL_KEY_FILE pointing at a file of 64 hex characters (the server reads it at start).
export const fake = null;

const PASSWORD = 'verify-erp-Pa55';

export default async function erpCredentials(v) {
  const { page, expect } = v;
  await v.signIn();
  const section = page.getByRole('region', { name: '报销系统账号密码' });
  await v.step('open 设置 and find the 报销系统账号密码 section', async () => {
    await page.goto('/#/settings');
    await expect(section.getByRole('heading', { name: '还没有保存' })).toBeVisible();
    await v.shot('empty');
  });
  await v.step('fill the account and password, 保存并试登录', async () => {
    await section.getByLabel('报销系统账号').fill('verify-zhangsan');
    await section.getByLabel('报销系统密码').fill(PASSWORD);
    await expect(section.getByText('挤下线')).toBeVisible();
    await section.getByRole('button', { name: '保存并试登录' }).click();
    await expect(section.getByRole('heading', { name: '已保存，还没有试登录成功' })).toBeVisible();
    await expect(section.getByText('还没有配对 baox 本地执行器')).toBeVisible();
    await expect(section.getByText('verify-zhangsan')).toBeVisible();
    await expect(section.getByLabel('报销系统密码')).toHaveCount(0);
    await v.shot('saved-untested');
  });
  const saved = await v.api.get('/api/erp-credentials');
  v.note(`GET /api/erp-credentials after saving: ${JSON.stringify(saved)}`);
  expect(JSON.stringify(saved)).not.toContain(PASSWORD);
  expect(saved).toMatchObject({ available: true, status: 'untested', erpAccount: 'verify-zhangsan' });
  await v.step('reload: the account and status come back, the password does not', async () => {
    await page.reload();
    await expect(section.getByRole('heading', { name: '已保存，还没有试登录成功' })).toBeVisible();
    expect(await page.content()).not.toContain(PASSWORD);
  });
  const taskId = await v.confirmedTask();
  // Saved but untested (nothing paired) says nothing about a 本地执行器: the card keeps the 浏览器扩展 copy. The authorised
  // case (本地执行器 copy and the 挤下线 warning) needs a 试登录 and is covered by web/src/pages/ReviewPage.test.tsx.
  await v.step('untested 凭据: the 去报销 card on the review page does not claim a 本地执行器 signs in', async () => {
    await page.goto(`/#/task/${taskId}/review`);
    await expect(page.getByRole('button', { name: '去报销', exact: true })).toBeVisible();
    await expect(page.getByText('已配对的浏览器扩展会为这次报销打开报销系统标签页', { exact: false })).toBeVisible();
    await expect(page.getByText('挤下线')).toHaveCount(0);
    await v.shot('review-untested');
  });
  await v.step('清除 and confirm', async () => {
    await page.goto('/#/settings');
    await section.getByRole('button', { name: '清除报销系统账号密码' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '清除报销系统账号密码' }).click();
    await expect(section.getByRole('heading', { name: '还没有保存' })).toBeVisible();
    await v.shot('cleared');
  });
  const cleared = await v.api.get('/api/erp-credentials');
  v.note(`GET /api/erp-credentials after clearing: ${JSON.stringify(cleared)}`);
  expect(cleared).toMatchObject({ status: 'none', erpAccount: null });
}
