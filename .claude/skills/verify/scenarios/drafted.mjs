// 去报销 to its one ending (ADR-0037): the job signs in by itself, fills, 暂存s the bill and finds it again, ERP 草稿已交接.
// Nothing on the way waits for the employee. ERP is the scripted `drafted` double (server/src/e2e-main.ts).
export const fake = 'drafted';

export default async function drafted(v) {
  const { page, expect } = v;
  await v.signIn();
  const taskId = await v.confirmedTask();
  await v.step('click 去报销 on the review page', async () => {
    await page.goto(`/#/task/${taskId}/review`);
    await page.getByRole('button', { name: '去报销', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`#/task/${taskId}/erp$`));
    await expect(page.getByRole('heading', { name: '填写报销单' })).toBeVisible();
  });
  await v.step('the job runs through to 暂存 with nothing to click', async () => {
    await expect(page.getByRole('link', { name: '查看完成结果' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: '我已登录，继续' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: '去报销系统查看' })).toBeVisible();
    await v.shot('drafted');
  });
  const done = await v.record('drafted', taskId);
  expect(done).toMatchObject({ stage: 'done', erp: { status: 'done', outcome: 'drafted', draftNo: null, review: { draftId: '119946' } } });
}
