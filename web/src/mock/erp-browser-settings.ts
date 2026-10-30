import { AUTH_ERRORS, ErpBrowserSettingsSchema, SaveErpBrowserSettingsInputSchema, UNAUTHENTICATED_CODE, UnauthenticatedError, type AppAdapter, type ErpBrowserSettings } from '@baox/contract';
import { defaultStorage, type MockAuth } from './auth';
import type { MockOptions } from './options';

export function createErpBrowserSettingsFlow(options: MockOptions, auth: MockAuth) {
  const storage = options.storage ?? defaultStorage();
  const key = (accountId: string) => `baox.mock.erpBrowserSettings.${accountId}`;
  const read = (accountId: string): ErpBrowserSettings => {
    try {
      const parsed = ErpBrowserSettingsSchema.safeParse(JSON.parse(storage.getItem(key(accountId)) ?? 'null'));
      if (parsed.success) return parsed.data;
    } catch {
      // Corrupt or inaccessible browser storage uses the default.
    }
    return { browserMode: 'headless' };
  };
  const flow: Pick<AppAdapter, 'getErpBrowserSettings' | 'saveErpBrowserSettings'> = {
    async getErpBrowserSettings() {
      const account = auth.account();
      if (!account) throw new UnauthenticatedError();
      return read(account.accountId);
    },
    async saveErpBrowserSettings(input) {
      const account = auth.account();
      if (!account) return { ok: false, error: { code: UNAUTHENTICATED_CODE, message: AUTH_ERRORS.unauthenticated }, settings: null };
      const parsed = SaveErpBrowserSettingsInputSchema.safeParse(input);
      if (!parsed.success) return { ok: false, error: { code: 'invalid_input', message: '请选择无头或有头模式。' }, settings: null };
      try {
        storage.setItem(key(account.accountId), JSON.stringify(parsed.data));
      } catch {
        return { ok: false, error: { code: 'storage_unavailable', message: '浏览器设置保存失败，请重试。' }, settings: null };
      }
      return { ok: true, settings: parsed.data };
    },
  };
  return {
    flow,
    reset() {
      const account = auth.account();
      if (account) storage.setItem(key(account.accountId), JSON.stringify({ browserMode: 'headless' }));
    },
  };
}
