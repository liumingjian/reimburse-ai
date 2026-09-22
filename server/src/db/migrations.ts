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
// - account.must_change_password: set by a temporary password (admin or `baox admin emergency-reset`), cleared by a change.
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

// Slice #190: 打印稿 (print sheet). All append-only. `print_setting` holds the per-material print settings (rotation,
// four crop corners; latest per material wins, so they survive a regeneration). `payment_screenshot` +
// `payment_screenshot_removal` hold the 支付截图 (payment screenshots; the latest unremoved one per voucher is current).
// `print_render` is one composed sheet (merged PDF + page images, both content-addressed blobs) bound to the
// confirmation it was made from: a sheet whose `confirmation_revision` is not the standing confirmation is stale.
const print190: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('print_setting')
      .addColumn('setting_id', 'text', (c) => c.primaryKey())
      .addColumn('task_id', 'text', (c) => c.notNull().references('task.task_id'))
      .addColumn('account_id', 'text', (c) => c.notNull().references('account.account_id'))
      .addColumn('material_id', 'text', (c) => c.notNull().references('material.material_id'))
      .addColumn('rotate', 'integer')
      .addColumn('corners', 'text')
      .addColumn('revision', 'integer', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .execute();
    await db.schema
      .createTable('payment_screenshot')
      .addColumn('screenshot_id', 'text', (c) => c.primaryKey())
      .addColumn('task_id', 'text', (c) => c.notNull().references('task.task_id'))
      .addColumn('account_id', 'text', (c) => c.notNull().references('account.account_id'))
      .addColumn('voucher_material_id', 'text', (c) => c.notNull().references('material.material_id'))
      .addColumn('blob_sha256', 'text', (c) => c.notNull().references('blob.sha256'))
      .addColumn('file_name', 'text', (c) => c.notNull())
      .addColumn('revision', 'integer', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .execute();
    await db.schema
      .createTable('payment_screenshot_removal')
      .addColumn('removal_id', 'text', (c) => c.primaryKey())
      .addColumn('screenshot_id', 'text', (c) => c.notNull().references('payment_screenshot.screenshot_id'))
      .addColumn('task_id', 'text', (c) => c.notNull().references('task.task_id'))
      .addColumn('account_id', 'text', (c) => c.notNull().references('account.account_id'))
      .addColumn('revision', 'integer', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .execute();
    await db.schema
      .createTable('print_render')
      .addColumn('render_id', 'text', (c) => c.primaryKey())
      .addColumn('task_id', 'text', (c) => c.notNull().references('task.task_id'))
      .addColumn('account_id', 'text', (c) => c.notNull().references('account.account_id'))
      .addColumn('confirmation_revision', 'integer', (c) => c.notNull())
      .addColumn('pdf_sha256', 'text', (c) => c.notNull().references('blob.sha256'))
      .addColumn('pages', 'text', (c) => c.notNull())
      .addColumn('revision', 'integer', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .execute();
    for (const table of ['print_setting', 'payment_screenshot', 'payment_screenshot_removal', 'print_render']) await appendOnly(db, table);
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

// Slice #192: 对账 (reconcile) and 转人工 (hand-off). `erp_reconcile_job` is one run of the read-only reconcile job on
// the task's latest fill job (its events go to `erp_job_event` under its own job id); `erp_hand_off` records the
// 转人工 and the bucket it was made on (the lifecycle `handed_off` is on `task`). Both append-only.
const reconcile192: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('erp_reconcile_job')
      .addColumn('job_id', 'text', (c) => c.primaryKey())
      .addColumn('fill_job_id', 'text', (c) => c.notNull().references('erp_job.job_id'))
      .addColumn('task_id', 'text', (c) => c.notNull().references('task.task_id'))
      .addColumn('account_id', 'text', (c) => c.notNull().references('account.account_id'))
      .addColumn('revision', 'integer', (c) => c.notNull())
      .addColumn('started_at', 'text', (c) => c.notNull())
      .execute();
    await db.schema
      .createTable('erp_hand_off')
      .addColumn('hand_off_id', 'text', (c) => c.primaryKey())
      .addColumn('task_id', 'text', (c) => c.notNull().references('task.task_id'))
      .addColumn('account_id', 'text', (c) => c.notNull().references('account.account_id'))
      .addColumn('fill_job_id', 'text')
      .addColumn('bucket', 'text')
      .addColumn('revision', 'integer', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull())
      .execute();
    for (const table of ['erp_reconcile_job', 'erp_hand_off']) await appendOnly(db, table);
  },
};

// #218: local project intake records an explicit source on new admitted facts. Existing rows remain null so their
// prior catalog-derived meaning and append-only history are preserved exactly.
const offlineProjectIntake218: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema.alterTable('project_book_event').addColumn('admission_source', 'text').execute();
  },
};

