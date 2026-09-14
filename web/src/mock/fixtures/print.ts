import type { PlacementSlot, Corners, Placement, PrintPage, PrintSheet, TaskSnapshot } from '@baox/contract';

// 打印稿夹具（mock 服务端角色）：7 页与 fixtures/scripts/data.mjs 的 PRINT_PAGES 一致，页图是生成器产出的 PNG。
// 旋转换一张预先生成的变体页图（print-pgN-r<上><下>.png）；四角裁剪只记下坐标（mock 不重新矫正照片），页图不变。
// 合并 PDF 是生成器用 7 张默认页图合成的 fixtures/print-sheet.pdf。

type PageDef = {
  pageId: string;
  nos: string;
  date: string;
  categoryLabel: string;
  grossAmount: string;
  top: string;
  bottom: string | null;
  rotateTop: boolean;
  rotateBottom: boolean;
};

// 材料按文件名找（种子任务与现场上传得到的材料 id 不同）。页序跟随统一业务序号（内核分类排序），与生成器的 PRINT_PAGES 一致。
const PAGE_DEFS: readonly PageDef[] = [
  { pageId: 'pg1', nos: 'No.1-3', date: '2026-08-10', categoryLabel: '外地市内交通', grossAmount: '69.19', top: '高德打车_发票.pdf', bottom: '高德打车_行程单.pdf', rotateTop: false, rotateBottom: false },
  { pageId: 'pg2', nos: 'No.4', date: '2026-08-11', categoryLabel: '外地市内交通', grossAmount: '38.40', top: '曹操出行_发票.pdf', bottom: '曹操出行_行程单.pdf', rotateTop: false, rotateBottom: false },
  { pageId: 'pg3', nos: 'No.5', date: '2026-08-15', categoryLabel: '外地市内交通', grossAmount: '32.00', top: 'IMG_4871.jpg', bottom: null, rotateTop: true, rotateBottom: false },
  { pageId: 'pg4', nos: 'No.6', date: '2026-08-19', categoryLabel: '外地市内交通', grossAmount: '47.00', top: 'IMG_4906.jpg', bottom: null, rotateTop: true, rotateBottom: false },
  { pageId: 'pg5', nos: 'No.7', date: '2026-08-09', categoryLabel: '长途交通', grossAmount: '73.00', top: '铁路电子客票_0809.pdf', bottom: null, rotateTop: false, rotateBottom: false },
  { pageId: 'pg6', nos: 'No.8', date: '2026-08-22', categoryLabel: '长途交通', grossAmount: '73.00', top: '铁路电子客票_0822.pdf', bottom: null, rotateTop: false, rotateBottom: false },
  { pageId: 'pg7', nos: 'No.9', date: '2026-08-09', categoryLabel: '住宿', grossAmount: '3640.00', top: '全季酒店_发票.pdf', bottom: '全季酒店_结账单.pdf', rotateTop: false, rotateBottom: true },
];

// 出租车票照片（900x1200）上自动检测到的纸张四角，原图像素。
const AUTO_CORNERS: Readonly<Record<string, Corners>> = {
  'IMG_4871.jpg': [[182, 167], [586, 139], [638, 893], [234, 921]],
  'IMG_4906.jpg': [[182, 167], [586, 139], [638, 893], [234, 921]],
};

const ORIGINAL_URLS: Readonly<Record<string, string>> = {
  'IMG_4871.jpg': 'fixtures/m09-taxi-photo.jpg',
  'IMG_4906.jpg': 'fixtures/m10-taxi-photo.jpg',
};

export const PRINT_SHEET_FILE_NAME = '打印稿_2026-08上海出差.pdf';
export const PRINT_SHEET_URL = 'fixtures/print-sheet.pdf';
export const MISSING_SCREENSHOT_NOTICE = (nos: string, categoryLabel: string) =>
  `${nos} ${categoryLabel}发票还没有支付截图。可以照常打印，该页下半页只放结账单。`;

// 与生成器的 printPageFile 同一规则：默认放置用 print-pgN.png，其余组合用 -r<上><下> 变体。
function pageImageUrl(def: PageDef, rotateTop: boolean, rotateBottom: boolean): string {
  if (rotateTop === def.rotateTop && (def.bottom === null || rotateBottom === def.rotateBottom)) return `fixtures/print-${def.pageId}.png`;
  const flags = def.bottom === null ? `${rotateTop ? 1 : 0}` : `${rotateTop ? 1 : 0}${rotateBottom ? 1 : 0}`;
  return `fixtures/print-${def.pageId}-r${flags}.png`;
}

