import type { Corners, PrintSheet } from '@baox/contract';
import type { Db } from '../db/database';

// The stored print facts of one task (migration 0007_190_print). The snapshot's `printSheet` / `paymentScreenshots`
// are projected from them in `task-snapshot/print.ts`.

export type StoredPlacement = {
  materialId: string;
  fileName: string;
  rotate: boolean;
  croppable: boolean;
  corners: Corners | null;
  cropAdjusted: boolean;
  // The original photo the corners refer to (EXIF orientation applied); null for a PDF.
  original: { sha256: string; width: number; height: number } | null;
  // Pages of a multi-page PDF that were not embedded (only page 1 ever is). Absent means none were left out.
  extraPageCount?: number;
};

export type StoredPage = {
  pageId: string;
  voucherMaterialId: string;
  no: number;
  nos: string;
  header: string;
  date: string;
  categoryLabel: string;
  grossAmount: string;
  pngSha256: string;
  top: StoredPlacement | null;
  bottom: StoredPlacement | null;
  acceptsPaymentScreenshot: boolean;
  screenshotId: string | null;
  // Supporting materials this voucher has beyond the one on the bottom half; named in a notice, never dropped silently.
  droppedFileNames?: string[];
};

export type Render = { renderId: string; confirmationRevision: number; pdfSha256: string; pages: StoredPage[] };
export type PrintSetting = { rotate?: boolean; corners?: Corners };
export type Screenshot = { screenshotId: string; voucherMaterialId: string; fileName: string; sha256: string };

export type PrintFacts = {
  // The latest composed sheet; null before the first generation.
  render: Render | null;
  // Latest rotation / corners per material.
  settings: ReadonlyMap<string, PrintSetting>;
  // The current screenshot per voucher.
  screenshots: readonly Screenshot[];
};

export type SheetState = PrintSheet['status'];

export async function loadPrintFacts(tx: Db, taskId: string): Promise<PrintFacts> {
  const latest = await tx.selectFrom('print_render').selectAll().where('task_id', '=', taskId).orderBy('revision', 'desc').executeTakeFirst();
  const render = latest ? { renderId: latest.render_id, confirmationRevision: latest.confirmation_revision, pdfSha256: latest.pdf_sha256, pages: JSON.parse(latest.pages) as StoredPage[] } : null;
  const settings = new Map<string, PrintSetting>();
  for (const row of await tx.selectFrom('print_setting').selectAll().where('task_id', '=', taskId).orderBy('revision').execute()) {
    const setting: PrintSetting = { ...settings.get(row.material_id) };
    if (row.rotate !== null) setting.rotate = row.rotate === 1;
    if (row.corners !== null) setting.corners = JSON.parse(row.corners) as Corners;
    settings.set(row.material_id, setting);
  }
  // The latest screenshot per voucher is current, unless it was removed (an older one does not come back).
  const current = new Map<string, Screenshot>();
  for (const row of await tx.selectFrom('payment_screenshot').selectAll().where('task_id', '=', taskId).orderBy('revision').execute()) {
    current.set(row.voucher_material_id, { screenshotId: row.screenshot_id, voucherMaterialId: row.voucher_material_id, fileName: row.file_name, sha256: row.blob_sha256 });
  }
  const removed = new Set((await tx.selectFrom('payment_screenshot_removal').select('screenshot_id').where('task_id', '=', taskId).execute()).map((row) => row.screenshot_id));
  return { render, settings, screenshots: [...current.values()].filter((shot) => !removed.has(shot.screenshotId)) };
}

// A sheet belongs to the confirmation it was composed from: it is `generated` only while that confirmation stands.
// Any invalidation (the confirmation status leaves `confirmed`) or a re-confirmation (a newer confirmation row)
// leaves it `stale` until it is generated again. Print actions need no stepToken for this: the binding is a fact.
export function sheetState(facts: PrintFacts, confirmation: 'unconfirmed' | 'confirmed' | 'invalidated', confirmedRevision: number | null): SheetState {
  if (!facts.render) return 'not_generated';
  return confirmation === 'confirmed' && facts.render.confirmationRevision === confirmedRevision ? 'generated' : 'stale';
}

// The blobs a task's print facts refer to (all sheets ever composed, so an already loaded page image keeps working).
export async function printFileShas(tx: Db, taskId: string): Promise<Set<string>> {
  const shas = new Set<string>();
  for (const row of await tx.selectFrom('print_render').select(['pdf_sha256', 'pages']).where('task_id', '=', taskId).execute()) {
    shas.add(row.pdf_sha256);
    for (const page of JSON.parse(row.pages) as StoredPage[]) shas.add(page.pngSha256);
  }
  for (const row of await tx.selectFrom('payment_screenshot').select('blob_sha256').where('task_id', '=', taskId).execute()) shas.add(row.blob_sha256);
  return shas;
}
