import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR, SAMPLE_MATERIALS } from '@baox/fixtures';
import { TaskSnapshotSchema, type TaskSnapshot } from '@baox/contract';
import type { Page } from '@playwright/test';
import { answerStayGaps, expect, signIn, test } from './fixture';

// Slice 08 (#187) on the real server: 待确认项 (pending items) answered on the pending page. An unrecognised PDF is
// resolved by 手工补填 (manual fill), and a 重复发票 (duplicate invoice) inside the task by exclusion.

type File = { name: string; mimeType: string; buffer: Buffer };

function sample(prefix: string): File {
  const found = SAMPLE_MATERIALS.find((candidate) => candidate.file.startsWith(prefix));
  if (!found) throw new Error(`fixture ${prefix} is missing from @baox/fixtures`);
  return { name: found.fileName, mimeType: 'application/pdf', buffer: readFileSync(join(GENERATED_DIR, found.file)) };
}

const snapshotOf = async (response: { json: () => Promise<unknown> }): Promise<TaskSnapshot> => TaskSnapshotSchema.parse(await response.json());

// Creates a task, uploads each file as its own batch, starts 材料盘点 and waits for the parser job.
async function inventoried(page: Page, files: readonly File[]): Promise<TaskSnapshot> {
  let snapshot = await snapshotOf(await page.request.post('/api/tasks', { data: { homeCity: '杭州' } }));
  const taskId = snapshot.task.taskId;
  for (const file of files) snapshot = await snapshotOf(await page.request.post(`/api/tasks/${taskId}/batches`, { multipart: { files: file } }));
  await page.request.post(`/api/tasks/${taskId}/actions/start-inventory`, { data: { stepToken: snapshot.step.stepToken } });
  await expect.poll(async () => (await snapshotOf(await page.request.get(`/api/tasks/${taskId}`))).inventory.status, { timeout: 20_000 }).toBe('done');
  return snapshotOf(await page.request.get(`/api/tasks/${taskId}`));
}

test('认不出的 PDF 选「手工补填」：在同一张表里选定材料种类、对照原件填写后，待确认项都处理完', async ({ page }) => {
  await signIn(page);
  const office = sample('m12');
  const { task } = await inventoried(page, [office]);
  await page.goto(`/#/task/${task.taskId}/pending`);

  await expect(page.getByRole('heading', { name: `认不出「${office.name}」` })).toBeVisible();
  await page.getByRole('button', { name: '手工补填' }).click();
  const form = page.getByRole('form', { name: `手工补填「${office.name}」` });
  await form.getByLabel('材料种类 *').selectOption({ label: '全电发票' });
  const fill = (label: string, value: string) => form.getByLabel(`${label} *`, { exact: true }).fill(value);
  await fill('发票号码', '26312000000105523361');
  await fill('开票日期', '2026-08-18');
  await fill('发票票种', '普票');
  await fill('销售方名称', '上海某某办公用品有限公司');
  await fill('项目名称', '*文具*签字笔');
  await fill('不含税金额', '84.96');
  await fill('税额', '11.04');
  await fill('价税合计', '96.00');
  await form.getByRole('button', { name: '保存并标记已处理' }).click();

  await expect(page.getByRole('heading', { name: '没有待确认项了' })).toBeVisible();
  const snapshot = await snapshotOf(await page.request.get(`/api/tasks/${task.taskId}`));
  expect(snapshot.materials[0]).toMatchObject({ kind: 'vat_invoice', layout: null, status: 'ok' });
  expect(snapshot.materials[0]?.fields.find((field) => field.key === 'totalAmount')).toMatchObject({ value: '96.00', source: 'user', editClass: 'fact_correctable' });
});

test('同一张发票传了两份：重复发票只能排除，排除后留下一条明细', async ({ page }) => {
  await signIn(page);
  const hotel = sample('m01');
  // The same invoice as a second file (a trailing PDF comment changes only the content hash).
  const copy = { ...hotel, name: '全季酒店_发票_副本.pdf', buffer: Buffer.concat([hotel.buffer, Buffer.from('\n% copy\n')]) };
  const { task } = await inventoried(page, [hotel, copy]);
  await page.goto(`/#/task/${task.taskId}/pending`);

  await expect(page.getByRole('heading', { name: `「${copy.name}」与「${hotel.name}」是同一张发票` })).toBeVisible();
  await page.getByRole('button', { name: '排除这份材料' }).click();

  // Excluding the copy lets the remaining invoice form its event; #213's trio check then asks it for its 结账单 and
  // 支付截图, answered here with 确认没有 because this test is about the duplicate.
  await answerStayGaps(page, task.taskId);
  await page.reload();
  await expect(page.getByRole('heading', { name: '没有待确认项了' })).toBeVisible();
  const snapshot = await snapshotOf(await page.request.get(`/api/tasks/${task.taskId}`));
  expect(snapshot.materials.map((material) => material.status)).toEqual(['ok', 'excluded']);
  expect(snapshot.lines).toEqual([expect.objectContaining({ grossAmount: '3640.00' })]);
});
