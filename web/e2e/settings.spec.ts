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
  // 去报销的方式 (#428): with nothing paired the page opens on the 本地执行器; the extension's section needs choosing.
  const choice = page.getByRole('radio', { name: '浏览器扩展' });
  if (!query.includes('extension=')) {
    await expect(page.getByRole('radio', { name: '本地执行器（推荐）' })).toBeChecked();
    await expect(page.getByRole('region', { name: '浏览器扩展' })).toHaveCount(0);
    // #429: the 报销系统 account form sits inside the 本地执行器 section.
    await expect(page.getByRole('region', { name: 'baox 本地执行器' }).getByRole('region', { name: '报销系统账号密码' })).toBeVisible();
    await choice.check({ force: true });
  }
  await expect(choice).toBeChecked();
  await expect(page.getByRole('region', { name: 'baox 本地执行器' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '报销系统账号密码' })).toHaveCount(0);
  const extension = page.getByRole('region', { name: '浏览器扩展' });
  await expect(extension).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: '设置' })).toBeVisible();
  await expect(page.getByText('选择去报销的方式，连接好后回到报销任务去报销。')).toBeVisible();
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

test('a disconnected extension gets the active-origin migration path for the default and an override', async ({ page }, testInfo) => {
  for (const [name, origin] of [
    ['default', 'http://10.250.0.222:8888'],
    ['override', 'https://baox.example.com:9443'],
  ] as const) {
    const extension = await openSettings(page, DESKTOP_VIEWPORTS[0], `?extension=disconnected&extensionOrigin=${encodeURIComponent(origin)}`);
    await expect(extension.getByRole('heading', { name: '扩展暂时没有连接' })).toBeVisible();
    await expect(extension.getByText(origin, { exact: true })).toBeVisible();
    await expect(extension.getByText(`应用地址变更后，旧扩展不会连接到 ${origin}。`)).toBeVisible();
    const steps = extension.getByRole('list', { name: '改用当前地址的扩展' });
    await expect(steps.getByText(`在 ${origin} 下载新的浏览器扩展并解压。`)).toBeVisible();
    await expect(steps.getByText('在 Chrome 或 Edge 的扩展页移除旧扩展，或用新解压目录替换后点“重新加载”。')).toBeVisible();
    await expect(steps.getByText('回到这里生成新的配对码，并在新扩展中输入。')).toBeVisible();
    await expect(steps.getByText('看到“已连接”后再去报销。')).toBeVisible();
    await expect(extension.getByText(`旧地址的配对不表示已连接到 ${origin}。`)).toBeVisible();
    await expect(extension.getByRole('link', { name: '下载浏览器扩展' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`settings-origin-migration-${name}.png`), fullPage: true });
  }
});

test('tutorial opens in a separate tab from 安装遇到问题 and remains readable at both desktop widths', async ({ page }, testInfo) => {
  for (const viewport of DESKTOP_VIEWPORTS) {
    const extension = await openSettings(page, viewport);
    // #429: the tutorial is reachable only from the collapsed 「安装遇到问题？」.
    const tutorialLink = extension.getByRole('link', { name: '打开安装教程' });
    await expect(tutorialLink).toBeHidden();
    await extension.getByText('安装遇到问题？').click();
    const popupPromise = page.waitForEvent('popup');
    await tutorialLink.click();
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
