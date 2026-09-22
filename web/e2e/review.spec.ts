import { expect, test, type Page } from '@playwright/test';

// 整单明细确认（Skill 的唯一一次整单确认，在项目归属之后）与「去打印 / 去报销」分岔。直接用 file:// 打开 mock 构建产物（pnpm build:mock）。
const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const open = (query: string, hash: string) => `${INDEX}${query}${hash}`;

const INVALIDATED = '材料已变更，之前的整单明细确认与已生成的打印稿作废。请重新核对后再确认。';
const PROJECT_CHANGED = '项目归属已变更，之前的整单明细确认失效。请重新核对后再确认。';

const table = (page: Page) => page.getByRole('table', { name: '整单明细' });
const checkbox = (page: Page) => page.getByRole('region', { name: '整单确认' }).getByRole('button', { name: '确认整单明细', exact: true });
const printLink = (page: Page) => page.getByRole('link', { name: '去打印', exact: true });
const claimButton = (page: Page) => page.getByRole('button', { name: '去报销', exact: true });

// 同一文档内只改 hash（不重新加载页面），mock 的内存状态得以保留。
async function jump(page: Page, hash: string) {
  await page.evaluate((next) => {
    window.location.hash = next;
  }, hash);
}

test('确认：?seed=review 是 No. 加内核 13 列，按费用分类排序；整页没有「参考材料」，文件名只在材料包清单一节；点「确认」后才出现并列的去打印与去报销', async ({ page }, testInfo) => {
  await page.goto(open('?seed=review', '#/task/T1/review'));
  await expect(page.getByRole('heading', { name: '整单明细确认' })).toBeVisible();
  await expect(table(page).locator('thead th')).toHaveText(['No.', '发票', '项目号', '起始日期', '结束日期', '住宿地/城市', '出发点', '目的地', '费用分类', '费用项目', '发票类型', '费用金额', '税额', '总额']);
  const rows = table(page).locator('tbody tr');
  await expect(rows).toHaveCount(9);
  await expect(rows.locator('td:nth-child(1)')).toHaveText(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  const remote = '外地市内交通';
  // 外地市内交通在长途交通之前，住宿排最后。
  await expect(rows.locator('td:nth-child(9)')).toHaveText([remote, remote, remote, remote, remote, remote, '长途交通', '长途交通', '住宿']);
  // 住宿：住宿地/城市为上海，2026-08-09 至 2026-08-22；交通行结束日期与起始日期相同。
  const hotel = page.getByTestId('confirm-row-9').locator('td');
  await expect(hotel.nth(3)).toHaveText('2026-08-09');
  await expect(hotel.nth(4)).toHaveText('2026-08-22');
  await expect(hotel.nth(5)).toHaveText('上海');
  await expect(hotel.nth(2)).toHaveText('P-2307 / 华东客户交付');
  for (const no of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const cells = page.getByTestId(`confirm-row-${no}`).locator('td');
    await expect(cells.nth(4)).toHaveText((await cells.nth(3).textContent()) ?? '');
  }
  await expect(page.getByTestId('confirm-row-5').locator('td').nth(6)).toHaveText('张江高科');
  // 13 列表格里没有文件名、参考材料文字与合计行。
  const text = await table(page).innerText();
  expect(text).not.toMatch(/\.pdf|\.jpg|\.png|参考材料|合计 ·/);
  // 整页（主区）没有「参考材料」；文件名只在「材料包」一节（#114 的材料包文件清单），别的区域一个都没有。
  const main = page.locator('main');
  expect(await main.innerText()).not.toContain('参考材料');
  // 材料包清单默认收起，点开再核对。
  await page.getByRole('region', { name: '材料包' }).getByText('材料包 13 份文件').click();
  const packageText = await page.getByRole('region', { name: '材料包' }).innerText();
  expect((await main.innerText()).replace(packageText, '')).not.toMatch(/\.pdf|\.jpg|\.png/);
  await expect(page.getByTestId('package-files')).toHaveText('核对材料已生成，共 13 份文件。');
  await expect(page.getByRole('list', { name: '材料包文件' }).getByRole('listitem')).toHaveCount(13);
  await expect(page.getByTestId('review-purpose')).toContainText('上海产品评审出差');
  // 支付截图入口在打印稿页，不在确认页。
  await expect(page.getByRole('button', { name: /补充支付截图/ })).toHaveCount(0);

  await expect(checkbox(page)).toBeEnabled();
  await expect(printLink(page)).toHaveCount(0);
  await expect(claimButton(page)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('review-unconfirmed.png'), fullPage: true });

  await checkbox(page).click();
  await expect(printLink(page)).toBeVisible();
  await expect(claimButton(page)).toBeVisible();
  await expect(page.getByText(/^整单明细已确认（/)).toBeVisible();
  // 两个入口同级样式、并排。
  await expect(printLink(page)).toHaveClass(/cds--btn--primary/);
  await expect(claimButton(page)).toHaveClass(/cds--btn--primary/);
  const [a, b] = await Promise.all([printLink(page).boundingBox(), claimButton(page).boundingBox()]);
  expect(a && b && Math.abs(a.y - b.y) < 2 && a.x < b.x).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('review-confirmed.png'), fullPage: true });
});

