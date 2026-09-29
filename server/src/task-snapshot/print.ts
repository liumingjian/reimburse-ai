import { STAY_TRIO_COPY, type PaymentScreenshot, type Placement, type PrintSheet } from '@baox/contract';
import { CATEGORIES } from '../kind-policy';
import type { PrintFacts, SheetState, StoredPage, StoredPlacement } from '../print/facts';
import { droppedMaterialsNotice, extraPagesNotice, unrecordedScreenshotNotice } from '../print/layout';
import type { StayTrio } from '../stay-trio';

// The snapshot's `printSheet` and `paymentScreenshots` (去打印, #190), projected from the task's stored print facts
// (`print/facts.ts`).

// Every file the task's print facts refer to; `GET /api/tasks/:id/files/:sha256` serves only a task's own files.
export const fileUrl = (taskId: string, sha256: string): string => `/api/tasks/${taskId}/files/${sha256}`;

// `trios`: the inventory's 住宿 trios. Where a page's invoice has one, its record decides the missing-screenshot notice
// (a confirmed absence), so print and inventory read one fact instead of judging the absence twice (#213). A 住宿 page
// with no record still gets a notice rather than silence.
export function printView(taskId: string, taskName: string, facts: PrintFacts, state: SheetState, trios: readonly StayTrio[] = []): { printSheet: PrintSheet; paymentScreenshots: PaymentScreenshot[] } {
  const paymentScreenshots = facts.screenshots.map((shot) => ({ screenshotId: shot.screenshotId, voucherMaterialId: shot.voucherMaterialId, fileName: shot.fileName, url: fileUrl(taskId, shot.sha256) }));
  const render = facts.render;
  const recorded = new Map(trios.flatMap((trio) => (trio.invoiceId ? [[trio.invoiceId, trio] as const] : [])));
  const screenshotNotice = (page: StoredPage): string[] => {
    if (page.screenshotId !== null) return [];
    const trio = recorded.get(page.voucherMaterialId);
    if (trio) return trio.screenshot?.noneConfirmed ? [STAY_TRIO_COPY.printNotice(page.nos, page.categoryLabel)] : [];
    return page.categoryLabel === CATEGORIES.accommodation.label ? [unrecordedScreenshotNotice(page.nos, page.categoryLabel)] : [];
  };
  if (state !== 'generated' || !render) return { paymentScreenshots, printSheet: { status: state, fileName: null, url: null, pages: [], notices: [] } };
  const placement = (stored: StoredPlacement | null): Placement | null =>
    stored && {
      materialId: stored.materialId,
      fileName: stored.fileName,
      rotate: stored.rotate,
      croppable: stored.croppable,
      corners: stored.corners,
      cropAdjusted: stored.cropAdjusted,
      imageUrl: stored.original ? fileUrl(taskId, stored.original.sha256) : null,
    };
  return {
    paymentScreenshots,
    printSheet: {
      status: 'generated',
      fileName: `打印稿_${taskName}.pdf`,
      url: fileUrl(taskId, render.pdfSha256),
      pages: render.pages.map((page) => ({
        pageId: page.pageId,
        no: page.no,
        header: page.header,
        nos: page.nos,
        date: page.date,
        categoryLabel: page.categoryLabel,
        grossAmount: page.grossAmount,
        imageUrl: fileUrl(taskId, page.pngSha256),
        top: placement(page.top),
        bottom: placement(page.bottom),
        acceptsPaymentScreenshot: page.acceptsPaymentScreenshot,
        screenshotId: page.screenshotId,
      })),
      // Everything the sheet could not carry is said out loud: a missing payment screenshot, the pages of a multi-page
      // original that were not embedded, and the supporting materials a one-per-page bottom half had no room for.
      notices: [
        ...render.pages.flatMap(screenshotNotice),
        ...render.pages.flatMap((page) =>
          [page.top, page.bottom].flatMap((placement) => (placement?.extraPageCount ? [extraPagesNotice(page.nos, placement.fileName, placement.extraPageCount + 1)] : [])),
        ),
        ...render.pages.flatMap((page) => (page.droppedFileNames && page.droppedFileNames.length > 0 ? [droppedMaterialsNotice(page.nos, page.droppedFileNames)] : [])),
      ],
    },
  };
}
