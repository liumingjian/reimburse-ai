import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR, SAMPLE_MATERIALS } from '@baox/fixtures';
import { TaskSnapshotSchema, type TaskSnapshot } from '@baox/contract';
import type { Locator, Page } from '@playwright/test';
import { answerStayGaps, expect, paymentScreenshot, signIn, test } from './fixture';

// Slice 11 (#190) on the real server: 去打印. A task with a hotel invoice, its folio and a taxi photo is brought to
// choose_action through the API; the page then generates the merged sheet, and the user rotates, crops and downloads
// the PDF. None of it touches the confirmation.

const samples = ['m01', 'm02', 'm09'].map((prefix) => {
  const found = SAMPLE_MATERIALS.find((sample) => sample.file.startsWith(prefix));
  if (!found) throw new Error(`fixture ${prefix} is missing from @baox/fixtures`);
  return found;
});

const TAXI_HEADER = 'No.1 · 08-15 · 外地市内交通 · 32.00';
const HOTEL_HEADER = 'No.2 · 08-09 · 住宿 · 3640.00';

async function snapshotOf(page: Page, taskId: string): Promise<TaskSnapshot> {
  return TaskSnapshotSchema.parse(await (await page.request.get(`/api/tasks/${taskId}`)).json());
}

async function act(page: Page, snapshot: TaskSnapshot, name: string, body: Record<string, unknown> = {}): Promise<TaskSnapshot> {
  const response = await page.request.post(`/api/tasks/${snapshot.task.taskId}/actions/${name}`, { data: { ...body, stepToken: snapshot.step.stepToken } });
  if (!response.ok()) throw new Error(`${name} failed: ${response.status()} ${await response.text()}`);
  return TaskSnapshotSchema.parse(await response.json());
}

// `screenshots`: how many 支付截图 are uploaded with the materials (ADR-0032); together they pay the hotel invoice.
async function confirmedTask(page: Page, materials = samples, screenshots = 0): Promise<string> {
  const created = TaskSnapshotSchema.parse(await (await page.request.post('/api/tasks', { data: { homeCity: '杭州' } })).json());
  const taskId = created.task.taskId;
  for (const sample of materials) {
    const mimeType = sample.file.endsWith('.jpg') ? 'image/jpeg' : 'application/pdf';
    const uploaded = await page.request.post(`/api/tasks/${taskId}/batches`, { multipart: { files: { name: sample.fileName, mimeType, buffer: readFileSync(join(GENERATED_DIR, sample.file)) } } });
    expect(uploaded.ok()).toBe(true);
  }
  for (let n = 1; n <= screenshots; n += 1) {
    // 3640.00 in equal parts, the last taking the odd cents, each paid on a night of the 08-09 to 08-22 stay.
    const part = Math.floor(364000 / screenshots);
    const amount = ((n === screenshots ? 364000 - part * (screenshots - 1) : part) / 100).toFixed(2);
    const buffer = await paymentScreenshot(page, { amount, paidAt: `2026-08-${String(8 + n).padStart(2, '0')} 12:00:0${n}`, payee: '上海某某酒店管理有限公司', number: `42000000002026080${n}00000000000${n}` });
    const uploaded = await page.request.post(`/api/tasks/${taskId}/batches`, { multipart: { files: { name: `付款${n}.png`, mimeType: 'image/png', buffer } } });
    expect(uploaded.ok()).toBe(true);
  }
  await act(page, await snapshotOf(page, taskId), 'start-inventory');
  // Waits out inventory and answers the 住宿 trio gaps it raises.
  await answerStayGaps(page, taskId);
  expect((await page.request.post('/api/project-book/intake', { data: { number: 'P-2307', name: '华东客户交付' } })).ok()).toBe(true);
  const ready = await snapshotOf(page, taskId);
  const review = await act(page, ready, 'submit-project-assignment', { purpose: '上海产品评审出差', projects: Object.fromEntries(ready.lines.map((line) => [line.lineId, 'P-2307'])) });
  const confirmed = await act(page, review, 'confirm-review', { digest: review.confirmation.digest });
  expect(confirmed).toMatchObject({ stage: 'actions', step: { kind: 'choose_action' } });
  return taskId;
}

