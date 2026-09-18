import type { Line, Material } from '@baox/contract';

// 打印稿 (print sheet) layout, pure (docs/design/standalone-app.md「打印稿」): one A4 portrait page per 主要报销凭证
// (primary voucher), the voucher on the top half and its 证明材料 (supporting material) on the bottom half, a thin
// dashed line between them, and a one-line header in the top margin that takes no space from either half.
// Coordinates are PDF points with a lower-left origin.

export type Size = { width: number; height: number };
export type Box = { x: number; y: number; width: number; height: number };

export const A4: Size = { width: 595.28, height: 841.89 };

const SIDE = 24;
const BOTTOM = 24;
const HEADER_TOP = 14;
const HEADER_HEIGHT = 12;
const HEADER_GAP = 8;
const GUTTER = 12;
// 住宿页 bottom half with a 支付截图: the folio takes about 2/3 on the left, the screenshot 1/3 on the right.
const SPLIT_GAP = 8;

const contentTop = A4.height - HEADER_TOP - HEADER_HEIGHT - HEADER_GAP;
const halfHeight = (contentTop - BOTTOM - GUTTER) / 2;
const width = A4.width - 2 * SIDE;

export const HEADER_BOX: Box = { x: SIDE, y: A4.height - HEADER_TOP - HEADER_HEIGHT, width, height: HEADER_HEIGHT };
export const SEPARATOR_Y = BOTTOM + halfHeight + GUTTER / 2;
export const SEPARATOR_X: readonly [number, number] = [SIDE, A4.width - SIDE];

const TOP: Box = { x: SIDE, y: contentTop - halfHeight, width, height: halfHeight };
const BOTTOM_HALF: Box = { x: SIDE, y: BOTTOM, width, height: halfHeight };
const leftWidth = ((width - SPLIT_GAP) * 2) / 3;
const BOTTOM_LEFT: Box = { x: SIDE, y: BOTTOM, width: leftWidth, height: halfHeight };
const BOTTOM_RIGHT: Box = { x: SIDE + leftWidth + SPLIT_GAP, y: BOTTOM, width: width - leftWidth - SPLIT_GAP, height: halfHeight };

export type Region = 'top' | 'bottom' | 'bottom_left' | 'bottom_right';
export const REGIONS: Readonly<Record<Region, Box>> = { top: TOP, bottom: BOTTOM_HALF, bottom_left: BOTTOM_LEFT, bottom_right: BOTTOM_RIGHT };

// The scale that fits `content` into `region`, upright or turned a quarter.
export function scaleOf(content: Size, region: Size, rotate: boolean): number {
  const w = rotate ? content.height : content.width;
  const h = rotate ? content.width : content.height;
  return Math.min(region.width / w, region.height / h);
}

// Placement rule: whichever of upright / turned 90° gives the larger scale (ties stay upright).
export function prefersRotation(content: Size, region: Size): boolean {
  return scaleOf(content, region, true) > scaleOf(content, region, false) * 1.0001;
}

// Where content lands, centred in the region, as pdf-lib draw options. Turned content is drawn with a clockwise
// quarter turn about its (x, y) corner, so its footprint hangs below y: x..x+height, y-width..y.
export type Placed = { x: number; y: number; width: number; height: number; rotate: 0 | -90 };

export function place(content: Size, region: Box, rotate: boolean): Placed {
  const scale = scaleOf(content, region, rotate);
  const w = content.width * scale;
  const h = content.height * scale;
  const footprint = rotate ? { width: h, height: w } : { width: w, height: h };
  const left = region.x + (region.width - footprint.width) / 2;
  const bottom = region.y + (region.height - footprint.height) / 2;
  return rotate ? { x: left, y: bottom + w, width: w, height: h, rotate: -90 } : { x: left, y: bottom, width: w, height: h, rotate: 0 };
}

