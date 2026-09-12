import { expect, test, type Page } from '@playwright/test';

// 项目归属：待确认项之后、整单确认之前（两条路径都经过），形状照内核 Variant B 工作台。
// 直接用 file:// 打开 mock 构建产物（pnpm build:mock）。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

const workbench = (page: Page) => page.getByRole('complementary', { name: '项目工作台' });
const search = (page: Page) => page.getByRole('searchbox', { name: '查找个人项目簿' });
const names = (page: Page) => workbench(page).getByRole('list', { name: '项目列表' }).locator('.name');
const usedNames = (page: Page) => workbench(page).getByRole('list', { name: '本次已归入' }).locator('.name');
const usage = (page: Page, number: string) => page.getByTestId(`usage-${number}`);
const pick = (page: Page, no: number) => page.getByRole('checkbox', { name: `选择明细 No.${no}` }).click();
const assignTo = (page: Page, label: string) => workbench(page).getByRole('button', { name: `归入 ${label}` }).click();
const projectOf = (page: Page, no: number) => page.getByTestId(`project-of-${no}`);
const submit = (page: Page) => page.getByRole('button', { name: '确认项目归属' });
const conflictDialog = (page: Page) => page.getByRole('dialog', { name: '2 条明细已有其他项目归属，请确认是否覆盖' });

async function jump(page: Page, hash: string) {
  await page.evaluate((next) => {
    window.location.hash = next;
  }, hash);
}

async function selectConflict(page: Page) {
  await pick(page, 1);
  await pick(page, 2);
  await pick(page, 3);
  await assignTo(page, 'P-3312 产品调研');
  await expect(conflictDialog(page)).toBeVisible();
}

test('只列可选项目：?seed=assign 直接打开，不可选的项目不出现；本次已归入带条数与金额；搜索过滤可选列表', async ({ page }, testInfo) => {
  await page.goto(open('?seed=assign', '#/task/T1/project'));
  await expect(page.getByRole('heading', { name: '项目归属' })).toBeVisible();
  await expect(usedNames(page)).toHaveText(['华东客户交付']);
  await expect(usage(page, 'P-2307')).toHaveText('2 条 · 47.54 元');
  await expect(names(page)).toHaveText(['华东客户交付二期', '产品调研', '内部培训']);
  await expect(workbench(page).getByText('南京客户培训')).toHaveCount(0);
  await expect(workbench(page).getByText('旧版对账工具')).toHaveCount(0);
  await expect(page.getByTestId('assign-summary')).toHaveText('已归属 2 / 9 条 · 合计 3972.59 元');
  await page.screenshot({ path: testInfo.outputPath('project-initial.png'), fullPage: true });

  await search(page).fill('华东');
  await expect(names(page)).toHaveText(['华东客户交付二期']);
  await search(page).fill('P-1180');
  await expect(names(page)).toHaveText(['内部培训']);
  await search(page).fill('没有这个项目');
  await expect(names(page)).toHaveCount(0);
  await expect(workbench(page).getByText('没有匹配的可选项目')).toBeVisible();
});

test('按类别全选：勾选「外地市内交通」组标题一次归入 P-2307，该组全部已归入，项目按钮的条数与金额随之变化', async ({ page }, testInfo) => {
  await page.goto(open('?seed=project', '#/task/T1/project'));
  await expect(page.getByRole('region', { name: '外地市内交通' })).toContainText('6 条');
  await expect(page.getByTestId('line-card-9')).toContainText('2026-08-09 至 2026-08-22');
  await expect(page.getByTestId('line-card-7')).toContainText('杭州东 → 上海虹桥');

  await page.getByRole('checkbox', { name: '选择外地市内交通' }).click();
  await expect(page.getByText('已选 6 条')).toBeVisible();
  await assignTo(page, 'P-2307 华东客户交付');
  for (const no of [1, 2, 3, 4, 5, 6]) await expect(projectOf(page, no)).toHaveText('P-2307 · 华东客户交付');
  await expect(projectOf(page, 7)).toHaveText('未归属');
  await expect(usage(page, 'P-2307')).toHaveText('6 条 · 186.59 元');

  await pick(page, 9);
  await assignTo(page, 'P-3312 产品调研');
  await expect(usage(page, 'P-3312')).toHaveText('1 条 · 3640.00 元');
  await expect(usedNames(page)).toHaveText(['华东客户交付', '产品调研']);
  await expect(names(page)).toHaveText(['华东客户交付二期', '内部培训']);
  await page.screenshot({ path: testInfo.outputPath('project-group-assigned.png'), fullPage: true });
});