async function expectLoaded(image: Locator) {
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
}

test.describe('confirmed print and ERP navigation', () => {
  test.use({ serverEnv: { BAOX_ERP_FAKE: 'drafted' } });

  test('readable preview controls and both routes retain the same confirmation', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await signIn(page);
    const taskId = await confirmedTask(page, samples.filter((sample) => sample.file.endsWith('.pdf')));
    const before = await snapshotOf(page, taskId);
    await page.goto(`/#/task/${taskId}/print`);
    const image = page.locator('.app-page-image').first();
    await expectLoaded(image);
    const list = page.getByRole('list', { name: '打印稿页面' });
    const images = list.locator('img.app-page-image');
    const firstRow = Math.min(await images.count(), 4);
    for (const [width, height] of [[1366, 768], [1920, 1080]]) {
      await page.setViewportSize({ width: width!, height: height! });
      await expect(page.getByRole('toolbar', { name: '打印稿查看' })).toBeInViewport();
      // The pages tile, four to a row by default (QA 2026-09-30): one top edge, about a quarter of the list width each.
      const listBox = (await list.boundingBox())!;
      const boxes = await Promise.all(Array.from({ length: firstRow }, (_, n) => images.nth(n).boundingBox()));
      for (const box of boxes) {
        expect(Math.abs(box!.y - boxes[0]!.y)).toBeLessThan(2);
        expect(box!.width).toBeLessThan(listBox.width / 4);
        expect(box!.width).toBeGreaterThan(listBox.width / 6);
      }
      await page.screenshot({ path: testInfo.outputPath(`print-${width}.png`) });
    }
    await page.getByRole('tablist', { name: '每行页数' }).getByRole('tab', { name: '每行 3 页' }).click();
    const listBox = (await list.boundingBox())!;
    const first = (await image.boundingBox())!;
    expect(first.width).toBeGreaterThan(listBox.width / 4);
    expect(first.width).toBeLessThan(listBox.width / 3);
    await page.reload();
    await expect(page.getByRole('tablist', { name: '每行页数' }).getByRole('tab', { name: '每行 3 页' })).toHaveAttribute('aria-selected', 'true');
    // A click on a page opens it full screen.
    await image.click();
    await expect(page.getByRole('img', { name: '第 1 页页图（全屏）' })).toBeVisible();
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    expect((await snapshotOf(page, taskId)).confirmation).toEqual(before.confirmation);
    await page.getByRole('button', { name: '去报销', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`#/task/${taskId}/erp$`));
    await expect.poll(async () => (await snapshotOf(page, taskId)).erp.status).toBe('done');
    await page.getByRole('link', { name: '去打印', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`#/task/${taskId}/print$`));
    await page.getByRole('link', { name: '查看填报进度', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`#/task/${taskId}/erp$`));
    expect((await snapshotOf(page, taskId)).confirmation).toEqual(before.confirmation);
  });
});

