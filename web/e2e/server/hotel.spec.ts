import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR, SAMPLE_MATERIALS } from '@baox/fixtures';
import { STAY_TRIO_COPY, TaskSnapshotSchema, type TaskSnapshot } from '@baox/contract';
import type { Browser, Page } from '@playwright/test';
import { answerStayGaps, expect, signIn, test } from './fixture';

// Slice 06 (#185) on the real server: a hotel invoice plus a 全季 结账单 (folio) give one line with check-in and
// check-out dates; a folio from another chain is unrecognised and offers 手工补填 (manual fill).

type Upload = { name: string; buffer: Buffer };

const sample = (prefix: string): Upload => {
  const found = SAMPLE_MATERIALS.find((candidate) => candidate.file.startsWith(prefix));
  if (!found) throw new Error(`fixture ${prefix} is missing from @baox/fixtures`);
  return { name: found.fileName, buffer: readFileSync(join(GENERATED_DIR, found.file)) };
};

// @baox/fixtures has no folio of another chain: print one with Chrome, same shape as m02 but a 汉庭 (Hanting) hotel.
async function otherChainFolio(browser: Browser): Promise<Upload> {
  const page = await browser.newPage();
  await page.setContent(`<html><body style="font-family: 'STHeiti', 'Arial Unicode MS', sans-serif; font-size: 13px; padding: 48px">
    <h1 style="font-size: 22px">结账单 GUEST FOLIO</h1>
    <div>汉庭酒店（杭州某某店）</div>
    <div>入住人：林颂宜　房号：0612</div>
    <div>入住日期：2026-08-09</div><div>离店日期：2026-08-11</div><div>天数：2</div>
    <div>消费合计 398.00</div>
  </body></html>`);
  const buffer = await page.pdf({ format: 'A4' });
  await page.close();
  return { name: '汉庭酒店_结账单.pdf', buffer };
}

