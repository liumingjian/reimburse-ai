import { fixtureMaterial } from '../kernel/test/fixture-materials.mjs';
import fs from 'node:fs';
const d = '/tmp/baox-parse-edge';
fs.rmSync(d, { recursive: true, force: true });
fs.mkdirSync(d + '/dup', { recursive: true });
fs.mkdirSync(d + '/refonly', { recursive: true });
fs.mkdirSync(d + '/broken', { recursive: true });

const cc = fixtureMaterial('single-invoice.pdf');
const buf = fs.readFileSync(cc);
// 同一张发票，字节完全相同的两个副本
fs.writeFileSync(d + '/dup/a.pdf', buf);
fs.writeFileSync(d + '/dup/b.pdf', buf);
// 同一张发票，字节不同（尾部追加注释，内容哈希变了，票面没变）
fs.writeFileSync(d + '/dup/c.pdf', Buffer.concat([buf, Buffer.from('\n% baox-edge\n')]));

// 只有参考材料
fs.copyFileSync(fixtureMaterial('hotel-folio.pdf'), d + '/refonly/folio.pdf');

// 有文字但不是支持票种
const mk = (body) => {
  const objs = body;
  let out = '%PDF-1.4\n';
  objs.forEach((o, i) => { out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  out += `trailer\n<< /Root 1 0 R >>\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
};
const stream = (s) => `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
fs.writeFileSync(d + '/broken/plain.pdf', mk([
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
  stream('BT /F1 12 Tf 72 700 Td (this is not an invoice) Tj ET'),
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
]));
// 一页也没有文字（扫描件的形状）
fs.writeFileSync(d + '/broken/scan.pdf', mk([
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
  stream('0 0 0 rg 10 10 100 100 re f'),
]));
console.log('built', d);
