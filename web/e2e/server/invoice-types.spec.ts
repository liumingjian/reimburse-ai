import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR, SAMPLE_MATERIALS } from '@baox/fixtures';
import { TaskSnapshotSchema, type TaskSnapshot } from '@baox/contract';
import type { Page } from '@playwright/test';
import { answerStayGaps, expect, hotelFolio, signIn, test } from './fixture';

test.use({ serverEnv: { BAOX_PARSE_FIXTURE: 'uncertain-invoice-type' } });

const snapshotOf = async (page: Page, taskId: string): Promise<TaskSnapshot> => TaskSnapshotSchema.parse(await (await page.request.get(`/api/tasks/${taskId}`)).json());

test('未知票面票种要求选择 ERP 发票类型，且不改写票面字段', async ({ page }) => {
  const sample = SAMPLE_MATERIALS.find((candidate) => candidate.file.startsWith('m01'));
  if (!sample) throw new Error('fixture m01 is missing from @baox/fixtures');

  await signIn(page);
  let snapshot = TaskSnapshotSchema.parse(await (await page.request.post('/api/tasks', { data: { homeCity: '杭州' } })).json());
  const taskId = snapshot.task.taskId;
  snapshot = TaskSnapshotSchema.parse(
    await (
      await page.request.post(`/api/tasks/${taskId}/batches`, {
        multipart: { files: { name: 'uncertain-invoice-type.pdf', mimeType: 'application/pdf', buffer: readFileSync(join(GENERATED_DIR, sample.file)) } },
      })
    ).json(),
  );
  snapshot = TaskSnapshotSchema.parse(await (await page.request.post(`/api/tasks/${taskId}/batches`, { multipart: { files: { ...hotelFolio(), name: 'uncertain-invoice-type-folio.pdf' } } })).json());
  await page.request.post(`/api/tasks/${taskId}/actions/start-inventory`, { data: { stepToken: snapshot.step.stepToken } });
  await answerStayGaps(page, taskId);

  await page.goto(`/#/task/${taskId}/pending`);
  await expect(page.getByRole('heading', { name: '为「uncertain-invoice-type.pdf」选择报销系统发票类型' })).toBeVisible();
  for (const label of ['普通发票', '增值税发票', '机票', '火车票', '其他运输票', '其他']) {
    await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: '其他', exact: true }).click();
  // The hotel trio is derived once the selected ERP type lets this voucher form a line.
  await answerStayGaps(page, taskId);
  await page.reload();
  await expect(page.getByRole('heading', { name: '没有待确认项了' })).toBeVisible();

  snapshot = await snapshotOf(page, taskId);
  expect(snapshot.materials[0]?.fields.find((field) => field.key === 'invoiceType')?.value).toBe('定额发票');
  expect(snapshot.lines).toEqual([expect.objectContaining({ invoiceType: '其他', invoiceTypeSource: 'employee_choice' })]);
});
