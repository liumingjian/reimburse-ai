import JSZip from 'jszip';
import type { SummaryData } from '@baox/contract';
import { readFileSync } from 'node:fs';
import { summaryCells } from './cells';
const escapeXml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export async function summaryPreview(data: SummaryData): Promise<string> {
  const zip = await JSZip.loadAsync(readFileSync(new URL('./template.xlsx', import.meta.url)));
  const source = zip.file('xl/worksheets/sheet1.xml');
  if (!source) throw new Error('Missing summary worksheet');
  const sheet = await source.async('string');
  const columns = Array.from({ length: 11 }, () => 65);
  for (const match of sheet.matchAll(/<col\b([^>]+)\/?\s*>/g)) {
    const attrs = match[1] ?? ''; const width = Number(/width="([^"]+)"/.exec(attrs)?.[1] ?? 8) * 7;
    const start = Number(/min="([^"]+)"/.exec(attrs)?.[1] ?? 1); const end = Number(/max="([^"]+)"/.exec(attrs)?.[1] ?? start);
    for (let col = start; col <= Math.min(end, 11); col += 1) columns[col - 1] = width;
  }
  const rows = Array.from({ length: 20 }, () => 25);
  for (const match of sheet.matchAll(/<row\b([^>]+)>/g)) { const attrs = match[1] ?? ''; const row = Number(/\br="(\d+)"/.exec(attrs)?.[1]); if (row <= 20) rows[row - 1] = Number(/ht="([^"]+)"/.exec(attrs)?.[1] ?? 20) * 1.333; }
  const point = (address: string) => { const [, col = 'A', row = '1'] = /([A-Z]+)(\d+)/.exec(address) ?? []; return { col: col.charCodeAt(0) - 65, row: Number(row) - 1 }; };
  const values = new Map<string, string>();
  for (const match of sheet.matchAll(/<c\b([^>]*?)(?:\s*\/>|>([\s\S]*?)<\/c>)/g)) { const address = /\br="([^"]+)"/.exec(match[1] ?? '')?.[1]; const value = /<t[^>]*>([\s\S]*?)<\/t>/.exec(match[2] ?? '')?.[1]; if (address && value) values.set(address, value.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')); }
  for (const cell of summaryCells(data)) values.set(cell.address, cell.display);
  const merges = [...sheet.matchAll(/<mergeCell ref="([^"]+)"\s*\/>/g)].map(match => { const [a = 'A1', b = a] = match[1]!.split(':'); return { start: point(a), end: point(b) }; });
  const sum = (sizes: number[], end: number) => sizes.slice(0, end).reduce((a,b) => a+b, 0);
  const parts: string[] = [];
  for (let row = 0; row < 20; row += 1) for (let col = 0; col < 11; col += 1) {
    const merge = merges.find(m => col >= m.start.col && col <= m.end.col && row >= m.start.row && row <= m.end.row);
    if (merge && (col !== merge.start.col || row !== merge.start.row)) continue;
    const x = sum(columns, col); const y = sum(rows, row); const width = sum(columns, (merge?.end.col ?? col) + 1) - x; const height = sum(rows, (merge?.end.row ?? row) + 1) - y;
    const value = values.get(`${String.fromCharCode(65 + col)}${row + 1}`) ?? '';
    const wrap = (row === 6 && col === 0) || (row === 5 && col === 7);
    const font = row < 2 ? 21 : wrap ? (col === 7 ? 13 : 15) : Math.min(15, width / Math.max(value.length, 1) * 0.95);
    const perLine = Math.max(1, Math.floor((width - 6) / font));
    const chunks = wrap ? value.match(new RegExp(`.{1,${perLine}}`, 'gu')) ?? [''] : [value];
    const lineHeight = Math.min(font * 1.1, height / chunks.length);
    if (row >= 4 && row < 19) parts.push(`<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="white" stroke="black" stroke-width=".8"/>`);
    parts.push(`<text x="${x + width / 2}" y="${y + height / 2 - (chunks.length - 1) * lineHeight / 2}" font-size="${font}" text-anchor="middle" dominant-baseline="central">${chunks.map((chunk, index) => `<tspan x="${x + width / 2}" dy="${index ? lineHeight : 0}">${escapeXml(chunk)}</tspan>`).join('')}</text>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-12 -12 ${sum(columns,11)+24} ${sum(rows,20)+24}" role="img" aria-label="报销汇总表" style="background:white;font-family:SimSun,Songti SC,serif">${parts.join('')}</svg>`;
}
