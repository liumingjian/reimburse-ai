import { randomUUID } from 'node:crypto';
import type { Db } from './db/database';

// Per-account 常驻城市 (home city) memory: an append-only history whose latest row is the current value (ADR-0015
// "each change also appends a history row"). A null value is a reset. New tasks default to it.

export type HomeCitySource = 'task_create' | 'task_edit' | 'reset' | 'legacy_import';

export async function rememberHomeCity(tx: Db, accountId: string, homeCity: string | null, source: HomeCitySource, at: string): Promise<void> {
  const last = await tx.selectFrom('home_city_setting').select((eb) => eb.fn.max('seq').as('seq')).executeTakeFirst();
  await tx.insertInto('home_city_setting').values({ setting_id: randomUUID(), seq: Number(last?.seq ?? 0) + 1, account_id: accountId, home_city: homeCity, source, created_at: at }).execute();
}

export async function rememberedHomeCity(db: Db, accountId: string): Promise<string | null> {
  const row = await db.selectFrom('home_city_setting').select('home_city').where('account_id', '=', accountId).orderBy('seq', 'desc').executeTakeFirst();
  return row?.home_city ?? null;
}
