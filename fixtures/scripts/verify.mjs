#!/usr/bin/env node
// 校验夹具产物：文件集与清单一致；每份 PDF 用内核的零依赖取字器（kernel/src/pdftext.mjs）抽出预期中文；图片有正确的文件头。
// 用法：node fixtures/scripts/verify.mjs   退出码 0 = 全部通过。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPdfText } from '../../kernel/src/pdftext.mjs';
import {
  AMAP_INVOICE,
  AMAP_ITINERARY,
  CAOCAO_INVOICE,
  CAOCAO_ITINERARY,
  HOTEL_FOLIO,
  HOTEL_INVOICE,
  OTHER_INVOICE,
  RAIL_0809,
  RAIL_0822,
} from './data.mjs';
import { EXPECTED_FILES, MATERIAL_FILES, OUTPUT_DIR } from './generate.mjs';

// 每份 PDF 必须抽得出的字符串：标题、号码、日期、金额与关键中文。
const EXPECTED_TEXT = {
  m01: ['电子发票', '增值税专用发票', HOTEL_INVOICE.number, HOTEL_INVOICE.date, HOTEL_INVOICE.seller.name, '价税合计', HOTEL_INVOICE.gross, HOTEL_INVOICE.net, HOTEL_INVOICE.tax, '住宿服务'],
  m02: ['结账单', HOTEL_FOLIO.hotel, '入住日期', HOTEL_FOLIO.checkIn, '离店日期', HOTEL_FOLIO.checkOut, '消费合计', HOTEL_FOLIO.total],
  m03: ['电子发票', '普通发票', AMAP_INVOICE.number, AMAP_INVOICE.date, '运输服务', '价税合计', AMAP_INVOICE.gross, AMAP_INVOICE.net, AMAP_INVOICE.tax],
  m04: ['行程单', AMAP_ITINERARY.brand, `共计${AMAP_ITINERARY.count}单行程`, `合计${AMAP_ITINERARY.total}元`, '虹桥枢纽', '漕河泾', '静安寺', '张江', '26.69', '20.85', '21.65'],
  m05: ['电子发票', '普通发票', CAOCAO_INVOICE.number, CAOCAO_INVOICE.date, '价税合计', CAOCAO_INVOICE.gross, '-1.94', CAOCAO_INVOICE.net],
  m06: ['行程单', CAOCAO_ITINERARY.brand, '浦东机场', '张江', '38.40'],
  m07: ['铁路电子客票', RAIL_0809.number, RAIL_0809.date, RAIL_0809.train, RAIL_0809.from, RAIL_0809.to, RAIL_0809.price],
  m08: ['铁路电子客票', RAIL_0822.number, RAIL_0822.date, RAIL_0822.train, RAIL_0822.from, RAIL_0822.to, RAIL_0822.price],
  m11: ['电子发票', '普通发票', OTHER_INVOICE.number, OTHER_INVOICE.date, '餐饮服务', OTHER_INVOICE.gross],
};

const MAGIC = {
  pdf: (buf) => buf.subarray(0, 5).toString('latin1') === '%PDF-',
  jpg: (buf) => buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  png: (buf) => buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
};

// 取字结果里同一行的片段之间可能有空格；比对时去掉所有空白。
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
    const name = MATERIAL_FILES[id];
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
