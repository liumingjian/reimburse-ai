#!/usr/bin/env node
// Verify the generated fixtures: the file set matches the manifest; every PDF yields the expected Chinese text through
// the zero-dependency extractor (./pdftext.mjs, the original kernel extractor); every image has the right magic bytes.
// Usage: node fixtures/scripts/verify.mjs   exit code 0 = everything passed.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPdfText } from './pdftext.mjs';
import {
  AMAP_INVOICE,
  AMAP_ITINERARY,
  BUNDLED_FEE_INVOICE,
  AMAP_ITINERARY_GAP,
  AMAP_ITINERARY_WRAPPED,
  AMAP_ITINERARY_CROSS_CITY,
  CAOCAO_INVOICE,
  CAOCAO_ITINERARY,
  HOTEL_FOLIO,
  HOTEL_INVOICE,
  DINING_INVOICE,
  DINING_RECEIPT,
  DISCOUNTED_DINING_RECEIPT,
  OFFICE_SUPPLIES_INVOICE,
  RAIL_0809,
  RAIL_0822,
  RAIL_SPLIT_RUNS,
  SPACED_TITLE_INVOICE,
  SPLIT_NUMBER_INVOICE,
  TRANSPORT_INVOICE,
  WIDE_COLUMN_INVOICE,
  WRAPPED_ITEM_INVOICE,
} from './data.mjs';
import { EXPECTED_FILES, OUTPUT_DIR, PDF_DOC_FILES } from './generate.mjs';

// What every PDF must yield: its title, number, date, amounts and the wording that identifies the face.
const EXPECTED_TEXT = {
  m13: [DINING_RECEIPT.title, DINING_RECEIPT.merchant, DINING_RECEIPT.date, '实付', DINING_RECEIPT.paid],
  m14: [DISCOUNTED_DINING_RECEIPT.title, '合计', DISCOUNTED_DINING_RECEIPT.total, '优惠', DISCOUNTED_DINING_RECEIPT.discount, '实付', DISCOUNTED_DINING_RECEIPT.paid],
  m01: ['电子发票', '增值税专用发票', HOTEL_INVOICE.number, HOTEL_INVOICE.date, HOTEL_INVOICE.seller.name, '价税合计', HOTEL_INVOICE.gross, HOTEL_INVOICE.net, HOTEL_INVOICE.tax, '住宿服务'],
  m02: ['结账单', HOTEL_FOLIO.hotel, '入住日期', HOTEL_FOLIO.checkIn, '离店日期', HOTEL_FOLIO.checkOut, '消费合计', HOTEL_FOLIO.total],
  m03: ['电子发票', '普通发票', AMAP_INVOICE.number, AMAP_INVOICE.date, '运输服务', '价税合计', AMAP_INVOICE.gross, AMAP_INVOICE.net, AMAP_INVOICE.tax],
  m04: ['行程单', AMAP_ITINERARY.brand, `共计${AMAP_ITINERARY.count}单行程`, `合计${AMAP_ITINERARY.total}元`, '虹桥枢纽', '漕河泾', '静安寺', '张江', '26.69', '20.85', '21.65'],
  m05: ['电子发票', '普通发票', CAOCAO_INVOICE.number, CAOCAO_INVOICE.date, '价税合计', CAOCAO_INVOICE.gross, '-1.94', CAOCAO_INVOICE.net],
  m06: ['行程单', CAOCAO_ITINERARY.brand, '浦东机场', '张江', '38.40'],
  m07: ['铁路电子客票', RAIL_0809.number, RAIL_0809.date, RAIL_0809.train, RAIL_0809.from, RAIL_0809.to, RAIL_0809.price],
  m08: ['铁路电子客票', RAIL_0822.number, RAIL_0822.date, RAIL_0822.train, RAIL_0822.from, RAIL_0822.to, RAIL_0822.price],
  r201: ['电子发票', '普通发票', BUNDLED_FEE_INVOICE.number, BUNDLED_FEE_INVOICE.date, '运输服务', '经纪代理服务', '价税合计', BUNDLED_FEE_INVOICE.gross, BUNDLED_FEE_INVOICE.net, BUNDLED_FEE_INVOICE.tax],
  r202: ['行程单', AMAP_ITINERARY_GAP.brand, `共计${AMAP_ITINERARY_GAP.count}单行程`, `合计${AMAP_ITINERARY_GAP.total}元`, '张江', '浦东机场', '待结算'],
  m11: ['电子发票', '普通发票', DINING_INVOICE.number, DINING_INVOICE.date, '餐饮服务', DINING_INVOICE.gross],
  m12: ['电子发票', '普通发票', OFFICE_SUPPLIES_INVOICE.number, OFFICE_SUPPLIES_INVOICE.date, '办公用品', OFFICE_SUPPLIES_INVOICE.gross],
  r204: ['铁路电子客票', RAIL_SPLIT_RUNS.number, RAIL_SPLIT_RUNS.date, RAIL_SPLIT_RUNS.train, RAIL_SPLIT_RUNS.from, RAIL_SPLIT_RUNS.to, RAIL_SPLIT_RUNS.seat, '票价', RAIL_SPLIT_RUNS.price],
  r01: ['电子发票', '增值税专用发票', SPLIT_NUMBER_INVOICE.number, SPLIT_NUMBER_INVOICE.date, '住宿服务', SPLIT_NUMBER_INVOICE.gross, SPLIT_NUMBER_INVOICE.net, SPLIT_NUMBER_INVOICE.tax],
  r205: ['行程单', AMAP_ITINERARY_WRAPPED.brand, `共计${AMAP_ITINERARY_WRAPPED.count}单行程`, `合计${AMAP_ITINERARY_WRAPPED.total}元`, '2026-08-10', '08:52', '26.69元', '42.50', '虹桥枢纽', '张江'],
  r209: ['行程单', AMAP_ITINERARY_CROSS_CITY.brand, `申请时间：${AMAP_ITINERARY_CROSS_CITY.applyDate}`, `共计${AMAP_ITINERARY_CROSS_CITY.count}单行程`, `合计${AMAP_ITINERARY_CROSS_CITY.total}元`, '杭州市', '上海市', '12.49', '15.00'],
  r206: ['电子发票', '普通发票', TRANSPORT_INVOICE.number, TRANSPORT_INVOICE.date, '交通运输服务', '发票联', TRANSPORT_INVOICE.gross, TRANSPORT_INVOICE.net, TRANSPORT_INVOICE.tax],
  r207: ['电子发票', '普通发票', WIDE_COLUMN_INVOICE.number, WIDE_COLUMN_INVOICE.date, '交通运输服务', '客运服务费', '合计', WIDE_COLUMN_INVOICE.gross, WIDE_COLUMN_INVOICE.net, WIDE_COLUMN_INVOICE.tax],
  r208: ['电子发票', '普通发票', WRAPPED_ITEM_INVOICE.number, WRAPPED_ITEM_INVOICE.date, '交通运输服务', '预约调度费', '合计', WRAPPED_ITEM_INVOICE.gross, WRAPPED_ITEM_INVOICE.net, WRAPPED_ITEM_INVOICE.tax],
  r02: ['电子发票', '普通发票', SPACED_TITLE_INVOICE.number, SPACED_TITLE_INVOICE.date, '住宿服务', SPACED_TITLE_INVOICE.gross, SPACED_TITLE_INVOICE.net, SPACED_TITLE_INVOICE.tax],
};

