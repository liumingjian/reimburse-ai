import { randomUUID } from 'node:crypto';
import { LEGACY_IMPORT_ERRORS, type LegacyImport, type LegacyImportReport } from '@baox/contract';
import type { Db } from '../db/database';
import type { ImportRunTable } from '../db/schema';
import type { Holding } from '../occupancy-ledger';
import { rememberHomeCity } from '../settings';
import { readLegacyTree, type LegacyData, type LegacyProblem } from './read';

// 旧数据导入 (legacy import), ADR-0015 as amended by ADR-0018: runs once, when the first admin account is created, and
// imports into that account, in one transaction, with an `import_run` row:
//   - 常驻城市 (home city) → a `home_city_setting` row with source `legacy_import`;
//   - 个人项目簿 (personal book) → `admitted` events of that account's personal book (never the public book);
//   - each ERP-touched legacy task → a read-only terminal task with `origin = legacy` (lifecycle `handed_off`) plus a
//     `legacy_task` row (`saved` → ERP 单据已交接, anything else → 转人工) and its 发票占用 (occupancy) claims.
// Untouched legacy tasks and identity bindings import nothing. A corrupt tree records a `failed` run and writes
// nothing else; the owner may retry (after fixing it) or skip. Any later run is refused: re-running is a no-op.

export type LegacyOutcome = 'draft_handed_over' | 'handed_off';

export class LegacyImportRefusal extends Error {
  readonly code = 'import_not_pending';
  constructor() {
    super(LEGACY_IMPORT_ERRORS.notPending);
  }
}

export const legacyTaskName = (label: string) => `旧版任务 ${label}`;
export const legacyOutcomeOf = (erpWriteState: string): LegacyOutcome => (erpWriteState === 'saved' ? 'draft_handed_over' : 'handed_off');

const iso = (date: Date) => `${date.toISOString().slice(0, 19)}Z`;
// Legacy tasks without a home city of their own show the imported one, else this placeholder (the contract needs one).
const UNKNOWN_HOME_CITY = '未记录';

const emptyReport = (problems: LegacyProblem[] = []): LegacyImportReport => ({ homeCity: null, projects: 0, handedOver: 0, handedOff: 0, invoices: 0, notMigrated: [], problems });

function reportOf(data: LegacyData): LegacyImportReport {
  const handedOver = data.touched.filter((task) => legacyOutcomeOf(task.erpWriteState) === 'draft_handed_over').length;
  return {
    homeCity: data.homeCity?.value ?? null,
    projects: data.projects.length,
    handedOver,
    handedOff: data.touched.length - handedOver,
    invoices: data.touched.reduce((sum, task) => sum + task.invoices.length, 0),
    notMigrated: data.untouched,
    problems: [],
  };
}

async function nextSeq(tx: Db, table: 'import_run' | 'project_book_event'): Promise<number> {
  const last = await tx.selectFrom(table).select((eb) => eb.fn.max('seq').as('seq')).executeTakeFirst();
  return Number(last?.seq ?? 0) + 1;
}

async function recordRun(tx: Db, accountId: string, outcome: ImportRunTable['outcome'], report: LegacyImportReport, at: string): Promise<string> {
  const runId = randomUUID();
  await tx.insertInto('import_run').values({ run_id: runId, seq: await nextSeq(tx, 'import_run'), account_id: accountId, outcome, report: JSON.stringify(report), created_at: at }).execute();
  return runId;
}

async function write(tx: Db, accountId: string, runId: string, data: LegacyData, at: string): Promise<void> {
  if (data.homeCity) await rememberHomeCity(tx, accountId, data.homeCity.value, 'legacy_import', data.homeCity.confirmedAt ?? at);
  let seq = await nextSeq(tx, 'project_book_event');
  for (const project of data.projects) {
    await tx
      .insertInto('project_book_event')
      .values({
        event_id: randomUUID(),
        seq: seq++,
        scope: 'personal',
        owner_account_id: accountId,
        number: project.number,
        action: 'admitted',
        name: project.name,
        verdict: null,
        expires_on: project.expiresOn,
        admission_source: null,
        actor_account_id: accountId,
        created_at: project.confirmedAt ?? at,
      })
      .execute();
  }
  for (const legacy of data.touched) {
    const taskId = randomUUID();
    await tx
      .insertInto('task')
      .values({
        task_id: taskId,
        account_id: accountId,
        name: legacyTaskName(legacy.label),
        home_city: legacy.homeCity ?? data.homeCity?.value ?? UNKNOWN_HOME_CITY,
        lifecycle: 'handed_off',
        origin: 'legacy',
        revision: 1,
        created_at: legacy.createdAt,
        updated_at: legacy.erpWriteAt ?? legacy.createdAt,
      })
      .execute();
    await tx
      .insertInto('legacy_task')
      .values({
        task_id: taskId,
        account_id: accountId,
        run_id: runId,
        legacy_task_id: legacy.legacyTaskId,
        outcome: legacyOutcomeOf(legacy.erpWriteState),
        erp_write_state: legacy.erpWriteState,
        erp_write_at: legacy.erpWriteAt,
        reconcile_bucket: legacy.reconcileBucket,
        bill_no: legacy.billNo,
        created_at: at,
      })
      .execute();
    for (const invoice of legacy.invoices) {
      await tx.insertInto('legacy_claim').values({ claim_id: randomUUID(), task_id: taskId, account_id: accountId, invoice_key: invoice.key, file_name: invoice.fileName, created_at: at }).execute();
    }
  }
}

