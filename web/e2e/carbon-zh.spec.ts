import { expect, test, type Page } from '@playwright/test';

// Carbon 组件自带的英文文案（默认参数、读屏文字、图标标题、aria-label、placeholder）都要换成中文（ADR-0012）。
// 检查整页文字（含视觉隐藏的读屏文字与 SVG 标题）和常见的可访问属性，弹层打开时也查一遍。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

const ENGLISH = [
  'items selected',
  'item selected',
  'Search',
  'Clear search input',
  'Filter table',
  'data table toolbar',
  'Close',
  'Complete',
  'Current',
  'Incomplete',
  'Invalid',
  'Cancel',
  'Previous',
  'Next',
  'Select all',
  'Select row',
  'Expand',
  'Collapse',
  'Sort',
  'Dismiss',
  'Show password',
  'Hide password',
  'Open menu',
  'Options',
  'Provide itemText',
  'Loading',
  'error icon',
  'info icon',
  'warning icon',
  'success icon',
  'Focus sentinel',
  'Choose a date',
  'Items per page',
];

const PAGES: ReadonlyArray<readonly [string, string]> = [
  ['', '#/tasks'],
  ['', '#/tasks/new'],
  ['', '#/projects'],
  ['', '#/settings'],
  ['?seed=upload', '#/task/T1/upload'],
  ['?seed=inventory', '#/task/T1/inventory'],
  ['?seed=pending', '#/task/T1/pending'],
  ['?seed=project', '#/task/T1/project'],
  ['?seed=review', '#/task/T1/review'],
  ['?seed=actions', '#/task/T1/review'],
  ['?seed=print', '#/task/T1/print'],
  ['?seed=erp', '#/task/T1/erp'],
  ['?seed=done', '#/task/T1/done'],
  ['', '#/task/T2/reconcile'],
  ['?seed=inventory', '#/task/T1/review'],
  ['?fault=service-disconnected', '#/tasks'],
  ['?auth=setup', '#/tasks'],
  ['?auth=signed-out', '#/tasks'],
];

async function englishLeftovers(page: Page): Promise<string[]> {
  const text = await page.evaluate(() => {
    const attributes = ['aria-label', 'title', 'placeholder', 'alt', 'aria-description', 'aria-roledescription'];
    const values = [...document.querySelectorAll('*')].flatMap((element) => attributes.map((name) => element.getAttribute(name) ?? ''));
    return [document.body.textContent ?? '', ...values].join('\n');
  });
  return ENGLISH.filter((word) => new RegExp(`\\b${word}\\b`).test(text));
}

test('主要页面没有 Carbon 自带的英文文案', async ({ page }) => {
  for (const [query, hash] of PAGES) {
    await page.goto(open(query, hash));
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    expect(await englishLeftovers(page), `${query}${hash}`).toEqual([]);
  }
});

test('断连时的加载指示（InlineLoading）与不可用的新建按钮没有英文文案', async ({ page }, testInfo) => {
  await page.goto(open('?fault=service-disconnected', '#/tasks'));
  const waiting = page.locator('.cds--inline-loading').filter({ hasText: '正在等待本地服务恢复' });
  await expect(waiting).toBeVisible();
  await expect(page.getByRole('button', { name: '新建报销任务' })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('tasks-disconnected.png'), fullPage: true });
  expect(await englishLeftovers(page), '断连').toEqual([]);
  // InlineLoading 的图标说明默认是英文小写 loading：可访问属性里也不许出现。
  const loadingAttributes = await page.evaluate(() =>
    [...document.querySelectorAll('[aria-label], [title]')].map((element) => `${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('title') ?? ''}`).filter((text) => /loading/i.test(text)),
  );
  expect(loadingAttributes).toEqual([]);
});

