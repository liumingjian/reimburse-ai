import fs from 'node:fs';

const utf16beHex = (text) => {
  const bytes = Buffer.alloc(text.length * 2);
  for (let i = 0; i < text.length; i++) bytes.writeUInt16BE(text.charCodeAt(i), i * 2);
  return bytes.toString('hex');
};

/** 写一份只有文字层的最小 PDF，供材料流程测试使用。 */
export function writeTextPdf(filePath, text) {
  const content = `BT /F1 12 Tf 50 750 Td <${utf16beHex(text)}> Tj ET`;
  const pdf = [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
      + '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >> endobj',
    `4 0 obj << /Length ${Buffer.byteLength(content)} >> stream\n${content}\nendstream endobj`,
    '5 0 obj << /Type /Font /Subtype /Type0 /BaseFont /Test /Encoding /Identity-H >> endobj',
    '%%EOF',
  ].join('\n');
  fs.writeFileSync(filePath, pdf);
}
