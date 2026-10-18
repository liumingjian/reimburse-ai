import { expect, test, type Page } from '@playwright/test';

// The 设置页 shows the baox 本地执行器 only (ADR-0037, #437): no 去报销的方式 to choose and no 浏览器扩展 section.
// Without a paired 本地执行器, 去报销 is refused with a link to the 设置页.

const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;
const DESKTOP_VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
] as const;
const DEFAULT_ORIGIN = 'http://10.250.0.222:8888';
const CODE = 'K7MQ2PXD';

async function openSettings(page: Page, viewport: (typeof DESKTOP_VIEWPORTS)[number], query = '') {
  await page.setViewportSize(viewport);
  // A fresh page each time: the same URL again would be a same-document navigation keeping the last state.
  await page.goto('about:blank');
  await page.goto(open(query, '#/settings'));
  const local = page.getByRole('region', { name: 'baox 本地执行器' });
  await expect(local).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: '设置' })).toBeVisible();
  await expect(page.getByText('装好并连上本地执行器，再回到报销任务去报销。')).toBeVisible();
  // Nothing to choose, and nothing of the 浏览器扩展 left.
  await expect(page.getByRole('radio', { name: /本地执行器|浏览器扩展/ })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '浏览器扩展' })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('扩展');
  // #429: the 报销系统 account form sits inside the 本地执行器 section.
  await expect(local.getByRole('region', { name: '报销系统账号密码' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  return local;
}

test('first-time settings leads with the install command at both desktop widths', async ({ page }, testInfo) => {
  for (const viewport of DESKTOP_VIEWPORTS) {
    const local = await openSettings(page, viewport, '?pairing=none');
    const generate = local.getByRole('button', { name: '生成安装命令' });
    await expect(generate).toBeDisabled();
    await expect(local.getByRole('button', { name: '撤销配对' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '完全重置' })).toBeHidden();
    await local.getByRole('radio', { name: 'Mac' }).check({ force: true });
    await expect(generate).toBeEnabled();
    await generate.click();
    await expect(local.getByText(`curl -fsSL ${DEFAULT_ORIGIN}/install/${CODE} | sh`)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`settings-first-time-${viewport.width}.png`), fullPage: true });
  }
});

test('paired settings shows 已连接 and 撤销配对 at both desktop widths', async ({ page }, testInfo) => {
  for (const viewport of DESKTOP_VIEWPORTS) {
    const local = await openSettings(page, viewport);
    await expect(local.getByText('已连接', { exact: true })).toBeVisible();
    await expect(local.getByRole('button', { name: '撤销配对' })).toBeVisible();
    await expect(page.getByRole('button', { name: '完全重置' })).toBeHidden();

    const controls = local.locator('.cds--btn:visible');
    await expect(controls).not.toHaveCount(0);
    for (const control of await controls.all()) {
      expect(await control.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(40);
    }
    await page.screenshot({ path: testInfo.outputPath(`settings-paired-${viewport.width}.png`), fullPage: true });
  }
});

test('the install and uninstall commands name the active address, the default and an override', async ({ page }) => {
  for (const origin of [DEFAULT_ORIGIN, 'https://baox.example.com:9443']) {
    const query = origin === DEFAULT_ORIGIN ? '?pairing=none' : `?pairing=none&origin=${encodeURIComponent(origin)}`;
    const local = await openSettings(page, DESKTOP_VIEWPORTS[0], query);
    await local.getByRole('radio', { name: 'Windows' }).check({ force: true });
    await local.getByRole('button', { name: '生成安装命令' }).click();
    await expect(local.getByText(`powershell -ExecutionPolicy Bypass -c "irm ${origin}/install/${CODE} | iex"`)).toBeVisible();
    await local.getByText('安装遇到问题？').click();
    await expect(local.getByText(`curl -fsSL ${origin}/uninstall/mac | sh`)).toBeVisible();
  }
});

test('安装遇到问题 is collapsed and holds the install steps; the old tutorial route is gone', async ({ page }, testInfo) => {
  for (const viewport of DESKTOP_VIEWPORTS) {
    const local = await openSettings(page, viewport, '?pairing=none');
    const steps = local.getByRole('list', { name: '安装步骤' });
    await expect(steps).toBeHidden();
    await local.getByText('安装遇到问题？').click();
    await expect(steps).toBeVisible();
    await expect(local.getByRole('link', { name: '打开安装教程' })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`settings-trouble-${viewport.width}.png`), fullPage: true });
  }
  await page.goto(open('', '#/settings/tutorial'));
  await expect(page).toHaveURL(/#\/tasks$/);
});

test('without a paired 本地执行器, 去报销 is refused with a link to the 设置页 and a way back', async ({ page }) => {
  await page.setViewportSize(DESKTOP_VIEWPORTS[0]);
  await page.goto(open('?seed=actions&pairing=none', '#/task/T1/review'));
  const card = page.getByRole('region', { name: '去报销' });
  await card.getByRole('button', { name: '去报销' }).click();
  await expect(card.getByRole('alert')).toContainText('先在设置页安装本地执行器。');
  await expect(page).toHaveURL(/#\/task\/T1\/review$/);
  await card.getByRole('link', { name: '去设置页' }).click();
  await expect(page.getByRole('region', { name: 'baox 本地执行器' })).toBeVisible();
  await page.getByRole('region', { name: '返回报销任务' }).getByRole('link', { name: '返回报销任务' }).click();
  await expect(page).toHaveURL(/#\/task\/T1\/review$/);
  await expect(page.getByRole('heading', { level: 1, name: '整单明细确认' })).toBeVisible();
});
