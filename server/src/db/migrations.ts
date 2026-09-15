import { type Kysely, sql } from 'kysely';
import type { Migration } from 'kysely/migration';

// Forward-only migrations, keyed and applied in name order. Never edit a landed migration; add the next one.
// A migration that runs against an existing database must be tested on a fixture of the prior version (ADR-0015);
// the `VACUUM INTO backups/` step lands with the first such migration.

// The walking skeleton's implicit account. 0002_193_accounts removes it when it owns nothing; otherwise it stays as a
// credential-less, deactivated account nobody can sign in to.
const IMPLICIT_ACCOUNT_ID = 'local';
const IMPLICIT_ACCOUNT_NAME = '本机用户';

// Facts that are insert-only: SQLite refuses UPDATE and DELETE on them.
async function appendOnly(db: Kysely<unknown>, table: string): Promise<void> {
  for (const op of ['UPDATE', 'DELETE'] as const) {
    const name = sql.raw(`${table}_no_${op.toLowerCase()}`);
    const message = sql.lit(`${table} is append-only`);
    await sql`CREATE TRIGGER ${name} BEFORE ${sql.raw(op)} ON ${sql.table(table)} BEGIN SELECT RAISE(ABORT, ${message}); END`.execute(db);
  }
}

const initial: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('account')
      .addColumn('account_id', 'text', (c) => c.primaryKey())
      .addColumn('display_name', 'text', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .execute();
    await db.schema
      .createTable('task')
      .addColumn('task_id', 'text', (c) => c.primaryKey())
      .addColumn('account_id', 'text', (c) => c.notNull().references('account.account_id'))
      .addColumn('name', 'text', (c) => c.notNull())
      .addColumn('home_city', 'text', (c) => c.notNull())
      .addColumn('lifecycle', 'text', (c) => c.notNull().check(sql`lifecycle IN ('open', 'voided', 'handed_off')`))
      .addColumn('revision', 'integer', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .addColumn('updated_at', 'text', (c) => c.notNull())
      .execute();
    await db.schema
      .createTable('upload_batch')
      .addColumn('batch_id', 'text', (c) => c.primaryKey())
      .addColumn('task_id', 'text', (c) => c.notNull().references('task.task_id'))
      .addColumn('account_id', 'text', (c) => c.notNull().references('account.account_id'))
      .addColumn('no', 'integer', (c) => c.notNull())
      .addColumn('uploaded_at', 'text', (c) => c.notNull())
      .addUniqueConstraint('upload_batch_task_no', ['task_id', 'no'])
      .execute();
    await db.schema
      .createTable('blob')
      .addColumn('sha256', 'text', (c) => c.primaryKey())
      .addColumn('size', 'integer', (c) => c.notNull())
      .addColumn('mime', 'text', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .execute();
    await db.schema
      .createTable('material')
      .addColumn('material_id', 'text', (c) => c.primaryKey())
      .addColumn('task_id', 'text', (c) => c.notNull().references('task.task_id'))
      .addColumn('account_id', 'text', (c) => c.notNull().references('account.account_id'))
      .addColumn('batch_id', 'text', (c) => c.notNull().references('upload_batch.batch_id'))
      .addColumn('blob_sha256', 'text', (c) => c.notNull().references('blob.sha256'))
      .addColumn('file_name', 'text', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .execute();
    for (const table of ['upload_batch', 'blob', 'material']) await appendOnly(db, table);
    await sql`INSERT INTO account (account_id, display_name, created_at) VALUES (${IMPLICIT_ACCOUNT_ID}, ${IMPLICIT_ACCOUNT_NAME}, ${new Date().toISOString()})`.execute(db);
  },
};

// Slice #180: rejected files of a batch, the file order within a batch, 材料排除 (material exclusion), start-inventory
// runs and reopen-upload. Facts that order against each other carry the task `revision` they were accepted at.
const inventory180: Migration = {
  async up(db: Kysely<unknown>) {
    // Position of the file within its batch; null for materials uploaded before this migration.
    await sql`ALTER TABLE material ADD COLUMN batch_seq integer`.execute(db);
    await db.schema
      .createTable('upload_rejection')
      .addColumn('rejection_id', 'text', (c) => c.primaryKey())
      .addColumn('task_id', 'text', (c) => c.notNull().references('task.task_id'))
      .addColumn('account_id', 'text', (c) => c.notNull().references('account.account_id'))
      .addColumn('batch_id', 'text', (c) => c.notNull().references('upload_batch.batch_id'))
      .addColumn('batch_seq', 'integer', (c) => c.notNull())
      .addColumn('file_name', 'text', (c) => c.notNull())
      .addColumn('size', 'integer', (c) => c.notNull())
      .addColumn('reason_code', 'text', (c) => c.notNull().check(sql`reason_code IN ('unsupported_type', 'too_large', 'heic', 'duplicate_content')`))
      .addColumn('reason', 'text', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .execute();
    await db.schema
      .createTable('material_exclusion')
      .addColumn('exclusion_id', 'text', (c) => c.primaryKey())
      .addColumn('task_id', 'text', (c) => c.notNull().references('task.task_id'))
      .addColumn('account_id', 'text', (c) => c.notNull().references('account.account_id'))
      .addColumn('material_id', 'text', (c) => c.notNull().unique().references('material.material_id'))
      .addColumn('revision', 'integer', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .execute();
    await db.schema
      .createTable('inventory_run')
      .addColumn('run_id', 'text', (c) => c.primaryKey())
      .addColumn('task_id', 'text', (c) => c.notNull().references('task.task_id'))
      .addColumn('account_id', 'text', (c) => c.notNull().references('account.account_id'))
      .addColumn('version_no', 'integer', (c) => c.notNull())
      .addColumn('revision', 'integer', (c) => c.notNull())
      .addColumn('started_at', 'text', (c) => c.notNull())
      .execute();
    await db.schema
      .createTable('upload_reopen')
      .addColumn('reopen_id', 'text', (c) => c.primaryKey())
      .addColumn('task_id', 'text', (c) => c.notNull().references('task.task_id'))
      .addColumn('account_id', 'text', (c) => c.notNull().references('account.account_id'))
      .addColumn('revision', 'integer', (c) => c.notNull())
      .addColumn('reopened_at', 'text', (c) => c.notNull())
      .execute();
    for (const table of ['upload_rejection', 'material_exclusion', 'inventory_run', 'upload_reopen']) await appendOnly(db, table);
  },
};

// 应用账号 (app accounts, ADR-0018): credentials, role and the deactivation flag on `account`, plus server-side sessions.
// `username` stays nullable only for the implicit account of 0001 when it already owns tasks.
const accounts: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema.alterTable('account').addColumn('username', 'text').execute();
    await db.schema.alterTable('account').addColumn('password_hash', 'text').execute();
    await db.schema
      .alterTable('account')
      .addColumn('role', 'text', (c) => c.notNull().defaultTo('user').check(sql`role IN ('user', 'admin')`))
      .execute();
    await db.schema.alterTable('account').addColumn('active', 'integer', (c) => c.notNull().defaultTo(1)).execute();
    await db.schema.createIndex('account_username').unique().on('account').column('username').execute();
    await sql`DELETE FROM account WHERE account_id = ${IMPLICIT_ACCOUNT_ID} AND NOT EXISTS (SELECT 1 FROM task WHERE task.account_id = account.account_id)`.execute(db);
    await sql`UPDATE account SET active = 0 WHERE username IS NULL`.execute(db);
    // The browser holds a random token; only its sha256 is stored. `expires_at` slides on use (30 days).
    await db.schema
      .createTable('session')
      .addColumn('token_sha256', 'text', (c) => c.primaryKey())
      .addColumn('account_id', 'text', (c) => c.notNull().references('account.account_id'))
      .addColumn('created_at', 'text', (c) => c.notNull())
      .addColumn('expires_at', 'text', (c) => c.notNull())
      .execute();
  },
};

// Slice #181: the ERP job protocol's durable record (ADR-0016). Every executor event is appended; each
// `attempt_started` also lands in erp_attempt before the executor may mutate ERP. Both are append-only.
const erpAttempts: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('erp_job_event')
      .addColumn('event_id', 'text', (c) => c.primaryKey())
      .addColumn('job_id', 'text', (c) => c.notNull())
      .addColumn('task_id', 'text', (c) => c.notNull().references('task.task_id'))
      .addColumn('seq', 'integer', (c) => c.notNull())
      .addColumn('type', 'text', (c) => c.notNull())
      .addColumn('payload', 'text', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .addUniqueConstraint('erp_job_event_job_seq', ['job_id', 'seq'])
      .execute();
    await db.schema
      .createTable('erp_attempt')
      .addColumn('attempt_id', 'text', (c) => c.primaryKey())
      .addColumn('job_id', 'text', (c) => c.notNull())
      .addColumn('task_id', 'text', (c) => c.notNull().references('task.task_id'))
      .addColumn('action', 'text', (c) => c.notNull().check(sql`action IN ('import', 'fill', 'save')`))
      .addColumn('preconditions', 'text', (c) => c.notNull())
      .addColumn('expected_postconditions', 'text', (c) => c.notNull())
      .addColumn('erp_build', 'text', (c) => c.notNull())
      .addColumn('form_id', 'text', (c) => c.notNull())
      .addColumn('erp_account', 'text', (c) => c.notNull())
      .addColumn('erp_tenant', 'text', (c) => c.notNull())
      .addColumn('erp_display_name', 'text', (c) => c.notNull())
      .addColumn('started_at', 'text', (c) => c.notNull())
      .execute();
    for (const table of ['erp_job_event', 'erp_attempt']) await appendOnly(db, table);
  },
};

// Slice #183: one parser outcome per material per inventory run, appended by the background parser job. The outcome
// (candidates, findings) is plain JSON in `detail`; pending items are derived from it, never stored.
const parse183: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('parse_result')
      .addColumn('result_id', 'text', (c) => c.primaryKey())
      .addColumn('task_id', 'text', (c) => c.notNull().references('task.task_id'))
      .addColumn('account_id', 'text', (c) => c.notNull().references('account.account_id'))
      .addColumn('run_id', 'text', (c) => c.notNull().references('inventory_run.run_id'))
      .addColumn('material_id', 'text', (c) => c.notNull().references('material.material_id'))
      .addColumn('outcome', 'text', (c) => c.notNull().check(sql`outcome IN ('recognised', 'unrecognised', 'ambiguous', 'failed')`))
      .addColumn('kind', 'text')
      .addColumn('layout', 'text')
      .addColumn('parser_version', 'text')
      .addColumn('detail', 'text', (c) => c.notNull())
      .addColumn('revision', 'integer', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .addUniqueConstraint('parse_result_run_material', ['run_id', 'material_id'])
      .execute();
    await appendOnly(db, 'parse_result');
  },
};

