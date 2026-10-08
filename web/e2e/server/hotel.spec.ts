import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR, SAMPLE_MATERIALS } from '@baox/fixtures';
import { STAY_TRIO_COPY, TaskSnapshotSchema, type TaskSnapshot } from '@baox/contract';
import type { Browser, Page } from '@playwright/test';
import { answerStayGaps, expect, paymentScreenshot, signIn, test } from './fixture';

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

// ADR-0032: the missing-screenshot 待确认项 takes 支付截图 from one file dialog; they go up as a batch placed with the
// invoice and inventory runs again. The real OCR reads them, their sum covers the invoice, so the stay settles by
// itself, the 清单 shows them in the stay with 改归属, and the confirmed list prints them on a continuation page.
test('住宿发票的支付截图：在待确认项里一次选两张，重新盘点后按金额合计归到这次住宿，这一项自动处理完；打印稿印在续页', async ({ page }) => {
  test.setTimeout(240_000);
  await inventory(page, [sample('m01'), sample('m02')]);
  const taskId = /#\/task\/([^/]+)\//.exec(page.url())?.[1] ?? '';
  const read = async () => TaskSnapshotSchema.parse(await (await page.request.get(`/api/tasks/${taskId}`)).json());
  await expect.poll(async () => (await read()).stage, { timeout: 60_000 }).toBe('pending');

  await page.goto(`/#/task/${taskId}/pending`);
  const copy = STAY_TRIO_COPY.screenshot;
  const detail = page.getByLabel('待确认项详情');
  await expect(detail.getByRole('heading', { name: copy.title(sample('m01').name) })).toBeVisible();
  const shots = [
    { name: '付款第1天.png', mimeType: 'image/png', buffer: await paymentScreenshot(page, { amount: '1820.00', paidAt: '2026-08-09 13:01:12', payee: '上海某某酒店管理有限公司', number: '4200000000202608090000000001' }) },
    { name: '付款第2天.png', mimeType: 'image/png', buffer: await paymentScreenshot(page, { amount: '1830.00', paidAt: '2026-08-15 08:46:16', payee: '上海某某酒店管理有限公司', number: '4200000000202608150000000002' }) },
  ];
  await detail.getByLabel(copy.inputLabel(sample('m01').name)).setInputFiles(shots);
  await expect(page).toHaveURL(new RegExp(`#/task/${taskId}/inventory$`));

  // 1820.00 + 1830.00 = 3650.00 covers the 3640.00 invoice: nothing is left to answer.
  await expect.poll(async () => (await read()).stage, { timeout: 120_000 }).toBe('project');
  const done = await read();
  const invoice = done.materials.find((material) => material.fileName === sample('m01').name);
  for (const shot of shots) expect(done.materials.find((material) => material.fileName === shot.name)).toMatchObject({ kind: 'payment_screenshot', status: 'ok', payment: { invoiceId: invoice?.materialId } });
  expect(done.pendingItems).toEqual([expect.objectContaining({ itemId: `stay_screenshot_missing.${invoice?.materialId}`, status: 'resolved' })]);
  expect(invoice?.checkText).toContain('实付比发票多 10.00 元');

  // The 清单 lists them in the stay, each with 改归属.
  await page.goto(`/#/task/${taskId}/inventory`);
  await page.getByRole('button', { name: '费用事件 No.1', exact: true }).click();
  await expect(page.getByLabel(`改归属：${shots[0]!.name}`)).toHaveValue(invoice?.materialId ?? '');

  // Confirmed, the list prints both on the continuation page after the hotel page.
  expect((await page.request.post('/api/project-book/intake', { data: { number: 'P-2307', name: '华东客户交付' } })).ok()).toBe(true);
  const ready = await read();
  const assigned = await page.request.post(`/api/tasks/${taskId}/actions/submit-project-assignment`, {
    data: { purpose: '上海产品评审出差', projects: Object.fromEntries(ready.lines.map((line) => [line.lineId, 'P-2307'])), stepToken: ready.step.stepToken },
  });
  expect(assigned.ok()).toBe(true);
  await page.goto(`/#/task/${taskId}/review`);
  await page.getByRole('region', { name: '整单确认' }).getByRole('button', { name: '确认整单明细', exact: true }).click();
  await page.getByRole('link', { name: '去打印', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/task/${taskId}/print$`));
  await expect(page.getByRole('list', { name: '打印稿页面' }).locator('.page-hdr')).toHaveText(['No.1 · 08-09 · 住宿 · 3640.00', 'No.1 支付截图（续） · 全季酒店（上海某某店） · 3640.00'], { timeout: 60_000 });
  const printed = await read();
  expect(printed.printSheet.pages[1]?.screenshotIds).toEqual(shots.map((shot) => printed.materials.find((material) => material.fileName === shot.name)?.materialId));
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
