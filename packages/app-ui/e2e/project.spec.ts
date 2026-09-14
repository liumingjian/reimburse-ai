import { expect, test, type Page } from '@playwright/test';

// 项目归属：待确认项之后、整单确认之前（两条路径都经过），形状照内核 Variant B 工作台，选项目用 Carbon 批量操作栏与项目弹层。
// 直接用 file:// 打开 mock 构建产物（pnpm build:mock）。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

// 右栏「本次归属」只读摘要；每个项目用字段组显示项目号、条数、价税合计三个值。
const panel = (page: Page) => page.getByRole('complementary', { name: '本次归属' });
const usedItems = (page: Page) => panel(page).getByRole('list', { name: '本次归属的项目' }).getByRole('listitem');
const usage = (page: Page, number: string) => page.getByTestId(`usage-${number}`).getByRole('definition');
// 批量操作栏只在勾选了明细时出现；「归入项目」弹层是搜索加单选列表。
const batch = (page: Page) => page.getByRole('region', { name: '批量操作' });
const picker = (page: Page) => page.getByRole('dialog', { name: '归入项目' });
const pickerSearch = (page: Page) => picker(page).getByRole('searchbox', { name: '查找项目' });
const optionNumbers = (page: Page) => picker(page).getByRole('radio').evaluateAll((radios) => radios.map((radio) => (radio as HTMLInputElement).value));
const choose = (page: Page, number: string) => picker(page).getByRole('radio', { name: new RegExp(number) }).locator('xpath=following-sibling::label[1]').click();
const pick = (page: Page, no: number) => page.getByRole('checkbox', { name: `选择明细 No.${no}` }).locator('xpath=following-sibling::label[1]').click();
async function assignTo(page: Page, number: string) {
  await batch(page).getByRole('button', { name: '归入项目' }).click();
  await choose(page, number);
  await picker(page).getByRole('button', { name: '确认归入' }).click();
}
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
  await assignTo(page, 'P-3312');
  await expect(conflictDialog(page)).toBeVisible();
}

test('本次归属只读、没有按钮；没勾选时没有归入入口；勾选后批量操作栏出现，取消清空勾选', async ({ page }, testInfo) => {
  await page.goto(open('?seed=assign', '#/task/T1/project'));
  await expect(page.getByRole('heading', { name: '项目归属' })).toBeVisible();
  await expect(usedItems(page)).toHaveCount(1);
  await expect(usedItems(page)).toContainText('华东客户交付');
  await expect(usage(page, 'P-2307')).toHaveText(['P-2307', '2 条', '47.54 元']);
  await expect(panel(page).getByRole('button')).toHaveCount(0);
  await expect(page.getByTestId('assign-summary')).toHaveText('已归属2 / 9 条整单合计3972.59 元');
  await expect(batch(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '归入项目' })).toHaveCount(0);
  await expect(page.getByText('先勾选明细')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('project-initial.png'), fullPage: true });

  await pick(page, 3);
  await pick(page, 4);
  await expect(batch(page).getByText('已选 2 条')).toBeVisible();
  await expect(batch(page).getByRole('button', { name: '归入项目' })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('project-batch.png'), fullPage: true });
  await batch(page).getByRole('button', { name: '取消' }).click();
  await expect(batch(page)).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: '选择明细 No.3' })).not.toBeChecked();
  await expect(projectOf(page, 3)).toHaveText('未归属');
});

