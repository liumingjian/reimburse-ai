import { expect, test, type Page } from '@playwright/test';

// Carbon 组件自带的英文文案（默认参数、读屏文字、图标标题、aria-label、placeholder）都要换成中文（ADR-0008）。
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
  ['?identity=unbound', '#/tasks'],
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

test('弹层打开时也没有英文文案（作废确认、新建任务、追加材料）', async ({ page }) => {
  await page.goto(open('', '#/tasks'));
  await page.getByRole('button', { name: '作废 2026-08 上海出差（产品评审）' }).click();
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
  await page.getByRole('complementary', { name: '项目工作台' }).getByRole('button', { name: '归入 P-3312 产品调研' }).click();
  await expect(page.getByText('先勾选明细')).toBeVisible();
  expect(await englishLeftovers(page), '项目归属「先勾选明细」提示').toEqual([]);

  await page.goto(open('?seed=actions', '#/task/T1/review'));
  await page.getByRole('button', { name: '追加材料' }).click();
  await expect(page.getByRole('dialog', { name: '追加材料会形成新的盘点版本' })).toBeVisible();
  expect(await englishLeftovers(page), '追加材料').toEqual([]);
});
