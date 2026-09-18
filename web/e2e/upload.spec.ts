import { expect, test, type Page } from '@playwright/test';

// 上传批次（#101）；新建任务弹层见 new-task.spec.ts。直接用 file:// 打开 mock 构建产物（pnpm build:mock）。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;


type Upload = { name: string; mimeType: string; buffer: Buffer };

const pdf = (name: string, body = `%PDF-1.4 ${name}`): Upload => ({ name, mimeType: 'application/pdf', buffer: Buffer.from(body) });
const png = (name: string, body = `png ${name}`): Upload => ({ name, mimeType: 'image/png', buffer: Buffer.from(body) });

async function choose(page: Page, files: Upload[]) {
  await page.locator('input[type=file]').setInputFiles(files);
}

const batch = (page: Page, no: number) => page.locator('section', { has: page.getByRole('heading', { name: new RegExp(`^上传批次 #${no}$`) }) });
// 文件行：按文件名整串匹配（拒绝原因里也会出现别的文件名，所以不能用子串）。
const row = (page: Page, panel: ReturnType<typeof batch>, fileName: string) => panel.locator('li', { has: page.getByText(fileName, { exact: true }) });

// 同一文档内只改 hash（不重新加载页面），mock 的内存状态（如新建的 T4）得以保留。
async function jump(page: Page, hash: string) {
  await page.evaluate((next) => {
    window.location.hash = next;
  }, hash);
}

