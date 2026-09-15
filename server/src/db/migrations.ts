import { type Kysely, sql } from 'kysely';
import type { Migration } from 'kysely/migration';

// Forward-only migrations, keyed and applied in name order. Never edit a landed migration; add the next one.
// A migration that runs against an existing database must be tested on a fixture of the prior version (ADR-0015);
// the `VACUUM INTO backups/` step lands with the first such migration.

export const IMPLICIT_ACCOUNT_ID = 'local';
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

export const MIGRATIONS: Record<string, Migration> = {
  '0001_initial': initial,
  '0002_181_erp_attempts': erpAttempts,
};