// #219: lifecycle facts remain in the existing append-only project stream. `maintenance_action` distinguishes their
// semantics from legacy `removed` / `admitted` rows without rebuilding the historical table and its action CHECK.
const projectLifecycle219: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema.alterTable('project_book_event').addColumn('maintenance_action', 'text').execute();
  },
};

// #220: correcting a project appends a maintenance fact. The previous identity makes a renumbering explicit while
// retaining the original event stream; `maintenance_action` is owned by the preceding lifecycle migration.
const projectEdit220: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema.alterTable('project_book_event').addColumn('previous_number', 'text').execute();
  },
};

// Self-registration starts as a pending application. Existing accounts are approved by the default so this
// representation change cannot lock people out of an established local installation.
const accountApproval222: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema.alterTable('account').addColumn('approved', 'integer', (c) => c.notNull().defaultTo(1)).execute();
  },
};

// #242: 重新去报销 (the recovery out of an import that was never saved) starts a fill job of its own, and the audit
// trail has to be able to tell that job from the original 去报销 without relying on row order. `erp_job.trigger`
// therefore gains a third value, `refill`. SQLite cannot widen a CHECK in place, so the table is rebuilt in the
// documented way: create the new shape, copy every row, drop the old one, rename. Dropping the parent would trip the
// three children that reference `erp_job` (erp_job_cancel, erp_approved_preview, erp_reconcile_job), so enforcement
// is suspended across the rebuild and restored after it — `foreign_keys` when this runs outside a transaction,
// `defer_foreign_keys` when it runs inside one, since each is a no-op in the other case. `legacy_alter_table` keeps
// the rename from re-parsing a schema that is halfway rebuilt. The append-only triggers go down with the dropped
// table and are recreated on the new one.
const refillTrigger242: Migration = {
  async up(db: Kysely<unknown>) {
    await sql`PRAGMA foreign_keys = OFF`.execute(db);
    await sql`PRAGMA defer_foreign_keys = ON`.execute(db);
    await db.schema
      .createTable('erp_job_rebuilt')
      .addColumn('job_id', 'text', (c) => c.primaryKey())
      .addColumn('task_id', 'text', (c) => c.notNull().references('task.task_id'))
      .addColumn('account_id', 'text', (c) => c.notNull().references('account.account_id'))
      .addColumn('kind', 'text', (c) => c.notNull().check(sql`kind IN ('fill')`))
      .addColumn('trigger', 'text', (c) => c.notNull().check(sql`trigger IN ('start', 'confirm_login', 'refill')`))
      .addColumn('confirmation_digest', 'text', (c) => c.notNull())
      .addColumn('plan', 'text', (c) => c.notNull())
      .addColumn('revision', 'integer', (c) => c.notNull())
      .addColumn('started_at', 'text', (c) => c.notNull())
      .execute();
    await sql`INSERT INTO erp_job_rebuilt (job_id, task_id, account_id, kind, trigger, confirmation_digest, plan, revision, started_at)
              SELECT job_id, task_id, account_id, kind, trigger, confirmation_digest, plan, revision, started_at FROM erp_job`.execute(db);
    await sql`DROP TABLE erp_job`.execute(db);
    await sql`PRAGMA legacy_alter_table = ON`.execute(db);
    await sql`ALTER TABLE erp_job_rebuilt RENAME TO erp_job`.execute(db);
    await sql`PRAGMA legacy_alter_table = OFF`.execute(db);
    await appendOnly(db, 'erp_job');
    await sql`PRAGMA foreign_keys = ON`.execute(db);
  },
};

