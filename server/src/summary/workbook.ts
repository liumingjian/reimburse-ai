import JSZip from 'jszip';
import type { SummaryData } from '@baox/contract';
import { readFileSync } from 'node:fs';
import { summaryCells } from './cells';
const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export async function summaryWorkbook(data: SummaryData): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(readFileSync(new URL('./template.xlsx', import.meta.url)));
  const sheet = zip.file('xl/worksheets/sheet1.xml');
  if (!sheet) throw new Error('Missing summary worksheet');
  let sheetXml = await sheet.async('string');
  const put = (cell: string, value: string | number, formula = false) => {
    const pattern = new RegExp(`<c\\b([^>]*\\br="${cell}"[^>]*?)(?:\\/>|>[\\s\\S]*?<\\/c>)`);
    sheetXml = sheetXml.replace(pattern, (_whole, attrs: string) => `<c${attrs.replace(/\s+t="[^"]*"/g, '')}${typeof value === 'string' && !formula ? ' t="inlineStr"' : ''}>${formula ? `<f>${xml(String(value))}</f>` : typeof value === 'number' ? `<v>${value}</v>` : `<is><t>${xml(value)}</t></is>`}</c>`);
  };
  for (const cell of summaryCells(data)) {
    if (cell.kind === 'formula') put(cell.address, cell.formula, true);
    else put(cell.address, cell.value);
  }
  zip.file('xl/worksheets/sheet1.xml', sheetXml);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
