import type { Line, PendingAnswer } from '@baox/contract';
import { sql } from 'kysely';
import type { Db } from './db/database';
import type { LegacyTaskTable, MaterialTable, TaskTable, UploadBatchTable, UploadRejectionTable } from './db/schema';
import { legacyHoldings } from './legacy/import';
import { inventoryView, type InventoryView, type ViewMaterial } from './inventory-view';
import { occupancyBlockers, type Holding } from './occupancy-ledger';
import type { ParseOutcome } from './parse/dispatch';
import { materialMedium } from './parse/media';
import { inventoried, type TaskFacts } from './task-policy';
import { assignmentOf, type Assignment, type AssignmentFact, type PinnedProject } from './assignment';
import { bookOptions, type BookOption } from './books';
import { pinnedCompanyRules, type CompanyRules } from './rules/company-rules';
import { confirmationDigest, confirmationStatus, type ConfirmationDigest, type ConfirmationFact } from './confirmation';
import { loadErp, type ErpRecord } from './erp/fill-state';
import { loadPrintFacts, type PrintFacts } from './print/facts';

// Loading task facts (任务事实): every read that builds what the task service decides on and projects from. Reads
// only, no decisions: `task-policy.ts` turns `LoadedTask.facts` into stage, step and write admission, and `tasks.ts` acts on the rest.

type Tx = Db;

// `medium` is the medium recognition sniffed from the bytes at upload (`parse/media.ts` `materialMedium`): what the
// material list, print and the PDFs-first parse order go by, and what the parser reads the material as.
export type MaterialRow = MaterialTable & { size: number; mime: string; row_no: number; excluded: number; medium: 'pdf' | 'image' };

export type LoadedTask = {
  facts: TaskFacts;
  view: InventoryView;
  runId: string | null;
  parsed: ReadonlySet<string>;
  // The task's current 常驻城市 snapshot and pinned company rules (#188).
  homeCity: string;
  rules: CompanyRules;
  // 项目归属 once the inventory is clean; null before.
  assignment: Assignment | null;
  // The ERP facts of an imported legacy task (#195); null for every task created in the app.
  legacy: LegacyTaskTable | null;
  // The lines as listed (with project and expense item), the digest a confirmation would be made over (null while
  // there is nothing to confirm), and the latest stored confirmation (#189).
  lines: Line[];
  digest: ConfirmationDigest | null;
  confirmed: ConfirmationFact | null;
  // 去报销 (#191): the latest fill job and the task's ERP attempts.
  erp: ErpRecord;
  // 打印稿 (#190): settings, payment screenshots and the latest composed sheet.
  print: PrintFacts;
};

const viewMaterial = (row: MaterialRow): ViewMaterial => ({
  materialId: row.material_id,
  batchId: row.batch_id,
  fileName: row.file_name,
  relativePath: row.source_path ?? row.file_name,
  contentHash: row.blob_sha256,
  size: row.size,
  mediaType: row.medium,
  excluded: Boolean(row.excluded),
  uploadedAt: row.created_at,
  uploadSeq: row.row_no,
});

export async function materialRows(tx: Tx, taskId: string): Promise<MaterialRow[]> {
  const rows = await tx
    .selectFrom('material')
    .innerJoin('blob', 'blob.sha256', 'material.blob_sha256')
    .leftJoin('material_exclusion', 'material_exclusion.material_id', 'material.material_id')
    .selectAll('material')
    .select(['blob.size', 'blob.mime', 'blob.medium as sniffed', sql<number>`material.rowid`.as('row_no'), sql<number>`material_exclusion.exclusion_id IS NOT NULL`.as('excluded')])
    .where('material.task_id', '=', taskId)
    .orderBy(sql`material.rowid`)
    .execute();
  return rows.map(({ sniffed, ...row }) => ({ ...row, medium: materialMedium({ fileName: row.file_name, mime: row.mime, sniffed }) }));
}

// The upload batches and rejected files the snapshot lists next to the materials.
export async function uploadHistory(tx: Tx, taskId: string): Promise<{ batches: UploadBatchTable[]; rejections: UploadRejectionTable[] }> {
  const batches = await tx.selectFrom('upload_batch').selectAll().where('task_id', '=', taskId).orderBy('no').execute();
  const rejections = await tx.selectFrom('upload_rejection').selectAll().where('task_id', '=', taskId).execute();
  return { batches, rejections };
}