test('吸底栏与首屏：主按钮是「确认整单明细」、往回走的是 ghost；1440 下确认后去打印与去报销在首屏内、排在明细表之前', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(open('?seed=review', '#/task/T1/review'));
  await expect(page.getByRole('heading', { name: '整单明细确认' })).toBeVisible();
  const bar = page.getByRole('region', { name: '整单确认' });
  await expect(checkbox(page)).toHaveClass(/cds--btn--primary/);
  await expect(bar.getByRole('link', { name: '回到待确认项' })).toHaveClass(/cds--btn--ghost/);
  await expect(bar.getByRole('link', { name: '修改项目归属' })).toHaveClass(/cds--btn--ghost/);
  await expect(page.getByText('唯一一次整单确认，项目归属一并生效。')).toHaveCount(1);
  await expect(bar).not.toContainText('项目归属一并生效');
  await page.screenshot({ path: testInfo.outputPath('review-1440-before-confirm.png') });

  await checkbox(page).click();
  await expect(printLink(page)).toBeVisible();
  const [print, claim, tableBox] = await Promise.all([printLink(page).boundingBox(), claimButton(page).boundingBox(), table(page).boundingBox()]);
  // 不滚动就能看到两个入口：整个按钮都在 900 高的首屏内，且在明细表上方。
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  for (const box of [print, claim]) {
    expect(box && box.y >= 0 && box.y + box.height <= 900).toBe(true);
    expect(box && tableBox && box.y + box.height < tableBox.y).toBe(true);
  }
  const before = await page.evaluate(() => {
    const table = document.querySelector('table[aria-label="整单明细"]');
    const links = [...document.querySelectorAll('a, button')].filter((node) => node.textContent?.trim() === '去打印' || node.textContent?.trim() === '去报销');
    return links.length === 2 && links.every((node) => table !== null && (node.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
  });
  expect(before).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('review-1440-after-confirm.png') });
});

