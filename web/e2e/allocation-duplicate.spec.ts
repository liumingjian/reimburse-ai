import { expect, test, type Page } from '@playwright/test';

// 逐段分摊、待确认项阻塞项、跨任务重复发票（内核 allocation_required / intake_open_items / duplicate_blocked），
// 以及盘点页与待确认项页不出现规则名、字段来源与「候选」。直接用 file:// 打开 mock 构建产物（pnpm build:mock）。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

const ALLOCATION = '合并交通发票逐段金额';
const GIVEN_UP = '逐段金额认不出';
const FORBIDDEN = /rule:|user|候选/;

const list = (page: Page) => page.getByLabel('待确认项清单');
const detail = (page: Page) => page.getByLabel('待确认项详情');
const item = (page: Page, title: string) => list(page).getByRole('button', { name: new RegExp(`^${title}`) });
const segment = (page: Page, index: number) => detail(page).getByLabel(new RegExp(`^第 ${index} 段`));
const save = (page: Page) => detail(page).getByRole('button', { name: '保存并标记已处理' });

const FIXTURE_FILES = [
  '全季酒店_发票.pdf',
  '全季酒店_结账单.pdf',
  '高德打车_发票.pdf',
  '高德打车_行程单.pdf',
  '曹操出行_发票.pdf',
  '曹操出行_行程单.pdf',
  '铁路电子客票_0809.pdf',
  '铁路电子客票_0822.pdf',
  'IMG_4871.jpg',
  'IMG_4906.jpg',
  '办公用品_发票.pdf',
];

async function answerTheRest(page: Page) {
  await item(page, '补填起点与终点').click();
  await detail(page).getByLabel('起点 *').fill('张江高科');
  await detail(page).getByLabel('终点 *').fill('漕河泾开发区');
  await save(page).click();
  await expect(detail(page).getByRole('heading', { name: '下车时间不合法，并补填起点与终点' })).toBeVisible();
  await detail(page).getByLabel('下车时间 *').fill('19:06');
  await detail(page).getByLabel('起点 *').fill('静安寺');
  await detail(page).getByLabel('终点 *').fill('虹桥枢纽');
  await save(page).click();
  await expect(detail(page).getByRole('heading', { name: '不支持的材料类型' })).toBeVisible();
  await detail(page).getByRole('button', { name: '排除此材料' }).click();
  await expect(detail(page).getByRole('heading', { name: '住宿发票「全季酒店_发票.pdf」缺少支付截图' })).toBeVisible();
  await detail(page).getByRole('button', { name: '确认没有支付截图' }).click();
}

test('?allocation=1：出现逐段分摊待确认项；不守恒显示服务端错误，守恒后通过；不显示处理人', async ({ page }, testInfo) => {
  await page.goto(open('?seed=pending&allocation=1', '#/task/T1/pending'));
  await expect(page.getByText('还剩 5 个')).toBeVisible();
  const buttons = list(page).getByRole('button');
  await expect(buttons).toHaveCount(5);
  // 清单行不再重复处理人（说明文字里服务端给的「要你处理的事项」照常显示）。
  await expect(list(page)).not.toContainText('要你处理');

  await expect(detail(page).getByRole('heading', { name: ALLOCATION })).toBeVisible();
  await expect(segment(page, 3)).toHaveValue('21.56');
  await detail(page).getByRole('button', { name: '提交逐段金额' }).click();
  await expect(detail(page).getByRole('alert').filter({ hasText: /\S/ })).toHaveText(
    '各段加起来是 69.10 元，和票面价税合计 69.19 元对不上。请对照行程单重新填写，不会平均、不会按比例，也不会把差额加到任何一段上。',
  );
  await expect(page.getByText('还剩 5 个')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('allocation-not-conserved.png'), fullPage: true });

  await segment(page, 3).fill('21.65');
  await detail(page).getByRole('button', { name: '提交逐段金额' }).click();
  await expect(detail(page).getByRole('heading', { name: '补填起点与终点' })).toBeVisible();
  await expect(item(page, ALLOCATION)).toContainText('已处理');
  await expect(page.getByText('还剩 4 个')).toBeVisible();

  // 继续处理完，明细与默认相同（9 行）。
  await answerTheRest(page);
  await expect(page.getByRole('heading', { name: '没有待确认项了' })).toBeVisible();
  await page.getByRole('link', { name: '进入项目归属' }).click();
  await expect(page.getByRole('checkbox', { name: /^选择明细 No\.\d+$/ })).toHaveCount(9);
});

