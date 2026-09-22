import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR } from '@baox/fixtures';
import { TaskSnapshotSchema } from '@baox/contract';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { databasePath, writeBlob } from '../data-dir';
import { readBook } from '../books';
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
// Named columns, and only the ones 0001 created: everything a later migration adds to these tables is nullable or has
// a default, so the same rows insert cleanly at every version. A positional INSERT could not do this -- `task` gains
// `origin` in 0005_195 -- and that is the point: these rows have to survive migrating forward from any version.
// Returns the account id the fixture task belongs to.
async function priorVersionFixture(migration: string): Promise<string> {
  const db = new Kysely<any>({ dialect: new SqliteDialect({ database: new Database(databasePath(dataDir)) }) });
  const { error } = await new Migrator({ db, provider: { getMigrations: async () => MIGRATIONS } }).migrateTo(migration);
  if (error) throw error;
  const at = '2026-09-01T10:00:00Z';
  const sha = 'a'.repeat(64);
  // 0002_193 deletes the implicit account of 0001 once it owns no tasks, so from that version on an empty database has
  // no account at all. Take whichever account the version left behind, and make one only when there is none: what this
  // fixture is about is the task facts surviving, not who owns them.
  const owner = (await sql<{ account_id: string }>`SELECT account_id FROM account LIMIT 1`.execute(db)).rows[0]?.account_id ?? 'local';
  await sql`INSERT OR IGNORE INTO account (account_id, display_name, created_at) VALUES (${owner}, '本机用户', ${at})`.execute(db);
  await sql`INSERT INTO task (task_id, account_id, name, home_city, lifecycle, revision, created_at, updated_at)
            VALUES ('old-task', ${owner}, '旧任务', '杭州', 'open', 3, ${at}, ${at})`.execute(db);
  await sql`INSERT INTO upload_batch (batch_id, task_id, account_id, no, uploaded_at)
            VALUES ('old-batch', 'old-task', ${owner}, 1, ${at})`.execute(db);
  await sql`INSERT INTO blob (sha256, size, mime, created_at) VALUES (${sha}, 12, 'application/pdf', ${at})`.execute(db);
  await sql`INSERT INTO material (material_id, task_id, account_id, batch_id, blob_sha256, file_name, created_at)
            VALUES ('old-material', 'old-task', ${owner}, 'old-batch', ${sha}, 'old.pdf', ${at})`.execute(db);
  // Populate the project stream as soon as that version supports it. These are legacy facts even on newer schemas;
  // maintenance migrations must preserve removal semantics and existing cross-scope collisions.
  if (migration >= '0004_188_projects') {
    const facts = [
      ['personal', owner, 'OLD-ACTIVE', 'admitted', '历史个人项目'],
      ['personal', owner, 'OLD-REMOVED', 'admitted', '历史移除项目'],
      ['personal', owner, 'OLD-REMOVED', 'removed', null],
      ['personal', owner, 'OLD-SHARED', 'admitted', '个人历史名称'],
      ['public', null, 'OLD-SHARED', 'admitted', '公共历史名称'],
      ['public', null, 'OLD-INACTIVE', 'admitted', '历史公共项目'],
      ['public', null, 'OLD-INACTIVE', 'removed', null],
    ];
    for (const [index, [scope, account, number, action, name]] of facts.entries()) {
      await sql`INSERT INTO project_book_event
        (event_id, seq, scope, owner_account_id, number, action, name, actor_account_id, created_at)
        VALUES (${'old-project-' + index}, ${index + 1}, ${scope}, ${account}, ${number}, ${action}, ${name}, ${owner}, ${at})`.execute(db);
    }
  }
  await db.destroy();
  return owner;
}