test('冲突：取消不改变归属，只处理未归属只动未归属的明细，确认覆盖全部改掉', async ({ page }, testInfo) => {
  await page.goto(open('?seed=project', '#/task/T1/project'));
  await expect(projectOf(page, 1)).toHaveText('P-2307 · 华东客户交付');

  await selectConflict(page);
  await expect(conflictDialog(page).getByRole('button')).toHaveText(['取消', '只处理未归属', '确认覆盖']);
  await page.screenshot({ path: testInfo.outputPath('project-conflict.png'), fullPage: true });
  await conflictDialog(page).getByRole('button', { name: '取消' }).click();
  await expect(conflictDialog(page)).toHaveCount(0);
  await expect(projectOf(page, 1)).toHaveText('P-2307 · 华东客户交付');
  await expect(projectOf(page, 3)).toHaveText('未归属');

  // 取消保留勾选：再点一次归入，直接选「只处理未归属」。
  await assignTo(page, 'P-3312 产品调研');
  await conflictDialog(page).getByRole('button', { name: '只处理未归属' }).click();
  await expect(projectOf(page, 3)).toHaveText('P-3312 · 产品调研');
  await expect(projectOf(page, 1)).toHaveText('P-2307 · 华东客户交付');
  await expect(projectOf(page, 2)).toHaveText('P-2307 · 华东客户交付');

  await selectConflict(page);
  await conflictDialog(page).getByRole('button', { name: '确认覆盖' }).click();
  await expect(projectOf(page, 1)).toHaveText('P-3312 · 产品调研');
  await expect(projectOf(page, 2)).toHaveText('P-3312 · 产品调研');
  await expect(page.getByTestId('assign-summary')).toHaveText('已归属 3 / 9 条 · 合计 3972.59 元');
  await expect(usage(page, 'P-3312')).toHaveText('3 条 · 69.19 元');
});

test('提交：未归属或事由为空时不可用；提交后自动核对报销信息、准备材料，进入整单确认', async ({ page }, testInfo) => {
  await page.goto(open('?seed=project', '#/task/T1/project'));
  await expect(page.getByTestId('assign-summary')).toHaveText('已归属 2 / 9 条 · 合计 3972.59 元');
  await expect(submit(page)).toBeDisabled();

  await page.getByRole('checkbox', { name: '仅未归属' }).click();
  await page.getByRole('checkbox', { name: '全选当前明细' }).click();
  await assignTo(page, 'P-3312 产品调研');
  await expect(page.getByText('所有明细都已归属。')).toBeVisible();
  await page.getByRole('checkbox', { name: '仅未归属' }).click();
  await expect(page.getByTestId('assign-summary')).toHaveText('已归属 9 / 9 条 · 合计 3972.59 元');
  await expect(submit(page)).toBeDisabled();
  await page.getByLabel('报销事由').fill('上海产品评审出差');
  await expect(submit(page)).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('project-ready.png'), fullPage: true });

  await submit(page).click();
  await expect(page).toHaveURL(/#\/task\/T1\/review$/);
  await expect(page.getByRole('heading', { name: '整单明细确认' })).toBeVisible();
  await expect(page.getByRole('region', { name: '整单确认' }).getByRole('button', { name: '确认', exact: true })).toBeVisible();
  await expect(page.getByTestId('review-purpose')).toContainText('上海产品评审出差');

  // 回到项目归属：已提交，ERP 写入开始前仍可改派，有整单确认入口。
  await jump(page, '#/task/T1/project');
  await expect(page.getByText(/项目归属已提交/)).toBeVisible();
  await expect(submit(page)).toBeEnabled();
  await page.getByRole('link', { name: '去整单明细确认' }).click();
  await expect(page).toHaveURL(/#\/task\/T1\/review$/);
});

test('在项目簿删除本任务已用的项目：提交仍通过；这个项目「已锁定」，不能归入新的明细', async ({ page }, testInfo) => {
  await page.goto(open('?seed=review', '#/projects'));
  await expect(page.getByRole('heading', { name: '个人项目簿', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: '删除 P-2307' }).click();
  await expect(page.getByTestId('book-row-P-2307')).toHaveCount(0);

  await jump(page, '#/task/T1/project');
  await expect(page.getByRole('heading', { name: '项目归属' })).toBeVisible();
  await expect(usage(page, 'P-2307')).toHaveText('3 条 · 3786.00 元');
  await expect(workbench(page).getByRole('list', { name: '本次已归入' }).getByText('已锁定')).toBeVisible();
  await expect(workbench(page).getByRole('button', { name: '归入 P-2307 华东客户交付' })).toHaveCount(0);
  await expect(names(page)).toHaveText(['华东客户交付二期', '内部培训']);
  await page.screenshot({ path: testInfo.outputPath('project-deleted-locked.png'), fullPage: true });

  await page.getByLabel('报销事由').fill('上海产品评审出差（补）');
  await submit(page).click();
  await expect(page).toHaveURL(/#\/task\/T1\/review$/);
  await expect(page.getByRole('region', { name: '整单确认' }).getByRole('button', { name: '确认', exact: true })).toBeEnabled();
  await expect(page.getByTestId('confirm-row-9')).toContainText('P-2307 / 华东客户交付');
});
