import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { HANDOVER_COMPLETED_NOTICE } from '@baox/contract';

// spec #109 Testing Decisions：一条从登录到完成的全流程，用 dist-mock/sample-materials/ 的 11 份示例材料，其余都是 mock 默认值。
// 登录应用账号 → 新建任务 → 上传 → 盘点 → 待确认项 → 项目归属 → 报销信息核对与材料准备（自动）→ 整单确认
// → 打印稿 → 去报销（写入报销系统）→ 完成。整条路径在同一个文档里走（只改 hash），mock 的内存状态一路保留。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const SAMPLES_DIR = fileURLToPath(new URL('../dist-mock/sample-materials/', import.meta.url));

const h1 = (page: Page, name: string) => page.getByRole('heading', { name, level: 1 });

async function jump(page: Page, hash: string) {
  await page.evaluate((next) => {
    window.location.hash = next;
  }, hash);
}

test('全流程：从登录一路走到完成，上传 sample-materials 的 11 份材料', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const files = readdirSync(SAMPLES_DIR).map((name) => join(SAMPLES_DIR, name));
  expect(files).toHaveLength(11);

  // 1. 登录应用账号（夹具账号，mock 密码）。
  await page.goto(`${INDEX}?auth=signed-out#/tasks`);
  await expect(h1(page, '登录')).toBeVisible();
  await page.getByLabel('用户名').fill('林颂宜');
  await page.getByLabel('密码').fill('mock-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(h1(page, '报销任务')).toBeVisible();

  // 2. 新建任务（常驻城市用网络位置候选）。
  await page.getByRole('button', { name: '新建报销任务' }).click();
  await page.getByRole('dialog', { name: '新建报销任务' }).getByRole('button', { name: '创建并上传材料' }).click();
  await expect(page).toHaveURL(/#\/task\/T4\/upload$/);

  // 3. 上传示例材料并盘点。
  await page.getByLabel('拖入文件，或点击选择', { exact: true }).setInputFiles(files);
  await expect(page.getByRole('heading', { name: /^上传批次 #1$/ })).toHaveText('上传批次 #1');
  await page.getByRole('button', { name: '开始材料盘点' }).click();
  await expect(page).toHaveURL(/#\/task\/T4\/inventory$/);
  await expect(page.getByRole('link', { name: '处理 3 个待确认项' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('2026-08 上海出差', { exact: true }).first()).toBeVisible();
  await page.getByRole('link', { name: '处理 3 个待确认项' }).click();
  await expect(page).toHaveURL(/#\/task\/T4\/pending$/);

  // 4. 待确认项。
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

  // 5. 项目归属（项目簿用夹具默认值）与报销事由。
  await page.getByRole('link', { name: '进入项目归属' }).click();
  await expect(page).toHaveURL(/#\/task\/T4\/project$/);
  await page.getByLabel('报销事由').fill('上海产品评审出差');
  await page.getByRole('checkbox', { name: '全选当前明细' }).locator('xpath=following-sibling::label[1]').click();
  await page.getByRole('complementary', { name: '归入项目' }).getByRole('button', { name: /P-3312/ }).click();
  await expect(page.getByTestId('assign-summary')).toHaveText('已归属9 / 9 条整单合计3972.59 元');
  await page.getByRole('button', { name: '确认项目归属' }).click();

  // 6. 报销信息核对、材料准备自动完成后，唯一一次整单确认。
  await expect(page).toHaveURL(/#\/task\/T4\/review$/);
  const confirm = page.getByRole('region', { name: '整单确认' }).getByRole('button', { name: '确认整单明细', exact: true });
  await expect(confirm).toBeEnabled({ timeout: 15_000 });
  await expect(page.getByTestId('package-files')).toHaveText('核对材料已生成，共 13 份文件。');
  await expect(page.getByRole('table', { name: '整单明细' }).locator('tbody tr')).toHaveCount(9);
  await confirm.click();

  // 7. 打印稿。
  await page.getByRole('link', { name: '去打印', exact: true }).click();
  await expect(page).toHaveURL(/#\/task\/T4\/print$/);
  await expect(page.getByRole('list', { name: '打印稿页面' }).locator('.page-hdr').first()).toHaveText('No.1-3 · 08-10 · 外地市内交通 · 69.19');
  await page.getByRole('list', { name: '流程阶段' }).getByRole('button', { name: /^整单明细确认/ }).click();

  // 8. 去报销：登录后自动写入并严格回读，最后把填好的单据交接给员工。
  await page.getByRole('button', { name: '去报销', exact: true }).click();
  await expect(page).toHaveURL(/#\/task\/T4\/erp$/);
  await page.getByRole('button', { name: '我已登录，继续' }).click();
  await expect(page.getByRole('link', { name: '查看完成结果' })).toBeVisible({ timeout: 20_000 });

  // 9. 完成：固定句逐字显示，任务列表里是 10/10 单据交接。
  await page.getByRole('link', { name: '查看完成结果' }).click();
  await expect(page).toHaveURL(/#\/task\/T4\/done$/);
  await expect(page.getByTestId('handover-completed')).toHaveText(HANDOVER_COMPLETED_NOTICE);
  await page.screenshot({ path: testInfo.outputPath('journey-done.png'), fullPage: true });
  await jump(page, '#/tasks');
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: '2026-08 上海出差', exact: true }) });
  await expect(row.getByText('10/10 单据交接')).toBeVisible();
});