// Slice #188: pinned rules, home city memory and per-task edits, project books, project assignment. All insert-only.
// - rule_set: content-addressed company rules and project catalogs (ADR-0015); task_rule_pin: what a task pinned.
// - home_city_setting: per-account 常驻城市 history, the latest row is current (null = reset).
// - task_home_city: edits of a task's home city snapshot after creation; the latest wins over task.home_city.
// - project_book_event: personal (owner set) and public (owner null, #194) books as one event stream.
// - project_assign / project_submission: the assignment draft edits and the submitted, pinned selections.
const projects188: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('rule_set')
      .addColumn('hash', 'text', (c) => c.primaryKey())
      .addColumn('kind', 'text', (c) => c.notNull().check(sql`kind IN ('company_rules', 'project_catalog')`))
      .addColumn('content', 'text', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .execute();
    await db.schema
      .createTable('task_rule_pin')
      .addColumn('task_id', 'text', (c) => c.notNull().references('task.task_id'))
      .addColumn('account_id', 'text', (c) => c.notNull().references('account.account_id'))
      .addColumn('kind', 'text', (c) => c.notNull())
      .addColumn('hash', 'text', (c) => c.notNull().references('rule_set.hash'))
      .addColumn('created_at', 'text', (c) => c.notNull())
      .addPrimaryKeyConstraint('task_rule_pin_pk', ['task_id', 'kind'])
      .execute();
    await db.schema
      .createTable('home_city_setting')
      .addColumn('setting_id', 'text', (c) => c.primaryKey())
      .addColumn('seq', 'integer', (c) => c.notNull().unique())
      .addColumn('account_id', 'text', (c) => c.notNull().references('account.account_id'))
      .addColumn('home_city', 'text')
      .addColumn('source', 'text', (c) => c.notNull().check(sql`source IN ('task_create', 'task_edit', 'reset', 'legacy_import')`))
      .addColumn('created_at', 'text', (c) => c.notNull())
      .execute();
    await db.schema
      .createTable('task_home_city')
      .addColumn('change_id', 'text', (c) => c.primaryKey())
      .addColumn('task_id', 'text', (c) => c.notNull().references('task.task_id'))
      .addColumn('account_id', 'text', (c) => c.notNull().references('account.account_id'))
      .addColumn('home_city', 'text', (c) => c.notNull())
      .addColumn('revision', 'integer', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .execute();
    await db.schema
      .createTable('project_book_event')
      .addColumn('event_id', 'text', (c) => c.primaryKey())
      .addColumn('seq', 'integer', (c) => c.notNull().unique())
      .addColumn('scope', 'text', (c) => c.notNull().check(sql`scope IN ('personal', 'public')`))
      .addColumn('owner_account_id', 'text', (c) => c.references('account.account_id'))
      .addColumn('number', 'text', (c) => c.notNull())
      .addColumn('action', 'text', (c) => c.notNull().check(sql`action IN ('admitted', 'checked', 'removed')`))
      .addColumn('name', 'text')
      .addColumn('verdict', 'text')
      .addColumn('expires_on', 'text')
      .addColumn('actor_account_id', 'text', (c) => c.notNull().references('account.account_id'))
      .addColumn('created_at', 'text', (c) => c.notNull())
      .addCheckConstraint('project_book_event_owner', sql`(scope = 'personal') = (owner_account_id IS NOT NULL)`)
      .execute();
    await db.schema
      .createTable('project_assign')
      .addColumn('assign_id', 'text', (c) => c.primaryKey())
      .addColumn('task_id', 'text', (c) => c.notNull().references('task.task_id'))
      .addColumn('account_id', 'text', (c) => c.notNull().references('account.account_id'))
      .addColumn('revision', 'integer', (c) => c.notNull())
      .addColumn('line_ids', 'text', (c) => c.notNull())
      .addColumn('project_number', 'text', (c) => c.notNull())
      .addColumn('project_name', 'text', (c) => c.notNull())
      .addColumn('project_source', 'text', (c) => c.notNull().check(sql`project_source IN ('personal', 'public')`))
      .addColumn('only_unassigned', 'integer', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .execute();
    await db.schema
      .createTable('project_submission')
      .addColumn('submission_id', 'text', (c) => c.primaryKey())
      .addColumn('task_id', 'text', (c) => c.notNull().references('task.task_id'))
      .addColumn('account_id', 'text', (c) => c.notNull().references('account.account_id'))
      .addColumn('revision', 'integer', (c) => c.notNull())
      .addColumn('purpose', 'text', (c) => c.notNull())
      .addColumn('selection', 'text', (c) => c.notNull())
      .addColumn('lines_digest', 'text', (c) => c.notNull())
      .addColumn('catalog_hash', 'text', (c) => c.notNull().references('rule_set.hash'))
      .addColumn('created_at', 'text', (c) => c.notNull())
      .execute();
    for (const table of ['rule_set', 'task_rule_pin', 'home_city_setting', 'task_home_city', 'project_book_event', 'project_assign', 'project_submission']) await appendOnly(db, table);
  },
};

// Slice #187: answers to 待确认项 (pending items) and field edits, the 解析记录 (resolution records) of ADR-0014.
// Pending items stay derived; an answer is carried over to every later run that derives the same item id.
const pendingAnswers187: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('pending_answer')
      .addColumn('answer_id', 'text', (c) => c.primaryKey())
      .addColumn('task_id', 'text', (c) => c.notNull().references('task.task_id'))
      .addColumn('account_id', 'text', (c) => c.notNull().references('account.account_id'))
      .addColumn('item_id', 'text', (c) => c.notNull())
      .addColumn('material_id', 'text', (c) => c.notNull().references('material.material_id'))
      .addColumn('answer', 'text', (c) => c.notNull())
      .addColumn('revision', 'integer', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .execute();
    await db.schema.createIndex('pending_answer_task').on('pending_answer').columns(['task_id', 'revision']).execute();
    await appendOnly(db, 'pending_answer');
  },
};