test('项目弹层：只列可选项目，本次已用的在前并带条数；搜索过滤；选中后确认归入', async ({ page }, testInfo) => {
  await page.goto(open('?seed=project', '#/task/T1/project'));
  await pick(page, 3);
  await batch(page).getByRole('button', { name: '归入项目' }).click();
  await expect(picker(page)).toBeVisible();
  await expect(picker(page).getByRole('radio')).toHaveCount(4);
  expect(await optionNumbers(page)).toEqual(['P-2307', 'P-2311', 'P-3312', 'P-1180']);
  await expect(picker(page).getByText('本次 2 条')).toBeVisible();
  await expect(picker(page).getByText('南京客户培训')).toHaveCount(0);
  await expect(picker(page).getByText('旧版对账工具')).toHaveCount(0);
  await expect(picker(page).getByRole('button', { name: '确认归入' })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('project-picker.png'), fullPage: true });

  await pickerSearch(page).fill('华东');
  await expect(picker(page).getByRole('radio')).toHaveCount(2);
  expect(await optionNumbers(page)).toEqual(['P-2307', 'P-2311']);
  await pickerSearch(page).fill('P-1180');
  await expect(picker(page).getByRole('radio')).toHaveCount(1);
  expect(await optionNumbers(page)).toEqual(['P-1180']);
  await pickerSearch(page).fill('没有这个项目');
  await expect(picker(page).getByRole('radio')).toHaveCount(0);
  await expect(picker(page).getByText('没有匹配的可选项目')).toBeVisible();
  await pickerSearch(page).fill('');
  await choose(page, 'P-1180');
  await picker(page).getByRole('button', { name: '确认归入' }).click();
  await expect(picker(page)).toHaveCount(0);
  await expect(projectOf(page, 3)).toHaveText('P-1180 / 内部培训');
  await expect(batch(page)).toHaveCount(0);
});

test('按类别全选：勾选「外地市内交通」组标题一次归入 P-2307，该组全部已归入，本次归属的条数与金额随之变化', async ({ page }, testInfo) => {
  await page.goto(open('?seed=project', '#/task/T1/project'));
  await expect(page.getByRole('region', { name: '外地市内交通' })).toContainText('6 条');
  await expect(page.getByTestId('line-card-9')).toContainText('2026-08-09 至 2026-08-22');
  await expect(page.getByTestId('line-card-7')).toContainText('杭州东 → 上海虹桥');

  await page.getByRole('checkbox', { name: '选择外地市内交通' }).locator('xpath=following-sibling::label[1]').click();
  await expect(batch(page).getByText('已选 6 条')).toBeVisible();
  await assignTo(page, 'P-2307');
  for (const no of [1, 2, 3, 4, 5, 6]) await expect(projectOf(page, no)).toHaveText('P-2307 / 华东客户交付');
  await expect(projectOf(page, 7)).toHaveText('未归属');
  await expect(usage(page, 'P-2307')).toHaveText(['P-2307', '6 条', '186.59 元']);

  await pick(page, 9);
  await assignTo(page, 'P-3312');
  await expect(usage(page, 'P-3312')).toHaveText(['P-3312', '1 条', '3640.00 元']);
  await expect(usedItems(page)).toHaveCount(2);
  // 弹层里本次已用的两个项目排在前面。
  await pick(page, 7);
  await batch(page).getByRole('button', { name: '归入项目' }).click();
  await expect(picker(page).getByRole('radio')).toHaveCount(4);
  expect(await optionNumbers(page)).toEqual(['P-2307', 'P-3312', 'P-2311', 'P-1180']);
  await picker(page).getByRole('button', { name: '取消' }).click();
  await page.screenshot({ path: testInfo.outputPath('project-group-assigned.png'), fullPage: true });
});

test('冲突：从弹层确认后弹出三选一；取消不改变归属，只处理未归属只动未归属的明细，确认覆盖全部改掉', async ({ page }, testInfo) => {
  await page.goto(open('?seed=project', '#/task/T1/project'));
  await expect(projectOf(page, 1)).toHaveText('P-2307 / 华东客户交付');

  await selectConflict(page);
  await expect(picker(page)).toHaveCount(0);
  // 只看有文字的按钮（Carbon 弹层右上角的关闭按钮只有图标与「关闭」读屏名）。
  await expect(conflictDialog(page).getByRole('button').filter({ hasText: /\S/ })).toHaveText(['取消', '只处理未归属', '确认覆盖']);
  await page.screenshot({ path: testInfo.outputPath('project-conflict.png'), fullPage: true });
  await conflictDialog(page).getByRole('button', { name: '取消' }).click();
  await expect(conflictDialog(page)).toHaveCount(0);
  await expect(projectOf(page, 1)).toHaveText('P-2307 / 华东客户交付');
  await expect(projectOf(page, 3)).toHaveText('未归属');

  // 取消保留勾选：再归入一次，直接选「只处理未归属」。
  await expect(batch(page).getByText('已选 3 条')).toBeVisible();
  await assignTo(page, 'P-3312');
  await conflictDialog(page).getByRole('button', { name: '只处理未归属' }).click();
  await expect(projectOf(page, 3)).toHaveText('P-3312 / 产品调研');
  await expect(projectOf(page, 1)).toHaveText('P-2307 / 华东客户交付');
  await expect(projectOf(page, 2)).toHaveText('P-2307 / 华东客户交付');

  await selectConflict(page);
  await conflictDialog(page).getByRole('button', { name: '确认覆盖' }).click();
  await expect(projectOf(page, 1)).toHaveText('P-3312 / 产品调研');
  await expect(projectOf(page, 2)).toHaveText('P-3312 / 产品调研');
  await expect(page.getByTestId('assign-summary')).toHaveText('已归属3 / 9 条整单合计3972.59 元');
  await expect(usage(page, 'P-3312')).toHaveText(['P-3312', '3 条', '69.19 元']);
});

