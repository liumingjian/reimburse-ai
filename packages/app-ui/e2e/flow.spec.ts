import { expect, test, type Page } from '@playwright/test';

// spec #109 / #110：流程顺序照 Skill 的实际运行顺序。
// 待确认项 → 项目归属（含报销事由）→（报销信息核对、材料准备，自动）→ 唯一一次整单确认 → 去打印 / 去报销。
// 统一业务序号跟随内核确认表的分类排序：确认表 No.、打印稿页序与 ERP 回读行一致。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

const GUARD = '阶段不可跳过，请按顺序完成前面的步骤。';

async function jump(page: Page, hash: string) {
  await page.evaluate((next) => {
    window.location.hash = next;
  }, hash);
}

test('全流程：从 ?seed=pending 一路走到去打印与去报销，顺序为待确认项 → 项目归属 → 整单确认 → 分岔', async ({ page }, testInfo) => {
  await page.goto(open('?seed=pending', '#/task/T1/pending'));
  await expect(page.getByRole('list', { name: '流程阶段' }).getByRole('listitem')).toHaveText([
    /上传材料/,
    /材料盘点/,
    /待确认项/,
    /项目归属/,
    /整单明细确认/,
    /去打印 \/ 去报销/,
    /完成/,
  ]);

  // 1. 待确认项
  const detail = page.getByLabel('待确认项详情');
  await detail.getByLabel('起点 *').fill('张江高科');
  await detail.getByLabel('终点 *').fill('漕河泾开发区');
  await detail.getByRole('button', { name: '保存并标记已处理' }).click();
  await expect(detail.getByRole('heading', { name: '下车时间不合法，并补填起点与终点' })).toBeVisible();
  await detail.getByLabel('下车时间 *').fill('19:06');
  await detail.getByLabel('起点 *').fill('静安寺');
  await detail.getByLabel('终点 *').fill('虹桥枢纽');
  await detail.getByRole('button', { name: '保存并标记已处理' }).click();
  await detail.getByRole('button', { name: '排除此材料' }).click();
  await expect(page.getByRole('heading', { name: '没有待确认项了' })).toBeVisible();
  // 项目归属还没做：整单确认页不能进。
  await jump(page, '#/task/T1/review');
  await expect(page.getByText(GUARD)).toBeVisible();
  await jump(page, '#/task/T1/pending');

  // 2. 项目归属 + 报销事由
  await page.getByRole('link', { name: '进入项目归属' }).click();
  await expect(page).toHaveURL(/#\/task\/T1\/project$/);
  await page.getByLabel('报销事由').fill('上海产品评审出差');
  await page.getByRole('checkbox', { name: '全选当前明细' }).locator('xpath=following-sibling::label[1]').click();
  await page.getByRole('region', { name: '批量操作' }).getByRole('button', { name: '归入项目' }).click();
  await page.getByRole('dialog', { name: '归入项目' }).getByRole('radio', { name: /P-3312/ }).locator('xpath=following-sibling::label[1]').click();
  await page.getByRole('dialog', { name: '归入项目' }).getByRole('button', { name: '确认归入' }).click();
  await expect(page.getByTestId('assign-summary')).toHaveText('已归属9 / 9 条整单合计3972.59 元');
  await page.getByRole('button', { name: '确认项目归属' }).click();

  // 3. 自动核对报销信息、准备材料之后，唯一一次整单确认
  await expect(page).toHaveURL(/#\/task\/T1\/review$/);
  const checkbox = page.getByRole('region', { name: '整单确认' }).getByRole('button', { name: '确认整单明细', exact: true });
  await expect(checkbox).toBeVisible();
  await expect(page.getByTestId('review-purpose')).toContainText('上海产品评审出差');
  await page.screenshot({ path: testInfo.outputPath('flow-review.png'), fullPage: true });
  await checkbox.click();

  // 4. 分岔：去打印 / 去报销
  await expect(page.getByRole('link', { name: '去打印', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '去报销', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '去打印', exact: true }).click();
  await expect(page.getByRole('list', { name: '打印稿页面' }).locator('.page-hdr').first()).toHaveText('No.1-3 · 08-10 · 外地市内交通 · 69.19');
  await page.getByRole('list', { name: '流程阶段' }).getByRole('button', { name: /^整单明细确认/ }).click();
  await page.getByRole('button', { name: '去报销', exact: true }).click();
  await expect(page).toHaveURL(/#\/task\/T1\/erp$/);
  await expect(page.getByRole('button', { name: '开始填报' })).toHaveCount(0);
  await page.getByRole('button', { name: '我已登录，继续' }).click();
  await expect(page.getByRole('link', { name: '查看完成结果' })).toBeVisible();
  await expect(page.getByRole('button', { name: '开始填报' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('flow-erp-done.png'), fullPage: true });
});

test('阶段不可跳过：项目归属没完成时直接打开整单确认页', async ({ page }) => {
  await page.goto(open('?seed=project', '#/task/T1/review'));
  await expect(page.getByRole('heading', { name: '还不能进入这一步' })).toBeVisible();
  await expect(page.getByText(GUARD)).toBeVisible();
  await page.getByRole('link', { name: '回到当前阶段' }).click();
  await expect(page).toHaveURL(/#\/task\/T1\/project$/);

  await page.goto(open('?seed=pending', '#/task/T1/project'));
  await expect(page.getByText(GUARD)).toBeVisible();
});

test('统一业务序号：确认表 No.、打印稿页序与 ERP 回读行按分类排序且一致，No.1 是外地市内交通的首条，住宿排最后', async ({ page }) => {
  await page.goto(open('?seed=print', '#/task/T1/review'));
  const rows = page.getByRole('table', { name: '整单明细' }).locator('tbody tr');
  await expect(rows).toHaveCount(9);
  await expect(rows.nth(0).locator('td:nth-child(1)')).toHaveText('1');
  await expect(rows.nth(0).locator('td:nth-child(9)')).toHaveText('外地市内交通');
  await expect(rows.nth(0).locator('td:nth-child(7)')).toHaveText('虹桥枢纽');
  await expect(rows.nth(0).locator('td:nth-child(8)')).toHaveText('漕河泾');
  await expect(rows.nth(8).locator('td:nth-child(1)')).toHaveText('9');
  await expect(rows.nth(8).locator('td:nth-child(9)')).toHaveText('住宿');
  await expect(rows.nth(8).locator('td:nth-child(14)')).toHaveText('3640.00');

  await jump(page, '#/task/T1/print');
  const headers = page.getByRole('list', { name: '打印稿页面' }).locator('.page-hdr');
  await expect(headers.first()).toHaveText('No.1-3 · 08-10 · 外地市内交通 · 69.19');
  await expect(headers.last()).toHaveText('No.9 · 08-09 · 住宿 · 3640.00');

  await page.goto(open('?seed=done', '#/task/T1/done'));
  await expect(page.getByRole('table', { name: '逐条回读' }).locator('tbody tr')).toHaveCount(9);
  await expect(page.getByTestId('readback-1')).toContainText('高德 · 虹桥枢纽 → 漕河泾');
  await expect(page.getByTestId('readback-9')).toContainText('全季酒店 13 晚');
});