test('版式：No. 固定在左、总额固定在右，中间横向滚动；同分类重复值变淡但仍在；操作栏吸底；材料包默认收起', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.goto(open('?seed=review', '#/task/T1/review'));
  await expect(page.getByRole('heading', { name: '整单明细确认' })).toBeVisible();

  const packages = page.getByRole('region', { name: '材料包' });
  await expect(packages.getByRole('list', { name: '材料包文件' })).toBeHidden();
  await packages.getByText('材料包 13 份文件').click();
  await expect(packages.getByRole('list', { name: '材料包文件' }).getByRole('listitem')).toHaveCount(13);

  // 吸底操作栏：页面比视口高时贴在视口底边。
  const bar = page.getByRole('region', { name: '整单确认' });
  await expect(bar).toContainText('确认后即可去打印、去报销');
  const barBox = await bar.boundingBox();
  expect(barBox && Math.abs(barBox.y + barBox.height - 700) < 2).toBe(true);

  // 横向滚到最右：No. 仍贴左边，总额贴右边。
  const wrap = table(page).locator('xpath=..');
  const scrolled = await wrap.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    return element.scrollLeft;
  });
  expect(scrolled).toBeGreaterThan(0);
  const [scrollWidth1100, clientWidth1100] = await wrap.evaluate((element) => [element.scrollWidth, element.clientWidth]);
  console.log(`review table 1100: scrollWidth ${scrollWidth1100}, clientWidth ${clientWidth1100}`);
  const cells = page.getByTestId('confirm-row-2').locator('td');
  const [wrapBox, noBox, grossBox] = await Promise.all([wrap.boundingBox(), cells.first().boundingBox(), cells.last().boundingBox()]);
  expect(wrapBox && noBox && Math.abs(noBox.x - wrapBox.x) < 3).toBe(true);
  expect(wrapBox && grossBox && Math.abs(grossBox.x + grossBox.width - (wrapBox.x + wrapBox.width)) < 3).toBe(true);
  // 表头照常可读：No. 与总额两个表头也贴在两边。
  const heads = table(page).locator('thead th');
  const [noHead, grossHead] = await Promise.all([heads.first().boundingBox(), heads.last().boundingBox()]);
  expect(wrapBox && noHead && Math.abs(noHead.x - wrapBox.x) < 3).toBe(true);
  expect(wrapBox && grossHead && Math.abs(grossHead.x + grossHead.width - (wrapBox.x + wrapBox.width)) < 3).toBe(true);
  await expect(heads.last()).toHaveText('总额');
  // 与上一行相同的项目号照常显示。
  await expect(cells.nth(2)).toHaveText('P-3312 / 产品调研');
});

test('宽度：1440 窗口整单明细表铺满工作面、不横向滚动；项目号与费用项目不折行', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(open('?seed=review', '#/task/T1/review'));
  await expect(page.getByRole('heading', { name: '整单明细确认' })).toBeVisible();
  const wrap = table(page).locator('xpath=..');
  const [scrollWidth, clientWidth] = await wrap.evaluate((element) => [element.scrollWidth, element.clientWidth]);
  console.log(`review table 1440: scrollWidth ${scrollWidth}, clientWidth ${clientWidth}`);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  // 项目号、费用项目两列的每个单元格都只占一行。编码是小一号的等宽字，与名称同一行时两段文字的 top 不同，
  // 所以按行归并：一段文字的 top 落在上一行底边之下才算新的一行。
  const lines = await table(page).evaluate((element) => {
    const heads = [...element.querySelectorAll('thead th')].map((th) => th.textContent?.trim() ?? '');
    const result: Record<string, number> = {};
    for (const label of ['项目号', '费用项目']) {
      const index = heads.indexOf(label);
      let max = 0;
      for (const row of element.querySelectorAll('tbody tr')) {
        const cell = row.children[index];
        if (!(cell instanceof HTMLElement)) continue;
        const range = document.createRange();
        range.selectNodeContents(cell);
        const rects = [...range.getClientRects()].filter((rect) => rect.width > 0).sort((a, b) => a.top - b.top);
        let count = 0;
        let lineBottom = Number.NEGATIVE_INFINITY;
        for (const rect of rects) {
          if (rect.top >= lineBottom - 1) {
            count += 1;
            lineBottom = rect.bottom;
          } else {
            lineBottom = Math.max(lineBottom, rect.bottom);
          }
        }
        max = Math.max(max, count);
      }
      result[label] = max;
    }
    return result;
  });
  console.log(`review table 1440 line counts: ${JSON.stringify(lines)}`);
  expect(lines).toEqual({ 项目号: 1, 费用项目: 1 });
  // 表格铺满通栏容器，容器贴着工作面左右边线。
  const [wrapBox, mainBox, tableBox] = await Promise.all([wrap.boundingBox(), page.locator('main').boundingBox(), table(page).boundingBox()]);
  expect(wrapBox && mainBox && wrapBox.width > mainBox.width - 4).toBe(true);
  expect(wrapBox && tableBox && Math.abs(tableBox.width - wrapBox.width) < 2).toBe(true);
});