test('?allocation=1：选「这张票我认不出」照内核留下阻塞项；排除这张发票连同行程单之后才能进入项目归属', async ({ page }, testInfo) => {
  await page.goto(open('?seed=pending&allocation=1', '#/task/T1/pending'));
  await expect(detail(page).getByTestId('give-up-note')).toContainText('不能带着往下走');
  await detail(page).getByRole('button', { name: '这张票我认不出' }).click();
  await expect(detail(page).getByRole('heading', { name: '补填起点与终点' })).toBeVisible();
  // 新出现的阻塞项是未处理行：没有「已处理」标签。
  await expect(item(page, GIVEN_UP)).toBeVisible();
  await expect(item(page, GIVEN_UP).getByText('已处理', { exact: true })).toHaveCount(0);
  await item(page, ALLOCATION).click();
  await expect(detail(page).getByTestId('give-up-note')).toContainText('你选了「这张票我认不出」。');

  // 其余四项处理完仍然拦着：还剩 1 个，没有「进入项目归属」。
  await answerTheRest(page);
  await expect(page.getByText('还剩 1 个')).toBeVisible();
  await expect(page.getByRole('link', { name: '进入项目归属' })).toHaveCount(0);
  await item(page, GIVEN_UP).click();
  await expect(detail(page).getByText(/要拆成 3 段，你说过逐段金额认不出来。它不能带着往下走。/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('allocation-given-up.png'), fullPage: true });

  await detail(page).getByRole('button', { name: '排除这张发票及其行程单' }).click();
  await expect(page.getByRole('heading', { name: '没有待确认项了' })).toBeVisible();
  await page.getByRole('link', { name: '进入项目归属' }).click();
  // 高德三段不再形成明细：剩 6 行。
  await expect(page.getByRole('checkbox', { name: /^选择明细 No\.\d+$/ })).toHaveCount(6);
});

test('?duplicate=1：上传后整批停，显示重复发票表与命中的任务名；「移出」重复的那份后接着形成待确认项，明细少一行', async ({ page }, testInfo) => {
  await page.goto(open('?duplicate=1', '#/task/T1/upload'));
  await page.getByLabel('拖入文件，或点击选择', { exact: true }).setInputFiles(
    FIXTURE_FILES.map((name) => ({ name, mimeType: name.endsWith('.jpg') ? 'image/jpeg' : 'application/pdf', buffer: Buffer.from(`fixture ${name}`) })),
  );
  await expect(page.getByRole('heading', { name: '上传批次 #1' })).toBeVisible();
  await page.getByRole('button', { name: '开始材料盘点' }).click();

  const table = page.getByRole('table', { name: '重复发票' });
  await expect(table).toBeVisible({ timeout: 15000 });
  await expect(table.locator('thead th')).toHaveText(['序号', '材料/明细', '参考材料', '待处理问题', '处理人', '操作']);
  const cells = table.locator('tbody tr td');
  await expect(cells.nth(1)).toHaveText('铁路电子客票_0809.pdf');
  await expect(cells.nth(3)).toContainText('2026-06 北京培训');
  await expect(cells.nth(4)).toHaveText('要你处理');
  await expect(page.getByRole('list', { name: '命中的任务' })).toHaveText('2026-06 北京培训');
  await expect(page.getByRole('link', { name: /^处理 \d+ 个待确认项$/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '进入项目归属' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('duplicate-blocked.png'), fullPage: true });

  await page.evaluate(() => {
    window.location.hash = '#/task/T1/pending';
  });
  await expect(page.getByText('这批材料整批暂停，没有形成待确认项。')).toBeVisible();
  await expect(page.getByRole('list', { name: '命中的任务' })).toHaveText('2026-06 北京培训');

  // 出路照内核「把文件移出」：移出后阻塞解除，接着划分费用事件与待确认项。
  await page.getByRole('button', { name: '移出 铁路电子客票_0809.pdf' }).click();
  await expect(page.getByRole('table', { name: '重复发票' })).toHaveCount(0);
  await expect(page.getByText('还剩 4 个')).toBeVisible();
  await answerTheRest(page);
  await expect(page.getByRole('heading', { name: '没有待确认项了' })).toBeVisible();
  await page.getByRole('link', { name: '进入项目归属' }).click();
  await expect(page.getByRole('checkbox', { name: /^选择明细 No\.\d+$/ })).toHaveCount(8);
});

test('盘点页与待确认项页没有 rule:、user、「候选」文字', async ({ page }) => {
  await page.goto(open('?seed=inventory', '#/task/T1/inventory'));
  await expect(page.getByLabel('盘点结果')).toBeVisible();
  expect(await page.locator('body').innerText()).not.toMatch(FORBIDDEN);

  await page.goto(open('?seed=pending&allocation=1', '#/task/T1/pending'));
  for (const title of [ALLOCATION, '补填起点与终点', '下车时间不合法', '不支持的材料类型']) {
    await item(page, title).click();
    await expect(detail(page).getByRole('heading').first()).toContainText(title);
    expect(await page.locator('body').innerText()).not.toMatch(FORBIDDEN);
  }
  // 补填之后回看，也不显示字段来源。
  await item(page, '补填起点与终点').click();
  await detail(page).getByLabel('起点 *').fill('张江高科');
  await detail(page).getByLabel('终点 *').fill('漕河泾开发区');
  await save(page).click();
  // 等服务端采用答复：采用后页面会自动跳到下一个未处理项。答复还在路上时就点回这一项，随后到达的结果会把选中项
  // 换成下一个未处理项，详情里就一直等不到「已处理」。先等清单里这一项出现「已处理」，再点回去看。
  await expect(item(page, '补填起点与终点')).toContainText('已处理');
  await item(page, '补填起点与终点').click();
  await expect(detail(page).getByText('已处理')).toBeVisible();
  expect(await page.locator('body').innerText()).not.toMatch(FORBIDDEN);
});
