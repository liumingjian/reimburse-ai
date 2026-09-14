import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.SHOTS_DIR ?? '/tmp/carbon-b-shots';
const pageUrl = (name: string) => pathToFileURL(join(dir, `${name}.html`)).href;

for (const [width, height] of [
  [1440, 900],
  [1792, 1000],
] as const) {
  test.describe(`${width}x${height}`, () => {
    test.use({ viewport: { width, height } });

    test('任务列表', async ({ page }) => {
      const external: string[] = [];
      page.on('request', (request) => {
        if (!request.url().startsWith('file:')) external.push(request.url());
      });
      await page.goto(pageUrl('tasks'));
      await page.screenshot({ path: join(out, `tasks-${width}.png`), fullPage: true });
      await page.locator('.has-tip').first().hover();
      await expect(page.getByRole('tooltip').first()).toBeVisible();
      await page.screenshot({ path: join(out, `tasks-${width}-tooltip.png`) });
      expect(external).toEqual([]);
    });

    test('整单明细确认：13 列不横向滚动', async ({ page }) => {
      const external: string[] = [];
      page.on('request', (request) => {
        if (!request.url().startsWith('file:')) external.push(request.url());
      });
      await page.goto(pageUrl('review'));
      await page.screenshot({ path: join(out, `review-${width}.png`), fullPage: true });
      const size = await page.locator('.confirm-scroll').evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
      console.log(`review ${width}: scrollWidth ${size.scroll} clientWidth ${size.client}`);
      expect(size.scroll).toBeLessThanOrEqual(size.client);
      expect(external).toEqual([]);
    });
  });
}
