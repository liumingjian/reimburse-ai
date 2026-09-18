import { expect, test, type Page } from '@playwright/test';

// 项目归属：待确认项之后、整单确认之前（两条路径都经过），形状照内核 Variant B 工作台：左边勾选明细，点右侧「归入项目」面板里的项目直接归入，没有弹层。
// 直接用 file:// 打开 mock 构建产物（pnpm build:mock）。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

// 右栏「归入项目」面板：每个项目是一个按钮，点它就把勾选的明细归入；本次已用的项目在「本次已归入」列表里，带条数与金额。
const panel = (page: Page) => page.getByRole('complementary', { name: '归入项目' });
const targets = (page: Page, list?: string) => (list ? panel(page).getByRole('list', { name: list }) : panel(page)).locator('button.app-project-target');
const targetNumbers = (page: Page, list?: string) => targets(page, list).locator('.app-code');
const target = (page: Page, number: string) => panel(page).getByRole('button', { name: new RegExp(number) });
const panelSearch = (page: Page) => panel(page).getByRole('searchbox', { name: '查找项目' });
const usage = (page: Page, number: string) => page.getByTestId(`usage-${number}`);
// 吸顶选择栏的状态文字：下一步该做什么，或上一次归入了什么。
const selection = (page: Page) => page.getByTestId('assign-selection');
const pick = (page: Page, no: number) => page.getByRole('checkbox', { name: `选择明细 No.${no}` }).locator('xpath=following-sibling::label[1]').click();
const assignTo = (page: Page, number: string) => target(page, number).click();
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

test('归入项目面板：没勾选时项目不可点并提示先勾选；勾选后可点；取消选择清空勾选；没有批量操作栏与弹层', async ({ page }, testInfo) => {
  await page.goto(open('?seed=assign', '#/task/T1/project'));
  await expect(page.getByRole('heading', { name: '项目归属' })).toBeVisible();
  await expect(panel(page).getByRole('heading', { name: '归入项目' })).toBeVisible();
  await expect(targets(page, '本次已归入')).toHaveCount(1);
  await expect(targets(page, '本次已归入')).toContainText('华东客户交付');
  await expect(usage(page, 'P-2307')).toHaveText('2 条 / 47.54 元');
  await expect(page.getByTestId('assign-summary')).toHaveText('已归属2 / 9 条整单合计3972.59 元');
  await expect(page.getByRole('region', { name: '批量操作' })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(selection(page)).toHaveText('勾选明细后，点右侧项目归入');
  await expect(panel(page).getByText('先勾选左侧明细')).toBeVisible();
  await expect(targets(page).first()).toBeVisible();
  for (const button of await targets(page).all()) await expect(button).toBeDisabled();
  await expect(page.getByRole('button', { name: '取消选择' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('project-initial.png'), fullPage: true });

  await pick(page, 3);
  await pick(page, 4);
  await expect(selection(page)).toHaveText('已选 2 条，点右侧项目归入');
  await expect(panel(page).getByText('已选 2 条', { exact: true })).toBeVisible();
  for (const button of await targets(page).all()) await expect(button).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('project-selected.png'), fullPage: true });
  await page.getByRole('button', { name: '取消选择' }).click();
  await expect(selection(page)).toHaveText('勾选明细后，点右侧项目归入');
  await expect(page.getByRole('checkbox', { name: '选择明细 No.3' })).not.toBeChecked();
  await expect(target(page, 'P-3312')).toBeDisabled();
  await expect(projectOf(page, 3)).toHaveText('未归属');
});