test('提交：未归属或事由为空时不可用；提交后自动核对报销信息、准备材料，进入整单确认', async ({ page }, testInfo) => {
  await page.goto(open('?seed=project', '#/task/T1/project'));
  await expect(page.getByTestId('assign-summary')).toHaveText('已归属2 / 9 条整单合计3972.59 元');
  await expect(submit(page)).toBeDisabled();

  // 「未归属」筛选是切换器（与任务列表一致），不是复选框。
  await expect(page.getByRole('checkbox', { name: '仅未归属' })).toHaveCount(0);
  await page.getByRole('tablist', { name: '明细筛选' }).getByRole('tab', { name: '未归属' }).click();
  await page.getByRole('checkbox', { name: '全选当前明细' }).locator('xpath=following-sibling::label[1]').click();
  await assignTo(page, 'P-3312');
  await expect(page.getByText('所有明细都已归属。')).toBeVisible();
  await page.getByRole('tablist', { name: '明细筛选' }).getByRole('tab', { name: '全部' }).click();
  await expect(page.getByTestId('assign-summary')).toHaveText('已归属9 / 9 条整单合计3972.59 元');
  await expect(submit(page)).toBeDisabled();
  await page.getByLabel('报销事由').fill('上海产品评审出差');
  await expect(submit(page)).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('project-ready.png'), fullPage: true });

  await submit(page).click();
  await expect(page).toHaveURL(/#\/task\/T1\/review$/);
  await expect(page.getByRole('heading', { name: '整单明细确认' })).toBeVisible();
  await expect(page.getByRole('region', { name: '整单确认' }).getByRole('button', { name: '确认整单明细', exact: true })).toBeVisible();
  await expect(page.getByTestId('review-purpose')).toContainText('上海产品评审出差');

  // 回到项目归属：已提交，ERP 写入开始前仍可改派，有整单确认入口。
  await jump(page, '#/task/T1/project');
  await expect(page.getByText(/项目归属已提交/)).toBeVisible();
  await expect(submit(page)).toBeEnabled();
  await page.getByRole('link', { name: '去整单明细确认' }).click();
  await expect(page).toHaveURL(/#\/task\/T1\/review$/);
});