describe('migrations on an existing database', () => {
  it('upgrades the deployed maintenance schema without reopening its admitted barrier', async () => {
    await priorVersionFixture('0017_265_maintenance_gate');
    const prior = new Database(databasePath(dataDir));
    prior.prepare("UPDATE maintenance_gate SET state = 'admitted' WHERE gate_id = 'main'").run();
    prior.close();
    const db = await openDatabase(databasePath(dataDir));
    try {
      expect(await db.selectFrom('maintenance_gate').select('state').where('gate_id', '=', 'main').executeTakeFirstOrThrow()).toEqual({ state: 'admitted' });
      expect(await db.selectFrom('material').select('source_path').where('material_id', '=', 'old-material').executeTakeFirstOrThrow()).toEqual({ source_path: null });
      expect(await db.selectFrom('project_book_event').select('deadline_on').execute()).toEqual(expect.arrayContaining([{ deadline_on: null }]));
      expect(backups()).toHaveLength(1);
    } finally {
      await db.destroy();
    }
  });

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
      // Pending only on the 住宿 trio check (#213): a hotel invoice alone has no folio and no payment screenshot.
      expect(snapshot.materials).toEqual([expect.objectContaining({ materialId: 'old-material', kind: 'vat_invoice', layout: 'einvoice', status: 'pending' })]);
      expect(snapshot.pendingItems.map((item) => item.itemId)).toEqual(['stay_folio_missing.old-material', 'stay_screenshot_missing.old-material']);
    } finally {
      await migrated.destroy();
    }
  });

  // ADR-0015: every migration is tested on a populated database of the version before it, not only on an empty one.
  // Driven off MIGRATIONS itself, so a new migration is covered the moment it is added.
  const VERSIONS = Object.keys(MIGRATIONS);
  const LATEST = VERSIONS[VERSIONS.length - 1]!;

  it.each(VERSIONS)('migrates a populated %s database to latest with its facts intact', async (version) => {
    const owner = await priorVersionFixture(version);

    const db = await openDatabase(databasePath(dataDir));
    try {
      const snapshot = TaskSnapshotSchema.parse(await createTaskService(db, dataDir, owner).snapshot('old-task'));
      expect(snapshot.task.name).toBe('旧任务');
      expect(snapshot.materials.map((m) => m.fileName)).toEqual(['old.pdf']);
      expect(snapshot.batches[0]?.files.map((f) => f.status)).toEqual(['accepted']);
      if (version >= '0004_188_projects') {
        expect(await readBook(db, { scope: 'personal', ownerAccountId: owner })).toEqual([
          expect.objectContaining({ number: 'OLD-ACTIVE', name: '历史个人项目', deactivated: false, lastCheckedAt: '2026-09-01T10:00:00Z' }),
          expect.objectContaining({ number: 'OLD-SHARED', name: '个人历史名称', deactivated: false }),
        ]);
        expect(await readBook(db, { scope: 'public' })).toEqual([
          expect.objectContaining({ number: 'OLD-SHARED', name: '公共历史名称', deactivated: false }),
          expect.objectContaining({ number: 'OLD-INACTIVE', name: '历史公共项目', deactivated: true }),
        ]);
        await expect(sql`UPDATE project_book_event SET name = 'changed'`.execute(db)).rejects.toThrow();
        await expect(sql`DELETE FROM project_book_event`.execute(db)).rejects.toThrow();
      }
    } finally {
      await db.destroy();
    }
    // An existing database is backed up before it is migrated; at the newest version nothing is pending to migrate.
    expect(backups()).toEqual(version === LATEST ? [] : [expect.stringMatching(new RegExp(`-${version}\\.sqlite$`))]);
  });

  // 0014 rebuilds `erp_job` to widen the `trigger` CHECK, which is the only way SQLite allows it. The rows, the
  // children that reference them and the append-only triggers all have to come through that rebuild intact.
  it('migrates 0013 → latest with the ERP job rows, their children and their append-only rule intact', async () => {
    const owner = await priorVersionFixture('0013_222_account_approval');
    const at = '2026-09-01T10:00:00Z';
    const db = new Kysely<any>({ dialect: new SqliteDialect({ database: new Database(databasePath(dataDir)) }) });
    for (const [jobId, trigger] of [['old-job', 'start'], ['old-login', 'confirm_login']] as const) {
      await sql`INSERT INTO erp_job (job_id, task_id, account_id, kind, trigger, confirmation_digest, plan, revision, started_at)
                VALUES (${jobId}, 'old-task', ${owner}, 'fill', ${trigger}, 'digest', '{}', 3, ${at})`.execute(db);
    }
    await sql`INSERT INTO erp_job_cancel (cancel_id, job_id, task_id, account_id, revision, created_at)
              VALUES ('old-cancel', 'old-login', 'old-task', ${owner}, 3, ${at})`.execute(db);
    await sql`INSERT INTO erp_approved_preview (job_id, task_id, account_id, digest, preview, created_at)
              VALUES ('old-job', 'old-task', ${owner}, 'digest', '{}', ${at})`.execute(db);
    await sql`INSERT INTO erp_reconcile_job (job_id, fill_job_id, task_id, account_id, revision, started_at)
              VALUES ('old-reconcile', 'old-job', 'old-task', ${owner}, 3, ${at})`.execute(db);
    await db.destroy();

    const migrated = await openDatabase(databasePath(dataDir));
    try {
      expect(await migrated.selectFrom('erp_job').select(['job_id', 'trigger']).orderBy('job_id').execute()).toEqual([
        { job_id: 'old-job', trigger: 'start' },
        { job_id: 'old-login', trigger: 'confirm_login' },
      ]);
      // The children still point at the parent that was rebuilt under them.
      expect(await migrated.selectFrom('erp_reconcile_job').select(['fill_job_id']).execute()).toEqual([{ fill_job_id: 'old-job' }]);
      expect(await migrated.selectFrom('erp_job_cancel').select(['job_id']).execute()).toEqual([{ job_id: 'old-login' }]);
      expect(await migrated.selectFrom('erp_approved_preview').select(['job_id']).execute()).toEqual([{ job_id: 'old-job' }]);
      // 重新去报销 is now storable, an unknown trigger still is not, and the table is still append-only.
      await sql`INSERT INTO erp_job (job_id, task_id, account_id, kind, trigger, confirmation_digest, plan, revision, started_at)
                VALUES ('new-refill', 'old-task', ${owner}, 'fill', 'refill', 'digest', '{}', 4, ${at})`.execute(migrated);
      await expect(sql`INSERT INTO erp_job (job_id, task_id, account_id, kind, trigger, confirmation_digest, plan, revision, started_at)
                       VALUES ('bogus', 'old-task', ${owner}, 'fill', 'whatever', 'digest', '{}', 4, ${at})`.execute(migrated)).rejects.toThrow();
      await expect(sql`UPDATE erp_job SET trigger = 'start' WHERE job_id = 'new-refill'`.execute(migrated)).rejects.toThrow();
      await expect(sql`DELETE FROM erp_job WHERE job_id = 'new-refill'`.execute(migrated)).rejects.toThrow();
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
