import { expect, test, type Page } from '@playwright/test';

// 待确认项（#102）。直接用 file:// 打开 mock 构建产物（pnpm build:mock）；原件预览来自 dist-mock/fixtures/。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

const list = (page: Page) => page.getByLabel('待确认项清单');
const detail = (page: Page) => page.getByLabel('待确认项详情');
// 按标题开头找条目（标题之间互为前缀时不串）；按文件名找用 itemByFile。
const item = (page: Page, title: string) => list(page).getByRole('button', { name: new RegExp(`^${title}`) });
const itemByFile = (page: Page, fileName: string) => list(page).getByRole('button', { name: new RegExp(fileName) });
const save = (page: Page) => detail(page).getByRole('button', { name: '保存并标记已处理' });

test('左右分栏：原件预览随选中项切换，夹具文件能从 dist-mock/fixtures 打开', async ({ page }, testInfo) => {
  await page.goto(open('?seed=pending', '#/task/T1/pending'));
  await expect(page.getByRole('heading', { name: '待确认项' })).toBeVisible();
  await expect(page.getByText('对照原件补填或作出选择。还剩 3 个。')).toBeVisible();
  await expect(list(page).getByRole('button')).toHaveCount(3);

  const photo = detail(page).getByRole('img', { name: 'IMG_4871.jpg 原件' });
  await expect(photo).toHaveAttribute('src', 'fixtures/m09-taxi-photo.jpg');
  // 图片真的加载到了（说明 mock 构建把夹具复制进了 dist-mock/fixtures/）。
  await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  // 读出的字段照常显示，但不显示来源（规则名 / user）。
  await expect(detail(page).getByText('04213377')).toBeVisible();
  await expect(detail(page)).not.toContainText('rule:');
  await expect(detail(page).getByTestId('resolver')).toHaveText('处理人：要你处理');

  await item(page, '不支持的材料类型').click();
  const frame = detail(page).locator('iframe[title="餐饮_发票.pdf 原件"]');
  await expect(frame).toHaveAttribute('src', 'fixtures/m11-other-invoice.pdf');
  await expect(detail(page).getByRole('button', { name: '排除此材料' })).toBeVisible();

  await item(page, '下车时间不合法').click();
  await expect(detail(page).getByRole('img', { name: 'IMG_4906.jpg 原件' })).toHaveAttribute('src', 'fixtures/m10-taxi-photo.jpg');
  await expect(detail(page).getByText('90:60', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('pending-detail.png'), fullPage: true });
});

test('表单校验：必填与 HH:MM 格式阻止非法值', async ({ page }) => {
  await page.goto(open('?seed=pending', '#/task/T1/pending'));
  await save(page).click();
  await expect(detail(page).getByRole('alert')).toHaveCount(2);
  await expect(detail(page).getByRole('alert').first()).toHaveText('必填，对照原件填写。');

  await item(page, '下车时间不合法').click();
  await detail(page).getByLabel('下车时间 *').fill('90:60');
  await detail(page).getByLabel('起点 *').fill('静安寺');
  await detail(page).getByLabel('终点 *').fill('虹桥枢纽');
  await save(page).click();
  await expect(detail(page).getByRole('alert')).toHaveText('格式应为 HH:MM，且小时 00-23、分钟 00-59。');
  await expect(page.getByText('还剩 3 个')).toBeVisible();
});

test('补填与排除：全部处理完显示没有待确认项了，并能进入整单明细确认', async ({ page }, testInfo) => {
  await page.goto(open('?seed=pending', '#/task/T1/pending'));
  await detail(page).getByLabel('起点 *').fill('张江高科');
  await detail(page).getByLabel('终点 *').fill('漕河泾开发区');
  await save(page).click();
  await expect(detail(page).getByRole('heading', { name: '下车时间不合法，并补填起点与终点' })).toBeVisible();
  await expect(item(page, '补填起点与终点')).toContainText('已处理');
  await expect(page.getByText('还剩 2 个')).toBeVisible();

  await detail(page).getByLabel('下车时间 *').fill('19:06');
  await detail(page).getByLabel('起点 *').fill('静安寺');
  await detail(page).getByLabel('终点 *').fill('虹桥枢纽');
  await save(page).click();
  await expect(detail(page).getByRole('heading', { name: '不支持的材料类型' })).toBeVisible();

  await detail(page).getByRole('button', { name: '排除此材料' }).click();
  await expect(page.getByRole('heading', { name: '没有待确认项了' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('pending-empty.png'), fullPage: true });
  // 待确认项之后是项目归属（整单确认在项目归属之后）。
  await page.getByRole('link', { name: '进入项目归属' }).click();
  await expect(page).toHaveURL(/#\/task\/T1\/project$/);
  await expect(page.getByRole('heading', { name: '项目归属' })).toBeVisible();
  // 盘点页的入口也变成进入项目归属。
  await page.getByRole('list', { name: '流程阶段' }).getByRole('button', { name: /^材料盘点/ }).click();
  await expect(page.getByRole('link', { name: '进入项目归属' })).toBeVisible();
});

test('自行手工处理同样推进', async ({ page }) => {
  await page.goto(open('?seed=pending', '#/task/T1/pending'));
  await item(page, '不支持的材料类型').click();
  await detail(page).getByRole('button', { name: '自行手工处理' }).click();
  await expect(page.getByText('还剩 2 个')).toBeVisible();
  await expect(item(page, '不支持的材料类型')).toContainText('已处理');
});

test('?seed=review：待确认项页直接是空状态', async ({ page }) => {
  await page.goto(open('?seed=review', '#/task/T1/pending'));
  await expect(page.getByRole('heading', { name: '没有待确认项了' })).toBeVisible();
  await expect(page.getByRole('link', { name: '进入项目归属' })).toBeVisible();
});

test('?fault=unsupported-material：多出的不支持材料也能排除', async ({ page }) => {
  await page.goto(open('?seed=pending&fault=unsupported-material', '#/task/T1/pending'));
  await expect(page.getByText('还剩 4 个')).toBeVisible();
  await itemByFile(page, '曹操出行_行程单').click();
  await expect(detail(page).locator('iframe[title="曹操出行_行程单.pdf 原件"]')).toHaveAttribute('src', 'fixtures/m06-caocao-itinerary.pdf');
  await detail(page).getByRole('button', { name: '排除此材料' }).click();
  await expect(page.getByText('还剩 3 个')).toBeVisible();
});
