import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PAYMENT_SCREENSHOT_ERRORS, PRINT_ACTION_ERRORS, STAY_TRIO_COPY, type Corners, type Line, type Material, type PlacementSlot } from '@baox/contract';
import { blobPath, writeBlob } from '../data-dir';
import type { Db } from '../db/database';
import { paperCorners, type PaperCorners } from './straighten';
import { composeSheet, isJpegOrPng, pdfContent, photoContent, renderPages, screenshotContent, type Content, type Drawn } from './compose';
import { sheetState, type PrintFacts, type PrintSetting, type Screenshot, type StoredPage, type StoredPlacement } from './facts';
import { storedMime } from '../upload-rules';
import { planPages, prefersRotation, REGIONS, type Region } from './layout';
import type { StayTrio } from '../stay-trio';

// 去打印 (print) actions. Each reads the task, composes outside any transaction, and hands back a commit that
// `tasks.ts` runs through `mutate` at the revision it read, so a change in between is a 409 stale_step.

export type PrintSource = { sha256: string; mediaType: 'pdf' | 'image'; fileName: string };

export type PrintState = {
  taskId: string;
  accountId: string;
  dataDir: string;
  confirmation: 'unconfirmed' | 'confirmed' | 'invalidated';
  // Revision of the standing confirmation row; null when there is none.
  confirmedRevision: number | null;
  // The confirmed lines (while `confirmation` is `confirmed`) and the inventory's materials.
  lines: readonly Line[];
  materials: readonly Material[];
  // Included materials by id.
  sources: ReadonlyMap<string, PrintSource>;
  facts: PrintFacts;
  // The inventory's 住宿 trios (#213): which invoices take a screenshot, and which recorded a confirmed absence.
  trios: readonly StayTrio[];
  // Whether the task made an ERP action attempt (its facts are frozen).
  erpAttempted: boolean;
};

export type PrintCommit = (tx: Db, at: string, revision: number) => Promise<void>;

export class PrintRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Composed = { pdfSha256: string; pages: StoredPage[]; files: { sha256: string; size: number; mime: string }[] };

const IMAGE_NAME = /\.(jpe?g|png)$/i;

export async function generate(state: PrintState): Promise<PrintCommit | null> {
  if (state.confirmation !== 'confirmed') throw new PrintRefusal('not_confirmed', PRINT_ACTION_ERRORS.notConfirmed);
  // Idempotent: a sheet of the standing confirmation is returned as is.
  if (stateOf(state) === 'generated') return null;
  const composed = await compose(state, state.facts.settings, state.facts.screenshots);
  return renderCommit(state, composed);
}

export async function rotate(state: PrintState, pageId: string, slot: PlacementSlot, turned: boolean): Promise<PrintCommit> {
  const placement = placementOf(state, pageId, slot);
  const settings = withSetting(state.facts.settings, placement.materialId, { rotate: turned });
  const composed = await compose(state, settings, state.facts.screenshots);
  return async (tx, at, revision) => {
    await tx.insertInto('print_setting').values({ setting_id: randomUUID(), task_id: state.taskId, account_id: state.accountId, material_id: placement.materialId, rotate: turned ? 1 : 0, corners: null, revision, created_at: at }).execute();
    await renderCommit(state, composed)(tx, at, revision);
  };
}

export async function crop(state: PrintState, pageId: string, slot: PlacementSlot, corners: Corners): Promise<PrintCommit> {
  const placement = placementOf(state, pageId, slot);
  if (!placement.croppable || !placement.original) throw new PrintRefusal('not_croppable', PRINT_ACTION_ERRORS.notCroppable);
  const rounded = corners.map(([x, y]) => [Math.round(x), Math.round(y)]) as Corners;
  if (!cornersValid(rounded, placement.original)) throw new PrintRefusal('invalid_corners', PRINT_ACTION_ERRORS.invalidCorners);
  const settings = withSetting(state.facts.settings, placement.materialId, { corners: rounded });
  const composed = await compose(state, settings, state.facts.screenshots);
  return async (tx, at, revision) => {
    await tx.insertInto('print_setting').values({ setting_id: randomUUID(), task_id: state.taskId, account_id: state.accountId, material_id: placement.materialId, rotate: null, corners: JSON.stringify(rounded), revision, created_at: at }).execute();
    await renderCommit(state, composed)(tx, at, revision);
  };
}

