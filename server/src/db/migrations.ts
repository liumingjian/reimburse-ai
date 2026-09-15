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

export const MIGRATIONS: Record<string, Migration> = {
  '0001_initial': initial,
  '0002_180_inventory': inventory180,
  '0003_183_parse_results': parse183,
};
