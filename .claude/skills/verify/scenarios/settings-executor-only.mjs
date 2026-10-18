// The 设置页 shows the baox 本地执行器 only (ADR-0037, #437): no 去报销的方式 to choose, no 浏览器扩展 section, and the
// old tutorial route is gone. Then the 去报销 refusal without a pairing: the verify server always has an executor
// injected, so it never refuses by itself; the refusal body the real server sends (#435) is played by a page route,
// and what is proved is the page: the reason in place, the 「去设置页」 link, and the way back. The confirmed task is
// set up through the API (`v.confirmedTask()`).
export const fake = null;

const NOT_PAIRED = '先在设置页安装本地执行器。';

export default async function settingsExecutorOnly(v) {
  const { page, expect } = v;
  await v.signIn();
  await v.step('open the 设置页', async () => {
    await page.goto('/#/settings');
    await expect(page.getByRole('region', { name: 'baox 本地执行器' })).toBeVisible();
    await expect(page.getByRole('radio', { name: /本地执行器|浏览器扩展/ })).toHaveCount(0);
    await expect(page.getByRole('region', { name: '浏览器扩展' })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('扩展');
    await v.shot('settings');
  });
  await v.step('the old tutorial route lands on the task list', async () => {
    await page.goto('/#/settings/tutorial');
    await expect(page).toHaveURL(/#\/tasks$/);
  });

  const taskId = await v.confirmedTask();
  await page.route(`**/api/tasks/${taskId}/actions/start-erp-write`, (route) =>
    route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'executor_not_paired', message: NOT_PAIRED, link: 'settings' } }) }),
  );
  const card = page.getByRole('region', { name: '去报销' });
  await v.step('click 去报销 with nothing paired', async () => {
    await page.goto(`/#/task/${taskId}/review`);
    await card.getByRole('button', { name: '去报销', exact: true }).click();
    await expect(card.getByRole('alert')).toContainText(NOT_PAIRED);
    await expect(page).toHaveURL(new RegExp(`#/task/${taskId}/review$`));
    await v.shot('refused');
  });
  const refused = await v.record('refused', taskId);
  expect(refused).toMatchObject({ stage: 'actions', step: { kind: 'choose_action' }, erp: { status: 'idle' } });
  await v.step('follow 去设置页 and come back', async () => {
    await card.getByRole('link', { name: '去设置页' }).click();
    await expect(page.getByRole('region', { name: 'baox 本地执行器' })).toBeVisible();
    await v.shot('settings-from-task');
    await page.getByRole('region', { name: '返回报销任务' }).getByRole('link', { name: '返回报销任务' }).click();
    await expect(page).toHaveURL(new RegExp(`#/task/${taskId}/review$`));
  });
  const back = await v.record('back', taskId);
  expect(back.erp.status).toBe('idle');
}
