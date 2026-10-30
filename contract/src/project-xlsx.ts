import ExcelJS from 'exceljs';
import { prepareProjectImportRows, type ProjectImportSourceRow } from './project-import';

function text(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return String(value);
    const format = cell.numFmt.split(';')[0] ?? '';
    return /^0+$/.test(format) ? String(value).padStart(format.length, '0') : String(value);
  }
  return cell.text.trim();
}

function invalidCell(cell: ExcelJS.Cell): boolean {
  return cell.type === ExcelJS.ValueType.Formula || cell.type === ExcelJS.ValueType.Error || cell.type === ExcelJS.ValueType.Date
    || (typeof cell.value === 'number' && !Number.isSafeInteger(cell.value));
}

export async function readProjectWorkbook(data: ArrayBuffer, sheetName?: string) {
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(data); } catch { throw new Error('无法读取 Excel，请选择有效的 .xlsx 文件。'); }
  const sheets = workbook.worksheets.map(sheet => sheet.name);
  if (sheets.length === 0) throw new Error('文件中没有工作表。');
  const selected = sheetName ?? (sheets.length === 1 ? sheets[0] : undefined);
  if (!selected) return { kind: 'choose-sheet' as const, sheets };
  const sheet = workbook.getWorksheet(selected);
  if (!sheet) throw new Error('工作表不存在，请重新选择。');
  let header: ExcelJS.Row | undefined;
  sheet.eachRow(row => {
    let nonempty = false;
    row.eachCell(cell => { if (text(cell) || invalidCell(cell)) nonempty = true; });
    if (!header && nonempty) header = row;
  });
  if (!header) throw new Error('工作表为空。');
  const headerRow = header;
  const columns = (label: string): number[] => {
    const matches: number[] = [];
    headerRow.eachCell((cell, col) => { if (text(cell) === label) matches.push(col); });
    return matches;
  };
  const serial = columns('项目序号');
  const number = columns('项目号');
  const serialColumn = serial[0];
  const numberColumn = number[0];
  if (serial.length !== 1 || number.length !== 1 || !serialColumn || !numberColumn) throw new Error('首个非空行必须包含唯一的“项目序号”和“项目号”列。');
  const rows: ProjectImportSourceRow[] = [];
  const headerNumber = header.number;
  sheet.eachRow(row => {
    if (row.number <= headerNumber) return;
    const a = row.getCell(serialColumn);
    const b = row.getCell(numberColumn);
    const error = invalidCell(a) || invalidCell(b) ? '包含公式、错误值或无法作为编号读取的值，请在 Excel 中转为文本或值后重试。' : null;
    const number = text(a);
    const name = text(b);
    if (!number && !name && !error) return;
    rows.push({ row: row.number, number, name, error });
  });
  if (rows.length === 0) throw new Error('工作表没有可导入的项目行。');
  return { kind: 'rows' as const, sheets, sheet: selected, rows: prepareProjectImportRows(rows) };
}
