import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR } from '@baox/fixtures';
import { TaskSnapshotSchema } from '@baox/contract';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { databasePath, writeBlob } from '../data-dir';
import { startServer } from '../server';
import { createTaskService } from '../tasks';
import { tempDataDir } from '../test/harness';
import { DatabaseTooNewError, openDatabase } from './database';
import { MIGRATIONS } from './migrations';

// Startup migration safety (ADR-0015): a VACUUM INTO backup before migrating an existing database (last 5 kept),
// a database newer than the app refuses to start, and each migration runs on a fixture of the prior version.

let dataDir: string;
beforeEach(() => {
  dataDir = tempDataDir();
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const backups = () => readdirSync(join(dataDir, 'backups')).sort();

// A database at the schema of `migration` (inclusive), with one task and one material in it.
async function priorVersionFixture(migration: string): Promise<void> {
  const db = new Kysely<any>({ dialect: new SqliteDialect({ database: new Database(databasePath(dataDir)) }) });
  const { error } = await new Migrator({ db, provider: { getMigrations: async () => MIGRATIONS } }).migrateTo(migration);
  if (error) throw error;
  const at = '2026-09-01T10:00:00Z';
  await sql`INSERT INTO task VALUES ('old-task', 'local', '旧任务', '杭州', 'open', 3, ${at}, ${at})`.execute(db);
  await sql`INSERT INTO upload_batch VALUES ('old-batch', 'old-task', 'local', 1, ${at})`.execute(db);
  await sql`INSERT INTO blob VALUES (${'a'.repeat(64)}, 12, 'application/pdf', ${at})`.execute(db);
  await sql`INSERT INTO material VALUES ('old-material', 'old-task', 'local', 'old-batch', ${'a'.repeat(64)}, 'old.pdf', ${at})`.execute(db);
  await db.destroy();
}

describe('migrations on an existing database', () => {
  it('backs up with VACUUM INTO before migrating 0001 → latest, and keeps the old facts readable', async () => {
    await priorVersionFixture('0001_initial');

    const server = await startServer({ dataDir, port: 0 });
    await server.close();
    expect(backups()).toEqual([expect.stringMatching(/^\d{8}T\d{6}\d*Z?-0001_initial\.sqlite$/)]);

    // Since 0002_193 the implicit account that owns the old task is kept but deactivated (nobody can sign in to it),
    // so its facts are read through the account-scoped service rather than over HTTP.
    const db = await openDatabase(databasePath(dataDir));
    try {
      expect(await db.selectFrom('account').select(['account_id', 'username', 'active']).execute()).toEqual([{ account_id: 'local', username: null, active: 0 }]);
      const snapshot = TaskSnapshotSchema.parse(await createTaskService(db, dataDir, 'local').snapshot('old-task'));
      expect(snapshot.materials.map((m) => m.fileName)).toEqual(['old.pdf']);
      expect(snapshot.batches[0]?.files.map((f) => f.status)).toEqual(['accepted']);
      expect(snapshot.step.kind).toBe('start_inventory');
    } finally {
      await db.destroy();
    }
  });

  it('migrates 0002_180 → latest, and resumes the parser job of a run that was left without outcomes', async () => {
    const bytes = readFileSync(join(GENERATED_DIR, 'm01-hotel-invoice.pdf'));
    const sha = writeBlob(dataDir, bytes);
    const db = new Kysely<any>({ dialect: new SqliteDialect({ database: new Database(databasePath(dataDir)) }) });
    const { error } = await new Migrator({ db, provider: { getMigrations: async () => MIGRATIONS } }).migrateTo('0002_180_inventory');
    if (error) throw error;
    const at = '2026-09-01T10:00:00Z';
    await db.insertInto('task').values({ task_id: 'old-task', account_id: 'local', name: '旧任务', home_city: '杭州', lifecycle: 'open', revision: 3, created_at: at, updated_at: at }).execute();
    await db.insertInto('upload_batch').values({ batch_id: 'old-batch', task_id: 'old-task', account_id: 'local', no: 1, uploaded_at: at }).execute();
    await db.insertInto('blob').values({ sha256: sha, size: bytes.byteLength, mime: 'application/pdf', created_at: at }).execute();
    await db.insertInto('material').values({ material_id: 'old-material', task_id: 'old-task', account_id: 'local', batch_id: 'old-batch', blob_sha256: sha, file_name: '全季酒店_发票.pdf', created_at: at, batch_seq: 0 }).execute();
    await db.insertInto('inventory_run').values({ run_id: 'old-run', task_id: 'old-task', account_id: 'local', version_no: 1, revision: 3, started_at: at }).execute();
    await db.destroy();

    // The old task belongs to the implicit account, deactivated since 0002_193 (nobody can sign in to it): wait for
    // the resumed job's outcome in the database file, then read the facts through the account-scoped service.
    const server = await startServer({ dataDir, port: 0 });
    const reader = new Database(databasePath(dataDir), { readonly: true });
    try {
      expect(backups()).toEqual([expect.stringMatching(/-0002_180_inventory\.sqlite$/)]);
      const outcomes = reader.prepare<[string], { n: number }>('SELECT count(*) AS n FROM parse_result WHERE task_id = ?');
      for (let attempt = 0; (outcomes.get('old-task')?.n ?? 0) === 0 && attempt < 500; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      reader.close();
      await server.close();
    }
    const migrated = await openDatabase(databasePath(dataDir));
    try {
      const snapshot = TaskSnapshotSchema.parse(await createTaskService(migrated, dataDir, 'local').snapshot('old-task'));
      expect(snapshot.inventory.status).toBe('done');
      expect(snapshot.materials).toEqual([expect.objectContaining({ materialId: 'old-material', kind: 'vat_invoice', layout: 'einvoice', status: 'ok' })]);
    } finally {
      await migrated.destroy();
    }
  });

  it('keeps only the last 5 backups', async () => {
    await priorVersionFixture('0001_initial');
    for (const stamp of ['20260101T000000Z', '20260102T000000Z', '20260103T000000Z', '20260104T000000Z', '20260105T000000Z']) {
      writeFileSync(join(dataDir, 'backups', `${stamp}-0001_initial.sqlite`), '');
    }
    const db = await openDatabase(databasePath(dataDir));
    await db.destroy();
    const kept = backups();
    expect(kept).toHaveLength(5);
    expect(kept).not.toContain('20260101T000000Z-0001_initial.sqlite');
  });

  it('takes no backup when nothing is pending or the database is new', async () => {
    (await openDatabase(databasePath(dataDir))).destroy();
    const db = await openDatabase(databasePath(dataDir));
    await db.destroy();
    expect(backups()).toEqual([]);
  });

  it('refuses to start on a database newer than the app, and leaves it untouched', async () => {
    const db = await openDatabase(databasePath(dataDir));
    await sql`INSERT INTO kysely_migration (name, timestamp) VALUES ('9999_from_the_future', '2027-01-01T00:00:00.000Z')`.execute(db);
    await db.destroy();

    await expect(openDatabase(databasePath(dataDir))).rejects.toBeInstanceOf(DatabaseTooNewError);
    await expect(startServer({ dataDir, port: 0 })).rejects.toBeInstanceOf(DatabaseTooNewError);
    expect(backups()).toEqual([]);
    // The lock was released: the directory is not left claimed.
    expect(readdirSync(dataDir)).not.toContain('server.lock');
  });
});
