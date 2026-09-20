import { expect, test, type Page } from '@playwright/test';

// #117：界面用语遵守内核禁用词（不出现 ERP、候选等）、阶段名用内核 10 阶段、设置页「完全重置」、任务菜单「作废」。
// 直接用 file:// 打开 mock 构建产物（pnpm build:mock）。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

// 内核 FORBIDDEN_USER_TERMS（50931a3:kernel/src/interaction.mjs:99-131）。
const FORBIDDEN = [
  '内核', '模型', 'OCR', 'MarkItDown', 'Markdown', 'Node', 'CDP', 'AppleEvents', 'ego-browser', 'task space', 'BAOX_HOME', 'stepToken',
  'step.argv', 'blockedBy', 'resolvableBy', 'upload_dispatched', 'manifestHash', 'bundleHash', 'ERP', '候选', '原生票种', '手动 QA', '子 Agent',
  '机器', 'reextract', 'schema', 'hash', '数据库', '解析器', '置信度', '字段映射', 'rule:',
];

async function expectNoForbidden(page: Page, label: string) {
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const text = await page.locator('body').innerText();
  for (const term of FORBIDDEN) expect(text, `${label} 含「${term}」`).not.toContain(term);
}

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
  ['?seed=reconcile', '#/task/T1/reconcile'],
  ['?seed=reconcile', '#/task/T1/erp'],
  ['', '#/task/T2/reconcile'],
  ['', '#/task/T3/done'],
  ['?auth=setup', '#/tasks'],
  ['?auth=signed-out', '#/tasks'],
  ['?seed=pending&book=empty&allocation=1', '#/task/T1/pending'],
];

test('界面上不出现内核禁用词（ERP、候选等）', async ({ page }) => {
  for (const [query, hash] of PAGES) {
    await page.goto(open(query, hash));
    await expectNoForbidden(page, `${query}${hash}`);
  }
  // 展开后的回读差异也检查一遍。
  await page.goto(open('', '#/task/T2/reconcile'));
  await page.getByRole('button', { name: '展开 No.3' }).click();
  await expectNoForbidden(page, 'T2 展开 No.3');
});

test('阶段名用内核 10 阶段：只出现在任务列表徽标上，步骤条不重复', async ({ page }) => {
  await page.goto(open('?seed=project', '#/tasks'));
  await expect(page.getByRole('row', { name: /2026-08 上海出差（产品评审）/ }).getByText('6/10 项目归属')).toBeVisible();
  await expect(page.getByRole('row', { name: /2026-06 北京培训/ }).getByText('10/10 草稿交接')).toBeVisible();
  await page.goto(open('?seed=review', '#/tasks'));
  await expect(page.getByRole('row', { name: /2026-08 上海出差（产品评审）/ }).getByText('8/10 报销材料准备')).toBeVisible();
  await page.goto(open('?seed=erp', '#/tasks'));
  await expect(page.getByRole('row', { name: /2026-08 上海出差（产品评审）/ }).getByText('9/10 保存报销草稿')).toBeVisible();
  await page.goto(open('?seed=review', '#/task/T1/review'));
  await expect(page.getByRole('list', { name: '流程阶段' })).toBeVisible();
  await expect(page.getByRole('region', { name: '任务进度' })).not.toContainText('/10');
});

test('作废：T1 确认作废后从任务列表消失；动过报销系统的 T2、T3 也能作废，确认框说明撤不掉那边的单据', async ({ page }, testInfo) => {
  await page.goto(open('', '#/tasks'));
  for (const name of ['2026-07 深圳客户拜访', '2026-06 北京培训']) {
    const row = page.getByRole('row', { name: new RegExp(name) });
    await expect(row.getByRole('button', { name: '作废' })).toBeEnabled();
    await row.getByRole('button', { name: '作废' }).click();
    await expect(page.getByRole('dialog', { name: '作废这个报销任务？' })).toContainText('报销系统里已经产生的费用报销单');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  await page.getByRole('row', { name: /2026-08 上海出差（产品评审）/ }).getByRole('button', { name: '作废' }).click();
  const dialog = page.getByRole('dialog', { name: '作废这个报销任务？' });
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('abandon-dialog.png'), fullPage: true });
  await dialog.getByRole('button', { name: '作废', exact: true }).click();
  await expect(page.getByRole('row', { name: /2026-08 上海出差（产品评审）/ })).toHaveCount(0);
  await expect(page).toHaveURL(/#\/tasks$/);
  await expect(page.getByRole('row', { name: /2026-07 深圳客户拜访/ })).toBeVisible();
});

test('?seed=erp：已开始写入报销系统的 T1「作废」不可用', async ({ page }) => {
  await page.goto(open('?seed=erp', '#/tasks'));
  await expect(page.getByRole('row', { name: /2026-08 上海出差（产品评审）/ }).getByRole('button', { name: '作废' })).toBeDisabled();
});

test('完全重置：设置页二次确认后只清空当前账号的数据，仍然登录，任务列表为空', async ({ page }, testInfo) => {
  await page.goto(open('', '#/tasks'));
  await page.getByRole('navigation', { name: '全局' }).getByRole('link', { name: '设置' }).click();
  await expect(page).toHaveURL(/#\/settings$/);
  await page.getByRole('button', { name: '完全重置' }).click();
  const resetConfirm = page.getByRole('dialog', { name: '清空你的全部数据？' }).getByRole('button', { name: '清空并重置' });
  // 危险弹层：确认按钮是 Carbon 的 $button-danger-primary（#da1e28）。
  await expect(resetConfirm).toHaveCSS('background-color', 'rgb(218, 30, 40)');
  await resetConfirm.click();
  await expect(page).toHaveURL(/#\/tasks$/);
  await expect(page.getByRole('heading', { name: '还没有报销任务' })).toBeVisible();
  await expect(page.getByRole('banner').getByText('林颂宜', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('after-reset.png'), fullPage: true });
});