function placement(materialId: string, fileName: string, rotate: boolean): Placement {
  const corners = AUTO_CORNERS[fileName] ?? null;
  return {
    materialId,
    fileName,
    rotate,
    croppable: corners !== null,
    corners: corners ? (structuredClone(corners) as Corners) : null,
    cropAdjusted: false,
    imageUrl: ORIGINAL_URLS[fileName] ?? null,
  };
}

const defOf = (pageId: string) => PAGE_DEFS.find((def) => def.pageId === pageId);

// 住宿发票可以补充支付截图（打印稿住宿页下半页分栏放结账单与截图）：mock 服务端按费用分类判定。
function acceptsScreenshot(snapshot: TaskSnapshot, voucherMaterialId: string): boolean {
  return snapshot.lines.some((line) => line.voucherMaterialId === voucherMaterialId && line.category.code === 'accommodation');
}

// 生成打印稿：每张主要报销凭证一页，按统一业务序号；只收已确认明细里出现的凭证。
export function buildPrintSheet(snapshot: TaskSnapshot): PrintSheet {
  const byName = new Map(snapshot.materials.map((material) => [material.fileName, material.materialId]));
  const vouchers = new Set(snapshot.lines.map((line) => line.voucherMaterialId));
  const pages: PrintPage[] = [];
  for (const def of PAGE_DEFS) {
    const topId = byName.get(def.top);
    if (!topId || !vouchers.has(topId)) continue;
    const bottomId = def.bottom ? byName.get(def.bottom) : undefined;
    const no = snapshot.lines.find((line) => line.voucherMaterialId === topId)?.no ?? pages.length + 1;
    pages.push({
      acceptsPaymentScreenshot: acceptsScreenshot(snapshot, topId),
      pageId: def.pageId,
      no,
      header: `${def.nos} · ${def.date.slice(5)} · ${def.categoryLabel} · ${def.grossAmount}`,
      nos: def.nos,
      date: def.date,
      categoryLabel: def.categoryLabel,
      grossAmount: def.grossAmount,
      imageUrl: pageImageUrl(def, def.rotateTop, def.rotateBottom),
      top: placement(topId, def.top, def.rotateTop),
      bottom: def.bottom && bottomId ? placement(bottomId, def.bottom, def.rotateBottom) : null,
      screenshotId: null,
    });
  }
  const sheet: PrintSheet = { status: 'generated', fileName: PRINT_SHEET_FILE_NAME, url: PRINT_SHEET_URL, pages, notices: [] };
  return refreshScreenshots(sheet, snapshot);
}

// 支付截图变化后：每页的截图与「还没有支付截图」提醒随之更新（提醒不阻止下载）。
export function refreshScreenshots(sheet: PrintSheet, snapshot: TaskSnapshot): PrintSheet {
  const notices: string[] = [];
  const pages = sheet.pages.map((page) => {
    if (!page.acceptsPaymentScreenshot || !page.top) return page;
    const voucherMaterialId = page.top.materialId;
    const shot = snapshot.paymentScreenshots.find((candidate) => candidate.voucherMaterialId === voucherMaterialId);
    if (!shot) notices.push(MISSING_SCREENSHOT_NOTICE(page.nos, page.categoryLabel));
    return { ...page, screenshotId: shot?.screenshotId ?? null };
  });
  return { ...sheet, pages, notices };
}

// 旋转：记下新的放置，换成对应的页图。
export function rotatePage(page: PrintPage, slot: PlacementSlot, rotate: boolean): PrintPage {
  const def = defOf(page.pageId);
  const next = structuredClone(page);
  const target = next[slot];
  if (!target) return next;
  target.rotate = rotate;
  if (def) next.imageUrl = pageImageUrl(def, next.top?.rotate ?? def.rotateTop, next.bottom?.rotate ?? def.rotateBottom);
  return next;
}

// 四角裁剪：坐标取整后记下，标记为手动微调。mock 不重新矫正照片，页图保持不变。
export function cropPage(page: PrintPage, slot: PlacementSlot, corners: Corners): PrintPage {
  const next = structuredClone(page);
  const target = next[slot];
  if (!target) return next;
  target.corners = corners.map(([x, y]) => [Math.round(x), Math.round(y)]) as Corners;
  target.cropAdjusted = true;
  return next;
}

// 四角合法：非负、在原图范围内（mock 只知道夹具照片 900x1200），并且左上在右下的左上方。
const PHOTO_SIZE = { width: 900, height: 1200 };
export function cornersValid(corners: Corners): boolean {
  if (corners.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > PHOTO_SIZE.width || y > PHOTO_SIZE.height)) return false;
  const [tl, tr, br, bl] = corners;
  return tl[0] < tr[0] && bl[0] < br[0] && tl[1] < bl[1] && tr[1] < br[1];
}
