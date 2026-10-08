import { screenshotGroupOf, type Corners, type PrintPageKind, type PrintSheet } from '@baox/contract';
import type { Db } from '../db/database';
import type { ScreenshotGroup } from '../stay-trio';

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
  // `voucher`: one primary voucher over its supporting material. `screenshots`: the 支付截图 continuation page that
  // follows a 住宿 voucher page whose group has two or more (#333); it has no placements.
  kind: PrintPageKind;
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
  // The screenshots printed on this page, in upload order.
  screenshotIds: string[];
  // Continuation pages only: the hotel named in the header, if one is known.
  hotelName?: string | null;
  // Supporting materials this voucher has beyond the one on the bottom half; named in a notice, never dropped silently.
  droppedFileNames?: string[];
};

// What every page, of either kind, says of its voucher: stored from the page plan, projected into the snapshot.
export type PageHeading = Pick<StoredPage, 'no' | 'nos' | 'date' | 'categoryLabel' | 'grossAmount'>;
export const headingOf = ({ no, nos, date, categoryLabel, grossAmount }: PageHeading): PageHeading => ({ no, nos, date, categoryLabel, grossAmount });

// A page as stored in `print_render.pages`. A render composed before #333 has neither `kind` (every page was a voucher
// page) nor `screenshotIds`, but one nullable `screenshotId`.
type StoredPageJson = Omit<StoredPage, 'kind' | 'screenshotIds'> & { kind?: StoredPage['kind']; screenshotIds?: string[]; screenshotId?: string | null };

function pageOf(json: StoredPageJson): StoredPage {
  const { screenshotId, ...page } = json;
  return { ...page, kind: json.kind ?? 'voucher', screenshotIds: json.screenshotIds ?? (screenshotId ? [screenshotId] : []) };
}

export type Render = { renderId: string; confirmationRevision: number; pdfSha256: string; pages: StoredPage[] };
export type PrintSetting = { rotate?: boolean; corners?: Corners };
export type Screenshot = { screenshotId: string; voucherMaterialId: string; fileName: string; sha256: string };

export type PrintFacts = {
  // The latest composed sheet; null before the first generation.
  render: Render | null;
  // Latest rotation / corners per material.
  settings: ReadonlyMap<string, PrintSetting>;
  // Every current screenshot in the `payment_screenshot` table, in upload order; a voucher's group is its entries here
  // (#331). Only these can be removed or declared complete.
  screenshots: readonly Screenshot[];
  // The 支付截图 materials inventory placed with a 住宿 invoice (ADR-0032), in upload order; `screenshotId` is the
  // material's id. They print after the invoice's table group.
  placed: readonly Screenshot[];
  // The vouchers whose group the filer declared complete (「已传齐」) and that is not empty.
  completeGroups: ReadonlySet<string>;
};

export type SheetState = PrintSheet['status'];

export async function loadPrintFacts(tx: Db, taskId: string): Promise<PrintFacts> {
  const latest = await tx.selectFrom('print_render').selectAll().where('task_id', '=', taskId).orderBy('revision', 'desc').executeTakeFirst();
  const render = latest ? { renderId: latest.render_id, confirmationRevision: latest.confirmation_revision, pdfSha256: latest.pdf_sha256, pages: (JSON.parse(latest.pages) as StoredPageJson[]).map(pageOf) } : null;
  const settings = new Map<string, PrintSetting>();
  for (const row of await tx.selectFrom('print_setting').selectAll().where('task_id', '=', taskId).orderBy('revision').execute()) {
    const setting: PrintSetting = { ...settings.get(row.material_id) };
    if (row.rotate !== null) setting.rotate = row.rotate === 1;
    if (row.corners !== null) setting.corners = JSON.parse(row.corners) as Corners;
    settings.set(row.material_id, setting);
  }
  return { render, settings, placed: [], ...(await screenshotGroups(tx, taskId)) };
}

// Every screenshot the sheet prints: each invoice's table group, then the materials placed with it.
export const printedScreenshots = (facts: Pick<PrintFacts, 'screenshots' | 'placed'>): Screenshot[] => [...facts.screenshots, ...facts.placed];

