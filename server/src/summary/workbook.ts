import JSZip from 'jszip';
import type { SummaryData } from '@baox/contract';
import { readFileSync } from 'node:fs';
import { CURRENCY_FORMULA } from './currency-formula';
const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const CELLS = [['F6', 'D6'], ['F7', 'D7'], ['F8', 'D8'], ['K6', 'I6'], ['F9', 'D9']] as const;
export async function summaryWorkbook(data: SummaryData): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(readFileSync(new URL('./template.xlsx', import.meta.url)));
  const sheet = zip.file('xl/worksheets/sheet1.xml');
  if (!sheet) throw new Error('Missing summary worksheet');
  let sheetXml = await sheet.async('string');
  const put = (cell: string, value: string | number, formula = false) => {
    const pattern = new RegExp(`<c\\b([^>]*\\br="${cell}"[^>]*?)(?:\\/>|>[\\s\\S]*?<\\/c>)`);
    sheetXml = sheetXml.replace(pattern, (_whole, attrs: string) => `<c${attrs.replace(/\s+t="[^"]*"/g, '')}${typeof value === 'string' && !formula ? ' t="inlineStr"' : ''}>${formula ? `<f>${xml(String(value))}</f>` : typeof value === 'number' ? `<v>${value}</v>` : `<is><t>${xml(value)}</t></is>`}</c>`);
  };
  put('C4', data.name); put('F4', data.department); put('H3', '报销日期');
  put('I3', (Date.parse(`${data.reimbursementDate}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000);
  put('C3', data.billIdentifier); put('F3', data.businessTripIdentifier);
  data.rows.forEach((row, index) => { const cells = CELLS[index]; if (!cells) return; if (row.voucherCount || Number(row.amount)) { put(cells[0], Number(row.amount)); put(cells[1], row.voucherCount); } if (row.days) put('E6', row.days); });
  put('D17', 'ROUND(SUM(F6:F16,K6:K9),2)', true); put('B18', CURRENCY_FORMULA, true);
  zip.file('xl/worksheets/sheet1.xml', sheetXml);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
