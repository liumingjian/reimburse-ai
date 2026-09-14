import { expect, test, type Page } from '@playwright/test';

// 页头节奏（#123）：各页页头到内容的间距由页头组件统一（$spacing-07 = 32px）；页头没有孤立的返回按钮；表格 No. 列左对齐。
// 直接用 file:// 打开 mock 构建产物（pnpm build:mock）。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

const HEAD_TO_CONTENT = 32;

const PAGES: ReadonlyArray<readonly [string, string, string]> = [
  ['upload', '?seed=upload', '#/task/T1/upload'],
  ['inventory', '?seed=inventory', '#/task/T1/inventory'],
  ['pending', '?seed=pending', '#/task/T1/pending'],
  ['project', '?seed=project', '#/task/T1/project'],
  ['review', '?seed=review', '#/task/T1/review'],
  ['print', '?seed=print', '#/task/T1/print'],
  ['erp', '?seed=erp', '#/task/T1/erp'],
  ['reconcile', '', '#/task/T2/reconcile'],
  ['done', '?seed=done', '#/task/T1/done'],
];

// 页头文字块（标题加导语）的下边到页头后第一块有高度的内容的上边。
async function headToContent(page: Page): Promise<number> {
  const title = page.getByRole('main').getByRole('heading', { level: 1 });
  await expect(title).toBeVisible();
  return title.evaluate((h1) => {
    const text = h1.parentElement as HTMLElement;
    const head = text.parentElement as HTMLElement;
    let next = head.nextElementSibling as HTMLElement | null;
    while (next && next.getBoundingClientRect().height === 0) next = next.nextElementSibling as HTMLElement | null;
    if (!next) throw new Error('页头后面没有内容');
    return next.getBoundingClientRect().top - text.getBoundingClientRect().bottom;
  });
}

test('1440 下九个任务页的页头到内容间距一致（32px，允许 1px 误差）；附 1440 与 1100 截图', async ({ page }, testInfo) => {
  const gaps: Record<string, number> = {};
  for (const [name, query, hash] of PAGES) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(open(query, hash));
    gaps[name] = await headToContent(page);
    await page.screenshot({ path: testInfo.outputPath(`header-${name}-1440.png`) });
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.screenshot({ path: testInfo.outputPath(`header-${name}-1100.png`) });
  }
  for (const [name, gap] of Object.entries(gaps)) {
    expect.soft(Math.abs(gap - HEAD_TO_CONTENT), `${name} 页头到内容 ${gap}px`).toBeLessThanOrEqual(1);
  }
});

test('打印、报销、对账页头没有孤立的返回按钮；步骤条仍可回到已完成的步骤', async ({ page }) => {
  for (const [query, hash] of [
    ['?seed=print', '#/task/T1/print'],
    ['?seed=erp', '#/task/T1/erp'],
    ['', '#/task/T2/reconcile'],
  ] as const) {
    await page.goto(open(query, hash));
    await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('main').getByRole('link', { name: /^返回/ })).toHaveCount(0);
    await expect(page.getByRole('main').getByRole('button', { name: /^返回/ })).toHaveCount(0);
  }

  await page.goto(open('?seed=print', '#/task/T1/print'));
  await page.getByRole('list', { name: '流程阶段' }).getByRole('button', { name: /^整单明细确认/ }).click();
  await expect(page).toHaveURL(/#\/task\/T1\/review$/);
  await expect(page.getByRole('heading', { level: 1, name: '整单明细确认' })).toBeVisible();
});

test('整单明细、完成、对账表格的 No. 列左对齐，列宽按内容收紧', async ({ page }) => {
  for (const [query, hash, table] of [
    ['?seed=review', '#/task/T1/review', '整单明细'],
    ['?seed=done', '#/task/T1/done', '逐条回读'],
    ['', '#/task/T2/reconcile', '逐行比对'],
  ] as const) {
    await page.goto(open(query, hash));
    const grid = page.getByRole('table', { name: table });
    const head = grid.getByRole('columnheader', { name: 'No.' });
    const cell = grid.locator('tbody tr').first().getByRole('cell').first();
    await expect(head).toBeVisible();
    // 表头文字与首行序号的左边对齐，且都贴着单元格左内边距（左对齐）。
    const [headText, cellText, cellBox] = await Promise.all([
      head.evaluate((th) => {
        const range = document.createRange();
        range.selectNodeContents(th);
        return range.getBoundingClientRect().left;
      }),
      cell.evaluate((td) => {
        const range = document.createRange();
        range.selectNodeContents(td);
        return range.getBoundingClientRect().left;
      }),
      cell.evaluate((td) => {
        const box = td.getBoundingClientRect();
        return { left: box.left + parseFloat(getComputedStyle(td).paddingInlineStart), width: box.width };
      }),
    ]);
    expect.soft(Math.abs(cellText - cellBox.left), `${table} No. 单元格左对齐`).toBeLessThanOrEqual(1);
    expect.soft(Math.abs(headText - cellText), `${table} No. 表头与序号左边对齐`).toBeLessThanOrEqual(1);
    expect.soft(cellBox.width, `${table} No. 列宽按内容收紧`).toBeLessThanOrEqual(96);
  }
});

// Next step in the sticky bar (#141): step page headers keep only title and lead; the task list keeps its creation action.
const pageHead = (page: Page) => page.getByRole('main').getByRole('heading', { level: 1 }).locator('xpath=../..');

test('材料盘点与上传材料的下一步在吸底栏里，页头没有操作；任务列表页头保留新建报销任务', async ({ page }) => {
  await page.goto(open('?seed=inventory', '#/task/T1/inventory'));
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible();
  await expect(pageHead(page).getByRole('link')).toHaveCount(0);
  await expect(pageHead(page).getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '下一步' }).getByRole('link', { name: '处理 3 个待确认项' })).toBeVisible();

  await page.goto(open('?seed=upload', '#/task/T1/upload'));
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible();
  await expect(pageHead(page).getByRole('button')).toHaveCount(0);
  const bar = page.getByRole('region', { name: '下一步' });
  await expect(bar.getByRole('button', { name: '开始材料盘点' })).toBeVisible();
  await expect(bar.getByRole('button', { name: '追加下一批' })).toBeVisible();

  await page.goto(open('', '#/tasks'));
  await expect(pageHead(page).getByRole('button', { name: '新建报销任务' })).toBeVisible();
});

test('步骤页最多一个主按钮', async ({ page }) => {
  for (const [query, hash] of [
    ['?seed=upload', '#/task/T1/upload'],
    ['?seed=inventory', '#/task/T1/inventory'],
    ['?seed=project', '#/task/T1/project'],
    ['?seed=review', '#/task/T1/review'],
  ] as const) {
    await page.goto(open(query, hash));
    await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible();
    expect(await page.getByRole('main').locator('.cds--btn--primary').count(), `${hash} 主按钮数`).toBeLessThanOrEqual(1);
  }
});

test('1440 与 1100 下吸底栏不遮住盘点表的最后一行', async ({ page }) => {
  for (const [width, height] of [
    [1440, 1000],
    [1100, 900],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(open('?seed=inventory', '#/task/T1/inventory'));
    const bar = page.getByRole('region', { name: '下一步' });
    await expect(bar).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const lastRow = page.getByRole('main').locator('tbody tr').last();
    const [rowBottom, barTop] = await Promise.all([
      lastRow.evaluate((row) => row.getBoundingClientRect().bottom),
      bar.evaluate((node) => node.getBoundingClientRect().top),
    ]);
    expect(rowBottom, `${width} 最后一行底边不低于吸底栏顶边`).toBeLessThanOrEqual(barTop + 1);
  }
});
