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
  expect(done.printSheet.status).toBe('not_generated');

  await v.step('return to the task list and open 去打印 for the first time after ERP completion', async () => {
    await page.getByRole('link', { name: '报销任务', exact: true }).click();
    const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: '去打印', exact: true }) });
    await expect(row.getByRole('link', { name: '查看结果' })).toBeVisible();
    await v.shot('completed-task-list');
    await row.getByRole('link', { name: '去打印', exact: true }).click();
    await expect(page.getByRole('heading', { name: '打印稿预览' })).toBeVisible();
    await expect(page.getByRole('link', { name: '下载打印稿 PDF' })).toBeVisible();
    await v.shot('print-from-list');
  });
  const generated = await v.record('print-from-list', taskId);
  expect(generated.printSheet.status).toBe('generated');

  await v.step('rotate a placement and download the PDF without changing the reimbursement', async () => {
    await page.getByRole('button', { name: /旋转 90°：|改为竖放：/ }).first().click();
    await expect.poll(async () => (await v.api.snapshot(taskId)).printSheet.pages[0].top.rotate).toBe(!generated.printSheet.pages[0].top.rotate);
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: '下载打印稿 PDF' }).click();
    expect(await (await download).failure()).toBeNull();
    await v.shot('print-rotated');
  });
  const rotated = await v.record('print-rotated', taskId);
  expect(rotated.stage).toBe('done');
  for (const field of ['erp', 'confirmation', 'lines', 'projectAssignment']) expect(rotated[field]).toEqual(done[field]);

  await v.step('open the completed task from its row and use its 去打印 entry again', async () => {
    await page.getByRole('link', { name: '报销任务', exact: true }).click();
    const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: '查看结果' }) });
    await row.getByRole('cell').first().click();
    await expect(page.getByRole('heading', { name: '完成', exact: true })).toBeVisible();
    await page.getByRole('link', { name: '去打印', exact: true }).click();
    await expect(page.getByRole('link', { name: '下载打印稿 PDF' })).toBeVisible();
    await v.shot('print-from-result');
  });
  const reopened = await v.record('print-from-result', taskId);
  expect(reopened.printSheet).toEqual(rotated.printSheet);
  expect(reopened.erp).toEqual(done.erp);
}
