import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR, SAMPLE_MATERIALS } from '@baox/fixtures';
import { TaskSnapshotSchema, type TaskSnapshot } from '@baox/contract';
import type { Browser, Page } from '@playwright/test';
import { answerStayGaps, expect, paymentScreenshot, signIn, test } from './fixture';

// Slice 06 (#185) on the real server: a hotel invoice plus a 全季 结账单 (folio) give one line with check-in and
// check-out dates; a folio from another chain is unrecognised and is filled by hand (手工补填) in one form.

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
  const buffer = await page.pdf({ format: 'A4'});
  await page.close();
  return { name: '汉庭酒店_结账单.pdf', buffer };
}

// A small hotel's receipt photographed: no layout reads it, but it prints the invoice's total and the stay's dates.
async function receiptPhoto(browser: Browser): Promise<Upload> {
  const page = await browser.newPage();
  await page.setViewportSize({ width: 750, height: 900});
  await page.setContent(`<html><body style="margin:0;background:#fff;font-family:'PingFang SC','STHeiti',sans-serif;font-size:30px;padding:60px">
    <div style="font-size:40px;margin-bottom:40px">某某商务宾馆</div>
    <div style="margin:24px 0">到达 2026-08-09</div><div style="margin:24px 0">离开 2026-08-22</div>
    <div style="margin:24px 0">合计 3640.00</div>
  </body></html>`);
  const buffer = await page.screenshot({ type: 'png'});
  await page.close();
  return { name: '宾馆收据.png', buffer };
}