// 补充支付截图 (#213); a second one replaces the first. Only a 住宿 invoice takes one, from its missing-screenshot
// 待确认项, whether or not a sheet exists: the invoice has a trio screenshot part exactly when the check asks for one
// (open or resolved). Any other voucher is refused. A generated sheet is recomposed; without one only the fact is
// stored, and the sheet picks it up when it is generated.
export async function addScreenshot(state: PrintState, voucherMaterialId: string, file: { fileName: string; mime: string; bytes: Uint8Array }): Promise<PrintCommit> {
  if (!state.trios.some((trio) => trio.invoiceId === voucherMaterialId && trio.screenshot)) throw new PrintRefusal('screenshot_not_applicable', PAYMENT_SCREENSHOT_ERRORS.notApplicable);
  const named = IMAGE_NAME.test(file.fileName) || (!/\.[a-z0-9]+$/i.test(file.fileName) && /^image\/(jpeg|png)$/.test(file.mime));
  if (!named || !(await isJpegOrPng(file.bytes))) throw new PrintRefusal('not_image', PAYMENT_SCREENSHOT_ERRORS.notImage);
  const sha256 = writeBlob(state.dataDir, file.bytes);
  const shot: Screenshot = { screenshotId: randomUUID(), voucherMaterialId, fileName: file.fileName, sha256 };
  const screenshots = [...state.facts.screenshots.filter((s) => s.voucherMaterialId !== voucherMaterialId), shot];
  const composed = stateOf(state) === 'generated' ? await compose(state, state.facts.settings, screenshots) : null;
  return async (tx, at, revision) => {
    await tx.insertInto('blob').values({ sha256, size: file.bytes.byteLength, mime: storedMime(file.fileName, file.mime), created_at: at }).onConflict((oc) => oc.column('sha256').doNothing()).execute();
    await tx.insertInto('payment_screenshot').values({ screenshot_id: shot.screenshotId, task_id: state.taskId, account_id: state.accountId, voucher_material_id: voucherMaterialId, blob_sha256: sha256, file_name: file.fileName, revision, created_at: at }).execute();
    if (composed) await renderCommit(state, composed)(tx, at, revision);
  };
}

// Removing a 住宿 invoice's screenshot reopens its missing-screenshot item unless an absence was confirmed. Before the
// list is confirmed that is just the check asking again; after it (or once ERP was touched) it would pull a confirmed
// list back into inventory, so it is refused then and the screenshot can only be replaced.
export async function removeScreenshot(state: PrintState, screenshotId: string): Promise<PrintCommit> {
  const removing = state.facts.screenshots.find((shot) => shot.screenshotId === screenshotId);
  if (!removing) throw new PrintRefusal('screenshot_not_found', PAYMENT_SCREENSHOT_ERRORS.notFound);
  const trio = state.trios.find((candidate) => candidate.invoiceId === removing.voucherMaterialId);
  if (trio?.screenshot && !trio.screenshot.noneConfirmed && (state.confirmation === 'confirmed' || state.erpAttempted)) throw new PrintRefusal('screenshot_required', STAY_TRIO_COPY.removeLocked);
  const screenshots = state.facts.screenshots.filter((shot) => shot.screenshotId !== screenshotId);
  const composed = stateOf(state) === 'generated' ? await compose(state, state.facts.settings, screenshots) : null;
  return async (tx, at, revision) => {
    await tx.insertInto('payment_screenshot_removal').values({ removal_id: randomUUID(), screenshot_id: screenshotId, task_id: state.taskId, account_id: state.accountId, revision, created_at: at }).execute();
    if (composed) await renderCommit(state, composed)(tx, at, revision);
  };
}

