import {
  PENDING_CHOICE_KEY,
  PAYMENT_SCREENSHOT_ERRORS,
  PRINT_ACTION_ERRORS,
  STAY_TRIO_COPY,
  fieldAnswer,
  screenshotGroupOf,
  stayTrioItemId,
  type ActionError,
  type ActionOutcome,
  type AppAdapter,
  type PlacementSlot,
  type PrintPage,
  type TaskSnapshot,
} from '@baox/contract';
import type { MockBus } from '../bus';
import { buildPrintSheet, cornersValid, cropPage, rotatePage } from '../fixtures/print';
import { settlePending } from './pending';

// 支付截图与打印稿（生成、旋转、四角裁剪）。这些动作都不带 stepToken，也不碰整单明细确认；支付截图的「已传齐」、删空，以及
// 「确认没有支付截图」之后的上传会改变缺支付截图待确认项的状态，随之改变 step（同服务端）。

export type PrintFlow = Pick<AppAdapter, 'addPaymentScreenshots' | 'removePaymentScreenshot' | 'completePaymentScreenshots' | 'generatePrintSheet' | 'rotatePlacement' | 'cropPlacement'>;

// 图片判定按扩展名，其次按 MIME（无扩展名时）。
function isImage(file: File): boolean {
  const match = /\.([a-z0-9]+)$/i.exec(file.name);
  if (match) return /^(jpe?g|png)$/i.test(match[1] ?? '');
  return /^image\/(jpeg|png)$/.test(file.type);
}

// 浏览器里给截图一个可显示的对象 URL；jsdom 没有 createObjectURL，用占位地址。
// 占位地址也得是同源路径：契约只收同源地址（伪协议会直接进 img src），`mock:` 这样的自造协议过不了。
function objectUrl(file: File, screenshotId: string): string {
  if (typeof URL.createObjectURL === 'function') return URL.createObjectURL(file);
  return `mock/screenshot/${screenshotId}`;
}

