import { PRINT_ACTION_ERRORS, type ActionError, type PlacementSlot, type ActionOutcome, type AppAdapter, PAYMENT_SCREENSHOT_ERRORS, type PrintPage, type TaskSnapshot } from '@baox/contract';
import type { MockBus } from '../bus';
import { buildPrintSheet, cornersValid, cropPage, refreshScreenshots, rotatePage } from '../fixtures/print';

// 支付截图与打印稿（生成、旋转、四角裁剪）。这些动作都不碰整单明细确认与 step，也不带 stepToken。

export type PrintFlow = Pick<AppAdapter, 'addPaymentScreenshot' | 'removePaymentScreenshot' | 'generatePrintSheet' | 'rotatePlacement' | 'cropPlacement'>;

// 图片判定按扩展名，其次按 MIME（无扩展名时）。
function isImage(file: File): boolean {
  const match = /\.([a-z0-9]+)$/i.exec(file.name);
  if (match) return /^(jpe?g|png)$/i.test(match[1] ?? '');
  return /^image\/(jpeg|png)$/.test(file.type);
}

// 浏览器里给截图一个可显示的对象 URL；jsdom 没有 createObjectURL，用占位地址。
function objectUrl(file: File, screenshotId: string): string {
  if (typeof URL.createObjectURL === 'function') return URL.createObjectURL(file);
  return `mock:screenshot/${screenshotId}`;
}

export function createPrintFlow(bus: MockBus): PrintFlow {
  let nextScreenshotNo = 1;

  // 支付截图变了：已生成的打印稿随之更新该页截图与提醒（不作废、不碰确认）。
  const afterScreenshotChange = (snapshot: TaskSnapshot) => {
    if (snapshot.printSheet.status === 'generated') snapshot.printSheet = refreshScreenshots(snapshot.printSheet, snapshot);
  };

  // 打印稿的旋转与裁剪：只改这一页的放置（服务端立即重新渲染该页），不改原件、不碰确认状态与 step。
  const adjustPage = (taskId: string, pageId: string, slot: PlacementSlot, change: (page: PrintPage) => PrintPage | { error: ActionError }): ActionOutcome => {
    const snapshot = bus.draft(taskId);
    if (snapshot.printSheet.status !== 'generated') return bus.fail('print_not_generated', PRINT_ACTION_ERRORS.notGenerated);
    const index = snapshot.printSheet.pages.findIndex((page) => page.pageId === pageId);
    const page = snapshot.printSheet.pages[index];
    if (!page) return bus.fail('page_not_found', PRINT_ACTION_ERRORS.pageNotFound);
    if (!page[slot]) return bus.fail('slot_empty', PRINT_ACTION_ERRORS.slotEmpty);
    const result = change(page);
    if ('error' in result) return { ok: false, error: result.error, snapshot: null };
    snapshot.printSheet.pages[index] = result;
    snapshot.task.updatedAt = bus.now();
    return bus.commit(snapshot);
  };

  return {
    // 支付截图：只在已生成的打印稿上补充（入口在打印稿页）；只接受图片；每张住宿发票至多一张，再补即替换。
    // 只进 paymentScreenshots 与打印稿，不碰确认状态与 step。
    async addPaymentScreenshot(taskId, voucherMaterialId, file) {
      const snapshot = bus.draft(taskId);
      if (snapshot.printSheet.status !== 'generated') return bus.fail('print_not_generated', PAYMENT_SCREENSHOT_ERRORS.notGenerated);
      const page = snapshot.printSheet.pages.find((candidate) => candidate.top?.materialId === voucherMaterialId);
      if (!page || !page.acceptsPaymentScreenshot) return bus.fail('screenshot_not_applicable', PAYMENT_SCREENSHOT_ERRORS.notApplicable);
      if (!isImage(file)) return bus.fail('not_image', PAYMENT_SCREENSHOT_ERRORS.notImage);
      const screenshotId = `s${nextScreenshotNo}`;
      nextScreenshotNo += 1;
      snapshot.paymentScreenshots = snapshot.paymentScreenshots.filter((shot) => shot.voucherMaterialId !== voucherMaterialId);
      snapshot.paymentScreenshots.push({ screenshotId, voucherMaterialId, fileName: file.name, url: objectUrl(file, screenshotId) });
      afterScreenshotChange(snapshot);
      snapshot.task.updatedAt = bus.now();
      return bus.commit(snapshot);
    },
    async removePaymentScreenshot(taskId, screenshotId) {
      const snapshot = bus.draft(taskId);
      if (!snapshot.paymentScreenshots.some((shot) => shot.screenshotId === screenshotId)) {
        return bus.fail('screenshot_not_found', PAYMENT_SCREENSHOT_ERRORS.notFound);
      }
      snapshot.paymentScreenshots = snapshot.paymentScreenshots.filter((shot) => shot.screenshotId !== screenshotId);
      afterScreenshotChange(snapshot);
      snapshot.task.updatedAt = bus.now();
      return bus.commit(snapshot);
    },
    // 生成打印稿：须已完成整单明细确认；已生成的直接返回（幂等），作废的按当前确认数据重新生成。
    async generatePrintSheet(taskId) {
      const snapshot = bus.draft(taskId);
      if (snapshot.confirmation.status !== 'confirmed') return bus.fail('not_confirmed', PRINT_ACTION_ERRORS.notConfirmed);
      if (snapshot.printSheet.status === 'generated') return { ok: true, snapshot };
      snapshot.printSheet = buildPrintSheet(snapshot);
      snapshot.task.updatedAt = bus.now();
      return bus.commit(snapshot);
    },
    rotatePlacement: async (taskId, pageId, slot, rotate) => adjustPage(taskId, pageId, slot, (page) => rotatePage(page, slot, rotate)),
    cropPlacement: async (taskId, pageId, slot, corners) =>
      adjustPage(taskId, pageId, slot, (page) => {
        if (!page[slot]?.croppable) return { error: { code: 'not_croppable', message: PRINT_ACTION_ERRORS.notCroppable } };
        if (!cornersValid(corners)) return { error: { code: 'invalid_corners', message: PRINT_ACTION_ERRORS.invalidCorners } };
        return cropPage(page, slot, corners);
      }),
  };
}
