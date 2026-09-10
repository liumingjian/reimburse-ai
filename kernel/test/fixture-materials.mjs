import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { writeTextPdf } from './fixture-pdf.mjs';

// Synthetic parser inputs only. No original invoices, personal identifiers or scans.
// Legacy filenames are aliases used by existing tests, never the source of field values.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baox-fixtures-'));
process.once('exit', () => fs.rmSync(root, { recursive: true, force: true }));
const invoice = (type, number, date, net, tax, total) => [
  `电子发票(${type})`, '旅客运输服务', `发票号码:${number}`,
  `开票日期:${date}`, `合计¥${net}¥${tax}`,
  `价税合计(大写)测试金额(小写)¥${total}`,
].join('\n');
const texts = {
  'hotel-invoice.pdf': invoice('增值税专用发票', '10000000000000000001', '2026年08月22日', '3433.96', '206.04', '3640.00'),
  'multi-invoice.pdf': invoice('普通发票', '10000000000000000002', '2026年08月07日', '67.17', '2.02', '69.19'),
  'single-invoice.pdf': invoice('普通发票', '10000000000000000003', '2026年09月02日', '50.12', '1.51', '51.63'),
  'rail.pdf': '电子发票(铁路电子客票)\n发票号码:10000000000000000004\n开票日期:2026年09月02日\n合肥南站 G100 广州南站\n2026年08月22日11:17开\n票价:¥703.00',
  'multi-itinerary.pdf': '高德地图 AMAPITINERARY 行程单\n共计3单行程，合计69.19元\n1 2026-07-09 08:30 北京市 测试起点至测试终点 26.69元\n2 2026-07-09 12:30 北京市 测试起点至测试终点 20.85元\n3 2026-07-10 09:00 北京市 测试起点至测试终点 21.65元',
  'single-itinerary.pdf': '高德地图 AMAPITINERARY 行程单\n共计1单行程，合计51.63元\n1 2026-08-27 08:30 广州市 测试起点至测试终点 51.63元',
  'hotel-folio.pdf': '测试酒店结账单\n入住日期:2026-08-09\n离店日期:2026-08-22\n付款合计3640.00',
};
const aliases = {
  'fp-jd.pdf': 'hotel-invoice.pdf', 'zd-jd.pdf': 'hotel-folio.pdf',
  '【AA出行-69.19元-3个行程】高德打车电子发票.pdf': 'multi-invoice.pdf',
  '【AA出行-69.19元-3个行程】高德打车电子行程单.pdf': 'multi-itinerary.pdf',
  '【曹操出行-51.63元-1个行程】高德打车电子发票.pdf': 'single-invoice.pdf',
  '【曹操出行-51.63元-1个行程】高德打车电子行程单.pdf': 'single-itinerary.pdf',
  '26349119423005877606.pdf': 'rail.pdf',
  'fengyun-1.png': 'landscape.png', '行程单.png': 'wide.png',
};

function png(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc((width + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}

export function fixtureMaterial(...parts) {
  const name = path.basename(path.join(...parts));
  const key = aliases[name] ?? name;
  const file = path.join(root, key);
  if (!fs.existsSync(file)) {
    if (key === 'single-itinerary.pdf') {
      const row = (y, cells) => cells.map(([x, text]) => ({ x, y, text }));
      writeTextPdf(file, [
        ...row(750, [[10, '高德地图 AMAPITINERARY 行程单']]),
        ...row(720, [[10, '共计1单行程，合计51.63元']]),
        ...row(680, [[10, '序号'], [50, '日期'], [150, '时间'], [210, '城市'], [310, '起点'], [410, '终点'], [510, '金额']]),
        ...row(650, [[10, '1'], [50, '2026-08-27'], [150, '08:30'], [210, '广州市'], [310, '测试起点'], [410, '测试终点'], [510, '51.63元']]),
      ]);
    } else if (texts[key]) writeTextPdf(file, texts[key]);
    else if (key === 'landscape.png') fs.writeFileSync(file, png(1816, 1396));
    else if (key === 'wide.png') fs.writeFileSync(file, png(1598, 606));
    else throw new Error(`Unknown synthetic material: ${name}`);
  }
  return file;
}

export function fixtureDirectory() {
  const dir = path.join(root, 'materials');
  for (const [rel, name] of Object.entries({
    '住宿/fp-jd.pdf': 'hotel-invoice.pdf',
    '住宿/zd-jd.pdf': 'hotel-folio.pdf',
    '交通/invoice.pdf': 'single-invoice.pdf',
    '交通/itinerary.pdf': 'single-itinerary.pdf',
    '交通/invoice.png': 'landscape.png',
    '交通/itinerary.png': 'wide.png',
    '长途/26349119423005877606.pdf': 'rail.pdf',
  })) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(fixtureMaterial(name), target);
  }
  return dir;
}
