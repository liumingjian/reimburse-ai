import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { MIGRATIONS } from './migrations';
import type { Schema } from './schema';

export type Db = Kysely<Schema>;

const BACKUPS_KEPT = 5;

// A database that holds migrations this app does not know was written by a newer app. It is left untouched.
export class DatabaseTooNewError extends Error {
  constructor(
    readonly path: string,
    readonly unknownMigrations: readonly string[],
  ) {
    super(`Database ${path} was written by a newer baox (unknown migrations: ${unknownMigrations.join(', ')}); refusing to start`);
    this.name = 'DatabaseTooNewError';
  }
}

function executedMigrations(sqlite: Database.Database): string[] {
  const table = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kysely_migration'").get();
  if (!table) return [];
  return (sqlite.prepare('SELECT name FROM kysely_migration ORDER BY name').all() as { name: string }[]).map((row) => row.name);
}

// `VACUUM INTO backups/<ts>-<fromVersion>.sqlite`, then prune to the last BACKUPS_KEPT (names sort by time).
function backUp(sqlite: Database.Database, path: string, fromVersion: string): void {
  const dir = join(dirname(path), 'backups');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const target = join(dir, `${stamp}-${fromVersion}.sqlite`);
  sqlite.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  chmodSync(target, 0o600);
  const backups = readdirSync(dir).filter((name) => name.endsWith('.sqlite')).sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - BACKUPS_KEPT))) rmSync(join(dir, old), { force: true });
}

// Opens the database and runs the forward-only migrations before anything else touches it (ADR-0015):
// a newer database refuses to start untouched; an existing database with pending migrations is backed up first.
// `:memory:` is the test seam.
export async function openDatabase(path: string): Promise<Db> {
  const onDisk = path !== ':memory:';
  const existed = onDisk && existsSync(path);
  const sqlite = new Database(path);
  const executed = executedMigrations(sqlite);
  const unknown = executed.filter((name) => !(name in MIGRATIONS));
  if (unknown.length > 0) {
    sqlite.close();
    throw new DatabaseTooNewError(path, unknown);
  }
  if (onDisk) {
    chmodSync(path, 0o600);
    sqlite.pragma('journal_mode = WAL');
  }
  sqlite.pragma('foreign_keys = ON');
  const pending = Object.keys(MIGRATIONS).filter((name) => !executed.includes(name));
  const lastExecuted = executed.at(-1);
  if (existed && lastExecuted && pending.length > 0) backUp(sqlite, path, lastExecuted);
  const db = new Kysely<Schema>({ dialect: new SqliteDialect({ database: sqlite }) });
  const migrator = new Migrator({ db, provider: { getMigrations: async () => MIGRATIONS } });
  const { error } = await migrator.migrateToLatest();
  if (error) {
    await db.destroy();
    throw error instanceof Error ? error : new Error(String(error));
  }
  return db;
}
