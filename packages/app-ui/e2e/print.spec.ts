import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// 打印稿预览：页图与页眉（页序跟随统一业务序号）、旋转、四角裁剪（鼠标拖动角点）、支付截图、下载合并 PDF；任何调整都不改变整单明细确认。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

const PAGE_HEADERS = [
  'No.1-3 · 08-10 · 外地市内交通 · 69.19',
  'No.4 · 08-11 · 外地市内交通 · 38.40',
  'No.5 · 08-15 · 外地市内交通 · 32.00',
  'No.6 · 08-19 · 外地市内交通 · 47.00',
  'No.7 · 08-09 · 长途交通 · 73.00',
  'No.8 · 08-22 · 长途交通 · 73.00',
  'No.9 · 08-09 · 住宿 · 3640.00',
];

const pageList = (page: Page) => page.getByRole('list', { name: '打印稿页面' });
const hotelCard = (page: Page) => pageList(page).getByRole('listitem', { name: 'No.9 · 08-09 · 住宿 · 3640.00', exact: true });

async function expectImageLoaded(page: Page, testId: string) {
  await expect.poll(() => page.getByTestId(testId).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
}

async function expectConfirmationUnchanged(page: Page) {
  await page.getByRole('link', { name: '返回确认页' }).click();
  await expect(page.getByRole('heading', { name: '整单明细确认' })).toBeVisible();
  await expect(page.getByText(/^整单明细已确认/)).toBeVisible();
  await expect(page.getByRole('link', { name: '去打印', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '整单确认' }).getByRole('button', { name: '确认整单明细', exact: true })).toHaveCount(0);
}

test('?seed=print 直接打开：7 页页图与页眉，缺支付截图提醒，下载链接指向合并 PDF', async ({ page }, testInfo) => {
  await page.goto(open('?seed=print', '#/task/T1/print'));
  await expect(page.getByRole('heading', { name: '打印稿预览' })).toBeVisible();
  await expect(pageList(page).locator('.page-hdr')).toHaveText(PAGE_HEADERS);
  for (const id of ['pg1', 'pg3', 'pg5', 'pg7']) await expectImageLoaded(page, `page-image-${id}`);
  await expect(page.getByRole('status', { name: '打印提醒' })).toContainText('No.9 住宿发票还没有支付截图');

  const download = page.getByRole('link', { name: '下载打印稿 PDF' });
  await expect(download).toBeVisible();
  const href = await download.getAttribute('href');
  expect(href).toBe('fixtures/print-sheet.pdf');
  const pdf = fileURLToPath(new URL(href ?? '', page.url()));
  expect(existsSync(pdf)).toBe(true);
  expect(readFileSync(pdf).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  await page.screenshot({ path: testInfo.outputPath('print.png'), fullPage: true });
});

test('从「去打印」进入：页面请服务端生成打印稿后逐页显示', async ({ page }) => {
  await page.goto(open('?seed=actions', '#/task/T1/review'));
  await page.getByRole('link', { name: '去打印', exact: true }).click();
  await expect(pageList(page).locator('.page-hdr')).toHaveText(PAGE_HEADERS);
  await expect(page.getByRole('link', { name: '下载打印稿 PDF' })).toHaveAttribute('href', 'fixtures/print-sheet.pdf');
});

test('支付截图只在打印稿页补充：住宿页补上后提醒消失，移除后回来；整单明细确认不变，确认页没有入口', async ({ page }, testInfo) => {
  await page.goto(open('?seed=print', '#/task/T1/print'));
  await expect(pageList(page).getByRole('button', { name: /^补充支付截图/ })).toHaveCount(1);
  await expect(hotelCard(page).getByRole('button', { name: '补充支付截图：全季酒店_发票.pdf' })).toBeVisible();
  await hotelCard(page)
    .getByLabel('选择支付截图：全季酒店_发票.pdf')
    .setInputFiles({ name: 'IMG_5011.png', mimeType: 'image/png', buffer: Buffer.from('png bytes') });
  await expect(hotelCard(page).getByText('IMG_5011.png')).toBeVisible();
  await expect(page.getByRole('status', { name: '打印提醒' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('print-screenshot.png'), fullPage: true });

  await hotelCard(page).getByRole('button', { name: '移除支付截图：全季酒店_发票.pdf' }).click();
  await expect(hotelCard(page).getByRole('button', { name: '补充支付截图：全季酒店_发票.pdf' })).toBeVisible();
  await expect(page.getByRole('status', { name: '打印提醒' })).toBeVisible();

  // 非图片被拒绝，原因就地显示。
  await hotelCard(page)
    .getByLabel('选择支付截图：全季酒店_发票.pdf')
    .setInputFiles({ name: '支付记录.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') });
  await expect(hotelCard(page).getByRole('alert')).toHaveText('只接受图片（JPG、PNG）。');

  await expectConfirmationUnchanged(page);
  await expect(page.getByRole('button', { name: /补充支付截图/ })).toHaveCount(0);
});

test('旋转：结账单改为竖放后页图更新，再旋转回来；整单明细确认不变', async ({ page }) => {
  await page.goto(open('?seed=print', '#/task/T1/print'));
  const image = page.getByTestId('page-image-pg7');
  await expect(image).toHaveAttribute('src', 'fixtures/print-pg7.png');
  await page.getByRole('button', { name: '改为竖放：全季酒店_结账单.pdf' }).click();
  await expect(image).toHaveAttribute('src', 'fixtures/print-pg7-r00.png');
  await expectImageLoaded(page, 'page-image-pg7');
  await page.getByRole('button', { name: '旋转 90°：全季酒店_结账单.pdf' }).click();
  await expect(image).toHaveAttribute('src', 'fixtures/print-pg7.png');
  await page.getByRole('button', { name: '改为竖放：IMG_4871.jpg' }).click();
  await expect(page.getByTestId('page-image-pg3')).toHaveAttribute('src', 'fixtures/print-pg3-r0.png');
  await expectConfirmationUnchanged(page);
});

test('四角裁剪：鼠标拖动角点，坐标以原图像素提交，回执显示回显坐标；整单明细确认不变', async ({ page }, testInfo) => {
  await page.goto(open('?seed=print', '#/task/T1/print'));
  await page.getByRole('button', { name: '调整四角：IMG_4871.jpg' }).click();
  const editor = page.getByRole('region', { name: '四角裁剪' });
  const original = editor.getByRole('img', { name: 'IMG_4871.jpg 原图' });
  await expect.poll(() => original.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(900);
  await expect(page.getByTestId('corner-0')).toHaveText('左上角(182, 167)');

  // 显示宽度与原图 900 像素之比；把左上角向右下拖 40 x 30 显示像素。鼠标坐标是视口坐标，先确保编辑器在视口内。
  await original.scrollIntoViewIfNeeded();
  const box = await original.boundingBox();
  const handle = editor.getByRole('button', { name: '拖动左上角' });
  const handleBox = await handle.boundingBox();
  if (!box || !handleBox) throw new Error('编辑器没有渲染出来');
  const scale = 900 / box.width;
  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 20, startY + 15, { steps: 4 });
  await page.mouse.move(startX + 40, startY + 30, { steps: 4 });
  await page.mouse.up();

  const expectedX = Math.round((startX + 40 - box.x) * scale);
  const expectedY = Math.round((startY + 30 - box.y) * (1200 / box.height));
  await expect(page.getByTestId('corner-0')).toHaveText(`左上角(${expectedX}, ${expectedY})`);
  expect(expectedX).toBeGreaterThan(182);
  expect(expectedY).toBeGreaterThan(167);

  // 键盘微调右下角：Shift+← 一次 10 像素。
  await editor.getByRole('button', { name: '拖动右下角' }).focus();
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(page.getByTestId('corner-2')).toHaveText('右下角(628, 893)');
  await page.screenshot({ path: testInfo.outputPath('crop-editor.png'), fullPage: true });

  await editor.getByRole('button', { name: '提交裁剪' }).click();
  await expect(page.getByTestId('crop-receipt')).toHaveText(`已提交裁剪：(${expectedX}, ${expectedY}) (586, 139) (628, 893) (234, 921)`);
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole('listitem', { name: 'No.5 · 08-15 · 外地市内交通 · 32.00' })).toContainText('已手动微调裁剪');
  await expectConfirmationUnchanged(page);
});
