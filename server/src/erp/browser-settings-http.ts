import { HTTP_ENDPOINTS, SaveErpBrowserSettingsInputSchema } from '@baox/contract';
import type { Hono } from 'hono';
import { AuthRefusal } from '../accounts/accounts';
import { accountOf, type AppEnv } from '../accounts/http';
import type { Db } from '../db/database';
import { readErpBrowserSettings, saveErpBrowserSettings } from './browser-settings';

export function mountErpBrowserSettingsRoutes(app: Hono<AppEnv>, db: Db): void {
  app.get(HTTP_ENDPOINTS.getErpBrowserSettings.path, async (c) => c.json(await readErpBrowserSettings(db, accountOf(c).accountId)));
  app.post(HTTP_ENDPOINTS.saveErpBrowserSettings.path, async (c) => {
    const input = SaveErpBrowserSettingsInputSchema.strict().safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw new AuthRefusal(400, 'invalid_input', '请选择无窗口或显示浏览器窗口。');
    return c.json(await saveErpBrowserSettings(db, accountOf(c).accountId, input.data));
  });
}
