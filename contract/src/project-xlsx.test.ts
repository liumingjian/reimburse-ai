import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { readProjectWorkbook } from './project-xlsx';

describe('project workbook', () => {
  it('finds reordered headers, preserves zeros and internal text, and marks formulas and incomplete rows', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('项目');
    sheet.addRow([]);
    sheet.addRow(['其他', ' 项目号 ', '项目序号', '项目名称']);
    sheet.addRow(['忽略', ' 客户  项目-0012 ', 12, '不能作为项目号']);
    sheet.getCell('C3').numFmt = '0000';
    sheet.addRow(['', '客户  项目-0012', '0012']);
    sheet.addRow(['', '公式', { formula: '1+2', result: 3 }]);
    sheet.addRow(['', '缺少序号']);
    sheet.addRow(['其他内容']);
    sheet.addRow(['', '版本一', '20']);
    sheet.addRow(['', '版本二', '20']);
    const result = await readProjectWorkbook(await workbook.xlsx.writeBuffer());
    expect(result.kind).toBe('rows');
    if (result.kind !== 'rows') throw new Error('expected rows');
    expect(result.rows).toMatchObject([
      { row: 3, number: '0012', name: '客户  项目-0012', status: 'add' },
      { row: 4, number: '0012', status: 'skip' },
      { row: 5, status: 'error', note: expect.stringContaining('公式') },
      { row: 6, status: 'error', note: expect.stringContaining('必填') },
      { row: 8, number: '20', status: 'error' },
      { row: 9, number: '20', status: 'error' },
    ]);
  });

  it('requires a sheet choice for multiple sheets and unique headers on the first nonempty row', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('说明').addRow(['说明']);
    workbook.addWorksheet('项目').addRows([['项目序号', '项目号'], ['0001', '客户-项目-0001']]);
    const bytes = await workbook.xlsx.writeBuffer();
    expect(await readProjectWorkbook(bytes)).toEqual({ kind: 'choose-sheet', sheets: ['说明', '项目'] });
    expect(await readProjectWorkbook(bytes, '项目')).toMatchObject({ kind: 'rows', rows: [{ number: '0001' }] });
    await expect(readProjectWorkbook(bytes, '说明')).rejects.toThrow('唯一');
    workbook.getWorksheet('项目')!.getRow(1).getCell(3).value = '项目序号';
    await expect(readProjectWorkbook(await workbook.xlsx.writeBuffer(), '项目')).rejects.toThrow('唯一');
  });
});