test('面板列表：只列可选项目，本次已用的在前并带条数与金额；搜索过滤；点项目直接归入；搜到唯一项目时回车归入', async ({ page }, testInfo) => {
  await page.goto(open('?seed=project', '#/task/T1/project'));
  await pick(page, 3);
  await expect(targetNumbers(page)).toHaveText(['P-2307', 'P-2311', 'P-3312', 'P-1180']);
  await expect(targetNumbers(page, '本次已归入')).toHaveText(['P-2307']);
  await expect(targetNumbers(page, '可选项目')).toHaveText(['P-2311', 'P-3312', 'P-1180']);
  await expect(usage(page, 'P-2307')).toHaveText('2 条 / 47.54 元');
  await expect(panel(page).getByText('南京客户培训')).toHaveCount(0);
  await expect(panel(page).getByText('旧版对账工具')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('project-panel.png'), fullPage: true });

  await panelSearch(page).fill('华东');
  await expect(targetNumbers(page)).toHaveText(['P-2307', 'P-2311']);
  await panelSearch(page).fill('P-1180');
  await expect(targetNumbers(page)).toHaveText(['P-1180']);
  await panelSearch(page).fill('没有这个项目');
  await expect(targets(page)).toHaveCount(0);
  await expect(panel(page).getByText('没有匹配的项目')).toBeVisible();
  await panelSearch(page).fill('');
  await expect(targets(page)).toHaveCount(4);

  await assignTo(page, 'P-1180');
  await expect(projectOf(page, 3)).toHaveText('P-1180 / 内部培训');
  await expect(selection(page)).toHaveText('已归入 P-1180 内部培训');
  await expect(page.getByRole('checkbox', { name: '选择明细 No.3' })).not.toBeChecked();
  await expect(target(page, 'P-1180')).toBeDisabled();

  // 搜到唯一可选项目时，在搜索框回车就归入勾选的明细。
  await pick(page, 4);
  await panelSearch(page).fill('P-3312');
  await expect(targetNumbers(page)).toHaveText(['P-3312']);
  await panelSearch(page).press('Enter');
  await expect(projectOf(page, 4)).toHaveText('P-3312 / 产品调研');
  await expect(selection(page)).toHaveText('已归入 P-3312 产品调研');
});

test('按类别全选：勾选「外地市内交通」组标题一次归入 P-2307，该组全部已归入，本次已归入的条数与金额随之变化', async ({ page }, testInfo) => {
  await page.goto(open('?seed=project', '#/task/T1/project'));
  await expect(page.getByRole('region', { name: '外地市内交通' })).toContainText('6 条');
  await expect(page.getByTestId('line-card-9')).toContainText('2026-08-09 至 2026-08-22');
  await expect(page.getByTestId('line-card-7')).toContainText('杭州东 → 上海虹桥');

  await page.getByRole('checkbox', { name: '选择外地市内交通' }).locator('xpath=following-sibling::label[1]').click();
  await expect(selection(page)).toHaveText('已选 6 条，点右侧项目归入');
  await assignTo(page, 'P-2307');
  for (const no of [1, 2, 3, 4, 5, 6]) await expect(projectOf(page, no)).toHaveText('P-2307 / 华东客户交付');
  await expect(projectOf(page, 7)).toHaveText('未归属');
  await expect(usage(page, 'P-2307')).toHaveText('6 条 / 186.59 元');

  await pick(page, 9);
  await assignTo(page, 'P-3312');
  await expect(usage(page, 'P-3312')).toHaveText('1 条 / 3640.00 元');
  await expect(targets(page, '本次已归入')).toHaveCount(2);
  // 面板里本次已用的两个项目排在前面。
  await expect(targetNumbers(page)).toHaveText(['P-2307', 'P-3312', 'P-2311', 'P-1180']);
  await page.screenshot({ path: testInfo.outputPath('project-group-assigned.png'), fullPage: true });
});

