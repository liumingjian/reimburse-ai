import { expect, test, type Page } from '@playwright/test';

const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;
const DESKTOP_VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
] as const;

async function openSettings(page: Page, viewport: (typeof DESKTOP_VIEWPORTS)[number], query = '') {
  await page.setViewportSize(viewport);
  await page.goto(open(query, '#/settings'));
  const extension = page.getByRole('region', { name: '浏览器扩展' });
  await expect(extension).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: '设置' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  return extension;
}

test('first-time settings leads with the extension connection action at both desktop widths', async ({ page }, testInfo) => {
  for (const viewport of DESKTOP_VIEWPORTS) {
    const extension = await openSettings(page, viewport);
    await expect(extension.getByRole('heading', { name: '还没有配对' })).toBeVisible();
    await expect(extension.getByRole('heading', { name: '第一次连接' })).toBeVisible();
    await expect(extension.getByRole('button', { name: '生成配对码' })).toBeVisible();
    await expect(extension.getByText('扩展暂时没有连接')).toHaveCount(0);
    await expect(extension.getByRole('button', { name: '撤销配对' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '完全重置' })).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath(`settings-first-time-${viewport.width}.png`), fullPage: true });
  }
});

test('paired settings shows connection facts and relevant recovery actions at both desktop widths', async ({ page }, testInfo) => {
  for (const viewport of DESKTOP_VIEWPORTS) {
    const extension = await openSettings(page, viewport, '?extension=paired');
    await expect(extension.getByRole('heading', { name: '已配对' })).toBeVisible();
    await expect(extension.getByRole('heading', { name: '扩展已连接，可以开始去报销' })).toBeVisible();
    await expect(extension.getByRole('button', { name: '重新生成配对码' })).toHaveCount(1);
    await expect(extension.getByRole('button', { name: '撤销配对' })).toBeVisible();
    await expect(extension.getByText('扩展没有连上这个应用')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '完全重置' })).toBeHidden();

    const controls = extension.locator('.cds--btn');
    await expect(controls).not.toHaveCount(0);
    for (const control of await controls.all()) {
      expect(await control.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(40);
    }
    await page.screenshot({ path: testInfo.outputPath(`settings-paired-${viewport.width}.png`), fullPage: true });
  }
});

test('tutorial opens in a separate tab and remains readable at both desktop widths', async ({ page }, testInfo) => {
  for (const viewport of DESKTOP_VIEWPORTS) {
    const extension = await openSettings(page, viewport);
    const popupPromise = page.waitForEvent('popup');
    await extension.getByRole('link', { name: '打开安装教程' }).click();
    const tutorial = await popupPromise;
    await tutorial.waitForLoadState();
    await expect(tutorial).toHaveURL(/#\/settings\/tutorial$/);
    await expect(tutorial.getByRole('heading', { level: 1, name: '浏览器扩展安装教程' })).toBeVisible();
    await expect(tutorial.getByRole('img', { name: '浏览器扩展安装示意图' })).toBeVisible();
    await expect(tutorial.getByRole('list', { name: '安装步骤' })).toBeVisible();
    expect(await tutorial.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await tutorial.screenshot({ path: testInfo.outputPath(`settings-tutorial-${viewport.width}.png`), fullPage: true });
    await tutorial.close();
  }
});