// 管理员 (admin) tools (#194):
// - account.must_change_password: set by a temporary password (admin or `baox admin reset-password`), cleared by a change.
// - account_event: append-only audit of account changes (role, deactivation, passwords); who did it, to whom, when.
const admin194: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema.alterTable('account').addColumn('must_change_password', 'integer', (c) => c.notNull().defaultTo(0)).execute();
    await db.schema
      .createTable('account_event')
      .addColumn('event_id', 'text', (c) => c.primaryKey())
      .addColumn('account_id', 'text', (c) => c.notNull().references('account.account_id'))
      // null when the local CLI acted (access to the machine is the authority).
      .addColumn('actor_account_id', 'text', (c) => c.references('account.account_id'))
      .addColumn('action', 'text', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .execute();
    await appendOnly(db, 'account_event');
  },
};

// Slice #195: the one-time legacy `~/.baox` import (ADR-0015, ADR-0018). `import_run` records every run (absent,
// imported, failed, skipped); an imported ERP-touched legacy task is a `task` with `origin = 'legacy'` and lifecycle
// `handed_off`, plus its `legacy_task` facts and `legacy_claim` 发票占用 (invoice occupancy) keys.
const legacyImport195: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`ALTER TABLE task ADD COLUMN origin text NOT NULL DEFAULT 'app' CHECK (origin IN ('app', 'legacy'))`.execute(db);
    await db.schema
      .createTable('import_run')
      .addColumn('run_id', 'text', (c) => c.primaryKey())
      .addColumn('seq', 'integer', (c) => c.notNull().unique())
      .addColumn('account_id', 'text', (c) => c.notNull().references('account.account_id'))
      .addColumn('outcome', 'text', (c) => c.notNull().check(sql`outcome IN ('absent', 'imported', 'failed', 'skipped')`))
      .addColumn('report', 'text', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .execute();
    await db.schema
      .createTable('legacy_task')
      .addColumn('task_id', 'text', (c) => c.primaryKey().references('task.task_id'))
      .addColumn('account_id', 'text', (c) => c.notNull().references('account.account_id'))
      .addColumn('run_id', 'text', (c) => c.notNull().references('import_run.run_id'))
      .addColumn('legacy_task_id', 'text', (c) => c.notNull())
      .addColumn('outcome', 'text', (c) => c.notNull().check(sql`outcome IN ('draft_handed_over', 'handed_off')`))
      .addColumn('erp_write_state', 'text', (c) => c.notNull())
      .addColumn('erp_write_at', 'text')
      .addColumn('reconcile_bucket', 'text')
      .addColumn('bill_no', 'text')
      .addColumn('created_at', 'text', (c) => c.notNull())
      .execute();
    await db.schema
      .createTable('legacy_claim')
      .addColumn('claim_id', 'text', (c) => c.primaryKey())
      .addColumn('task_id', 'text', (c) => c.notNull().references('task.task_id'))
      .addColumn('account_id', 'text', (c) => c.notNull().references('account.account_id'))
      .addColumn('invoice_key', 'text', (c) => c.notNull())
      .addColumn('file_name', 'text', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .execute();
    await db.schema.createIndex('legacy_claim_key').on('legacy_claim').column('invoice_key').execute();
    for (const table of ['import_run', 'legacy_task', 'legacy_claim']) await appendOnly(db, table);
  },
};

