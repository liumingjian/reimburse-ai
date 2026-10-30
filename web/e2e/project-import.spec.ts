import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const INDEX = new URL('../dist-mock/index.html', import.meta.url).href;
const WORKBOOK = fileURLToPath(new URL('../../fixtures/generated/project-import.xlsx', import.meta.url));
const ERRORS = fileURLToPath(new URL('../../fixtures/generated/project-import-errors.xlsx', import.meta.url));

test('mock browser imports an Excel file after preview and skips repeated serials', async ({ page }) => {
  await page.goto(`${INDEX}?book=empty#/projects`);
  const importer = page.getByRole('region', { name: '批量导入个人项目', exact: true });
  await importer.getByLabel('选择 Excel 文件').setInputFiles(WORKBOOK);
  await expect(importer.getByRole('table', { name: '项目导入预览' })).toBeVisible();
  await expect(page.getByRole('table', { name: '个人项目簿', exact: true }).getByRole('row')).toHaveCount(2);
  await expect(importer.getByText('客户甲-服务项目-26-0001', { exact: true })).toBeVisible();
  await importer.getByRole('button', { name: /^确认导入/ }).click();
  await expect(importer.getByText('导入完成：新增 2 个项目，更新 0 个项目。')).toBeVisible();
  await expect(page.getByTestId('book-row-0001')).toContainText('客户甲-服务项目-26-0001');
  await expect(page.getByTestId('book-row-0002')).toContainText('客户乙-维护项目-26-0002');
  await importer.getByLabel('选择 Excel 文件').setInputFiles(WORKBOOK);
  await expect(importer.getByRole('button', { name: /^确认导入/ })).toBeDisabled();
  await expect(importer.getByText('新增 0 行，更新 0 行，跳过 2 行，错误 0 行。已选择 0 行。')).toBeVisible();
});

test('multiple sheets, invalid headers and error rows retain a usable preview and require explicit updates', async ({ page }) => {
  await page.goto(`${INDEX}?book=empty#/projects`);
  const importer = page.getByRole('region', { name: '批量导入个人项目', exact: true });
  await importer.getByLabel('选择 Excel 文件').setInputFiles(WORKBOOK);
  await importer.getByRole('button', { name: /^确认导入/ }).click();
  await expect(page.getByTestId('book-row-0001')).toBeVisible();
  await importer.getByLabel('选择 Excel 文件').setInputFiles(ERRORS);
  await expect(importer.getByRole('table', { name: '项目导入预览' })).toHaveCount(0);
  await importer.getByLabel('工作表').selectOption('说明');
  await expect(importer.getByText('首个非空行必须包含唯一的“项目序号”和“项目号”列。')).toBeVisible();
  await importer.getByLabel('工作表').selectOption('项目');
  await expect(importer.getByText('新增 1 行，更新 1 行，跳过 0 行，错误 4 行。已选择 1 行。')).toBeVisible();
  await expect(importer.getByText('客户甲-服务项目-26-0001', { exact: true })).toBeVisible();
  await expect(importer.getByLabel('选择第 2 行')).not.toBeChecked();
  await importer.getByLabel('选择第 2 行').press('Space');
  await importer.getByRole('button', { name: /^仅导入正常行/ }).click();
  await expect(importer.getByText('导入完成：新增 1 个项目，更新 1 个项目。')).toBeVisible();
  await expect(page.getByTestId('book-row-0001')).toContainText('更新后的项目号');
  await expect(page.getByTestId('book-row-0002')).toContainText('客户乙-维护项目-26-0002');
  await expect(page.getByTestId('book-row-0003')).toContainText('新增项目号');
  await expect(page.getByTestId('book-row-0004')).toHaveCount(0);
});
