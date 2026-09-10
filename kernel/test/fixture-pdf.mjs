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

export const TEST_INVOICE_TEXT = [
  '电子发票(普通发票)',
  '发票号码:12345678901234567890',
  '开票日期:2026年09月01日',
  '合计¥18.25¥0.55',
  '价税合计(大写)壹拾捌元捌角(小写)¥18.80',
].join('\n');

export const TEST_LEGACY_INVOICE_TEXT = [
  '北京增值税电子普通发票',
  '发票代码:011002301811',
  '发票号码:25627655',
  '开票日期:2024年07月04日',
  '*旅游服务*代订车服务费',
  '合计 ￥109.74 ￥6.58',
  '价税合计（大写）壹佰壹拾陆元叁角贰分（小写）￥116.32',
].join('\n');

export const TEST_TRANSPORT_INVOICE_TEXT = [
  '电子发票(普通发票)',
  '旅客运输服务',
  '发票号码:12345678901234567891',
  '开票日期:2026年09月01日',
  '合计¥67.17¥2.02',
  '价税合计(大写)陆拾玖元壹角玖分(小写)¥69.19',
].join('\n');

export const TEST_ITINERARY_TEXT = [
  '高德地图 AMAPITINERARY 行程单',
  '共计3单行程，合计69.19元',
  '1 2026-07-09 08:30 北京市 第一程 26.69元',
  '2 2026-07-09 12:30 北京市 第二程 20.85元',
  '3 2026-07-10 09:00 北京市 第三程 21.65元',
].join('\n');
