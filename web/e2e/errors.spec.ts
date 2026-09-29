import { expect, test, type Page } from '@playwright/test';

// 错误态（#107）：服务断连与自动恢复、stepToken 过期（409）后换上最新快照并提示、动作失败就地显示。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

const BANNER = '连不上报销服务，请检查网络后重试；如果一直这样，请联系维护者';
const STALE = '任务已在别处推进';

const banner = (page: Page) => page.getByRole('alert').filter({ hasText: BANNER });
const staleNotice = (page: Page) => page.getByRole('status').filter({ hasText: STALE });
const checkbox = (page: Page) => page.getByRole('region', { name: '整单确认' }).getByRole('button', { name: '确认整单明细', exact: true });
const printLink = (page: Page) => page.getByRole('link', { name: '去打印', exact: true });

// 只在 mock 构建里存在的钩子：另一个窗口推进了任务，这边的事件流还没送到。
async function advanceElsewhere(page: Page, taskId: string) {
  await page.evaluate((id) => {
    const hooks = window.__baoxMock;
    if (!hooks) throw new Error('mock 钩子不存在');
    hooks.advanceElsewhere(id);
  }, taskId);
}

test('service-disconnected：横幅出现，断开期间动作就地失败且没有弹窗；恢复后横幅消失、动作可以继续', async ({ page }, testInfo) => {
  await page.goto(open('?seed=review&fault=service-disconnected', '#/task/T1/review'));
  await expect(banner(page)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('disconnected.png'), fullPage: true });

  await checkbox(page).click();
  const confirmRegion = page.getByRole('region', { name: '整单确认' });
  await expect(confirmRegion.getByRole('alert')).toHaveText(/操作没有送达/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(checkbox(page)).toBeEnabled();

  // mock 在断开 3 s 后恢复。
  await expect(banner(page)).toHaveCount(0, { timeout: 10_000 });
  await page.screenshot({ path: testInfo.outputPath('reconnected.png'), fullPage: true });
  await checkbox(page).click();
  await expect(printLink(page)).toBeVisible();
  await expect(confirmRegion.getByRole('alert')).toHaveCount(0);
});

test('service-disconnected：断开期间打开别的任务页也显示横幅，恢复后消失', async ({ page }) => {
  await page.goto(open('?fault=service-disconnected', '#/task/T3/done'));
  await expect(banner(page)).toBeVisible();
  await page.evaluate(() => {
    window.location.hash = '#/task/T2/reconcile';
  });
  await expect(page.getByRole('heading', { name: '对账', exact: true })).toBeVisible();
  await expect(banner(page)).toBeVisible();
  await expect(banner(page)).toHaveCount(0, { timeout: 10_000 });
});

test('409：别处已确认整单，这边再点确认得到最新快照与提示，路由不变，没有就地错误', async ({ page }, testInfo) => {
  await page.goto(open('?seed=review', '#/task/T1/review'));
  await expect(checkbox(page)).toBeVisible();
  await advanceElsewhere(page, 'T1');
  await checkbox(page).click();
  await expect(staleNotice(page)).toBeVisible();
  await expect(page).toHaveURL(/#\/task\/T1\/review$/);
  await expect(printLink(page)).toBeVisible();
  await expect(checkbox(page)).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('stale-review.png'), fullPage: true });
  await page.getByRole('button', { name: '知道了' }).click();
  await expect(staleNotice(page)).toHaveCount(0);
});

test('409：待确认项答复凭据过期，答复没被采用，页面留在原处并提示', async ({ page }) => {
  await page.goto(open('?seed=pending', '#/task/T1/pending'));
  await expect(page.getByText('还剩 4 个')).toBeVisible();
  await advanceElsewhere(page, 'T1');
  const detail = page.getByLabel('待确认项详情');
  await detail.getByLabel(/^起点/).fill('静安寺');
  await detail.getByLabel(/^终点/).fill('虹桥火车站');
  await detail.getByRole('button', { name: '保存并标记已处理' }).click();
  await expect(staleNotice(page)).toBeVisible();
  await expect(page).toHaveURL(/#\/task\/T1\/pending$/);
  await expect(page.getByText('还剩 4 个')).toBeVisible();
  // Carbon 输入框自带空的 role="alert" 字数提示，只看有文字的。
  await expect(detail.getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(0);
});
