import { expect, test, type Page } from '@playwright/test';

// 整单明细确认（Skill 的唯一一次整单确认，在项目归属之后）与「去打印 / 去报销」分岔。直接用 file:// 打开 mock 构建产物（pnpm build:mock）。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

const INVALIDATED = '材料已变更，之前的整单明细确认与已生成的打印稿作废。请重新核对后再确认。';
const PROJECT_CHANGED = '项目归属已变更，之前的整单明细确认失效。请重新核对后再确认。';

const table = (page: Page) => page.getByRole('table', { name: '候选明细' });
const checkbox = (page: Page) => page.getByRole('checkbox', { name: '我已核对整单明细' });
const printLink = (page: Page) => page.getByRole('link', { name: '去打印', exact: true });
const claimButton = (page: Page) => page.getByRole('button', { name: '去报销', exact: true });

// 同一文档内只改 hash（不重新加载页面），mock 的内存状态得以保留。
async function jump(page: Page, hash: string) {
  await page.evaluate((next) => {
    window.location.hash = next;
  }, hash);
}

test('确认：?seed=review 列出 9 行、合计 3972.59，No. 按费用分类排序；勾选后才出现并列的去打印与去报销', async ({ page }, testInfo) => {
  await page.goto(open('?seed=review', '#/task/T1/review'));
  await expect(page.getByRole('heading', { name: '整单明细确认' })).toBeVisible();
  const rows = table(page).locator('tbody tr');
  await expect(rows).toHaveCount(9);
  await expect(rows.locator('td:nth-child(2)')).toHaveText(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  const remote = '外地市内交通';
  await expect(rows.locator('td:nth-child(4)')).toHaveText([remote, remote, remote, remote, remote, remote, '长途交通', '长途交通', '住宿']);
  await expect(table(page).getByRole('rowgroup', { name: 'No.1-3 · 高德打车_发票.pdf' }).getByRole('row')).toHaveCount(3);
  await expect(page.getByTestId('gross-total')).toHaveText('3972.59');
  await expect(page.getByText('合计 · 7 张发票 · 9 行')).toBeVisible();
  await expect(rows.nth(4)).toContainText('出租车 · 张江高科 → 漕河泾开发区');
  await expect(page.getByTestId('review-purpose')).toContainText('上海产品评审出差');
  // 支付截图入口在打印稿页，不在确认页。
  await expect(page.getByRole('button', { name: /补充支付截图/ })).toHaveCount(0);

  await expect(checkbox(page)).not.toBeChecked();
  await expect(printLink(page)).toHaveCount(0);
  await expect(claimButton(page)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('review-unconfirmed.png'), fullPage: true });

  await checkbox(page).click();
  await expect(printLink(page)).toBeVisible();
  await expect(claimButton(page)).toBeVisible();
  await expect(page.getByText(/^整单明细已确认（/)).toBeVisible();
  // 两个入口同级样式、并排。
  await expect(printLink(page)).toHaveClass(/btn-primary/);
  await expect(claimButton(page)).toHaveClass(/btn-primary/);
  const [a, b] = await Promise.all([printLink(page).boundingBox(), claimButton(page).boundingBox()]);
  expect(a && b && Math.abs(a.y - b.y) < 2 && a.x < b.x).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('review-confirmed.png'), fullPage: true });
});

test('分岔入口：?seed=actions 下去打印进入打印稿预览，去报销直接开始填报（没有「开始填报」）', async ({ page }) => {
  await page.goto(open('?seed=actions', '#/task/T1/review'));
  await expect(printLink(page)).toBeVisible();
  await expect(checkbox(page)).toHaveCount(0);
  await printLink(page).click();
  await expect(page).toHaveURL(/#\/task\/T1\/print$/);
  await expect(page.getByRole('heading', { name: '打印稿预览' })).toBeVisible();
  await jump(page, '#/task/T1/review');
  await claimButton(page).click();
  await expect(page).toHaveURL(/#\/task\/T1\/erp$/);
  await expect(page.getByRole('heading', { name: 'ERP 填报' })).toBeVisible();
  await expect(page.getByRole('button', { name: '开始填报' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '填报进度' }).getByRole('listitem', { name: '登录', exact: true })).toContainText('等待你操作');
  // 侧栏里「去打印 / 去报销」已经可进入。
  await expect(page.getByRole('list', { name: '流程阶段' }).getByRole('link', { name: /去打印 \/ 去报销/ })).toBeVisible();
});

test('确认后改派项目：确认失效并提示重新确认，重新确认后两个入口回来', async ({ page }, testInfo) => {
  await page.goto(open('?seed=actions', '#/task/T1/review'));
  await page.getByRole('link', { name: '修改项目归属' }).click();
  await expect(page).toHaveURL(/#\/task\/T1\/project$/);
  await page.getByRole('checkbox', { name: '选择明细 No.9' }).click();
  await page.getByRole('complementary', { name: '项目工作台' }).getByRole('button', { name: '归入 P-1180 内部培训' }).click();
  await page.getByRole('dialog', { name: '1 条明细已有其他项目归属，请确认是否覆盖' }).getByRole('button', { name: '确认覆盖' }).click();
  await page.getByRole('button', { name: '确认项目归属' }).click();

  await expect(page).toHaveURL(/#\/task\/T1\/review$/);
  await expect(page.getByText(PROJECT_CHANGED)).toBeVisible();
  await expect(checkbox(page)).toBeVisible();
  await expect(printLink(page)).toHaveCount(0);
  await expect(claimButton(page)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('review-project-changed.png'), fullPage: true });

  await checkbox(page).click();
  await expect(printLink(page)).toBeVisible();
  await expect(page.getByText(PROJECT_CHANGED)).toHaveCount(0);
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