async function inventory(page: Page, files: readonly Upload[]): Promise<TaskSnapshot> {
  await signIn(page);
  await page.goto('/#/tasks');
  await page.getByRole('button', { name: '新建报销任务' }).click();
  const dialog = page.getByRole('dialog', { name: '新建报销任务' });
  await dialog.getByLabel('常驻城市').fill('杭州');
  await dialog.getByRole('button', { name: '创建并上传材料' }).click();
  await expect(page).toHaveURL(/#\/task\/[^/]+\/upload$/);
  const taskId = /#\/task\/([^/]+)\//.exec(page.url())?.[1] ?? '';

  await page.getByLabel('拖入文件，或点击选择', { exact: true }).setInputFiles(files.map((file) => ({ name: file.name, mimeType: 'application/pdf', buffer: file.buffer })));
  const batch = page.locator('section', { has: page.getByRole('heading', { name: /^上传批次 #1$/ }) });
  for (const file of files) await expect(batch.getByText(file.name, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '开始材料盘点' }).click();
  await expect(page).toHaveURL(/#\/task\/[^/]+\/inventory$/);
  await expect(page.getByRole('group', { name: '盘点摘要' })).toContainText(`材料${files.length} 份`);
  return TaskSnapshotSchema.parse(await (await page.request.get(`/api/tasks/${taskId}`)).json());
}

test('酒店发票加全季结账单，盘点后得到一条带入住和离店日期的住宿明细', async ({ page }) => {
  const snapshot = await inventory(page, [sample('m01'), sample('m02')]);

  const event = page.getByRole('button', { name: '费用事件 No.1', exact: true }).locator('xpath=ancestor::tr[1]');
  await expect(event).toContainText('08-09 至 08-22');
  await expect(event).toContainText('住宿');
  await expect(event).toContainText('3640.00');

  const folio = snapshot.materials.find((material) => material.fileName === sample('m02').name);
  expect(folio).toMatchObject({ kind: 'hotel_folio', layout: 'labelled', role: 'reference', status: 'ok' });
  expect(snapshot.lines).toEqual([
    expect.objectContaining({ date: '2026-08-09', endDate: '2026-08-22', grossAmount: '3640.00', category: { code: 'accommodation', label: '住宿' }, referenceMaterialIds: [folio?.materialId] }),
  ]);
  // Paired, so #213's trio check asks only for the 支付截图; answering it with 确认没有 leaves no open item.
  const invoice = snapshot.materials.find((material) => material.fileName === sample('m01').name);
  expect(snapshot.pendingItems.map((item) => item.itemId)).toEqual([`stay_screenshot_missing.${invoice?.materialId}`]);
  const taskId = /#\/task\/([^/]+)\//.exec(page.url())?.[1] ?? '';
  await answerStayGaps(page, taskId);

  // A clean stay moves on to the project stage (#188).
  await expect.poll(async () => TaskSnapshotSchema.parse(await (await page.request.get(`/api/tasks/${taskId}`)).json()).stage).toBe('project');
});

// #331: the missing-screenshot 待确认项 takes a group of 支付截图 from one file dialog and settles on 「已传齐」; #332: it
// can be reopened to change the group.
test('住宿发票的支付截图：一次选两张，看到两张缩略图，点「已传齐」后这一项处理完；重新展开删掉一张仍已处理', async ({ page }) => {
  await inventory(page, [sample('m01'), sample('m02')]);
  const taskId = /#\/task\/([^/]+)\//.exec(page.url())?.[1] ?? '';
  const read = async () => TaskSnapshotSchema.parse(await (await page.request.get(`/api/tasks/${taskId}`)).json());
  await expect.poll(async () => (await read()).stage, { timeout: 60_000 }).toBe('pending');

  await page.goto(`/#/task/${taskId}/pending`);
  const copy = STAY_TRIO_COPY.screenshot;
  const detail = page.getByLabel('待确认项详情');
  await expect(detail.getByRole('heading', { name: copy.title(sample('m01').name) })).toBeVisible();
  const png = (n: number) => ({ name: `IMG_50${10 + n}.png`, mimeType: 'image/png', buffer: readFileSync(join(GENERATED_DIR, `print-pg${n}.png`)) });
  await detail.getByLabel(copy.inputLabel(sample('m01').name)).setInputFiles([png(1), png(2)]);

  const thumbnails = detail.getByRole('list', { name: '已上传的支付截图' }).getByRole('img');
  await expect(thumbnails).toHaveCount(2);
  await expect(thumbnails.nth(0)).toHaveAccessibleName(copy.thumbnail('IMG_5011.png', 1));
  await expect(thumbnails.nth(1)).toHaveAccessibleName(copy.thumbnail('IMG_5012.png', 2));
  await expect(detail.getByText(copy.count(2))).toBeVisible();
  // Uploads alone leave the item open.
  expect((await read()).pendingItems).toEqual([expect.objectContaining({ itemId: expect.stringMatching(/^stay_screenshot_missing\./), status: 'open' })]);

  await detail.getByRole('button', { name: copy.complete, exact: true }).click();
  await expect(page.getByRole('heading', { name: '没有待确认项了' })).toBeVisible();
  const done = await read();
  expect(done.pendingItems).toEqual([expect.objectContaining({ status: 'resolved' })]);
  expect(done.paymentScreenshots.map((shot) => shot.fileName)).toEqual(['IMG_5011.png', 'IMG_5012.png']);
  expect(done.stage).toBe('project');

  // #332: reopened from the all-done view, removing one of the two keeps the item resolved.
  await page.getByRole('button', { name: copy.reopen }).click();
  await detail.getByRole('button', { name: copy.remove('IMG_5011.png', 1) }).click();
  await expect(thumbnails).toHaveCount(1);
  await expect(thumbnails.nth(0)).toHaveAccessibleName(copy.thumbnail('IMG_5012.png', 1));
  await expect(detail.getByText(copy.count(1))).toBeVisible();
  await expect(page.getByRole('heading', { name: '没有待确认项了' })).toBeVisible();
  const reopened = await read();
  expect(reopened.pendingItems).toEqual([expect.objectContaining({ status: 'resolved' })]);
  expect(reopened.paymentScreenshots.map((shot) => shot.fileName)).toEqual(['IMG_5012.png']);
  expect(reopened.stage).toBe('project');
});

test('其他连锁的结账单认不出版式，转到手工补填', async ({ page, browser }) => {
  const other = await otherChainFolio(browser);
  const snapshot = await inventory(page, [other]);

  await expect(page.getByText('未识别版式').first()).toBeVisible();
  const [material] = snapshot.materials;
  expect(material).toMatchObject({ kind: null, layout: null, status: 'pending' });
  expect(snapshot.pendingItems).toEqual([
    expect.objectContaining({ itemId: `unrecognised.${material?.materialId}`, status: 'open', choices: expect.arrayContaining([{ key: 'manual_fill', label: '手工补填' }]) }),
  ]);
  expect(snapshot.lines).toEqual([]);
  expect(snapshot.stage).toBe('pending');
});
