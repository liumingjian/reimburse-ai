import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const { PDFDocument } = createRequire(new URL('../../../../server/package.json', import.meta.url))('@cantoo/pdf-lib');

// Real PDF acceptance through the page. The external JSON holds private paths and independently transcribed line
// expectations: { files: [...], homeCity, lines: [{ date, city, grossAmount, ... }], printPages }. Nothing calls ERP.
export const fake = null;

export default async function rideItineraries(v) {
  const { page, expect } = v;
  const casePath = process.env['BAOX_VERIFY_RIDE_CASE'];
  if (!casePath) throw new Error('Set BAOX_VERIFY_RIDE_CASE to a private acceptance-case JSON file');
  const expected = JSON.parse(readFileSync(casePath, 'utf8'));
  await v.signIn();
  await v.step('create a reimbursement task and upload the original PDFs', async () => {
    await page.goto('/#/tasks');
    await page.getByRole('button', { name: '新建报销任务' }).click();
    const dialog = page.getByRole('dialog', { name: '新建报销任务' });
    await dialog.getByLabel('常驻城市').fill(expected.homeCity);
    await dialog.getByRole('button', { name: '创建并上传材料' }).click();
    await expect(page).toHaveURL(/#\/task\/[^/]+\/upload$/);
    await page.getByLabel('拖入文件，或点击选择', { exact: true }).setInputFiles(expected.files);
    await expect(page.getByRole('button', { name: '开始材料盘点' })).toBeEnabled();
    await v.shot('uploaded');
  });
  const taskId = /#\/task\/([^/]+)\//.exec(page.url())[1];
  await v.record('uploaded', taskId);
  await v.step('inventory the originals and verify every trip', async () => {
    await page.getByRole('button', { name: '开始材料盘点' }).click();
    await expect.poll(async () => (await v.api.snapshot(taskId)).inventory.status, { timeout: 90_000 }).toBe('done');
    const snapshot = await v.record('inventory', taskId);
    expect(snapshot.pendingItems.filter((item) => item.status === 'open')).toEqual([]);
    expect(snapshot.lines).toHaveLength(expected.lines.length);
    for (const line of expected.lines) {
      expect(snapshot.lines).toContainEqual(expect.objectContaining({ ...line, ...(line.category ? { category: expect.objectContaining(line.category) } : {}) }));
    }
    expect(snapshot.inventory.summary).toMatchObject({ materialCount: expected.files.length, okCount: expected.files.length });
    await v.shot('inventory');
  });
  await v.step('add a project, assign every trip and confirm the whole claim', async () => {
    await page.goto(`/#/task/${taskId}/project`);
    await page.getByLabel('项目序号', { exact: true }).fill('VERIFY-RIDES');
    await page.getByLabel('项目号', { exact: true }).fill('行程解析验收项目');
    await page.getByRole('button', { name: '加入项目', exact: true }).click();
    await expect(page.getByTestId('book-message')).toContainText('已加入个人项目簿');
    await page.getByRole('button', { name: '项目录完了，开始归属' }).click();
    await page.getByRole('checkbox', { name: '全选当前明细' }).locator('xpath=following-sibling::label[1]').click();
    await page.getByRole('complementary', { name: '归入项目' }).getByRole('button', { name: /VERIFY-RIDES/ }).click();
    await page.getByLabel('报销事由', { exact: true }).fill('行程解析验收');
    await page.getByRole('button', { name: '确认项目归属', exact: true }).click();
    await expect(page).toHaveURL(/\/review$/);
    await v.shot('whole-list-review');
    await v.record('review', taskId);
    await page.getByRole('button', { name: '确认整单明细', exact: true }).click();
    await expect(page.getByRole('link', { name: '去打印', exact: true })).toBeVisible();
    const snapshot = await v.record('confirmed', taskId);
    expect(snapshot).toMatchObject({ stage: 'actions', confirmation: { status: 'confirmed' } });
    for (const line of snapshot.lines) {
      expect(line.projectCode).toBe('VERIFY-RIDES');
      expect(line.expenseItemCode).toBe(line.category.code === 'local_city_transport' ? 'FY008001' : 'FY010002');
    }
    await v.shot('confirmed');
  });
  await v.step('preview and download the print sheet', async () => {
    await page.getByRole('link', { name: '去打印', exact: true }).click();
    const pages = page.getByRole('list', { name: '打印稿页面' });
    await expect(pages.getByRole('listitem')).toHaveCount(expected.printPages);
    const downloading = page.waitForEvent('download');
    await page.getByRole('link', { name: '下载打印稿 PDF' }).click();
    const download = await downloading;
    const path = await download.path();
    const bytes = readFileSync(path);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    copyFileSync(path, join(v.out, 'print-sheet.pdf'));
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(expected.printPages);
    await v.shot('print');
    const snapshot = await v.record('print', taskId);
    expect(snapshot.confirmation.status).toBe('confirmed');
    for (const printed of snapshot.printSheet.pages.filter((sheet) => sheet.kind === 'voucher')) {
      const voucherLines = snapshot.lines.filter((line) => line.voucherMaterialId === printed.top.materialId);
      const printedNumbers = printed.nos.replace(/^No\./, '').split(',').flatMap((part) => {
        const [from, to = from] = part.split('-').map(Number);
        return Array.from({ length: to - from + 1 }, (_, index) => from + index);
      });
      expect(printedNumbers).toEqual(voucherLines.map((line) => line.no));
      expect(printed.categoryLabel.split(' / ')).toEqual([...new Set(voucherLines.map((line) => line.category.label))]);
    }
    v.note(`Verified ${expected.files.length} originals, ${expected.lines.length} trips and ${expected.printPages} print pages; no ERP action started`);
  });
}
