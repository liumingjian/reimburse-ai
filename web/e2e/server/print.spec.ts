import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR, SAMPLE_MATERIALS } from '@baox/fixtures';
import { TaskSnapshotSchema, type TaskSnapshot } from '@baox/contract';
import type { Locator, Page } from '@playwright/test';
import { answerStayGaps, expect, signIn, test } from './fixture';

// Slice 11 (#190) on the real server: 去打印. A task with a hotel invoice, its folio and a taxi photo is brought to
// choose_action through the API; the page then generates the merged sheet, and the user rotates, crops, attaches a
// 支付截图 (payment screenshot) and downloads the PDF. None of it touches the confirmation.

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

async function confirmedTask(page: Page, materials = samples): Promise<string> {
  const created = TaskSnapshotSchema.parse(await (await page.request.post('/api/tasks', { data: { homeCity: '杭州' } })).json());
  const taskId = created.task.taskId;
  for (const sample of materials) {
    const mimeType = sample.file.endsWith('.jpg') ? 'image/jpeg' : 'application/pdf';
    const uploaded = await page.request.post(`/api/tasks/${taskId}/batches`, { multipart: { files: { name: sample.fileName, mimeType, buffer: readFileSync(join(GENERATED_DIR, sample.file)) } } });
    expect(uploaded.ok()).toBe(true);
  }
  await act(page, await snapshotOf(page, taskId), 'start-inventory');
  // Waits out inventory and answers the 住宿 trio gaps it raises; the 支付截图 this test adds goes on from the print page.
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
  test.use({ serverEnv: { BAOX_ERP_FAKE: 'login_wall' } });

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
    await expect.poll(async () => (await snapshotOf(page, taskId)).erp.status).toBe('waiting_login');
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
  await expect(page.getByRole('status', { name: '打印提醒' })).toContainText('No.2 住宿发票在盘点时已确认没有支付截图');

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
