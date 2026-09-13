import { expect, test, type Page } from '@playwright/test';

// 材料盘点（#102）。直接用 file:// 打开 mock 构建产物（pnpm build:mock）。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

const FIXTURE_FILES = [
  '全季酒店_发票.pdf',
  '全季酒店_结账单.pdf',
  '高德打车_发票.pdf',
  '高德打车_行程单.pdf',
  '曹操出行_发票.pdf',
  '曹操出行_行程单.pdf',
  '铁路电子客票_0809.pdf',
  '铁路电子客票_0822.pdf',
  'IMG_4871.jpg',
  'IMG_4906.jpg',
  '餐饮_发票.pdf',
];

async function uploadFixtureNames(page: Page) {
  await page.locator('input[type=file]').setInputFiles(
    FIXTURE_FILES.map((name) => ({ name, mimeType: name.endsWith('.jpg') ? 'image/jpeg' : 'application/pdf', buffer: Buffer.from(`fixture ${name}`) })),
  );
}

async function jump(page: Page, hash: string) {
  await page.evaluate((next) => {
    window.location.hash = next;
  }, hash);
}

test('?seed=inventory：材料清单按费用事件归组，显示配对与守恒结论，不显示字段来源', async ({ page }, testInfo) => {
  await page.goto(open('?seed=inventory', '#/task/T1/inventory'));
  await expect(page.getByRole('heading', { name: '材料盘点' })).toBeVisible();
  await expect(page.getByRole('link', { name: '处理 3 个待确认项' })).toBeVisible();
  await expect(page.getByText('11 份材料，8 份通过，3 份需要你处理')).toBeVisible();
  await expect(page.getByText('主要报销凭证 7 · 参考材料 3 · 盘点版本 v1')).toBeVisible();
  await expect(page.getByLabel('盘点结果').getByText('通过', { exact: true })).toHaveCount(0);

  // 含待确认材料的事件默认展开；全部通过的事件收成一行，点开才看文件与材料证据关联。
  const taxi = page.getByRole('rowgroup', { name: '费用事件 5 · 2026-08-15 · 外地市内交通 · 32.00' });
  await expect(taxi.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
  await expect(taxi.getByText('IMG_4871.jpg')).toBeVisible();
  const amap = page.getByRole('rowgroup', { name: '费用事件 1-3 · 2026-08-10 至 2026-08-12 · 外地市内交通 · 26.69 + 20.85 + 21.65' });
  const amapToggle = amap.getByRole('button');
  await expect(amapToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(amap.getByText('高德打车_行程单.pdf')).toHaveCount(0);
  await amapToggle.click();
  await expect(amapToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(amap.getByText('打车发票与行程单配对：26.69 + 20.85 + 21.65 = 69.19，按分守恒')).toBeVisible();
  await expect(amap.getByText('高德打车_行程单.pdf')).toBeVisible();
  await expect(page.getByLabel('盘点结果').locator('thead th')).toHaveText(['文件', '识别为', '校验', '状态']);

  const hotel = page.getByRole('rowgroup', { name: '费用事件 9 · 2026-08-09 至 2026-08-22 · 住宿 · 3640.00' });
  await hotel.getByRole('button').click();
  await expect(hotel.getByText('住宿发票 3640.00 = 结账单消费合计 3640.00；13 天 = 08-09 入住至 08-22 离店')).toBeVisible();
  await expect(page.getByLabel('盘点结果')).not.toContainText('rule:');

  await expect(page.getByRole('rowgroup', { name: '未归入费用事件' }).getByText('未识别版式')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('inventory-results.png'), fullPage: true });
});

test('上传后开始材料盘点：先看到分阶段进度，再看到结果', async ({ page }, testInfo) => {
  await page.goto(open('', '#/task/T1/upload'));
  await uploadFixtureNames(page);
  await expect(page.getByRole('heading', { name: '上传批次 #1 · 11 份材料' })).toBeVisible();
  await page.getByRole('button', { name: '开始材料盘点' }).click();
  await expect(page).toHaveURL(/#\/task\/T1\/inventory$/);
  await expect(page.getByRole('status')).toHaveText(/^正在盘点：/);
  await expect(page.getByLabel('盘点进度')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('inventory-progress.png'), fullPage: true });
  await expect(page.getByRole('link', { name: '处理 3 个待确认项' })).toBeVisible({ timeout: 15000 });
  await expect(page.getByLabel('盘点进度')).toBeHidden();
  await page.getByRole('button', { name: /^No\.1-3 / }).click();
  await expect(page.getByRole('cell', { name: '26.69 + 20.85 + 21.65 = 69.19，按分守恒', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '处理 3 个待确认项' }).click();
  await expect(page.getByRole('heading', { name: '待确认项' })).toBeVisible();
  await expect(page.getByText('还剩 3 个')).toBeVisible();
});

test('?fault=unsupported-material：曹操行程单成为不支持的版式，待确认项 4 个', async ({ page }) => {
  await page.goto(open('?seed=inventory&fault=unsupported-material', '#/task/T1/inventory'));
  await expect(page.getByRole('link', { name: '处理 4 个待确认项' })).toBeVisible();
  const rest = page.getByRole('rowgroup', { name: '未归入费用事件' });
  await expect(rest.getByText('曹操出行_行程单.pdf')).toBeVisible();
  await expect(rest.getByText('未识别版式')).toHaveCount(2);
});

test('页面守卫：?seed=inventory 下直接打开后续页面显示阶段不可跳过', async ({ page }) => {
  await page.goto(open('?seed=inventory', '#/task/T1/print'));
  await expect(page.getByRole('heading', { name: '还不能进入这一步' })).toBeVisible();
  await expect(page.getByText('阶段不可跳过，请按顺序完成前面的步骤。')).toBeVisible();
  await jump(page, '#/task/T1/review');
  await expect(page.getByText('阶段不可跳过，请按顺序完成前面的步骤。')).toBeVisible();
  await page.getByRole('link', { name: '回到当前阶段' }).click();
  await expect(page).toHaveURL(/#\/task\/T1\/inventory$/);
  await expect(page.getByRole('heading', { name: '材料盘点' })).toBeVisible();
});