// A voucher's 支付截图 group (#331), replayed in revision order: an upload joins the group, a removal leaves it, and a
// declaration (「已传齐」) marks it complete. An emptied group is no longer complete: it needs a new declaration once
// something is in it again. Within one revision (only ever the 0020_331 backfill) uploads come first, then removals,
// then declarations.
async function screenshotGroups(tx: Db, taskId: string): Promise<Pick<PrintFacts, 'screenshots' | 'completeGroups'>> {
  type Event = { revision: number; order: number; apply: () => void };
  const current = new Map<string, Screenshot>();
  const complete = new Set<string>();
  const events: Event[] = [];
  for (const row of await tx.selectFrom('payment_screenshot').selectAll().where('task_id', '=', taskId).execute()) {
    const shot: Screenshot = { screenshotId: row.screenshot_id, voucherMaterialId: row.voucher_material_id, fileName: row.file_name, sha256: row.blob_sha256 };
    events.push({ revision: row.revision, order: 0, apply: () => current.set(shot.screenshotId, shot) });
  }
  for (const row of await tx.selectFrom('payment_screenshot_removal').select(['screenshot_id', 'revision']).where('task_id', '=', taskId).execute()) {
    events.push({
      revision: row.revision,
      order: 1,
      apply: () => {
        const shot = current.get(row.screenshot_id);
        if (!shot) return;
        current.delete(row.screenshot_id);
        if (![...current.values()].some((other) => other.voucherMaterialId === shot.voucherMaterialId)) complete.delete(shot.voucherMaterialId);
      },
    });
  }
  for (const row of await tx.selectFrom('payment_screenshot_group_complete').select(['voucher_material_id', 'revision']).where('task_id', '=', taskId).execute()) {
    events.push({
      revision: row.revision,
      order: 2,
      apply: () => {
        if ([...current.values()].some((shot) => shot.voucherMaterialId === row.voucher_material_id)) complete.add(row.voucher_material_id);
      },
    });
  }
  events.sort((a, b) => a.revision - b.revision || a.order - b.order);
  for (const event of events) event.apply();
  // A Map iterates in insertion order, which the replay made upload order.
  return { screenshots: [...current.values()], completeGroups: complete };
}

// Only the groups of `invoiceIds`, the 住宿 invoices that take 支付截图 (their trio has a screenshot part). Before #330
// the print page took a screenshot for any voucher; one left on another voucher belongs to no group: the filer can no
// longer change it (`screenshot_not_applicable`), so it is neither printed nor in the snapshot.
export function stayGroupsOnly(facts: PrintFacts, invoiceIds: ReadonlySet<string>): PrintFacts {
  const keep = (voucherMaterialId: string) => invoiceIds.has(voucherMaterialId);
  return { ...facts, screenshots: facts.screenshots.filter((shot) => keep(shot.voucherMaterialId)), completeGroups: new Set([...facts.completeGroups].filter(keep)) };
}

// A group takes no change (add, remove, 「已传齐」) once the list is confirmed or ERP was attempted: a change can reopen
// the screenshot item, which would pull a confirmed list back into inventory.
export const screenshotsLocked = (confirmation: 'unconfirmed' | 'confirmed' | 'invalidated', erpAttempted: boolean): boolean => confirmation === 'confirmed' || erpAttempted;

// Per voucher, what the 住宿 trio check reads of its group.
export function screenshotGroupsOf(facts: Pick<PrintFacts, 'screenshots' | 'completeGroups'>): Map<string, ScreenshotGroup> {
  const groups = new Map<string, ScreenshotGroup>();
  for (const shot of facts.screenshots) groups.set(shot.voucherMaterialId, { count: (groups.get(shot.voucherMaterialId)?.count ?? 0) + 1, complete: facts.completeGroups.has(shot.voucherMaterialId) });
  return groups;
}

// A sheet belongs to the confirmation it was composed from: it is `generated` only while that confirmation stands.
// Any invalidation (the confirmation status leaves `confirmed`) or a re-confirmation (a newer confirmation row)
// leaves it `stale` until it is generated again. Print actions need no stepToken for this: the binding is a fact.
//
// It must also print every voucher's current 支付截图 group. Groups are locked while the confirmation stands, but a
// reverted change revives the confirmation it had invalidated, and with it the sheet composed then: a group changed
// in between would leave that sheet printing screenshots the task no longer has (or missing new ones).
export function sheetState(facts: PrintFacts, confirmation: 'unconfirmed' | 'confirmed' | 'invalidated', confirmedRevision: number | null): SheetState {
  if (!facts.render) return 'not_generated';
  if (confirmation !== 'confirmed' || facts.render.confirmationRevision !== confirmedRevision) return 'stale';
  return printsCurrentGroups(facts.render, printedScreenshots(facts)) ? 'generated' : 'stale';
}

function printsCurrentGroups(render: Render, screenshots: readonly Screenshot[]): boolean {
  const printed = render.pages.flatMap((page) => page.screenshotIds);
  const vouchers = [...new Set(render.pages.map((page) => page.voucherMaterialId))];
  const current = vouchers.flatMap((voucher) => screenshotGroupOf(screenshots, voucher).map((shot) => shot.screenshotId));
  return printed.length === current.length && printed.every((id, index) => id === current[index]);
}

// The blobs a task's print facts refer to (all sheets ever composed, so an already loaded page image keeps working).
export async function printFileShas(tx: Db, taskId: string): Promise<Set<string>> {
  const shas = new Set<string>();
  for (const row of await tx.selectFrom('print_render').select(['pdf_sha256', 'pages']).where('task_id', '=', taskId).execute()) {
    shas.add(row.pdf_sha256);
    for (const page of JSON.parse(row.pages) as StoredPageJson[]) shas.add(page.pngSha256);
  }
  for (const row of await tx.selectFrom('payment_screenshot').select('blob_sha256').where('task_id', '=', taskId).execute()) shas.add(row.blob_sha256);
  return shas;
}