// The task's own facts and view, plus the cross-task 发票占用 blockers. A blocked batch forms no events and no
// pending items until the held invoices are excluded. `task` is the row the caller already scoped to its account.
export async function loadFacts(tx: Tx, task: TaskTable, materials?: readonly MaterialRow[]): Promise<LoadedTask> {
  const loaded = await loadOwnFacts(tx, task, materials);
  const { facts, view } = loaded;
  if (!facts.parse || view.waiting > 0 || view.claims.length === 0 || task.lifecycle !== 'open') return loaded;
  const blockers = await occupancyBlockers(await holdings(tx, task.task_id), task.account_id, task.task_id, view.claims);
  if (blockers.length === 0) return loaded;
  facts.parse = { ...facts.parse, openPendingItems: 0, blockers };
  facts.project = null;
  facts.confirmation = confirmationStatus(null, loaded.confirmed, facts.lastReopenRevision);
  // The run's progress stays as it was (the snapshot's summary then counts no open pending item).
  return { ...loaded, facts, assignment: null, lines: [], digest: null, view: { ...view, pendingItems: [], events: [], lines: [], openPendingItems: 0 } };
}

// Facts plus the inventory view of the current run (materials, pending items, events, lines), with the stored answers
// applied, and the 项目归属 (#188) of a clean inventory. Without occupancy, so the occupancy ledger can read any task
// through it; the task's own account scopes its project books.
async function loadOwnFacts(tx: Tx, task: TaskTable, materials?: readonly MaterialRow[]): Promise<LoadedTask> {
  const rows = materials ?? (await materialRows(tx, task.task_id));
  const run = await tx.selectFrom('inventory_run').select(['run_id', 'version_no', 'revision', 'started_at']).where('task_id', '=', task.task_id).orderBy('revision', 'desc').executeTakeFirst();
  const reopen = await tx.selectFrom('upload_reopen').select('revision').where('task_id', '=', task.task_id).orderBy('revision', 'desc').executeTakeFirst();
  const legacy = task.origin === 'legacy' ? ((await tx.selectFrom('legacy_task').selectAll().where('task_id', '=', task.task_id).executeTakeFirst()) ?? null) : null;
  const facts: TaskFacts = {
    ...(legacy ? { legacyOutcome: legacy.outcome } : {}),
    taskId: task.task_id,
    revision: task.revision,
    lifecycle: task.lifecycle,
    origin: task.origin ?? 'app',
    versionNo: new Set(rows.map((row) => row.batch_id)).size,
    includedMaterialCount: rows.filter((row) => !row.excluded).length,
    lastRun: run ? { versionNo: run.version_no, revision: run.revision } : null,
    lastReopenRevision: reopen?.revision ?? null,
    parse: null,
    project: null,
    confirmation: 'unconfirmed',
  };
  const homeCity = await currentHomeCity(tx, task);
  const rules = await pinnedCompanyRules(tx, task.task_id);
  const current = run && inventoried(facts) ? run : null;
  const results = current ? await tx.selectFrom('parse_result').select(['material_id', 'detail', 'created_at']).where('run_id', '=', current.run_id).orderBy('revision').execute() : [];
  // Answers outlive runs: a re-derived item with the same id meets its latest answer.
  const answers = new Map<string, PendingAnswer>();
  if (current) {
    for (const row of await tx.selectFrom('pending_answer').select(['item_id', 'answer']).where('task_id', '=', task.task_id).orderBy('revision').execute()) {
      answers.set(row.item_id, JSON.parse(row.answer) as PendingAnswer);
    }
  }
  // Payment screenshots are print facts, but the 住宿 trio check at inventory reads them too (#213).
  const print = await loadPrintFacts(tx, task.task_id);
  const view = inventoryView(
    rows.map(viewMaterial),
    current
      ? {
          outcomes: new Map(results.map((result) => [result.material_id, JSON.parse(result.detail) as ParseOutcome])),
          startedAt: current.started_at,
          finishedAt: results.at(-1)?.created_at ?? null,
        }
      : null,
    { homeCity, rules },
    answers,
    new Set(print.screenshots.map((shot) => shot.voucherMaterialId)),
  );
  if (current) facts.parse = { waiting: view.waiting, openPendingItems: view.openPendingItems, blockers: [] };
  let assignment: Assignment | null = null;
  let options: BookOption[] = [];
  if (current && view.waiting === 0 && view.openPendingItems === 0) {
    options = await bookOptions(tx, task.account_id, new Date());
    assignment = assignmentOf(view.lines, await assignmentFacts(tx, task.task_id), options, homeCity, true);
    facts.project = { lineCount: view.lines.length, selectableCount: options.length, workingCount: assignment.view.working.length, submitted: assignment.submitted !== null };
  }
  const lines = enrichLines(view.lines, rules, assignment);
  const submitted = assignment?.submitted ?? null;
  const digest = submitted ? confirmationDigest({ lines, purpose: submitted.purpose, selection: submitted.selection, selectable: new Set(options.map((option) => `${option.source}:${option.number}`)), rules, catalogHash: submitted.catalogHash, homeCity }) : null;
  const confirmed = await latestConfirmation(tx, task.task_id);
  facts.confirmation = confirmationStatus(digest, confirmed, facts.lastReopenRevision);
  const erp = await loadErp(tx, task.task_id);
  facts.erp = erp.facts;
  return { facts, view, runId: current?.run_id ?? null, parsed: new Set(results.map((result) => result.material_id)), homeCity, rules, assignment, legacy, lines, digest, confirmed, erp, print };
}

