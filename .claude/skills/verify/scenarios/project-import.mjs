// Drives project import through the real UI. No ERP actions are performed.
// BAOX_PROJECT_IMPORT_SAMPLE optionally selects a local workbook; the committed synthetic workbook is the default.
import { resolve } from 'node:path';

export const fake = null;

export default async function projectImport(v) {
  const { page, expect } = v;
  const sample = process.env['BAOX_PROJECT_IMPORT_SAMPLE'] ?? resolve('fixtures/generated/project-import.xlsx');
  await v.signIn();
  await page.goto('/#/projects');
  const personal = page.getByRole('region', { name: '批量导入个人项目', exact: true });
  let parsed;
  await v.step('upload Excel and inspect the personal project preview without writing', async () => {
    await expect(page.getByLabel('项目序号', { exact: true })).toBeVisible();
    await expect(page.getByLabel('项目号', { exact: true })).toBeVisible();
    const response = page.waitForResponse(response => response.url().endsWith('/api/project-book/import/preview') && response.status() === 200);
    await personal.getByLabel('选择 Excel 文件').setInputFiles(sample);
    parsed = await (await response).json();
    expect(parsed.kind).toBe('preview');
    expect(parsed.preview.rows.length).toBeGreaterThanOrEqual(2);
    expect(parsed.preview.rows.every(row => row.status === 'add')).toBe(true);
    await expect(personal.getByRole('table', { name: '项目导入预览' })).toBeVisible();
    expect((await v.api.get('/api/project-book')).projects).toHaveLength(0);
    await v.shot('personal-preview');
  });
  const first = parsed.preview.rows[0];
  await v.step('import selected personal rows and verify server values', async () => {
    // Leave the first row for the public book, so both scopes can be proved with the same source workbook.
    await personal.getByLabel(`选择第 ${first.row} 行`).press('Space');
    await expect(personal.getByLabel(`选择第 ${first.row} 行`)).not.toBeChecked();
    await personal.getByRole('button', { name: /^确认导入/ }).click();
    await expect(personal.getByText(/导入完成：新增/)).toBeVisible();
    const book = await v.api.get('/api/project-book');
    expect(book.projects.map(project => [project.number, project.name]).sort()).toEqual(parsed.preview.rows.slice(1).map(row => [row.number, row.name]).sort());
    v.note(`Personal book: ${JSON.stringify(book)}`);
    await v.shot('personal-imported');
  });
  await v.step('import the remaining project into the public book and show conflicts', async () => {
    await page.getByRole('tab', { name: '公共项目簿', exact: true }).click();
    const shared = page.getByRole('region', { name: '批量导入公共项目', exact: true });
    await shared.getByLabel('选择 Excel 文件').setInputFiles(sample);
    await expect(shared.getByRole('table', { name: '项目导入预览' })).toBeVisible();
    await expect(shared.getByText('个人项目已占用此序号，请使用转公共项目流程。', { exact: false }).first()).toBeVisible();
    await shared.getByRole('button', { name: /^确认导入/ }).click();
    await expect(shared.getByText(/导入完成：新增 1 个项目/)).toBeVisible();
    const book = await v.api.get('/api/public-project-book');
    expect(book.projects).toHaveLength(1);
    expect(book.projects[0]).toMatchObject({ number: first.number, name: first.name });
    v.note(`Public book: ${JSON.stringify(book)}`);
    await v.shot('public-imported');
  });
  await v.step('repeat the personal import and skip all existing or reserved serials', async () => {
    await page.getByRole('tab', { name: '个人项目簿', exact: true }).click();
    await personal.getByLabel('选择 Excel 文件').setInputFiles(sample);
    await expect(personal.getByRole('table', { name: '项目导入预览' })).toBeVisible();
    await expect(personal.getByRole('button', { name: /^确认导入/ })).toBeDisabled();
    expect((await v.api.get('/api/project-book')).projects).toHaveLength(parsed.preview.rows.length - 1);
    await v.shot('repeat-skipped');
  });
}