export function createPrintFlow(bus: MockBus): PrintFlow {
  let nextScreenshotNo = 1;

  const screenshotItemOf = (snapshot: TaskSnapshot, invoiceId: string) => snapshot.pendingItems.find((candidate) => candidate.itemId === stayTrioItemId('screenshot', invoiceId));
  // 支付截图组（#331，同服务端 print/service.ts）：只有住宿发票（列出了它的缺支付截图待确认项）收支付截图；组锁定时
  // （screenshotGroup.locked，见 fixtures/print.ts withScreenshotGroups）增、删、「已传齐」都拒绝。打印稿只在确认后存在，
  // 所以截图变化从不重排已生成的打印稿。
  const refusal = (snapshot: TaskSnapshot, voucherMaterialId: string): ActionOutcome | null => {
    const item = screenshotItemOf(snapshot, voucherMaterialId);
    // An excluded invoice leaves the 住宿 trio, as on the server.
    if (!item?.screenshotGroup || fieldAnswer(item.answer)[PENDING_CHOICE_KEY] === 'exclude') return bus.fail('screenshot_not_applicable', PAYMENT_SCREENSHOT_ERRORS.notApplicable);
    if (item.screenshotGroup.locked) return bus.fail('screenshot_locked', STAY_TRIO_COPY.changeLocked);
    return null;
  };
  const groupOf = (snapshot: TaskSnapshot, voucherMaterialId: string) => screenshotGroupOf(snapshot.paymentScreenshots, voucherMaterialId);
  // The invoice's screenshot item goes back to pending, its answer dropped (#332).
  const reopen = (snapshot: TaskSnapshot, taskId: string, invoiceId: string) => {
    const item = screenshotItemOf(snapshot, invoiceId);
    if (!item) return;
    item.status = 'open';
    item.answer = null;
    const invoice = snapshot.materials.find((material) => material.materialId === invoiceId);
    if (invoice) invoice.status = 'pending';
    settlePending(snapshot, bus.projectAllowList(taskId));
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
    // 支付截图 from the item (ADR-0032): the server adds them as a batch placed with this invoice and inventories again.
    // The mock has no parser, so it lists them as screenshots placed with the invoice that cover it, and settles the
    // item at once.
    async addPaymentScreenshots(taskId, voucherMaterialId, files) {
      const snapshot = bus.draft(taskId);
      const refused = refusal(snapshot, voucherMaterialId);
      if (refused) return refused;
      if (files.some((file) => !isImage(file))) return bus.fail('not_image', PAYMENT_SCREENSHOT_ERRORS.notImage);
      const invoice = snapshot.materials.find((material) => material.materialId === voucherMaterialId);
      if (!invoice) return bus.fail('screenshot_not_applicable', PAYMENT_SCREENSHOT_ERRORS.notApplicable);
      for (const file of files) {
        const materialId = `s${nextScreenshotNo}`;
        nextScreenshotNo += 1;
        snapshot.materials.push({
          ...invoice,
          materialId,
          fileName: file.name,
          relativePath: file.name,
          contentHash: `mock-${materialId}`,
          kind: 'payment_screenshot',
          layout: 'labelled',
          kindLabel: '支付截图',
          role: 'reference',
          shape: 'photo',
          mediaType: 'image',
          status: 'ok',
          checkText: '',
          linkedMaterialIds: [voucherMaterialId],
          pendingItemIds: [],
          originalUrl: objectUrl(file, materialId),
          previewUrl: null,
          variants: [],
          fields: [],
          payment: { invoiceId: voucherMaterialId, chosen: true, options: [] },
        });
        invoice.linkedMaterialIds = [...invoice.linkedMaterialIds, materialId];
        // As on the server, the snapshot's 支付截图 list also carries the placed materials: they print.
        snapshot.paymentScreenshots.push({ screenshotId: materialId, voucherMaterialId, fileName: file.name, url: objectUrl(file, materialId) });
      }
      const item = screenshotItemOf(snapshot, voucherMaterialId);
      if (item?.status === 'open') {
        item.status = 'resolved';
        item.answer = null;
        settlePending(snapshot, bus.projectAllowList(taskId));
      }
      snapshot.task.updatedAt = bus.now();
      return bus.commit(snapshot);
    },
    // Removing one keeps the rest in order. An emptied group is no longer complete, so an item settled on it opens again.
    async removePaymentScreenshot(taskId, screenshotId) {
      const snapshot = bus.draft(taskId);
      const removing = snapshot.paymentScreenshots.find((shot) => shot.screenshotId === screenshotId);
      if (!removing) return bus.fail('screenshot_not_found', PAYMENT_SCREENSHOT_ERRORS.notFound);
      const refused = refusal(snapshot, removing.voucherMaterialId);
      if (refused) return refused;
      snapshot.paymentScreenshots = snapshot.paymentScreenshots.filter((shot) => shot.screenshotId !== screenshotId);
      const invoiceId = removing.voucherMaterialId;
      if (groupOf(snapshot, invoiceId).length === 0 && bus.completeScreenshotGroups(taskId).delete(invoiceId)) {
        const item = screenshotItemOf(snapshot, invoiceId);
        if (item?.status === 'resolved' && item.answer === null) reopen(snapshot, taskId, invoiceId);
      }
      snapshot.task.updatedAt = bus.now();
      return bus.commit(snapshot);
    },
    // 「已传齐」: the group is complete and the item settles on it (idempotent); an empty group cannot be complete.
    async completePaymentScreenshots(taskId, voucherMaterialId) {
      const snapshot = bus.draft(taskId);
      const refused = refusal(snapshot, voucherMaterialId);
      if (refused) return refused;
      if (groupOf(snapshot, voucherMaterialId).length === 0) return bus.fail('screenshot_group_empty', PAYMENT_SCREENSHOT_ERRORS.empty);
      bus.completeScreenshotGroups(taskId).add(voucherMaterialId);
      const item = screenshotItemOf(snapshot, voucherMaterialId);
      if (item?.status === 'open') {
        item.status = 'resolved';
        const invoice = snapshot.materials.find((material) => material.materialId === voucherMaterialId);
        if (invoice && !snapshot.pendingItems.some((other) => other.materialId === voucherMaterialId && other.status === 'open')) invoice.status = 'ok';
        settlePending(snapshot, bus.projectAllowList(taskId));
      }
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