test('去打印：生成合并打印稿，旋转、四角裁剪，下载 PDF；预览页不补充支付截图；整单明细确认不变', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await signIn(page);
  const taskId = await confirmedTask(page);
  const confirmation = (await snapshotOf(page, taskId)).confirmation;

  await page.goto(`/#/task/${taskId}/review`);
  await page.getByRole('link', { name: '去打印', exact: true }).click();
  const pages = page.getByRole('list', { name: '打印稿页面' });
  await expect(pages.locator('.page-hdr')).toHaveText([TAXI_HEADER, HOTEL_HEADER], { timeout: 60_000 });
  const taxi = pages.getByRole('listitem', { name: TAXI_HEADER, exact: true });
  const hotel = pages.getByRole('listitem', { name: HOTEL_HEADER, exact: true });
  await expectLoaded(taxi.locator('img.app-page-image'));
  await expectLoaded(hotel.locator('img.app-page-image'));
  // The absence was recorded at inventory (确认没有支付截图 above), so the notice says so instead of asking again (#213).
  await expect(page.getByRole('status', { name: '打印提醒' })).toHaveCount(0);

  // Rotate the folio: the page image is rendered again and the button flips.
  const hotelImage = hotel.locator('img.app-page-image');
  const before = (await hotelImage.getAttribute('src')) ?? '';
  const rotateFolio = hotel.getByRole('button', { name: /^(旋转 90°|改为竖放)：全季酒店_结账单\.pdf$/ });
  const wasTurned = (await hotel.getByRole('button', { name: '改为竖放：全季酒店_结账单.pdf' }).count()) > 0;
  await rotateFolio.click();
  await expect(hotelImage).not.toHaveAttribute('src', before);
  await expect(hotel.getByRole('button', { name: `${wasTurned ? '旋转 90°' : '改为竖放'}：全季酒店_结账单.pdf` })).toBeVisible();
  await expectLoaded(hotelImage);

  // Crop the taxi photo on its original: nudge the bottom-right corner and submit; the server echoes the corners.
  await taxi.getByRole('button', { name: '调整四角：IMG_4871.jpg' }).click();
  const editor = page.getByRole('region', { name: '四角裁剪' });
  await expect.poll(() => editor.getByRole('img', { name: 'IMG_4871.jpg 原图' }).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await editor.getByRole('button', { name: '拖动右下角' }).focus();
  await page.keyboard.press('Shift+ArrowLeft');
  await editor.getByRole('button', { name: '提交裁剪' }).click();
  await expect(page.getByTestId('crop-receipt')).toContainText('已提交裁剪：');
  await expect(editor).toHaveCount(0);

  // The preview does not take payment screenshots (QA 2026-09-30); the 住宿 one is uploaded in its 待确认项.
  await expect(page.getByRole('button', { name: /支付截图/ })).toHaveCount(0);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await expectLoaded(hotelImage);
  await page.screenshot({ path: testInfo.outputPath('print.png'), fullPage: true });

  // Download the merged PDF.
  const downloading = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载打印稿 PDF' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^打印稿_.+\.pdf$/);
  const bytes = readFileSync(await download.path());
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(bytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g)?.length).toBe(2);

  expect((await snapshotOf(page, taskId)).confirmation).toEqual(confirmation);
});

// #333, ADR-0032: three 支付截图 uploaded with the materials are read, placed with the hotel invoice by date, and move to
// a continuation page right after its page. It tiles, opens full screen and is in the downloaded PDF like any other page.
test('住宿发票有 3 张支付截图：发票页后紧跟支付截图续页，可全屏查看，下载的 PDF 含续页', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  const taskId = await confirmedTask(page, samples.filter((sample) => sample.file.endsWith('.pdf')), 3);
  const hotelHeader = 'No.1 · 08-09 · 住宿 · 3640.00';
  const continuationHeader = 'No.1 支付截图（续） · 全季酒店（上海某某店） · 3640.00';

  await page.goto(`/#/task/${taskId}/print`);
  const pages = page.getByRole('list', { name: '打印稿页面' });
  await expect(pages.locator('.page-hdr')).toHaveText([hotelHeader, continuationHeader], { timeout: 60_000 });
  await expect(page.getByRole('status', { name: '打印提醒' })).toHaveCount(0);
  const continuation = pages.getByRole('listitem', { name: continuationHeader, exact: true });
  await expectLoaded(continuation.locator('img.app-page-image'));
  // Screenshots are neither turned nor cropped: the continuation page has no placement actions; the folio keeps its own.
  await expect(continuation.getByRole('button', { name: /旋转|改为竖放|调整四角/ })).toHaveCount(0);
  await expect(pages.getByRole('listitem', { name: hotelHeader, exact: true }).getByRole('button', { name: /^(旋转 90°|改为竖放)：全季酒店_结账单\.pdf$/ })).toBeVisible();

  await continuation.getByRole('button', { name: '全屏查看第 2 页' }).click();
  await expect(page.getByRole('img', { name: '第 2 页页图（全屏）' })).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();

  const downloading = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载打印稿 PDF' }).click();
  const bytes = readFileSync(await (await downloading).path());
  expect(bytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g)?.length).toBe(2);
});