async function latestConfirmation(tx: Tx, taskId: string): Promise<ConfirmationFact | null> {
  const row = await tx.selectFrom('review_confirmation').selectAll().where('task_id', '=', taskId).orderBy('revision', 'desc').executeTakeFirst();
  return row ? { digest: row.digest, detail: row.detail_digest, project: row.project_digest, confirmedAt: row.confirmed_at, revision: row.revision } : null;
}

// Every other task that still holds invoices (open, or handed off after touching ERP), in any account. The importing
// task's own occupancy is left out here because `occupancyBlockers` would discard it anyway — that rule lives there,
// this is only the query that avoids loading a task whose hold can never block it.
async function holdings(tx: Tx, importingTaskId: string): Promise<Holding[]> {
  const others = await tx.selectFrom('task').selectAll().where('task_id', '!=', importingTaskId).where('lifecycle', 'in', ['open', 'handed_off']).where('origin', '=', 'app').execute();
  const found: Holding[] = [];
  for (const task of others) {
    const { view } = await loadOwnFacts(tx, task);
    if (view.claims.length > 0) found.push({ accountId: task.account_id, taskId: task.task_id, taskName: task.name, handedOff: task.lifecycle === 'handed_off', claims: view.claims });
  }
  // Imported legacy tasks hold only their stored invoice keys (#195).
  return [...found, ...(await legacyHoldings(tx))];
}

// The task's 常驻城市: the latest edit, else the snapshot taken at creation.
async function currentHomeCity(tx: Tx, task: TaskTable): Promise<string> {
  const edit = await tx.selectFrom('task_home_city').select('home_city').where('task_id', '=', task.task_id).orderBy('revision', 'desc').executeTakeFirst();
  return edit?.home_city ?? task.home_city;
}

async function assignmentFacts(tx: Tx, taskId: string): Promise<AssignmentFact[]> {
  const assigns = await tx.selectFrom('project_assign').selectAll().where('task_id', '=', taskId).execute();
  const submissions = await tx.selectFrom('project_submission').selectAll().where('task_id', '=', taskId).execute();
  return [
    ...assigns.map((row): AssignmentFact => ({
      kind: 'assign',
      revision: row.revision,
      lineIds: JSON.parse(row.line_ids) as string[],
      project: { number: row.project_number, name: row.project_name, source: row.project_source },
      onlyUnassigned: row.only_unassigned === 1,
    })),
    ...submissions.map((row): AssignmentFact => ({
      kind: 'submit',
      revision: row.revision,
      purpose: row.purpose,
      selection: JSON.parse(row.selection) as Record<string, PinnedProject>,
      linesDigest: row.lines_digest,
      catalogHash: row.catalog_hash,
      submittedAt: row.created_at,
    })),
  ];
}

// Lines with what the pinned rules and the standing submission add: the ERP expense item of the derived category,
// and the pinned project.
function enrichLines(lines: readonly Line[], rules: CompanyRules, assignment: Assignment | null): Line[] {
  return lines.map((line) => {
    const rule = rules.categories[line.category.code];
    const pinned = assignment?.submitted?.selection[line.lineId] ?? null;
    return { ...line, expenseItemCode: rule?.expenseItemCode ?? null, expenseItemName: rule?.expenseItemName ?? null, projectCode: pinned?.number ?? null, projectName: pinned?.name ?? null };
  });
}
