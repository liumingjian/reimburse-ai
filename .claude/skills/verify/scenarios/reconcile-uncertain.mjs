// 去报销 whose save attempt ends in 写入结果不确定 (the scripted `uncertain_save` double): the task goes to 对账; the
// page shows ERP's own words and offers 开始对账 / 转人工; the read-only 对账 finds no form (未知); 转人工 ends it.
export const fake = 'uncertain_save';

export default async function reconcileUncertain(v) {
  const { page, expect } = v;
  await v.signIn();
  const taskId = await v.confirmedTask();
  await v.step('click 去报销; the write ends uncertain', async () => {
    await page.goto(`/#/task/${taskId}/review`);
    await page.getByRole('button', { name: '去报销', exact: true }).click();
    await expect.poll(async () => (await v.api.snapshot(taskId)).stage, { timeout: 30_000 }).toBe('reconcile');
  });
  const bar = page.getByRole('region', { name: '处置' });
  await v.step('the 对账 page explains and offers 开始对账 / 转人工', async () => {
    await page.goto(`/#/task/${taskId}/reconcile`);
    await expect(page.getByRole('alert')).toContainText('写入结果不确定');
    await expect(page.getByTestId('erp-text')).toHaveText('保存未完成：报销系统没有返回处理结果。');
    await expect(bar.getByRole('button')).toHaveText(['开始对账', '转人工']);
    await v.shot('reconcile-offered');
  });
  await v.step('开始对账 reads ERP and finds no form', async () => {
    await bar.getByRole('button', { name: '开始对账' }).click();
    await expect(page.getByTestId('reconcile-bucket')).toHaveText('未知');
    await v.shot('reconcile-unknown');
  });
  await v.step('转人工', async () => {
    await bar.getByRole('button', { name: '转人工' }).click();
    await expect(page.getByTestId('reconcile-status')).toHaveText('已转人工');
    await v.shot('handed-off');
  });
  const after = await v.record('handed-off', taskId);
  expect(after).toMatchObject({ stage: 'reconcile', reconcile: { status: 'handed_off' } });
}