async function inventory(page: Page, files: readonly Upload[]): Promise<TaskSnapshot> {
  await signIn(page);
  await page.goto('/#/tasks');
  await page.getByRole('button', { name: '新建报销任务' }).click();
  const dialog = page.getByRole('dialog', { name: '新建报销任务'});
  await dialog.getByLabel('常驻城市').fill('杭州');
  await dialog.getByRole('button', { name: '创建并上传材料' }).click();
  await expect(page).toHaveURL(/#\/task\/[^/]+\/upload$/);
  const taskId = /#\/task\/([^/]+)\//.exec(page.url())?.[1] ?? '';

  await page.getByLabel('拖入文件，或点击选择', { exact: true }).setInputFiles(files.map((file) => ({ name: file.name, mimeType: file.name.endsWith('.png') ? 'image/png' : 'application/pdf', buffer: file.buffer })));
  const batch = page.locator('section', { has: page.getByRole('heading', { name: /^上传批次 #1$/ })});
  for (const file of files) await expect(batch.getByText(file.name, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '开始材料盘点' }).click();
  await expect(page).toHaveURL(/#\/task\/[^/]+\/inventory$/);
  await expect(page.getByRole('group', { name: '盘点摘要' })).toContainText(`材料${files.length} 份`, { timeout: 60_000});
  return TaskSnapshotSchema.parse(await (await page.request.get(`/api/tasks/${taskId}`)).json());
}

test('酒店发票加全季结账单，盘点后得到一条带入住和离店日期的住宿明细', async ({ page }) => {
  const snapshot = await inventory(page, [sample('m01'), sample('m02')]);

  const event = page.getByRole('button', { name: '费用事件 No.1', exact: true }).locator('xpath=ancestor::tr[1]');
  await expect(event).toContainText('08-09 至 08-22');
  await expect(event).toContainText('住宿');
  await expect(event).toContainText('3640.00');

  const folio = snapshot.materials.find((material) => material.fileName === sample('m02').name);
  expect(folio).toMatchObject({ kind: 'hotel_folio', layout: 'labelled', role: 'reference', status: 'ok'});
  expect(snapshot.lines).toEqual([
    expect.objectContaining({ date: '2026-08-09', endDate: '2026-08-22', grossAmount: '3640.00', category: { code: 'accommodation', label: '住宿' }, referenceMaterialIds: [folio?.materialId] }),
  ]);
  // Paired, so #213's trio check asks only for the 支付截图; answering it with 确认没有 leaves no open item.
  const invoice = snapshot.materials.find((material) => material.fileName === sample('m01').name);
  expect(snapshot.pendingItems).toEqual([]);
  const taskId = /#\/task\/([^/]+)\//.exec(page.url())?.[1] ?? '';
  await answerStayGaps(page, taskId);

  // A clean stay moves on to the project stage (#188).
  await expect.poll(async () => TaskSnapshotSchema.parse(await (await page.request.get(`/api/tasks/${taskId}`)).json()).stage).toBe('project');
});

// Supplied payment screenshots enter through the normal upload flow and are placed with the
// invoice and inventory runs again. The real OCR reads them, their sum covers the invoice, so the stay settles by
// itself, the 清单 shows them in the stay with 改归属, and the confirmed list prints them on a continuation page.
test('住宿发票的支付截图：追加上传时一次选两张，重新盘点后按金额合计归到这次住宿，这一项自动处理完；打印稿印在续页', async ({ page }) => {
  test.setTimeout(240_000);
  await inventory(page, [sample('m01'), sample('m02')]);
  const taskId = /#\/task\/([^/]+)\//.exec(page.url())?.[1] ?? '';
  const read = async () => TaskSnapshotSchema.parse(await (await page.request.get(`/api/tasks/${taskId}`)).json());
  await expect.poll(async () => (await read()).stage, { timeout: 60_000 }).toBe('project');

  await page.goto(`/#/task/${taskId}/upload`);
  await page.getByRole('button', { name: '追加下一批', exact: true }).click();
  const shots = [
    { name: '付款第1天.png', mimeType: 'image/png', buffer: await paymentScreenshot(page, { amount: '1820.00', paidAt: '2026-08-09 13:01:12', payee: '上海某某酒店管理有限公司', number: '4200000000202608090000000001' }) },
    { name: '付款第2天.png', mimeType: 'image/png', buffer: await paymentScreenshot(page, { amount: '1830.00', paidAt: '2026-08-15 08:46:16', payee: '上海某某酒店管理有限公司', number: '4200000000202608150000000002' }) },
  ];
  await page.getByLabel('拖入文件，或点击选择', { exact: true }).setInputFiles(shots);
  await page.getByRole('button', { name: '开始材料盘点' }).click();
  await expect(page).toHaveURL(new RegExp(`#/task/${taskId}/inventory$`));

  // 1820.00 + 1830.00 = 3650.00 covers the 3640.00 invoice: nothing is left to answer.
  await expect.poll(async () => (await read()).stage, { timeout: 120_000 }).toBe('project');
  const done = await read();
  const invoice = done.materials.find((material) => material.fileName === sample('m01').name);
  for (const shot of shots) expect(done.materials.find((material) => material.fileName === shot.name)).toMatchObject({ kind: 'payment_screenshot', status: 'ok', payment: { invoiceId: invoice?.materialId }});
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
  await expect(page.getByRole('list', { name: '打印稿页面' }).locator('.page-hdr')).toHaveText(['No.1 · 08-09 · 住宿 · 3640.00', 'No.1 支付截图（续） · 全季酒店（上海某某店） · 3640.00'], { timeout: 60_000});
  const printed = await read();
  expect(printed.printSheet.pages[1]?.screenshotIds).toEqual(shots.map((shot) => printed.materials.find((material) => material.fileName === shot.name)?.materialId));
});

test('其他连锁的结账单认不出版式，在一张表里手工补填', async ({ page, browser }) => {
  const other = await otherChainFolio(browser);
  const snapshot = await inventory(page, [other]);

  await expect(page.getByText('未识别版式').first()).toBeVisible();
  const [material] = snapshot.materials;
  expect(material).toMatchObject({ kind: null, layout: null, status: 'pending'});
  expect(snapshot.pendingItems).toEqual([
    expect.objectContaining({ itemId: `unrecognised.${material?.materialId}`, status: 'open', choices: expect.arrayContaining([{ key: 'manual_fill', label: '手工补填' }]) }),
  ]);
  expect(snapshot.lines).toEqual([]);
  expect(snapshot.stage).toBe('pending');

  // #342: 手工补填 opens its form in place; the kind is picked there and one submit fills the folio.
  const taskId = snapshot.task.taskId;
  await page.goto(`/#/task/${taskId}/pending`);
  const detail = page.getByLabel('待确认项详情');
  await detail.getByRole('button', { name: '手工补填' }).click();
  const form = detail.getByRole('form', { name: `手工补填「${other.name}」`});
  await form.getByLabel('材料种类 *').selectOption({ label: '酒店结账单'});
  await form.getByLabel('入住日期 *').fill('2026-08-09');
  await form.getByLabel('离店日期 *').fill('2026-08-11');
  await form.getByLabel('消费合计 *').fill('398.00');
  await form.getByRole('button', { name: '保存并标记已处理' }).click();
  await expect(form.getByRole('button', { name: '保存并标记已处理' })).toBeHidden();
  const filled = TaskSnapshotSchema.parse(await (await page.request.get(`/api/tasks/${taskId}`)).json());
  expect(filled.materials[0]).toMatchObject({ kind: 'hotel_folio'});
  expect(filled.pendingItems.find((item) => item.itemId === `unrecognised.${material?.materialId}`)).toMatchObject({ status: 'resolved', answer: { kind: 'hotel_folio', folioTotal: '398.00' }});
});

// #336 decision 7c: the receipt is proposed as the invoice's folio, and one click pairs them into one stay.
test('认不出的宾馆收据图片带着发票的金额和日期：提议作为这张发票的结账单，一键确认', async ({ page, browser }) => {
  const receipt = await receiptPhoto(browser);
  const snapshot = await inventory(page, [sample('m01'), receipt]);
  const taskId = snapshot.task.taskId;
  const invoice = snapshot.materials.find((material) => material.fileName === sample('m01').name);
  const photo = snapshot.materials.find((material) => material.fileName === receipt.name);
  expect(snapshot.pendingItems.find((item) => item.itemId === `unrecognised.${photo?.materialId}`)?.choices[0]).toEqual({ key: `folio:${invoice?.materialId}`, label: `是「${sample('m01').name}」的结账单`});

  await page.goto(`/#/task/${taskId}/pending`);
  const detail = page.getByLabel('待确认项详情');
  await page.getByLabel('待确认项清单').getByRole('button', { name: new RegExp(`认不出「${receipt.name}」`) }).click();
  await detail.getByRole('button', { name: `是「${sample('m01').name}」的结账单` }).click();
  const read = async () => TaskSnapshotSchema.parse(await (await page.request.get(`/api/tasks/${taskId}`)).json());
  await expect.poll(async () => (await read()).materials.find((material) => material.fileName === receipt.name)?.kind).toBe('hotel_folio');

  const done = await read();
  expect(done.materials.find((material) => material.fileName === receipt.name)).toMatchObject({ kind: 'hotel_folio', linkedMaterialIds: [invoice?.materialId]});
  expect(done.lines[0]).toMatchObject({ date: '2026-08-09', endDate: '2026-08-22'});
});

test('住宿确认没有账单后重新打开仍可保存实际日期且不出现支付截图确认', async ({ page }) => {
  const start = await inventory(page, [sample('m01')]);
  const taskId = start.task.taskId;
  const read = async () => TaskSnapshotSchema.parse(await (await page.request.get(`/api/tasks/${taskId}`)).json());
  await page.goto(`/#/task/${taskId}/pending`);
  await page.getByRole('button', { name: '确认没有账单', exact: true }).click();
  await expect.poll(async () => (await read()).pendingItems[0]?.answer).toEqual({ choice: 'confirm_none'});
  await page.reload();
  await page.getByLabel('实际入住日期').fill('2026-08-10');
  await page.getByLabel('实际离店日期').fill('2026-08-20');
  await page.getByRole('button', { name: '保存费用详情' }).click();
  await expect.poll(async () => (await read()).stage).toBe('project');
  expect((await read()).lines[0]).toMatchObject({ date: '2026-08-10', endDate: '2026-08-20'});
  expect((await read()).pendingItems.some(item => item.itemId.startsWith('stay_screenshot_missing.'))).toBe(false);
  await page.reload();
  await page.getByRole('button', { name: '查看或修改费用详情' }).click();
  await page.getByRole('button', { name: '确认没有账单', exact: true }).click();
  await expect(page.getByLabel('实际入住日期')).toHaveValue('2026-08-10');
  expect((await read()).lines[0]!.date).toBe('2026-08-10');
});
