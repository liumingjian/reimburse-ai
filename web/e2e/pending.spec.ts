import { expect, test, type Page } from '@playwright/test';

// 待确认项（#102）。直接用 file:// 打开 mock 构建产物（pnpm build:mock）；原件预览来自 dist-mock/fixtures/。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

const list = (page: Page) => page.getByLabel('待确认项清单');
const detail = (page: Page) => page.getByLabel('待确认项详情');
// 按标题开头找条目（标题之间互为前缀时不串）；按文件名找用 itemByFile。
const item = (page: Page, title: string) => list(page).getByRole('button', { name: new RegExp(`^${title}`) });
const itemByFile = (page: Page, fileName: string) => list(page).getByRole('button', { name: new RegExp(fileName) });
const save = (page: Page) => detail(page).getByRole('button', { name: '保存并标记已处理' });

test('左右分栏：原件预览随选中项切换，夹具文件能从 dist-mock/fixtures 打开', async ({ page }, testInfo) => {
  await page.goto(open('?seed=pending', '#/task/T1/pending'));
  await expect(page.getByRole('heading', { name: '待确认项' })).toBeVisible();
  await expect(page.getByText('对照原件补填或作出选择。还剩 4 个。')).toBeVisible();
  await expect(list(page).getByRole('button')).toHaveCount(4);

  const photo = detail(page).getByRole('img', { name: 'IMG_4871.jpg 原件' });
  await expect(photo).toHaveAttribute('src', 'fixtures/m09-taxi-photo.jpg');
  // 图片真的加载到了（说明 mock 构建把夹具复制进了 dist-mock/fixtures/）。
  await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  // 读出的字段照常显示，但不显示来源（规则名 / user）。
  await expect(detail(page).getByText('04213377')).toBeVisible();
  await expect(detail(page)).not.toContainText('rule:');
  // 契约里的处理人不显示。
  await expect(page.getByRole('main')).not.toContainText('处理人');

  await item(page, '不支持的材料类型').click();
  const frame = detail(page).locator('iframe[title="办公用品_发票.pdf 原件"]');
  await expect(frame).toHaveAttribute('src', 'fixtures/m12-office-invoice.pdf');
  await expect(detail(page).getByRole('button', { name: '排除此材料' })).toBeVisible();

  await item(page, '下车时间不合法').click();
  await expect(detail(page).getByRole('img', { name: 'IMG_4906.jpg 原件' })).toHaveAttribute('src', 'fixtures/m10-taxi-photo.jpg');
  await expect(detail(page).getByText('90:60', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('pending-detail.png'), fullPage: true });
});

// 原件栏的内边距（$spacing-05 两侧）加两层 1px 边框。
const VIEWER_CHROME = 16 * 2 + 1 * 2 + 1 * 2;

for (const [width, height] of [
  [1440, 900],
  [1100, 900],
] as const) {
  test(`${width}：原件栏固定占 2/5，切换待确认项时表单左边不跳，保存按钮在首屏内；附截图`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await page.goto(open('?seed=pending', '#/task/T1/pending'));
    const photo = detail(page).getByRole('img', { name: 'IMG_4871.jpg 原件' });
    await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);

    const viewer = detail(page).getByTestId('doc-viewer');
    const form = detail(page).getByRole('form', { name: '补填起点与终点' });
    const [viewerBox, photoBox, formBox, saveBox] = await Promise.all([viewer.boundingBox(), photo.boundingBox(), form.boundingBox(), save(page).boundingBox()]);
    if (!viewerBox || !photoBox || !formBox || !saveBox) throw new Error('原件栏、原件、表单或保存按钮没有渲染');
    // 原件栏固定占两栏的 2/5（DESIGN.md「待确认项：原件与表单」, #319），照片在栏内居中、不溢出。
    const share = viewerBox.width / (formBox.x + formBox.width - viewerBox.x);
    expect(share).toBeGreaterThan(0.35);
    expect(share).toBeLessThan(0.45);
    expect(photoBox.width).toBeLessThanOrEqual(viewerBox.width - VIEWER_CHROME + 1);
    // 照片按高度等比缩放：宽高比保持 3:4。
    expect(Math.abs(photoBox.width / photoBox.height - 0.75)).toBeLessThan(0.01);
    // 表单在原件右侧，占剩余宽度，不窄于 400px。
    expect(formBox.x).toBeGreaterThan(viewerBox.x + viewerBox.width);
    expect(formBox.width).toBeGreaterThanOrEqual(400);
    // 保存按钮在首屏内。
    expect(saveBox.y + saveBox.height).toBeLessThanOrEqual(height);
    // 换到另一项（原件比例不同），表单栏的左边不动。
    const headingX = async () => (await detail(page).getByRole('heading', { level: 2 }).boundingBox())?.x;
    const before = await headingX();
    await item(page, '住宿发票').click();
    await expect(detail(page).getByRole('heading', { level: 2 })).toContainText('支付截图');
    expect(await headingX()).toBe(before);
    await page.screenshot({ path: testInfo.outputPath(`pending-${width}.png`) });
  });
}