// Slice #189: 整单明细确认 (whole-list detail confirmation) `{digest, confirmedAt}` (ADR-0014). The status is derived by
// comparing the latest row's digest with the current one; `detail_digest` / `project_digest` pick the notice.
const confirmation189: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('review_confirmation')
      .addColumn('confirmation_id', 'text', (c) => c.primaryKey())
      .addColumn('task_id', 'text', (c) => c.notNull().references('task.task_id'))
      .addColumn('account_id', 'text', (c) => c.notNull().references('account.account_id'))
      .addColumn('digest', 'text', (c) => c.notNull())
      .addColumn('detail_digest', 'text', (c) => c.notNull())
      .addColumn('project_digest', 'text', (c) => c.notNull())
      .addColumn('revision', 'integer', (c) => c.notNull())
      .addColumn('confirmed_at', 'text', (c) => c.notNull())
      .execute();
    await appendOnly(db, 'review_confirmation');
  },
};

// Slice #191: 去报销 (fill ERP) jobs. `erp_job` is one run of the fill job (the plan and the judge's inputs, frozen at
// the start); `erp_job_cancel` ends a login pause without writing; `erp_approved_preview` keeps the preview the judge
// approved after import, so reconcile (#192) can compare against it. The ERP phase is derived from these plus
// `erp_job_event` / `erp_attempt` (ADR-0014); all append-only.
const erpJobs191: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('erp_job')
      .addColumn('job_id', 'text', (c) => c.primaryKey())
      .addColumn('task_id', 'text', (c) => c.notNull().references('task.task_id'))
      .addColumn('account_id', 'text', (c) => c.notNull().references('account.account_id'))
      .addColumn('kind', 'text', (c) => c.notNull().check(sql`kind IN ('fill')`))
      .addColumn('trigger', 'text', (c) => c.notNull().check(sql`trigger IN ('start', 'confirm_login')`))
      .addColumn('confirmation_digest', 'text', (c) => c.notNull())
      .addColumn('plan', 'text', (c) => c.notNull())
      .addColumn('revision', 'integer', (c) => c.notNull())
      .addColumn('started_at', 'text', (c) => c.notNull())
      .execute();
    await db.schema
      .createTable('erp_job_cancel')
      .addColumn('cancel_id', 'text', (c) => c.primaryKey())
      .addColumn('job_id', 'text', (c) => c.notNull().references('erp_job.job_id'))
      .addColumn('task_id', 'text', (c) => c.notNull().references('task.task_id'))
      .addColumn('account_id', 'text', (c) => c.notNull().references('account.account_id'))
      .addColumn('revision', 'integer', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .execute();
    await db.schema
      .createTable('erp_approved_preview')
      .addColumn('job_id', 'text', (c) => c.primaryKey().references('erp_job.job_id'))
      .addColumn('task_id', 'text', (c) => c.notNull().references('task.task_id'))
      .addColumn('account_id', 'text', (c) => c.notNull().references('account.account_id'))
      .addColumn('digest', 'text', (c) => c.notNull())
      .addColumn('preview', 'text', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .execute();
    for (const table of ['erp_job', 'erp_job_cancel', 'erp_approved_preview']) await appendOnly(db, table);
  },
};

export const MIGRATIONS: Record<string, Migration> = {
  '0001_initial': initial,
  // Lexical order: 0002_180 runs before 0002_193 on a fresh or 0001-only database. Neither depends on the other.
  '0002_180_inventory': inventory180,
  '0002_193_accounts': accounts,
  '0003_181_erp_attempts': erpAttempts,
  '0003_183_parse_results': parse183,
  // Lexical order: 0004_187 runs before 0004_188. Neither depends on the other.
  '0004_187_pending_answers': pendingAnswers187,
  '0004_188_projects': projects188,
  '0005_194_admin': admin194,
  '0005_195_legacy_import': legacyImport195,
  '0006_189_confirmation': confirmation189,
  '0008_191_erp_jobs': erpJobs191,
};