test('分岔入口：?seed=actions 下去打印进入打印稿预览，去报销直接开始填报（没有「开始填报」）', async ({ page }) => {
  await page.goto(open('?seed=actions', '#/task/T1/review'));
  await expect(printLink(page)).toBeVisible();
  await expect(checkbox(page)).toHaveCount(0);
  await printLink(page).click();
  await expect(page).toHaveURL(/#\/task\/T1\/print$/);
  await expect(page.getByRole('heading', { name: '打印稿预览' })).toBeVisible();
  await jump(page, '#/task/T1/review');
  await claimButton(page).click();
  await expect(page).toHaveURL(/#\/task\/T1\/erp$/);
  await expect(page.getByRole('heading', { name: '填写报销单' })).toBeVisible();
  await expect(page.getByRole('button', { name: '开始填报' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '填报进度' }).getByRole('listitem', { name: '登录', exact: true })).toContainText('等待你登录');
  // 步骤条里「去打印 / 去报销」已经可进入。
  const actionsStep = page.getByRole('list', { name: '流程阶段' }).getByRole('button', { name: /^去打印 \/ 去报销/ });
  await expect(actionsStep).toBeVisible();
  await expect(actionsStep).not.toHaveAttribute('aria-disabled', 'true');
});

test('确认后改派项目：确认失效并提示重新确认，重新确认后两个入口回来', async ({ page }, testInfo) => {
  await page.goto(open('?seed=actions', '#/task/T1/review'));
  await page.getByRole('link', { name: '修改项目归属' }).click();
  await expect(page).toHaveURL(/#\/task\/T1\/project$/);
  await page.getByRole('checkbox', { name: '选择明细 No.9' }).locator('xpath=following-sibling::label[1]').click();
  await page.getByRole('complementary', { name: '归入项目' }).getByRole('button', { name: /P-1180/ }).click();
  await page.getByRole('dialog', { name: '1 条明细已有其他项目归属，请确认是否覆盖' }).getByRole('button', { name: '确认覆盖' }).click();
  await page.getByRole('button', { name: '确认项目归属' }).click();

  await expect(page).toHaveURL(/#\/task\/T1\/review$/);
  await expect(page.getByText(PROJECT_CHANGED)).toBeVisible();
  await expect(checkbox(page)).toBeVisible();
  await expect(printLink(page)).toHaveCount(0);
  await expect(claimButton(page)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('review-project-changed.png'), fullPage: true });

  await checkbox(page).click();
  await expect(printLink(page)).toBeVisible();
  await expect(page.getByText(PROJECT_CHANGED)).toHaveCount(0);
});

test('失效流程：追加材料先二次确认，取消不变；继续则确认失效、回到上传页并能接收新批次', async ({ page }, testInfo) => {
  await page.goto(open('?seed=actions', '#/task/T1/review'));
  await expect(printLink(page)).toBeVisible();
  await page.getByRole('button', { name: '追加材料' }).click();
  const dialog = page.getByRole('dialog', { name: '追加材料会形成新的盘点版本' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('将使整单明细确认失效');
  await page.screenshot({ path: testInfo.outputPath('review-reopen-dialog.png'), fullPage: true });

  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/#\/task\/T1\/review$/);
  await expect(printLink(page)).toBeVisible();

  await page.getByRole('button', { name: '追加材料' }).click();
  await dialog.getByRole('button', { name: '继续追加' }).click();
  await expect(page).toHaveURL(/#\/task\/T1\/upload$/);
  await expect(page.getByRole('heading', { name: '上传材料' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText(INVALIDATED);
  await expect(page.getByTestId('dropzone')).toBeVisible();

  await page.getByLabel('拖入文件，或点击选择', { exact: true }).setInputFiles({ name: '地铁_发票.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 metro') });
  await expect(page.getByRole('heading', { name: '上传批次 #2' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('review-invalidated-upload.png'), fullPage: true });

  // 旧确认失效：重新盘点前，整单明细确认页与打印页都不能进。
  await jump(page, '#/task/T1/review');
  await expect(page.getByRole('heading', { name: '还不能进入这一步' })).toBeVisible();
  await jump(page, '#/task/T1/print');
  await expect(page.getByRole('heading', { name: '还不能进入这一步' })).toBeVisible();
});
