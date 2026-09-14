import { expect, test, type Page } from '@playwright/test';

// 材料盘点（#102）。直接用 file:// 打开 mock 构建产物（pnpm build:mock）。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

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
  '餐饮_发票.pdf',
];

async function uploadFixtureNames(page: Page) {
  await page.locator('input[type=file]').setInputFiles(
    FIXTURE_FILES.map((name) => ({ name, mimeType: name.endsWith('.jpg') ? 'image/jpeg' : 'application/pdf', buffer: Buffer.from(`fixture ${name}`) })),
  );
}

async function jump(page: Page, hash: string) {
  await page.evaluate((next) => {
    window.location.hash = next;
  }, hash);
}

test('?seed=inventory：材料清单按费用事件归组，显示配对与守恒结论，不显示字段来源', async ({ page }, testInfo) => {
  await page.goto(open('?seed=inventory', '#/task/T1/inventory'));
  await expect(page.getByRole('heading', { name: '材料盘点' })).toBeVisible();
  await expect(page.getByRole('link', { name: '处理 3 个待确认项' })).toBeVisible();
  const summary = page.getByRole('group', { name: '盘点摘要' });
  await expect(summary).toContainText('材料11 份');
  await expect(summary).toContainText('通过8 份');
  await expect(summary).toContainText('需处理3 份');
  await expect(summary).toContainText('盘点版本v1');
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByLabel('盘点结果').getByText('通过', { exact: true })).toHaveCount(0);

  // 含待确认材料的事件默认展开，组行状态列就是「待确认」；全部通过的事件收成一行，点开才看文件与材料证据关联。
  const toggle = (name: string) => page.getByRole('button', { name, exact: true });
  const detail = (name: string) => page.getByRole('row', { name, exact: true });
  await expect(toggle('费用事件 No.5')).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle('费用事件 No.5').locator('xpath=ancestor::tr[1]')).toContainText('待确认');
  await expect(detail('费用事件 No.5').getByText('IMG_4871.jpg')).toBeVisible();
  await expect(toggle('费用事件 No.1-3')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('高德打车_行程单.pdf')).toHaveCount(0);
  const amapCells = toggle('费用事件 No.1-3').locator('xpath=ancestor::tr[1]').getByRole('cell');
  await expect(amapCells).toHaveText(['', 'No.1-3 外地市内交通', '08-10 至 08-12', '26.69 + 20.85 + 21.65', '2 份', '']);
  await toggle('费用事件 No.1-3').click();
  await expect(toggle('费用事件 No.1-3')).toHaveAttribute('aria-expanded', 'true');
  const amap = detail('费用事件 No.1-3');
  await expect(amap.getByText('材料证据关联', { exact: true })).toHaveCount(1);
  await expect(amap.getByText('打车发票与行程单配对：26.69 + 20.85 + 21.65 = 69.19，按分守恒')).toBeVisible();
  await expect(amap.getByText('26.69 + 20.85 + 21.65 = 69.19，按分守恒', { exact: true })).toHaveCount(0);
  await expect(amap.getByText('高德打车_行程单.pdf')).toBeVisible();
  const groupTable = page.getByRole('table', { name: '费用事件', exact: true });
  await expect(groupTable.locator(':scope > thead th')).toHaveText(['', '费用事件', '日期', '金额', '份数', '状态']);

  await toggle('费用事件 No.9').click();
  const hotel = detail('费用事件 No.9');
  await expect(hotel.getByText('住宿发票 3640.00 = 结账单消费合计 3640.00；13 天 = 08-09 入住至 08-22 离店')).toBeVisible();
  await expect(hotel.getByRole('list')).toHaveCount(0);
  await expect(page.getByLabel('盘点结果')).not.toContainText('rule:');

  // 未归入费用事件的材料单独一节，在表格下方。
  const rest = page.getByRole('region', { name: '未归入费用事件' });
  await expect(rest.getByText('未识别版式')).toBeVisible();
  const tableBox = await groupTable.boundingBox();
  const restBox = await rest.boundingBox();
  expect(restBox!.y).toBeGreaterThan(tableBox!.y + tableBox!.height - 1);
  await page.screenshot({ path: testInfo.outputPath('inventory-results.png'), fullPage: true });
});

test('全部展开与全部收起', async ({ page }) => {
  await page.goto(open('?seed=inventory', '#/task/T1/inventory'));
  const toggles = page.getByRole('button', { name: /^费用事件 No\./ });
  await expect(toggles).toHaveCount(7);
  await page.getByRole('button', { name: '全部展开', exact: true }).click();
  for (const toggle of await toggles.all()) await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('table', { name: /的材料$/ })).toHaveCount(8);
  await page.getByRole('button', { name: '全部收起', exact: true }).click();
  for (const toggle of await toggles.all()) await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('table', { name: /的材料$/ })).toHaveCount(1);
});