// `legacyHome` null disables the import (tests, unless they pass the fixture tree).
export function createLegacyImport(db: Db, legacyHome: string | null, clock: () => Date) {
  const latest = (tx: Db = db) => tx.selectFrom('import_run').selectAll().orderBy('seq', 'desc').executeTakeFirst();

  // Always inside the caller's transaction, so the run row and everything it imported land together.
  async function run(accountId: string, tx: Db): Promise<void> {
    const at = iso(clock());
    const read = legacyHome ? readLegacyTree(legacyHome) : ({ kind: 'absent' } as const);
    if (read.kind === 'absent') await recordRun(tx, accountId, 'absent', emptyReport(), at);
    else if (read.kind === 'corrupt') await recordRun(tx, accountId, 'failed', emptyReport(read.problems), at);
    else await write(tx, accountId, await recordRun(tx, accountId, 'imported', reportOf(read.data), at), read.data, at);
  }

  // The owner's pending (failed) run, or a refusal. Read inside the transaction that acts on it, so two concurrent
  // retries cannot both pass it and both import.
  async function pending(accountId: string, tx: Db): Promise<ImportRunTable> {
    const row = await latest(tx);
    if (!row || row.account_id !== accountId || row.outcome !== 'failed') throw new LegacyImportRefusal();
    return row;
  }

  return {
    // Called right after the first admin account is created, inside that same transaction. A second call finds the
    // run and does nothing.
    async onFirstAdmin(accountId: string, tx: Db = db): Promise<void> {
      if (await latest(tx)) return;
      await run(accountId, tx);
    },

    async view(accountId: string): Promise<LegacyImport> {
      const row = await latest();
      if (!row || row.account_id !== accountId) return { status: 'none', at: null, report: null, canRetry: false };
      return { status: row.outcome, at: row.created_at, report: JSON.parse(row.report) as LegacyImportReport, canRetry: row.outcome === 'failed' };
    },

    async retry(accountId: string): Promise<LegacyImport> {
      await db.transaction().execute(async (tx) => {
        await pending(accountId, tx);
        await run(accountId, tx);
      });
      return this.view(accountId);
    },

    // 明确跳过 (explicit skip): recorded, and it ends the import for good.
    async skip(accountId: string): Promise<LegacyImport> {
      await db.transaction().execute(async (tx) => {
        const failed = await pending(accountId, tx);
        await recordRun(tx, accountId, 'skipped', JSON.parse(failed.report) as LegacyImportReport, iso(clock()));
      });
      return this.view(accountId);
    },
  };
}

export type LegacyImportService = ReturnType<typeof createLegacyImport>;

// Imported legacy 发票占用 as occupancy holdings: always handed off (ERP may have consumed the invoices), so they hold
// against every later claim; `seq` 0 keeps them first even on equal times.
export async function legacyHoldings(tx: Db): Promise<Holding[]> {
  const rows = await tx
    .selectFrom('legacy_claim')
    .innerJoin('task', 'task.task_id', 'legacy_claim.task_id')
    .select(['legacy_claim.task_id', 'legacy_claim.account_id', 'legacy_claim.invoice_key', 'legacy_claim.file_name', 'task.name', 'task.created_at'])
    .orderBy('legacy_claim.task_id')
    .execute();
  const byTask = new Map<string, Holding>();
  for (const row of rows) {
    const holding = byTask.get(row.task_id) ?? { accountId: row.account_id, taskId: row.task_id, taskName: row.name, handedOff: true, claims: [] };
    byTask.set(row.task_id, { ...holding, claims: [...holding.claims, { key: row.invoice_key, materialId: `legacy.${row.task_id}`, fileName: row.file_name, at: row.created_at, seq: 0 }] });
  }
  return [...byTask.values()];
}
