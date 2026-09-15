import { chmodSync } from 'node:fs';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { MIGRATIONS } from './migrations';
import type { Schema } from './schema';

export type Db = Kysely<Schema>;

// Opens the database and runs the forward-only migrations before anything else touches it. A database that holds
// migrations this app does not know (a newer app wrote it) makes the kysely migrator fail, so it refuses to start.
// `:memory:` is the test seam.
export async function openDatabase(path: string): Promise<Db> {
  const sqlite = new Database(path);
  if (path !== ':memory:') {
    chmodSync(path, 0o600);
    sqlite.pragma('journal_mode = WAL');
  }
  sqlite.pragma('foreign_keys = ON');
  const db = new Kysely<Schema>({ dialect: new SqliteDialect({ database: sqlite }) });
  const migrator = new Migrator({ db, provider: { getMigrations: async () => MIGRATIONS } });
  const { error } = await migrator.migrateToLatest();
  if (error) {
    await db.destroy();
    throw error instanceof Error ? error : new Error(String(error));
  }
  return db;
}