// 经新建任务弹层创建 T4（常驻城市用预填的网络位置候选）。
async function createTask(page: Page) {
  await page.goto(open('', '#/tasks/new'));
  await expect(page.getByRole('dialog', { name: '新建报销任务' }).getByLabel('常驻城市')).toHaveValue('杭州');
  await page.getByRole('button', { name: '创建并上传材料' }).click();
  await expect(page).toHaveURL(/#\/task\/T4\/upload$/);
}

test('正常上传：pdf/jpg/png 逐文件已接收，按批次列出并出现开始材料盘点', async ({ page }, testInfo) => {
  await page.goto(open('', '#/task/T1/upload'));
  await choose(page, [pdf('全季酒店_发票.pdf'), { name: 'IMG_4871.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('jpeg bytes') }, png('IMG_4906.png')]);
  const first = batch(page, 1);
  await expect(first.getByRole('heading')).toHaveText('上传批次 #1');
  // 批次信息是带标签的字段组，不是页面拼的中点串。
  await expect(first.getByRole('term')).toHaveText('材料');
  await expect(first.getByRole('definition')).toHaveText('3 份');
  await expect(page.getByRole('main')).not.toContainText('·');
  await expect(first.getByText('已复制入任务目录')).toBeVisible();
  // 只标出例外：已接收的行不打标签，内容哈希不印在行里，只在文件名的悬停提示里。
  await expect(first.locator('li')).toHaveCount(3);
  await expect(first.getByText('已接收')).toHaveCount(0);
  await expect(first.getByText('拒绝', { exact: true })).toHaveCount(0);
  await expect(first).not.toContainText('sha256');
  await expect(row(page, first, '全季酒店_发票.pdf').getByText('全季酒店_发票.pdf', { exact: true })).toHaveAttribute('title', /^内容哈希 sha256:[0-9a-f]{8}$/);
  // PDF 与图片用不同图标。
  await expect(row(page, first, '全季酒店_发票.pdf').getByRole('img', { name: 'PDF' })).toBeVisible();
  await expect(row(page, first, 'IMG_4871.jpg').getByRole('img', { name: '图片' })).toBeVisible();
  await expect(row(page, first, 'IMG_4906.png').getByRole('img', { name: '图片' })).toBeVisible();
  const next = page.getByRole('region', { name: '下一步' });
  await expect(next.getByRole('button', { name: '开始材料盘点' })).toBeEnabled();
  await expect(next.getByRole('button', { name: '追加下一批' })).toBeVisible();
  await expect(next).toContainText('开始盘点后，追加或删除材料会形成新的盘点版本。');
  await page.screenshot({ path: testInfo.outputPath('upload-accepted.png'), fullPage: true });
});

for (const width of [1440, 1100]) {
  test(`空的上传页 ${width}px：拖放区铺满宽度，主文案、链接提示与格式标签居中，不是大块空白；下方说明下一步`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(open('?seed=upload', '#/task/T1/upload'));
    const zone = page.getByTestId('dropzone');
    await expect(zone).toHaveRole('button');
    await expect(zone).toHaveAccessibleName('拖入文件，或点击选择');
    const title = zone.getByText('把材料拖到这里', { exact: true });
    await expect(title).toBeVisible();
    await expect(zone.getByText('点击选择文件', { exact: true })).toBeVisible();
    for (const format of ['PDF', 'JPG', 'PNG', '单个 ≤ 20MB']) await expect(zone.getByText(format, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '选择文件' })).toHaveCount(0);
    const zoneBox = await zone.boundingBox();
    const titleBox = await title.boundingBox();
    if (!zoneBox || !titleBox) throw new Error('拖放区或主文案不可见');
    expect(zoneBox.width).toBeGreaterThan(width * 0.8);
    expect(Math.abs(titleBox.x + titleBox.width / 2 - (zoneBox.x + zoneBox.width / 2))).toBeLessThan(2);
    expect(zoneBox.height).toBeLessThanOrEqual(280);
    await expect(page.getByText('上传后点「开始材料盘点」，系统开始盘点。')).toBeVisible();
    await expect(page.getByText('原件会被复制进任务目录，不会被修改。')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test('点击拖放区或用键盘激活提示都打开文件选择器', async ({ page }) => {
  await page.goto(open('', '#/task/T1/upload'));
  const zone = page.getByTestId('dropzone');
  await expect(zone).toHaveRole('button');
  await expect(zone).toHaveAccessibleName('拖入文件，或点击选择');
  const byClick = page.waitForEvent('filechooser');
  await zone.click();
  expect((await byClick).isMultiple()).toBe(true);
  const byKey = page.waitForEvent('filechooser');
  await zone.focus();
  await page.keyboard.press('Enter');
  const chooser = await byKey;
  await chooser.setFiles([pdf('键盘选择_发票.pdf')]);
  await expect(row(page, batch(page, 1), '键盘选择_发票.pdf')).toBeVisible();
});

test('拖入文件也能上传', async ({ page }) => {
  await page.goto(open('', '#/task/T1/upload'));
  const dropzone = page.getByTestId('dropzone');
  await expect(dropzone).toBeVisible();
  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['%PDF-1.4 dropped'], '曹操出行_发票.pdf', { type: 'application/pdf' }));
    return dt;
  });
  await dropzone.dispatchEvent('drop', { dataTransfer });
  const first = batch(page, 1);
  await expect(first.getByRole('heading')).toHaveText('上传批次 #1');
  await expect(row(page, first, '曹操出行_发票.pdf')).toBeVisible();
  await expect(first.getByText('已复制入任务目录')).toBeVisible();
});

// Every reject code, batch #2 and starting inventory are covered on the real server: e2e/server/lifecycle.spec.ts.

test('?fault=duplicate-upload 让追加批次里出现内容重复', async ({ page }) => {
  await page.goto(open('?fault=duplicate-upload', '#/task/T1/upload'));
  await choose(page, [pdf('铁路电子客票_0809.pdf')]);
  await expect(batch(page, 1).getByRole('heading')).toHaveText('上传批次 #1');
  await page.getByRole('button', { name: '追加下一批' }).click();
  await choose(page, [pdf('铁路电子客票_0822.pdf'), pdf('餐饮_发票.pdf')]);
  const second = batch(page, 2);
  await expect(second.getByRole('heading')).toHaveText('上传批次 #2');
  await expect(row(page, second, '铁路电子客票_0822.pdf').getByText(/^内容重复/)).toBeVisible();
  await expect(row(page, second, '餐饮_发票.pdf')).toBeVisible();
  await expect(row(page, second, '餐饮_发票.pdf').getByText('拒绝', { exact: true })).toHaveCount(0);
});

test('守卫：没有材料时后续页面显示还没有上传材料；有材料但未盘点则阶段不可跳过', async ({ page }) => {
  await createTask(page);
  await jump(page, '#/task/T4/inventory');
  await expect(page.getByRole('heading', { name: '还没有上传材料' })).toBeVisible();
  await page.getByRole('link', { name: '去上传' }).click();
  await expect(page).toHaveURL(/#\/task\/T4\/upload$/);

  await choose(page, [pdf('餐饮_发票.pdf')]);
  await expect(batch(page, 1).getByRole('heading')).toHaveText('上传批次 #1');
  await jump(page, '#/task/T4/review');
  await expect(page.getByRole('heading', { name: '还不能进入这一步' })).toBeVisible();
});

test('?seed=inventory 的 T1 上传页列出批次 #1 的 11 份材料', async ({ page }) => {
  await page.goto(open('?seed=inventory', '#/task/T1/upload'));
  const first = batch(page, 1);
  await expect(first.getByRole('heading')).toHaveText('上传批次 #1');
  await expect(first.locator('li')).toHaveCount(11);
  await expect(first.getByText('已接收')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '开始材料盘点' })).toBeVisible();
});
