import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// 新建报销任务弹层、服务端命名、常驻城市候选，以及用 dist-mock/sample-materials/ 跑通上传与盘点。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const SAMPLES_DIR = fileURLToPath(new URL('../dist-mock/sample-materials/', import.meta.url));
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

const dialog = (page: Page) => page.getByRole('dialog', { name: '新建报销任务' });

// 同一文档内只改 hash，mock 的内存状态（新建的 T4、记住的常驻城市）得以保留。
async function jump(page: Page, hash: string) {
  await page.evaluate((next) => {
    window.location.hash = next;
  }, hash);
}

test('新建报销任务是任务列表上的弹层：预填网络位置候选，空城市就地报错，取消回到列表', async ({ page }, testInfo) => {
  await page.goto(open('', '#/tasks'));
  await page.getByRole('button', { name: '新建报销任务' }).click();
  await expect(page).toHaveURL(/#\/tasks\/new$/);
  const box = dialog(page);
  await expect(box).toBeVisible();
  await expect(page.getByRole('heading', { name: '报销任务', exact: true })).toBeVisible();
  await expect(box.getByRole('textbox')).toHaveCount(1);
  await expect(box.getByLabel('常驻城市')).toHaveValue('杭州');
  await expect(box.getByText('根据网络位置推测，不对可直接改成你的常驻城市。')).toBeVisible();
  await expect(box.getByText(/本地市内交通与外地市内交通/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('new-task-dialog.png'), fullPage: true });

  await box.getByLabel('常驻城市').fill('');
  await box.getByRole('button', { name: '创建并上传材料' }).click();
  // Carbon 输入框自带空的 role="alert" 字数提示，按文字取错误提示。
  await expect(box.getByRole('alert').filter({ hasText: '请填写常驻城市。' })).toHaveText('请填写常驻城市。');
  await expect(page).toHaveURL(/#\/tasks\/new$/);

  await box.getByRole('button', { name: '取消' }).click();
  await expect(page).toHaveURL(/#\/tasks$/);
  await expect(dialog(page)).toHaveCount(0);
});

test('?location=unavailable：常驻城市没有默认值，提示直接填写；填好后创建，下次新建默认是上次确认的城市', async ({ page }) => {
  await page.goto(open('?location=unavailable', '#/tasks/new'));
  const box = dialog(page);
  await expect(box.getByLabel('常驻城市')).toHaveValue('');
  await expect(box.getByText('没有获取到网络位置，请填写你的常驻城市。')).toBeVisible();
  await box.getByLabel('常驻城市').fill('苏州');
  await box.getByLabel('常驻城市').press('Enter');
  await expect(page).toHaveURL(/#\/task\/T4\/upload$/);
  // 等上传页真的渲染出来（任务列表与弹层已卸载）再跳回：hash 先变、React 后渲染，立刻跳回会让同一个弹层留着，读不到服务端记住的城市。
  await expect(page.getByRole('heading', { name: '上传材料' })).toBeVisible();

  await jump(page, '#/tasks/new');
  await expect(dialog(page).getByLabel('常驻城市')).toHaveValue('苏州');
  await expect(dialog(page).getByText('上次确认的常驻城市（按你的账号记住），可直接修改。')).toBeVisible();
});

test('全流程 QA：弹层创建任务，上传 sample-materials 的 14 份材料，盘点后 5 个待确认项，任务名称保持占位（同服务端）并有费用期间', async ({ page }, testInfo) => {
  const files = readdirSync(SAMPLES_DIR).map((name) => join(SAMPLES_DIR, name));
  expect(files).toHaveLength(14);

  await page.goto(open('', '#/tasks/new'));
  await dialog(page).getByRole('button', { name: '创建并上传材料' }).click();
  await expect(page).toHaveURL(/#\/task\/T4\/upload$/);
  await expect(page.getByText(/^\d{4}-\d{2}-\d{2} 新建报销$/)).toBeVisible();

  await page.getByLabel('拖入文件，或点击选择', { exact: true }).setInputFiles(files);
  await expect(page.getByRole('heading', { name: /^上传批次 #1$/ })).toHaveText('上传批次 #1');
  await page.getByRole('button', { name: '开始材料盘点' }).click();
  await expect(page).toHaveURL(/#\/task\/T4\/inventory$/);
  await expect(page.getByRole('link', { name: '处理 5 个待确认项' })).toBeVisible({ timeout: 15_000 });
  // The server never renames a task; the placeholder name stays.
  await expect(page.getByText(/^\d{4}-\d{2}-\d{2} 新建报销$/).first()).toBeVisible();
  await expect(page.getByText('未识别版式')).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('full-flow-inventory.png'), fullPage: true });

  await jump(page, '#/tasks');
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: /^\d{4}-\d{2}-\d{2} 新建报销$/ }) });
  await expect(row).toBeVisible();
  // As on the server, the candidate lines exist from the end of the inventory on, so the list has the period.
  await expect(row).toContainText('2026-08-09');
  await expect(row.getByText('暂无可用日期', { exact: true })).toHaveCount(0);
});
