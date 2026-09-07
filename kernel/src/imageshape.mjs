/**
 * 图片的**形状**：从文件头里精确读出来的宽高，以及由它算出的一个粗粒度形状档。
 *
 * 它存在的理由只有一个 —— 让「模型有没有真的打开过这张图」变成内核**验得了**的事。
 *
 * 0.9.2 真机上出过一次事故：模型一张图都没打开，就回报「图片显示不出来」，
 * 让用户回去重新导出材料。那是最坏的一种失败 —— 用户照做了，问题却不在他那边。
 * 要让它不再可能，得从两头堵：
 *
 *  1. **「这个文件根本打不开」不再是模型说了算。** 内核自己解得开文件头，
 *     就说明它是一张完整的、显示得出来的图；解不开的（截断、伪装成 png 的别的东西）
 *     内核在分类那一层就报成开放项交给用户，模型压根不会被派去看它。
 *     所以到了模型手上的每一张图，都是内核确认过打得开的。
 *  2. **交读数要带一句只有看过才答得上的话。** 就是这里的 `shape`：
 *     宽高比落在五档里的哪一档。内核从字节里算得出准确答案，模型不看图猜不中，
 *     而**看着图的人一眼就知道**。它对「看不清」一视同仁 —— 说看不清也要先证明在看。
 *
 * 五档而不是「横的竖的」两档，是因为两档太好蒙；档位之间留了边界宽容度，
 * 是因为真在看图的人也可能在临界比例上判偏一档，而**冤枉一次老实的读数**
 * 比放过一次蒙混更糟：这道闸的目的是挡住没看图的，不是考眼力。
 */
import fs from 'node:fs';

/** 宽高比（宽 ÷ 高）的分档。看着图就答得上，猜则五选一。 */
const BANDS = [
  { shape: 'tall', label: '细长条（高明显大于宽）', max: 0.66 },
  { shape: 'portrait', label: '竖着的', max: 0.95 },
  { shape: 'square', label: '接近正方形', max: 1.05 },
  { shape: 'landscape', label: '横着的', max: 1.6 },
  { shape: 'wide', label: '扁长条（宽明显大于高）', max: Infinity },
];

export const SHAPES = BANDS.map((b) => b.shape);
export const SHAPE_LABELS = Object.fromEntries(BANDS.map((b) => [b.shape, b.label]));

/** 边界宽容度：真实比例离档位边界不到这个比例时，相邻的那一档也算答对。 */
const EDGE_TOLERANCE = 0.08;

const bandIndex = (ratio) => BANDS.findIndex((b) => ratio <= b.max);

/** 宽高 -> 形状档。 */
export function shapeOf(width, height) {
  return BANDS[bandIndex(width / height)].shape;
}

/**
 * 报上来的形状档算不算对。
 *
 * 正解当然算对；相邻档在**真实比例贴着那条边界**时也算对 —— 1.04 和 1.06
 * 眼睛分不出是正方还是横的，那不是没看图。隔档一律不算。
 */
export function shapeMatches(width, height, reported) {
  if (typeof reported !== 'string') return false;
  const ratio = width / height;
  const truth = bandIndex(ratio);
  const said = SHAPES.indexOf(reported);
  if (said < 0) return false;
  if (said === truth) return true;
  if (Math.abs(said - truth) !== 1) return false;
  // 相邻档：只有真实比例离两档之间那条边界足够近才放行。
  const edge = BANDS[Math.min(said, truth)].max;
  return Math.abs(ratio - edge) / edge <= EDGE_TOLERANCE;
}

/** PNG：IHDR 一定是第一个块，宽高就在固定偏移上。 */
function pngSize(buf) {
  if (buf.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!sig.every((b, i) => buf[i] === b)) return null;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * JPEG：从 SOI 往后走标记段，取第一个 SOFn 里的宽高。
 * 跳过 SOF4/SOF8/SOF12（它们不是帧头）和所有没有长度字段的标记。
 */
function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }      // 填充字节，往前挪
    const marker = buf[i + 1];
    if (marker === 0xff) { i += 1; continue; }
    // 没有长度字段的标记：填充、SOI/EOI、RSTn。
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 9 >= buf.length) return null;
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (marker === 0xda) return null;               // 到了扫描数据还没见到帧头
    i += 2 + len;
  }
  return null;
}

/** 一段字节是不是一张读得出尺寸的图。读不出就是 `null` —— 那是内核的判定，不是模型的说法。 */
export function shapeOfBuffer(buf) {
  const size = pngSize(buf) ?? jpegSize(buf);
  return size ? { ...size, shape: shapeOf(size.width, size.height) } : null;
}

/** 同上，直接读文件。文件不在、读不动，一律 `null`。 */
export function shapeOfFile(absPath) {
  try { return shapeOfBuffer(fs.readFileSync(absPath)); } catch { return null; }
}