const stateOf = (state: PrintState) => sheetState(state.facts, state.confirmation, state.confirmedRevision);

function placementOf(state: PrintState, pageId: string, slot: PlacementSlot): StoredPlacement {
  if (stateOf(state) !== 'generated') throw new PrintRefusal('print_not_generated', PRINT_ACTION_ERRORS.notGenerated);
  const page = state.facts.render?.pages.find((candidate) => candidate.pageId === pageId);
  if (!page) throw new PrintRefusal('page_not_found', PRINT_ACTION_ERRORS.pageNotFound);
  const placement = page[slot];
  if (!placement) throw new PrintRefusal('slot_empty', PRINT_ACTION_ERRORS.slotEmpty);
  return placement;
}

function withSetting(settings: ReadonlyMap<string, PrintSetting>, materialId: string, change: PrintSetting): Map<string, PrintSetting> {
  const next = new Map(settings);
  next.set(materialId, { ...settings.get(materialId), ...change });
  return next;
}

// The smallest crop worth warping, as a fraction of the original's area: below this the quad is a slip of the finger,
// not a crop, and straightening it yields an unreadable sliver.
const MIN_CROP_AREA = 0.01;

// Inside the original image, in the order top-left, top-right, bottom-right, bottom-left, and a real quadrilateral:
// ordering alone accepts degenerate and self-intersecting quads (a bow tie passes every pairwise comparison).
// Convex, wound consistently, and covering at least a hundredth of the page is what 透视矫正 can actually use.
function cornersValid(corners: Corners, size: { width: number; height: number }): boolean {
  if (corners.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > size.width || y > size.height)) return false;
  const [tl, tr, br, bl] = corners;
  if (!(tl[0] < tr[0] && bl[0] < br[0] && tl[1] < bl[1] && tr[1] < br[1])) return false;
  // Cross product of each pair of adjacent edges: all the same sign means convex and never self-intersecting.
  const cross = corners.map(([x, y], index) => {
    const [nx, ny] = corners[(index + 1) % 4]!;
    const [fx, fy] = corners[(index + 2) % 4]!;
    return (nx - x) * (fy - ny) - (ny - y) * (fx - nx);
  });
  if (!(cross.every((value) => value > 0) || cross.every((value) => value < 0))) return false;
  // Shoelace area of the quad against the original.
  const area = Math.abs(corners.reduce((sum, [x, y], index) => {
    const [nx, ny] = corners[(index + 1) % 4]!;
    return sum + (x * ny - nx * y);
  }, 0)) / 2;
  return area >= size.width * size.height * MIN_CROP_AREA;
}

function renderCommit(state: PrintState, composed: Composed): PrintCommit {
  return async (tx, at, revision) => {
    for (const file of composed.files) await tx.insertInto('blob').values({ sha256: file.sha256, size: file.size, mime: file.mime, created_at: at }).onConflict((oc) => oc.column('sha256').doNothing()).execute();
    await tx
      .insertInto('print_render')
      .values({ render_id: randomUUID(), task_id: state.taskId, account_id: state.accountId, confirmation_revision: state.confirmedRevision ?? 0, pdf_sha256: composed.pdfSha256, pages: JSON.stringify(composed.pages), revision, created_at: at })
      .execute();
  };
}

// The bytes of a stored original, re-hashed: what is on disk must still be what was uploaded.
function verified(state: PrintState, sha256: string, fileName: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(blobPath(state.dataDir, sha256)));
  } catch {
    throw new PrintRefusal('blob_mismatch', `${PRINT_ACTION_ERRORS.blobMismatch}（${fileName}）`);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new PrintRefusal('blob_mismatch', `${PRINT_ACTION_ERRORS.blobMismatch}（${fileName}）`);
  return bytes;
}