// QA 2026-09-30: at 1366×768 the frame is too small to read a folio, and zooming inside it did not help. The frame
// keeps no zoom controls; the full-screen view shows the original as wide as the window allows.
test('原件全屏查看：1366×768 下原件铺开到可读宽度，可旋转，Esc 与点空白处关闭；附截图', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto(open('?seed=pending', '#/task/T1/pending'));
  const photo = detail(page).getByRole('img', { name: 'IMG_4871.jpg 原件' });
  await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
  const viewer = detail(page).getByTestId('doc-viewer');
  await expect(viewer.getByRole('toolbar')).toHaveCount(0);
  for (const name of ['放大', '缩小', '适应窗口']) await expect(viewer.getByRole('button', { name, exact: true })).toHaveCount(0);
  const frameWidth = (await photo.boundingBox())!.width;
  await page.screenshot({ path: testInfo.outputPath('viewer-frame-1366.png') });

  await viewer.getByRole('button', { name: '全屏查看', exact: true }).click();
  const dialog = page.getByRole('dialog').filter({ has: page.getByTestId('fullscreen-stage') });
  const large = dialog.getByRole('img', { name: 'IMG_4871.jpg 原件（全屏）' });
  await expect(large).toBeVisible();
  await expect(page.locator('.app-doc-fullscreen')).toHaveCSS('opacity', '1');
  // Focus lands on the image area, so no 「关闭」 tooltip pops up and the first Esc closes the view.
  await expect(page.getByTestId('fullscreen-stage')).toBeFocused();
  await expect(page.getByRole('tooltip').filter({ hasText: '关闭' })).toBeHidden();
  // The view covers the window, and the original is shown far larger than in the frame, up to the reading width.
  const dialogBox = (await dialog.boundingBox())!;
  expect(dialogBox.width).toBeGreaterThan(1366 - 2);
  expect(dialogBox.height).toBeGreaterThan(768 - 2);
  await expect.poll(async () => (await large.boundingBox())?.width ?? 0).toBeGreaterThan(Math.max(900, frameWidth * 2));
  expect((await large.boundingBox())!.width).toBeLessThanOrEqual(1024 + 1);
  await page.screenshot({ path: testInfo.outputPath('viewer-fullscreen-1366.png') });

  // Rotating turns it sideways, still within the reading width; the frame's original turns too.
  await dialog.getByRole('button', { name: '旋转 90°', exact: true }).click();
  await expect.poll(async () => {
    const box = await large.boundingBox();
    return box ? box.width > box.height && box.width <= 1024 + 1 : false;
  }).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('viewer-fullscreen-rotated.png') });

  await page.keyboard.press('Escape');
  await expect(large).toBeHidden();
  expect(await photo.getAttribute('style')).toContain('rotate(90deg)');

  // A click on the original opens it again; a click on the blank stage closes it.
  await viewer.getByTestId('doc-frame').click();
  await expect(large).toBeVisible();
  const stage = (await page.getByTestId('fullscreen-stage').boundingBox())!;
  await page.mouse.click(stage.x + 8, stage.y + stage.height - 8);
  await expect(large).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test('1000 宽（1056px 以下）：原件在上、表单在下，都不横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto(open('?seed=pending', '#/task/T1/pending'));
  const photo = detail(page).getByRole('img', { name: 'IMG_4871.jpg 原件' });
  await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
  const viewerBox = await detail(page).getByTestId('doc-viewer').boundingBox();
  const formBox = await detail(page).getByRole('form', { name: '补填起点与终点' }).boundingBox();
  if (!viewerBox || !formBox) throw new Error('原件栏或表单没有渲染');
  expect(formBox.y).toBeGreaterThanOrEqual(viewerBox.y + viewerBox.height);
  expect(viewerBox.x + viewerBox.width).toBeLessThanOrEqual(1000);
  expect(formBox.x + formBox.width).toBeLessThanOrEqual(1000);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('保存一项后：该行变淡并带「已处理」标签，页面上不出现「要你处理」', async ({ page }) => {
  await page.goto(open('?seed=pending', '#/task/T1/pending'));
  const titleColor = (title: string) => item(page, title).getByText(title, { exact: true }).evaluate((node) => getComputedStyle(node).color);
  const openColor = await titleColor('补填起点与终点');
  await detail(page).getByLabel('起点 *').fill('张江高科');
  await detail(page).getByLabel('终点 *').fill('漕河泾开发区');
  await save(page).click();
  await expect(page.getByText('还剩 3 个')).toBeVisible();
  await expect(item(page, '补填起点与终点').getByText('已处理', { exact: true })).toBeVisible();
  await expect(item(page, '下车时间不合法').getByText('已处理', { exact: true })).toHaveCount(0);
  expect(await titleColor('补填起点与终点')).not.toBe(openColor);
  await expect(page.getByText('要你处理')).toHaveCount(0);
});

test('表单校验：必填与 HH:MM 格式阻止非法值', async ({ page }) => {
  await page.goto(open('?seed=pending', '#/task/T1/pending'));
  await save(page).click();
  await expect(detail(page).getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(2);
  await expect(detail(page).getByRole('alert').filter({ hasText: /\S/ }).first()).toHaveText('必填，对照原件填写。');

  await item(page, '下车时间不合法').click();
  await detail(page).getByLabel('下车时间 *').fill('90:60');
  await detail(page).getByLabel('起点 *').fill('静安寺');
  await detail(page).getByLabel('终点 *').fill('虹桥枢纽');
  await save(page).click();
  await expect(detail(page).getByRole('alert').filter({ hasText: /\S/ })).toHaveText('格式应为 HH:MM，且小时 00-23、分钟 00-59。');
  await expect(page.getByText('还剩 4 个')).toBeVisible();
});

test('补填与排除：全部处理完显示没有待确认项了，并能进入整单明细确认', async ({ page }, testInfo) => {
  await page.goto(open('?seed=pending', '#/task/T1/pending'));
  await detail(page).getByLabel('起点 *').fill('张江高科');
  await detail(page).getByLabel('终点 *').fill('漕河泾开发区');
  await save(page).click();
  await expect(detail(page).getByRole('heading', { name: '下车时间不合法，并补填起点与终点' })).toBeVisible();
  await expect(item(page, '补填起点与终点')).toContainText('已处理');
  await expect(page.getByText('还剩 3 个')).toBeVisible();

  await detail(page).getByLabel('下车时间 *').fill('19:06');
  await detail(page).getByLabel('起点 *').fill('静安寺');
  await detail(page).getByLabel('终点 *').fill('虹桥枢纽');
  await save(page).click();
  await expect(detail(page).getByRole('heading', { name: '不支持的材料类型' })).toBeVisible();

  await detail(page).getByRole('button', { name: '排除此材料' }).click();
  // 住宿发票还没有支付截图（#213）：确认没有。
  await expect(detail(page).getByRole('heading', { name: '住宿发票「全季酒店_发票.pdf」缺少支付截图' })).toBeVisible();
  await detail(page).getByRole('button', { name: '确认没有支付截图' }).click();
  await expect(page.getByRole('heading', { name: '没有待确认项了' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('pending-empty.png'), fullPage: true });
  // 待确认项之后是项目归属（整单确认在项目归属之后）。
  await page.getByRole('link', { name: '进入项目归属' }).click();
  await expect(page).toHaveURL(/#\/task\/T1\/project$/);
  await expect(page.getByRole('heading', { name: '项目归属' })).toBeVisible();
  // 盘点页的入口也变成进入项目归属。
  await page.getByRole('list', { name: '流程阶段' }).getByRole('button', { name: /^材料盘点/ }).click();
  await expect(page.getByRole('link', { name: '进入项目归属' })).toBeVisible();
});

test('自行手工处理同样推进', async ({ page }) => {
  await page.goto(open('?seed=pending', '#/task/T1/pending'));
  await item(page, '不支持的材料类型').click();
  await detail(page).getByRole('button', { name: '自行手工处理' }).click();
  await expect(page.getByText('还剩 3 个')).toBeVisible();
  await expect(item(page, '不支持的材料类型')).toContainText('已处理');
});

test('?seed=review：待确认项页直接是空状态', async ({ page }) => {
  await page.goto(open('?seed=review', '#/task/T1/pending'));
  await expect(page.getByRole('heading', { name: '没有待确认项了' })).toBeVisible();
  await expect(page.getByRole('link', { name: '进入项目归属' })).toBeVisible();
});

test('?fault=unsupported-material：多出的不支持材料也能排除', async ({ page }) => {
  await page.goto(open('?seed=pending&fault=unsupported-material', '#/task/T1/pending'));
  await expect(page.getByText('还剩 5 个')).toBeVisible();
  await itemByFile(page, '曹操出行_行程单').click();
  await expect(detail(page).locator('iframe[title="曹操出行_行程单.pdf 原件"]')).toHaveAttribute('src', 'fixtures/m06-caocao-itinerary.pdf');
  await detail(page).getByRole('button', { name: '排除此材料' }).click();
  await expect(page.getByText('还剩 4 个')).toBeVisible();
});