// One printed page, in 统一业务序号 (business sequence) order: the lines of one voucher are consecutive, so a voucher
// with several legs gets a number range (`No.1-3`).
export type PagePlan = {
  pageId: string;
  voucherMaterialId: string;
  bottomMaterialId: string | null;
  // The voucher's other supporting materials. One page holds one of them (the bottom half), so the rest are named in
  // a notice rather than dropped without a word.
  droppedMaterialIds: string[];
  no: number;
  nos: string;
  date: string;
  categoryLabel: string;
  grossAmount: string;
  header: string;
  // Every voucher may take a 支付截图 (payment screenshot): story 61 asks for proof of payment beside its invoice,
  // not only for 住宿. With one the bottom half splits (supporting material left, screenshot right).
  acceptsPaymentScreenshot: boolean;
  // Whether a missing one is worth saying out loud. Only 住宿 is expected to carry proof of payment, so the reminder
  // stays there; raising it on every voucher would bury the page in notices nobody asked for.
  expectsPaymentScreenshot: boolean;
};

const cents = (amount: string): number => {
  const [whole = '0', fraction = ''] = amount.split('.');
  const sign = whole.startsWith('-') ? -1 : 1;
  return sign * (Math.abs(Number.parseInt(whole, 10)) * 100 + Number.parseInt(fraction.padEnd(2, '0').slice(0, 2) || '0', 10));
};
const amountOf = (value: number): string => `${value < 0 ? '-' : ''}${Math.floor(Math.abs(value) / 100)}.${String(Math.abs(value) % 100).padStart(2, '0')}`;

// Pages from the confirmed lines. The bottom half holds the voucher's reference (itinerary / folio), if any.
export function planPages(lines: readonly Line[], materials: readonly Material[]): PagePlan[] {
  const groups = new Map<string, Line[]>();
  for (const line of [...lines].sort((a, b) => a.no - b.no)) {
    const group = groups.get(line.voucherMaterialId) ?? [];
    group.push(line);
    groups.set(line.voucherMaterialId, group);
  }
  const known = new Set(materials.map((material) => material.materialId));
  const plans: PagePlan[] = [];
  for (const [voucherMaterialId, group] of groups) {
    const first = group[0];
    const last = group.at(-1);
    if (!first || !last) continue;
    const nos = first.no === last.no ? `No.${first.no}` : `No.${first.no}-${last.no}`;
    const grossAmount = amountOf(group.reduce((sum, line) => sum + cents(line.grossAmount), 0));
    const linked = materials.find((material) => material.materialId === voucherMaterialId)?.linkedMaterialIds ?? [];
    const supporting = [...new Set([...group.flatMap((line) => line.referenceMaterialIds), ...linked])].filter((id) => known.has(id) && id !== voucherMaterialId);
    const [bottomMaterialId = null, ...droppedMaterialIds] = supporting;
    plans.push({
      pageId: `page.${voucherMaterialId}`,
      voucherMaterialId,
      bottomMaterialId,
      droppedMaterialIds,
      no: first.no,
      nos,
      date: first.date,
      categoryLabel: first.category.label,
      grossAmount,
      header: `${nos} · ${first.date.slice(5)} · ${first.category.label} · ${grossAmount}`,
      acceptsPaymentScreenshot: true,
      expectsPaymentScreenshot: first.category.code === 'accommodation',
    });
  }
  return plans;
}

export const missingScreenshotNotice = (nos: string, categoryLabel: string): string => `${nos} ${categoryLabel}发票还没有支付截图。可以照常打印，该页下半页只放结账单。`;

// 一页只有一个下半页，放不下第二份证明材料；说出来，别让它无声无息地少掉。
export const droppedMaterialsNotice = (nos: string, fileNames: readonly string[]): string =>
  `${nos} 还有 ${fileNames.length} 份证明材料没有放进打印稿（每页下半页只放一份）：${fileNames.join('、')}。这些材料请另外打印。`;

// 多页的证明材料（长行程单、多页结账单）只嵌入了第 1 页。
export const extraPagesNotice = (nos: string, fileName: string, pageCount: number): string =>
  `${nos} 的「${fileName}」共 ${pageCount} 页，打印稿只放了第 1 页。其余 ${pageCount - 1} 页请另外打印。`;