// 需要注意的行只靠标签标出，没有整行黄底和自写的黄色左边条；1100 窗口不横向滚动。
for (const width of [1440, 1100]) {
  test(`${width}：不横向滚动，没有整行黄底，待确认标签带图标，页头与摘要条没有中点串`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(open('?seed=inventory', '#/task/T1/inventory'));
    await expect(page.getByRole('button', { name: '费用事件 No.5', exact: true })).toHaveAttribute('aria-expanded', 'true');

    for (const expand of ['全部展开', '全部收起']) {
      await page.getByRole('button', { name: expand, exact: true }).click();
      const overflow = await page.evaluate(() => {
        const root = document.scrollingElement!;
        const tables = [...document.querySelectorAll('table')].filter((table) => table.parentElement!.scrollWidth > table.parentElement!.clientWidth + 1);
        return { page: root.scrollWidth > root.clientWidth + 1, tables: tables.length };
      });
      expect(overflow, `${width} ${expand}`).toEqual({ page: false, tables: 0 });
    }
    await page.getByRole('button', { name: '全部展开', exact: true }).click();

    // 状态列的「待确认」标签带警示图标：组行 No.5、No.6，展开后的两份材料，加未归入的一份。
    const pendingStatus = page.locator('main td:last-child').filter({ hasText: /^待确认$/ });
    await expect(pendingStatus).toHaveCount(5);
    for (const cell of await pendingStatus.all()) await expect(cell.locator('svg')).toBeVisible();

    const cells = await page.getByLabel('盘点结果').locator('td').evaluateAll((tds) =>
      tds.map((td) => {
        const style = getComputedStyle(td);
        return { background: style.backgroundColor, shadow: style.boxShadow };
      }),
    );
    const warningBackground = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.background = 'var(--cds-notification-background-warning)';
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    });
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.background).not.toBe(warningBackground);
      expect(cell.shadow).not.toMatch(/inset/);
    }

    const head = page.locator('.app-page-head');
    await expect(head).not.toContainText('·');
    await expect(page.getByRole('group', { name: '盘点摘要' })).not.toContainText('·');
    await page.screenshot({ path: testInfo.outputPath(`inventory-${width}.png`), fullPage: true });
  });
}

test('上传后开始材料盘点：先看到分阶段进度，再看到结果', async ({ page }, testInfo) => {
  await page.goto(open('', '#/task/T1/upload'));
  await uploadFixtureNames(page);
  await expect(page.getByRole('heading', { name: '上传批次 #1' })).toBeVisible();
  await page.getByRole('button', { name: '开始材料盘点' }).click();
  await expect(page).toHaveURL(/#\/task\/T1\/inventory$/);
  await expect(page.getByRole('status')).toHaveText(/^正在盘点：/);
  await expect(page.getByLabel('盘点进度')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('inventory-progress.png'), fullPage: true });
  await expect(page.getByRole('link', { name: '处理 3 个待确认项' })).toBeVisible({ timeout: 15000 });
  await expect(page.getByLabel('盘点进度')).toBeHidden();
  await page.getByRole('button', { name: '费用事件 No.1-3', exact: true }).click();
  await expect(page.getByText('打车发票与行程单配对：26.69 + 20.85 + 21.65 = 69.19，按分守恒')).toBeVisible();
  await page.getByRole('link', { name: '处理 3 个待确认项' }).click();
  await expect(page.getByRole('heading', { name: '待确认项' })).toBeVisible();
  await expect(page.getByText('还剩 3 个')).toBeVisible();
});

test('?fault=unsupported-material：曹操行程单成为不支持的版式，待确认项 4 个', async ({ page }) => {
  await page.goto(open('?seed=inventory&fault=unsupported-material', '#/task/T1/inventory'));
  await expect(page.getByRole('link', { name: '处理 4 个待确认项' })).toBeVisible();
  const rest = page.getByRole('region', { name: '未归入费用事件' });
  await expect(rest.getByText('曹操出行_行程单.pdf')).toBeVisible();
  await expect(rest.getByText('未识别版式')).toHaveCount(2);
});

test('页面守卫：?seed=inventory 下直接打开后续页面显示阶段不可跳过', async ({ page }) => {
  await page.goto(open('?seed=inventory', '#/task/T1/print'));
  await expect(page.getByRole('heading', { name: '还不能进入这一步' })).toBeVisible();
  await expect(page.getByText('阶段不可跳过，请按顺序完成前面的步骤。')).toBeVisible();
  await jump(page, '#/task/T1/review');
  await expect(page.getByText('阶段不可跳过，请按顺序完成前面的步骤。')).toBeVisible();
  await page.getByRole('link', { name: '回到当前阶段' }).click();
  await expect(page).toHaveURL(/#\/task\/T1\/inventory$/);
  await expect(page.getByRole('heading', { name: '材料盘点' })).toBeVisible();
});