async function compose(state: PrintState, settings: ReadonlyMap<string, PrintSetting>, screenshots: readonly Screenshot[]): Promise<Composed> {
  const plans = planPages(state.lines, state.materials);
  // Every original and screenshot is re-hashed before anything is composed; one mismatch fails the whole sheet.
  const bytes = new Map<string, Uint8Array>();
  for (const plan of plans) {
    for (const id of [plan.voucherMaterialId, plan.bottomMaterialId]) {
      const source = id ? state.sources.get(id) : undefined;
      if (id && source && !bytes.has(id)) bytes.set(id, verified(state, source.sha256, source.fileName));
    }
  }
  const shotBytes = new Map(screenshots.map((shot) => [shot.screenshotId, verified(state, shot.sha256, shot.fileName)] as const));

  const prepared = async (materialId: string | null, region: Region): Promise<{ stored: StoredPlacement; drawn: Drawn } | null> => {
    const source = materialId ? state.sources.get(materialId) : undefined;
    const original = materialId ? bytes.get(materialId) : undefined;
    if (!materialId || !source || !original) return null;
    const setting = settings.get(materialId) ?? {};
    let content: Content;
    let croppable = false;
    let corners: Corners | null = null;
    let photo: StoredPlacement['original'] = null;
    if (source.mediaType === 'pdf') content = await pdfContent(original);
    else {
      const detected = await paperCorners(original);
      const full: PaperCorners = [
        [0, 0],
        [detected.width, 0],
        [detected.width, detected.height],
        [0, detected.height],
      ];
      corners = setting.corners ?? detected.corners ?? full;
      content = await photoContent(original, corners);
      croppable = true;
      photo = { sha256: source.sha256, width: detected.width, height: detected.height };
    }
    const box = REGIONS[region];
    const turned = setting.rotate ?? prefersRotation(content.size, box);
    const extraPages = content.kind === 'pdf' && content.pageCount > 1 ? { extraPageCount: content.pageCount - 1 } : {};
    return {
      stored: { materialId, fileName: source.fileName, rotate: turned, croppable, corners, cropAdjusted: croppable && setting.corners !== undefined, original: photo, ...extraPages },
      drawn: { content, rotate: turned, region: box },
    };
  };

  const sheet: { header: string; drawn: Drawn[] }[] = [];
  const pages: Omit<StoredPage, 'pngSha256'>[] = [];
  for (const plan of plans) {
    const shot = screenshots.find((candidate) => candidate.voucherMaterialId === plan.voucherMaterialId) ?? null;
    const top = await prepared(plan.voucherMaterialId, 'top');
    const bottom = await prepared(plan.bottomMaterialId, shot ? 'bottom_left' : 'bottom');
    const drawn = [top?.drawn, bottom?.drawn].filter((d): d is Drawn => d !== undefined);
    const shotContent = shot ? shotBytes.get(shot.screenshotId) : undefined;
    // The screenshot always stands upright in the right third.
    if (shotContent) drawn.push({ content: await screenshotContent(shotContent), rotate: false, region: REGIONS.bottom_right });
    sheet.push({ header: plan.header, drawn });
    pages.push({
      pageId: plan.pageId,
      voucherMaterialId: plan.voucherMaterialId,
      no: plan.no,
      nos: plan.nos,
      header: plan.header,
      date: plan.date,
      categoryLabel: plan.categoryLabel,
      grossAmount: plan.grossAmount,
      top: top?.stored ?? null,
      bottom: bottom?.stored ?? null,
      screenshotId: shot?.screenshotId ?? null,
      droppedFileNames: plan.droppedMaterialIds.map((id) => state.sources.get(id)?.fileName).filter((name): name is string => name !== undefined),
    });
  }
  const pdf = await composeSheet(sheet);
  const images = await renderPages(pdf);
  const files = [{ sha256: writeBlob(state.dataDir, pdf), size: pdf.byteLength, mime: 'application/pdf' }];
  const stored = pages.map((page, index) => {
    const png = images[index] ?? new Uint8Array();
    const sha256 = writeBlob(state.dataDir, png);
    files.push({ sha256, size: png.byteLength, mime: 'image/png' });
    return { ...page, pngSha256: sha256 };
  });
  return { pdfSha256: files[0]?.sha256 ?? '', pages: stored, files };
}