test('在项目簿删除本任务已用的项目：提交仍通过；这个项目「已锁定」，弹层里不能选它', async ({ page }, testInfo) => {
  await page.goto(open('?seed=review', '#/projects'));
  await expect(page.getByRole('heading', { name: '个人项目簿', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: '删除 P-2307' }).click();
  await expect(page.getByTestId('book-row-P-2307')).toHaveCount(0);

  await jump(page, '#/task/T1/project');
  await expect(page.getByRole('heading', { name: '项目归属' })).toBeVisible();
  await expect(usage(page, 'P-2307')).toHaveText(['P-2307', '3 条', '3786.00 元']);
  await expect(panel(page).getByText('已锁定')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('project-deleted-locked.png'), fullPage: true });
  await pick(page, 1);
  await batch(page).getByRole('button', { name: '归入项目' }).click();
  await expect(picker(page).getByRole('radio', { name: /P-2311/ })).toHaveCount(1);
  await expect(picker(page).getByRole('radio', { name: /P-2307/ })).toHaveCount(0);
  await picker(page).getByRole('button', { name: '取消' }).click();
  await batch(page).getByRole('button', { name: '取消' }).click();

  await page.getByLabel('报销事由').fill('上海产品评审出差（补）');
  await submit(page).click();
  await expect(page).toHaveURL(/#\/task\/T1\/review$/);
  await expect(page.getByRole('region', { name: '整单确认' }).getByRole('button', { name: '确认整单明细', exact: true })).toBeEnabled();
  await expect(page.getByTestId('confirm-row-9')).toContainText('P-2307 / 华东客户交付');
});

test('ERP 写入开始后只读：明细不能勾选，没有批量操作', async ({ page }) => {
  await page.goto(open('?seed=erp', '#/task/T1/project'));
  await expect(page.getByText('已开始写入报销系统，项目归属不能再修改。')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '全选当前明细' })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: '选择明细 No.1' })).toBeDisabled();
  await expect(batch(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '归入项目' })).toHaveCount(0);
  await expect(submit(page)).toBeDisabled();
});

// 工具栏一行放全选、筛选与已选条数，筛选宽度按内容；1100 下「本次归属」排到明细表下方，页面与明细区都不横向滚动。
for (const width of [1440, 1100]) {
  test(`${width} 下工具栏一行、筛选按内容宽；页面与明细区不横向滚动`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(open('?seed=project', '#/task/T1/project'));
    await expect(page.getByTestId('line-card-9')).toBeVisible();
    const selectAll = (await page.getByRole('checkbox', { name: '全选当前明细' }).locator('xpath=following-sibling::label[1]').boundingBox())!;
    const filter = (await page.getByRole('tablist', { name: '明细筛选' }).boundingBox())!;
    const count = (await page.getByText('已选 0 条', { exact: true }).first().boundingBox())!;
    const middle = (box: { y: number; height: number }) => box.y + box.height / 2;
    expect(Math.abs(middle(filter) - middle(selectAll))).toBeLessThan(8);
    expect(Math.abs(middle(count) - middle(selectAll))).toBeLessThan(8);
    expect(filter.width).toBeLessThan(320);
    const overflow = await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>('[aria-label="费用明细"]')!;
      return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, main: main.scrollWidth - main.clientWidth };
    });
    expect(overflow).toEqual({ page: 0, main: 0 });
    const table = (await page.getByTestId('line-card-9').boundingBox())!;
    const aside = (await panel(page).boundingBox())!;
    if (width === 1100) expect(aside.y).toBeGreaterThanOrEqual(table.y + table.height - 1);
    else expect(aside.x).toBeGreaterThanOrEqual(table.x + table.width - 1);
  });
}

// 评审提到吸底栏可能压住表格最后一行：在矮视口下滚到底，量最后一行与吸底栏的位置。
for (const width of [1440, 1100]) {
  test(`${width} 下滚到底后，最后一行完全在吸底栏之上；附截图`, async ({ page }, testInfo) => {
    const height = 700;
    await page.setViewportSize({ width, height });
    await page.goto(open('?seed=project', '#/task/T1/project'));
    const last = page.getByTestId('line-card-9');
    const bar = page.getByRole('region', { name: '提交项目归属' });
    await expect(last).toBeVisible();
    await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      for (const element of document.querySelectorAll<HTMLElement>('*')) {
        if (element.scrollHeight > element.clientHeight && getComputedStyle(element).overflowY !== 'visible') element.scrollTop = element.scrollHeight;
      }
    });
    const row = (await last.boundingBox())!;
    const barBox = (await bar.boundingBox())!;
    // 吸底栏贴在视口底边，最后一行在它上面、且在视口内。
    expect(barBox.y + barBox.height).toBeLessThanOrEqual(height + 0.5);
    expect(row.y).toBeGreaterThanOrEqual(0);
    expect(row.y + row.height).toBeLessThanOrEqual(barBox.y + 0.5);
    await page.screenshot({ path: testInfo.outputPath(`project-bottom-${width}.png`) });
  });
}