test('冲突：点项目后弹出三选一；取消不改变归属且保留勾选，只处理未归属只动未归属的明细，确认覆盖全部改掉', async ({ page }, testInfo) => {
  await page.goto(open('?seed=project', '#/task/T1/project'));
  await expect(projectOf(page, 1)).toHaveText('P-2307 / 华东客户交付');

  await selectConflict(page);
  // 冲突待定时面板里的项目不可点。
  await expect(target(page, 'P-1180')).toBeDisabled();
  // 只看有文字的按钮（Carbon 弹层右上角的关闭按钮只有图标与「关闭」读屏名）。
  await expect(conflictDialog(page).getByRole('button').filter({ hasText: /\S/ })).toHaveText(['取消', '只处理未归属', '确认覆盖']);
  await page.screenshot({ path: testInfo.outputPath('project-conflict.png'), fullPage: true });
  await conflictDialog(page).getByRole('button', { name: '取消' }).click();
  await expect(conflictDialog(page)).toHaveCount(0);
  await expect(projectOf(page, 1)).toHaveText('P-2307 / 华东客户交付');
  await expect(projectOf(page, 3)).toHaveText('未归属');

  // 取消保留勾选：再点一次项目，直接选「只处理未归属」。
  await expect(selection(page)).toHaveText('已选 3 条，点右侧项目归入');
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
  await expect(usage(page, 'P-3312')).toHaveText('3 条 / 69.19 元');
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

test('deactivating a submitted project preserves its snapshot and prevents new assignments', async ({ page }, testInfo) => {
  await page.goto(open('?seed=review', '#/projects'));
  await expect(page.getByRole('heading', { name: '个人项目簿', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: '停用项目 P-2307' }).click();
  await expect(page.getByTestId('book-row-P-2307')).toContainText('已停用');

  await jump(page, '#/task/T1/project');
  await expect(page.getByRole('heading', { name: '项目归属' })).toBeVisible();
  await expect(usage(page, 'P-2307')).toHaveText('3 条 / 3786.00 元');
  await expect(target(page, 'P-2307')).toContainText('已锁定');
  await page.screenshot({ path: testInfo.outputPath('project-deleted-locked.png'), fullPage: true });
  await pick(page, 1);
  await expect(target(page, 'P-2311')).toBeEnabled();
  await expect(target(page, 'P-2307')).toBeDisabled();
  await page.getByRole('button', { name: '取消选择' }).click();

  await page.getByLabel('报销事由').fill('上海产品评审出差（补）');
  await submit(page).click();
  await expect(page).toHaveURL(/#\/task\/T1\/review$/);
  await expect(page.getByRole('region', { name: '整单确认' }).getByRole('button', { name: '确认整单明细', exact: true })).toBeEnabled();
  await expect(page.getByTestId('confirm-row-9')).toContainText('P-2307 / 华东客户交付');
});

test('ERP 写入开始后只读：明细不能勾选，面板里的项目都不能点', async ({ page }) => {
  await page.goto(open('?seed=erp', '#/task/T1/project'));
  await expect(page.getByText('已开始写入报销系统，项目归属不能再修改。')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '全选当前明细' })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: '选择明细 No.1' })).toBeDisabled();
  await expect(panel(page).getByText('不能再修改')).toBeVisible();
  await expect(targets(page).first()).toBeVisible();
  for (const button of await targets(page).all()) await expect(button).toBeDisabled();
  await expect(panel(page).getByRole('button', { name: '新增项目' })).toBeDisabled();
  await expect(submit(page)).toBeDisabled();
});

// 选择栏一行放全选、筛选与状态文字，筛选宽度按内容；1440 与 1100 下「归入项目」面板都在明细表右侧，页面与明细区都不横向滚动。
for (const width of [1440, 1100]) {
  test(`${width} 下工具栏一行、筛选按内容宽；页面与明细区不横向滚动`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(open('?seed=project', '#/task/T1/project'));
    await expect(page.getByTestId('line-card-9')).toBeVisible();
    const selectAll = (await page.getByRole('checkbox', { name: '全选当前明细' }).locator('xpath=following-sibling::label[1]').boundingBox())!;
    const filter = (await page.getByRole('tablist', { name: '明细筛选' }).boundingBox())!;
    const status = (await page.getByRole('group', { name: '明细选择与筛选' }).getByTestId('assign-selection').boundingBox())!;
    const middle = (box: { y: number; height: number }) => box.y + box.height / 2;
    expect(Math.abs(middle(filter) - middle(selectAll))).toBeLessThan(8);
    expect(Math.abs(middle(status) - middle(selectAll))).toBeLessThan(8);
    expect(filter.width).toBeLessThan(320);
    const overflow = await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>('[aria-label="费用明细"]')!;
      return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, main: main.scrollWidth - main.clientWidth };
    });
    expect(overflow).toEqual({ page: 0, main: 0 });
    const table = (await page.getByTestId('line-card-9').boundingBox())!;
    const aside = (await panel(page).boundingBox())!;
    expect(aside.x).toBeGreaterThanOrEqual(table.x + table.width - 1);
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
