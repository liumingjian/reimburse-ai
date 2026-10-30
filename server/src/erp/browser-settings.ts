import type { ErpBrowserSettings } from '@baox/contract';
import type { Db } from '../db/database';

// A preference of the app account, independent of credential saves, refusals and clearing.
export async function readErpBrowserSettings(db: Db, accountId: string): Promise<ErpBrowserSettings> {
  const row = await db.selectFrom('erp_browser_setting').select('browser_mode').where('account_id', '=', accountId).executeTakeFirst();
  return { browserMode: row?.browser_mode ?? 'headless' };
}

export async function saveErpBrowserSettings(db: Db, accountId: string, settings: ErpBrowserSettings): Promise<ErpBrowserSettings> {
  await db.insertInto('erp_browser_setting').values({ account_id: accountId, browser_mode: settings.browserMode })
    .onConflict((conflict) => conflict.column('account_id').doUpdateSet({ browser_mode: settings.browserMode })).execute();
  return settings;
}
