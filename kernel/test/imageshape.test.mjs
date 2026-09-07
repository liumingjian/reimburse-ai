import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { shapeOf, shapeMatches, shapeOfBuffer, shapeOfFile, SHAPES } from '../src/imageshape.mjs';

const repo = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const res = (rel) => path.join(repo, 'resources', rel);

// 这一层是「模型有没有真的打开过这张图」那道闸的地基。它有两个职责，
// 一个比一个要紧：**内核自己解得开的才算图**，以及**形状是从字节里算出来的**。

test('真材料：PNG 的宽高从 IHDR 里精确读出来', () => {
  const a = shapeOfFile(res('交通/fengyun-1.png'));
  assert.deepEqual(a, { width: 1816, height: 1396, shape: 'landscape' });

  const b = shapeOfFile(res('交通/行程单.png'));
  assert.deepEqual(b, { width: 1598, height: 606, shape: 'wide' });
});

/** 手搓一张最小 JPEG：SOI + 一段 APP0 + SOF0 帧头。足够验标记扫描走不走得对。 */
function jpeg(width, height) {
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14)]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x03]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(6)]);
}

test('JPEG：跳过前面的标记段，从 SOFn 里取宽高', () => {
  assert.deepEqual(shapeOfBuffer(jpeg(1200, 1600)), { width: 1200, height: 1600, shape: 'portrait' });
});

test('解不开的字节就是解不开 —— 内核不猜，也不当作一张看不清的图', () => {
  assert.equal(shapeOfBuffer(Buffer.from('这不是图片，只是一段文字')), null);
  assert.equal(shapeOfBuffer(Buffer.alloc(0)), null);
  // 截断的 PNG：签名对，IHDR 还没写完。它显示不出来，得让用户换一份。
  const png = fs.readFileSync(res('交通/fengyun-1.png'));
  assert.equal(shapeOfBuffer(png.subarray(0, 20)), null);
  assert.equal(shapeOfFile('/no/such/file.png'), null);
});

test('五档形状：一眼看得出，猜则五选一', () => {
  assert.deepEqual(SHAPES, ['tall', 'portrait', 'square', 'landscape', 'wide']);
  assert.equal(shapeOf(600, 1600), 'tall');
  assert.equal(shapeOf(1200, 1600), 'portrait');
  assert.equal(shapeOf(1000, 1000), 'square');
  assert.equal(shapeOf(1400, 1000), 'landscape');
  assert.equal(shapeOf(3000, 1000), 'wide');
});

test('隔档一律不算：字段全抄对了也救不了一次没看图的提交', () => {
  assert.equal(shapeMatches(1816, 1396, 'landscape'), true);
  assert.equal(shapeMatches(1816, 1396, 'portrait'), false);
  assert.equal(shapeMatches(1816, 1396, 'tall'), false);
  assert.equal(shapeMatches(1816, 1396, '横着的'), false, '只认闭集里那五个词');
  assert.equal(shapeMatches(1816, 1396, undefined), false);
});

test('贴着边界时相邻档也算对 —— 这道闸是挡没看图的，不是考眼力', () => {
  // 1.04：正方和横着的边界（1.05）就在旁边，两边都算对。
  assert.equal(shapeMatches(1040, 1000, 'square'), true);
  assert.equal(shapeMatches(1040, 1000, 'landscape'), true);
  // 1.30：离任何一条边界都远，只有 landscape 算对。
  assert.equal(shapeMatches(1300, 1000, 'square'), false);
  assert.equal(shapeMatches(1300, 1000, 'wide'), false);
});
