// 去报销 when ERP sits on its login page: the job pauses at 等待登录 with nothing written; 取消去报销 returns the task
// to 整单确认 and 去报销 is offered again. ERP is the scripted `login_wall` double (server/src/e2e-main.ts).
export const fake = 'login_wall';

export default async function loginWall(v) {
  const { page, expect } = v;
  await v.signIn();
  const taskId = await v.confirmedTask();
  await v.step('click 去报销 on the review page', async () => {
    await page.goto(`/#/task/${taskId}/review`);
    await page.getByRole('button', { name: '去报销', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`#/task/${taskId}/erp$`));
    await expect(page.getByRole('heading', { name: '填写报销单' })).toBeVisible();
  });
  await v.step('the job pauses for the employee login', async () => {
    await expect.poll(async () => (await v.api.snapshot(taskId)).step.kind, { timeout: 30_000 }).toBe('erp_login');
    await v.shot('waiting-login');
  });
  const paused = await v.record('waiting-login', taskId);
  expect(paused.erp).toMatchObject({ status: 'waiting_login', outcome: 'none' });
  await v.step('取消去报销', async () => {
    await page.getByRole('button', { name: '取消去报销' }).click();
    await expect(page).toHaveURL(new RegExp(`#/task/${taskId}/review$`));
    await expect(page.getByRole('button', { name: '去报销', exact: true })).toBeEnabled();
    await v.shot('cancelled');
  });
  const after = await v.record('after-cancel', taskId);
  expect(after).toMatchObject({ stage: 'actions', step: { kind: 'choose_action' }, erp: { status: 'idle' } });
}