test('原件查看器工具栏：可访问名称与提示都是中文', async ({ page }) => {
  await page.goto(open('?seed=pending', '#/task/T1/pending'));
  const toolbar = page.getByRole('toolbar', { name: '原件查看' });
  await expect(toolbar).toBeVisible();
  const names = ['适应窗口', '放大', '缩小', '旋转 90°'];
  for (const name of names) {
    const button = toolbar.getByRole('button', { name, exact: true });
    // 键盘聚焦时出现中文提示。
    await button.focus();
    await expect(page.getByRole('tooltip').filter({ hasText: name }).first()).toBeAttached();
  }
  expect(await englishLeftovers(page), '原件查看器').toEqual([]);
  const labels = await toolbar.evaluate((node) =>
    [...node.querySelectorAll('*')].flatMap((element) => ['aria-label', 'title'].map((name) => element.getAttribute(name) ?? '')).filter(Boolean),
  );
  for (const label of labels) expect(label, label).not.toMatch(/[A-Za-z]/);
  const tooltips = await toolbar.locator('[role="tooltip"]').allTextContents();
  expect(tooltips.sort()).toEqual([...names].sort());
});

test('弹层打开时也没有英文文案（动过报销系统的作废确认、作废确认、新建任务、追加材料）', async ({ page }) => {
  await page.goto(open('', '#/tasks'));
  await expect(page.getByRole('button', { name: '更多', exact: true })).toHaveCount(0);
  // ADR-0030：动过报销系统的任务也能作废，它的确认框换的是那一段更长的说明。
  const touched = page.getByRole('row', { name: /2026-07 深圳客户拜访/ });
  await touched.getByRole('button', { name: '作废' }).click();
  await expect(page.getByRole('dialog', { name: '作废这个报销任务？' })).toContainText('报销系统里已经产生的费用报销单');
  expect(await englishLeftovers(page), '动过报销系统的作废确认').toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const item = page.getByRole('row', { name: /2026-08 上海出差（产品评审）/ }).getByRole('button', { name: '作废' });
  await expect(item).toBeEnabled();
  await item.click();
  await expect(page.getByRole('dialog', { name: '作废这个报销任务？' })).toBeVisible();
  expect(await englishLeftovers(page), '作废确认').toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.goto(open('', '#/tasks/new'));
  await expect(page.getByRole('dialog', { name: '新建报销任务' })).toBeVisible();
  await page.getByRole('dialog').getByLabel('常驻城市').fill('');
  await page.getByRole('dialog').getByRole('button', { name: '创建并上传材料' }).click();
  await expect(page.getByRole('dialog').getByRole('alert').filter({ hasText: '请填写常驻城市。' })).toBeVisible();
  expect(await englishLeftovers(page), '新建任务（含错误）').toEqual([]);

  await page.goto(open('?seed=project', '#/task/T1/project'));
  await page.getByRole('checkbox', { name: '选择明细 No.3' }).locator('xpath=following-sibling::label[1]').click();
  const selectionBar = page.getByRole('group', { name: '明细选择与筛选' });
  await expect(selectionBar.getByTestId('assign-selection')).toHaveText('已选 1 条，点右侧项目归入');
  await expect(selectionBar.getByRole('button', { name: '取消选择' })).toBeVisible();
  expect(await englishLeftovers(page), '项目归属选择栏（已勾选）').toEqual([]);
  // 「归入项目」面板的 Carbon 搜索框：占位文字与输入后出现的清除按钮都是中文。
  const assignPanel = page.getByRole('complementary', { name: '归入项目' });
  const search = assignPanel.getByRole('searchbox', { name: '查找项目' });
  await expect(search).toHaveAttribute('placeholder', '搜项目号或名称');
  await search.fill('没有这个项目');
  await expect(assignPanel.getByRole('button', { name: '清除查找' })).toBeVisible();
  await expect(assignPanel.getByText('没有匹配的项目')).toBeVisible();
  expect(await englishLeftovers(page), '项目归属「归入项目」面板（搜索无结果）').toEqual([]);

  await page.goto(open('?seed=actions', '#/task/T1/review'));
  await page.getByRole('button', { name: '追加材料' }).click();
  await expect(page.getByRole('dialog', { name: '追加材料会形成新的盘点版本' })).toBeVisible();
  expect(await englishLeftovers(page), '追加材料').toEqual([]);
});
