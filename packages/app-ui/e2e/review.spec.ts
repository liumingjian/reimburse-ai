import { expect, test, type Page } from '@playwright/test';

// 整单明细确认与「去打印 / 去报销」分岔（#103）。直接用 file:// 打开 mock 构建产物（pnpm build:mock）。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

const INVALIDATED = '材料已变更，之前的整单明细确认与已生成的打印稿作废。请重新核对后再确认。';

const table = (page: Page) => page.getByRole('table', { name: '候选明细' });
const checkbox = (page: Page) => page.getByRole('checkbox', { name: '我已核对整单明细' });
const printLink = (page: Page) => page.getByRole('link', { name: '去打印', exact: true });
const claimLink = (page: Page) => page.getByRole('link', { name: '去报销', exact: true });
const hotelGroup = (page: Page) => table(page).getByRole('rowgroup', { name: 'No.2 · 全季酒店_发票.pdf' });

// 同一文档内只改 hash（不重新加载页面），mock 的内存状态得以保留。
async function jump(page: Page, hash: string) {
  await page.evaluate((next) => {
    window.location.hash = next;
  }, hash);
}

test('确认：?seed=review 列出 9 行、合计 3972.59，勾选后才出现并列的去打印与去报销', async ({ page }, testInfo) => {
  await page.goto(open('?seed=review', '#/task/T1/review'));
  await expect(page.getByRole('heading', { name: '整单明细确认' })).toBeVisible();
  const rows = table(page).locator('tbody tr');
  await expect(rows).toHaveCount(9);
  await expect(rows.locator('td:nth-child(2)')).toHaveText(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  await expect(table(page).getByRole('rowgroup', { name: 'No.3-5 · 高德打车_发票.pdf' }).getByRole('row')).toHaveCount(3);
  await expect(page.getByTestId('gross-total')).toHaveText('3972.59');
  await expect(page.getByText('合计 · 7 张发票 · 9 行')).toBeVisible();
  await expect(rows.nth(6)).toContainText('出租车 · 张江高科 → 漕河泾开发区');

  await expect(checkbox(page)).not.toBeChecked();
  await expect(printLink(page)).toHaveCount(0);
  await expect(claimLink(page)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('review-unconfirmed.png'), fullPage: true });

  await checkbox(page).click();
  await expect(printLink(page)).toBeVisible();
  await expect(claimLink(page)).toBeVisible();
  await expect(page.getByText(/^整单明细已确认（/)).toBeVisible();
  // 两个按钮同级样式、并排。
  await expect(printLink(page)).toHaveClass(/btn-primary/);
  await expect(claimLink(page)).toHaveClass(/btn-primary/);
  const [a, b] = await Promise.all([printLink(page).boundingBox(), claimLink(page).boundingBox()]);
  expect(a && b && Math.abs(a.y - b.y) < 2 && a.x < b.x).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('review-confirmed.png'), fullPage: true });
});

test('分岔入口：?seed=actions 下去打印进入打印稿预览，去报销进入项目归属', async ({ page }) => {
  await page.goto(open('?seed=actions', '#/task/T1/review'));
  await expect(printLink(page)).toBeVisible();
  await expect(checkbox(page)).toHaveCount(0);
  await printLink(page).click();
  await expect(page).toHaveURL(/#\/task\/T1\/print$/);
  await expect(page.getByRole('heading', { name: '打印稿预览' })).toBeVisible();
  await jump(page, '#/task/T1/review');
  await claimLink(page).click();
  await expect(page).toHaveURL(/#\/task\/T1\/project$/);
  await expect(page.getByRole('heading', { name: '项目归属' })).toBeVisible();
  // 侧栏里「去打印 / 去报销」已经可进入。
  await expect(page.getByRole('list', { name: '流程阶段' }).getByRole('link', { name: /去打印 \/ 去报销/ })).toBeVisible();
});

test('支付截图：住宿发票行可补充与移除，确认状态不变', async ({ page }, testInfo) => {
  await page.goto(open('?seed=actions', '#/task/T1/review'));
  await expect(printLink(page)).toBeVisible();
  await expect(table(page).getByRole('button', { name: '补充支付截图' })).toHaveCount(1);
  await expect(hotelGroup(page).getByRole('button', { name: '补充支付截图' })).toBeVisible();

  await page.getByLabel('选择支付截图：全季酒店_发票.pdf').setInputFiles({ name: 'IMG_5011.png', mimeType: 'image/png', buffer: Buffer.from('png bytes') });
  await expect(hotelGroup(page).getByText('支付截图：IMG_5011.png')).toBeVisible();
  await expect(printLink(page)).toBeVisible();
  await expect(claimLink(page)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('review-screenshot.png'), fullPage: true });

  await hotelGroup(page).getByRole('button', { name: '移除' }).click();
  await expect(hotelGroup(page).getByRole('button', { name: '补充支付截图' })).toBeVisible();
  await expect(printLink(page)).toBeVisible();

  // 非图片被拒绝，仍停在已确认状态。
  await page.getByLabel('选择支付截图：全季酒店_发票.pdf').setInputFiles({ name: '支付记录.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') });
  await expect(page.getByRole('alert')).toHaveText('只接受图片（JPG、PNG）。');
  await expect(printLink(page)).toBeVisible();
});

test('失效流程：追加材料先二次确认，取消不变；继续则确认失效、回到上传页并能接收新批次', async ({ page }, testInfo) => {
  await page.goto(open('?seed=actions', '#/task/T1/review'));
  await expect(printLink(page)).toBeVisible();
  await page.getByRole('button', { name: '追加材料' }).click();
  const dialog = page.getByRole('dialog', { name: '追加材料会形成新的盘点版本' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('将使整单明细确认失效');
  await page.screenshot({ path: testInfo.outputPath('review-reopen-dialog.png'), fullPage: true });

  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/#\/task\/T1\/review$/);
  await expect(printLink(page)).toBeVisible();

  await page.getByRole('button', { name: '追加材料' }).click();
  await dialog.getByRole('button', { name: '继续追加' }).click();
  await expect(page).toHaveURL(/#\/task\/T1\/upload$/);
  await expect(page.getByRole('heading', { name: '上传材料' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText(INVALIDATED);
  await expect(page.getByText('拖入文件，或点击选择')).toBeVisible();

  await page.locator('input[type=file]').setInputFiles({ name: '地铁_发票.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 metro') });
  await expect(page.getByRole('heading', { name: '上传批次 #2 · 1 份材料' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('review-invalidated-upload.png'), fullPage: true });

  // 旧确认失效：重新盘点前，整单明细确认页与打印页都不能进。
  await jump(page, '#/task/T1/review');
  await expect(page.getByRole('heading', { name: '还不能进入这一步' })).toBeVisible();
  await jump(page, '#/task/T1/print');
  await expect(page.getByRole('heading', { name: '还不能进入这一步' })).toBeVisible();
});