const MAGIC = {
  pdf: (buf) => buf.subarray(0, 5).toString('latin1') === '%PDF-',
  jpg: (buf) => buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  png: (buf) => buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
};

// Fragments of one line may come back separated by spaces, so all whitespace is dropped before comparing.
const squash = (s) => s.replace(/\s+/g, '');

function verify() {
  const failures = [];
  const actual = readdirSync(OUTPUT_DIR).filter((name) => !name.startsWith('.')).sort();
  if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_FILES)) {
    failures.push(`文件集不一致：\n  实际 ${actual.join(', ')}\n  预期 ${EXPECTED_FILES.join(', ')}`);
  }
  let totalBytes = 0;
  for (const name of actual) {
    const path = join(OUTPUT_DIR, name);
    const buf = readFileSync(path);
    totalBytes += buf.length;
    const ext = name.slice(name.lastIndexOf('.') + 1);
    const check = MAGIC[ext];
    if (!check || !check(buf)) failures.push(`${name}：文件头不是 ${ext}`);
    if (buf.length > 1.5 * 1024 * 1024) failures.push(`${name}：${(buf.length / 1024).toFixed(0)} KB，超过 1.5 MB`);
  }
  for (const [id, expected] of Object.entries(EXPECTED_TEXT)) {
    const name = PDF_DOC_FILES[id];
    const path = join(OUTPUT_DIR, name);
    let result;
    try {
      result = extractPdfText(readFileSync(path));
    } catch (error) {
      failures.push(`${name}：取字抛出 ${error.message}`);
      continue;
    }
    if (!result.hasText) {
      failures.push(`${name}：没有文本层`);
      continue;
    }
    if (result.pageCount !== 1) failures.push(`${name}：应为 1 页，实际 ${result.pageCount} 页`);
    const text = squash(result.text);
    for (const needle of expected) {
      if (!text.includes(squash(needle))) failures.push(`${name}：抽不出「${needle}」`);
    }
    console.log(`${name}：${result.pageCount} 页，${result.text.length} 字，${(statSync(path).size / 1024).toFixed(0)} KB`);
  }
  console.log(`共 ${actual.length} 个文件，${(totalBytes / 1024).toFixed(0)} KB`);
  if (failures.length) {
    console.error(`校验失败（${failures.length}）：\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }
  console.log('夹具校验通过');
}

verify();
