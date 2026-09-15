import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR, SAMPLE_MATERIALS } from '@baox/fixtures';
import { TaskSnapshotSchema } from '@baox/contract';
import type { Page } from '@playwright/test';
import { expect, signIn, test } from './fixture';

// Slice 05 (#184) on the real server: a ride-hailing 全电发票 plus its multi-leg 高德 itinerary gives one candidate
// line per leg; when the legs do not conserve to the invoice total, an allocation 待确认项 asks the user instead.

type Upload = { name: string; mimeType: string; buffer: Buffer };

function sample(prefix: string): Upload {
  const found = SAMPLE_MATERIALS.find((candidate) => candidate.file.startsWith(prefix));
  if (!found) throw new Error(`fixture ${prefix} is missing from @baox/fixtures`);
  return { name: found.fileName, mimeType: 'application/pdf', buffer: readFileSync(join(GENERATED_DIR, found.file)) };
}

// The fixture generator's HTML templates (plain .mjs, no types): loaded through a URL so the typecheck skips them.
type TemplateDoc = { id: string; width: number; height: number; css: string; body: string };
type Templates = { DOCS: Record<string, TemplateDoc>; documentOf: (doc: TemplateDoc) => string };
const TEMPLATES_URL = new URL('../../../fixtures/scripts/templates.mjs', import.meta.url).href;

// The m04 itinerary with leg 3 printed as 21.66: the legs add up to 69.20 while the invoice says 69.19.
async function skewedItinerary(page: Page): Promise<Upload> {
  const { DOCS, documentOf } = (await import(TEMPLATES_URL)) as Templates;
  const m04 = DOCS['m04'];
  if (!m04) throw new Error('template m04 is missing');
  const printer = await page.context().newPage();
  await printer.setContent(documentOf({ ...m04, body: m04.body.replace('21.65', '21.66') }));
  const buffer = await printer.pdf({ preferCSSPageSize: true, printBackground: true });
  await printer.close();
  return { name: '高德打车_行程单_改.pdf', mimeType: 'application/pdf', buffer };
}

async function inventory(page: Page, files: Upload[]): Promise<string> {
  await signIn(page);
  await page.goto('/#/tasks');
  await page.getByRole('button', { name: '新建报销任务' }).click();
  const dialog = page.getByRole('dialog', { name: '新建报销任务' });
  await dialog.getByLabel('常驻城市').fill('杭州');
  await dialog.getByRole('button', { name: '创建并上传材料' }).click();
  await expect(page).toHaveURL(/#\/task\/[^/]+\/upload$/);
  const taskId = /#\/task\/([^/]+)\//.exec(page.url())?.[1] ?? '';
  await page.locator('input[type=file]').setInputFiles(files);
  const batch = page.locator('section', { has: page.getByRole('heading', { name: /^上传批次 #1$/ }) });
  for (const file of files) await expect(batch.getByText(file.name, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '开始材料盘点' }).click();
  await expect(page).toHaveURL(/#\/task\/[^/]+\/inventory$/);
  await expect(page.getByRole('group', { name: '盘点摘要' })).toContainText(`材料${files.length} 份`);
  return taskId;
}

const snapshotOf = async (page: Page, taskId: string) => TaskSnapshotSchema.parse(await (await page.request.get(`/api/tasks/${taskId}`)).json());

test('打车发票 + 三段高德行程单：逐段金额与发票分毫不差，每段一条候选明细', async ({ page }) => {
  const taskId = await inventory(page, [sample('m03'), sample('m04')]);

  const summary = page.getByRole('group', { name: '盘点摘要' });
  await expect(summary).toContainText('通过2 份');
  // One voucher group of three events (No.1-3); its detail lists each leg.
  const group = page.getByRole('button', { name: '费用事件 No.1-3', exact: true });
  // The group row's amount cell lists the legs it sums.
  await expect(group.locator('xpath=ancestor::tr[1]')).toContainText('26.69 + 20.85 + 21.65');
  await group.click();
  const legs = page.getByRole('list', { name: '费用事件 No.1-3 的明细' });
  await expect(legs.getByRole('listitem')).toHaveText([/No\.1\s*高德 · 虹桥枢纽 → 漕河泾\s*26\.69/, /No\.2\s*高德 · 漕河泾 → 静安寺\s*20\.85/, /No\.3\s*高德 · 静安寺 → 张江\s*21\.65/]);
  await expect(page.getByText('打车发票与行程单配对：26.69 + 20.85 + 21.65 = 69.19，按分守恒')).toBeVisible();

  const snapshot = await snapshotOf(page, taskId);
  expect(snapshot.lines.map((line) => [line.invoiceLabel, line.grossAmount, line.netAmount, line.taxAmount])).toEqual([
    ['发票1', '26.69', '25.92', '0.77'],
    ['发票1', '20.85', '20.24', '0.61'],
    ['发票1', '21.65', '21.02', '0.63'],
  ]);
  expect(snapshot.pendingItems).toEqual([]);
});

test('逐段金额加起来和发票对不上：不形成明细，出现一个逐段分摊待确认项', async ({ page }) => {
  const taskId = await inventory(page, [sample('m03'), await skewedItinerary(page)]);

  await page.getByRole('link', { name: '处理 1 个待确认项' }).or(page.getByRole('button', { name: '处理 1 个待确认项' })).click();
  await expect(page).toHaveURL(/#\/task\/[^/]+\/pending$/);
  const form = page.getByRole('form', { name: /要逐段给出金额/ });
  await expect(form).toBeVisible();
  await expect(form).toContainText('票面价税合计 69.19 元');

  const snapshot = await snapshotOf(page, taskId);
  expect(snapshot.lines).toEqual([]);
  expect(snapshot.pendingItems).toEqual([
    expect.objectContaining({
      kind: 'allocation',
      status: 'open',
      allocation: expect.objectContaining({ total: '69.19', segments: [expect.objectContaining({ suggested: '26.69' }), expect.objectContaining({ suggested: '20.85' }), expect.objectContaining({ suggested: '21.66' })] }),
    }),
  ]);
});