// #252: 扩展配对 (extension pairing, ADR-0019). One row per 应用账号 — `account_id` is the primary key, so a new
// 配对码 replacing the old one is a plain row replacement and there can never be two live pairings for an account.
// The extension holds a random 配对码 and later a random token; only their sha256 is stored, the way a session is.
// The token index is unique (32 random bytes never collide); the code index is not, so an astronomically unlikely
// collision between two accounts' ten-minute codes refuses a redemption rather than failing an insert.
const extensionPairing252: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('extension_pairing')
      .addColumn('account_id', 'text', (c) => c.primaryKey().references('account.account_id'))
      .addColumn('code_sha256', 'text')
      .addColumn('code_expires_at', 'text')
      .addColumn('token_sha256', 'text')
      .addColumn('browser', 'text')
      .addColumn('created_at', 'text', (c) => c.notNull())
      .addColumn('paired_at', 'text')
      .addColumn('last_connected_at', 'text')
      .execute();
    await db.schema.createIndex('extension_pairing_token').unique().on('extension_pairing').column('token_sha256').execute();
    await db.schema.createIndex('extension_pairing_code').on('extension_pairing').column('code_sha256').execute();
  },
};

// #253: the extension reports its version on pairing and on every connect (ADR-0021). Kept on the pairing row rather
// than derived from the live connection, so the settings page can still say which version paired after a restart.
const extensionVersion253: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema.alterTable('extension_pairing').addColumn('version', 'text').execute();
  },
};

// #280: retain the relative source path for every selected input. Existing single-file uploads have no path fact and
// are projected with their file name, so migrating them does not invent directory provenance.
const directoryIntake280: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema.alterTable('material').addColumn('source_path', 'text').execute();
    await db.schema.alterTable('upload_rejection').addColumn('source_path', 'text').execute();
  },
};

// #273: project-book entries gain an optional advisory deadline. It is separate from the legacy ERP expiry field;
// existing events remain null so migration never fabricates a date or changes historical selectability.
const projectDeadline273: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema.alterTable('project_book_event').addColumn('deadline_on', 'text').execute();
  },
};

// #265: the maintenance barrier has one durable row. `state` deliberately has no SQL CHECK: a damaged or manually
// altered value must reach the server as an unknown state and close the gate, rather than being normalised by SQLite.
const maintenanceGate265: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable('maintenance_gate')
      .addColumn('gate_id', 'text', (c) => c.primaryKey())
      .addColumn('state', 'text', (c) => c.notNull())
      .addColumn('updated_at', 'text', (c) => c.notNull())
      .execute();
    // A row is created with the table, so a later missing row is never mistaken for a fresh installation and opened.
    await sql`INSERT INTO maintenance_gate (gate_id, state, updated_at) VALUES ('main', 'open', ${new Date().toISOString()})`.execute(db);
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
  '0007_190_print': print190,
  '0008_191_erp_jobs': erpJobs191,
  '0009_192_reconcile': reconcile192,
  '0010_218_offline_project_intake': offlineProjectIntake218,
  '0011_219_project_lifecycle': projectLifecycle219,
  '0012_220_project_edit': projectEdit220,
  '0013_222_account_approval': accountApproval222,
  '0014_242_refill_trigger': refillTrigger242,
  '0015_252_extension_pairing': extensionPairing252,
  '0016_253_extension_version': extensionVersion253,
  '0017_265_maintenance_gate': maintenanceGate265,
  '0017_280_directory_intake': directoryIntake280,
  // Added after the already-integrated #280 migration so existing databases never need a landed migration rewritten.
  '0018_273_project_deadline': projectDeadline273,
};
