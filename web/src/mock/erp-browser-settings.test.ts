// @vitest-environment node
import { expect, test, vi } from 'vitest';
import { createMockAdapter } from './mock-adapter';
import { MOCK_ACCOUNT, MOCK_PASSWORD } from './auth';

test('mock preference survives adapter recreation and reset only clears the current account', async () => {
  const memory = new Map<string, string>();
  const options = { seed: null, fault: null, storage: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => void memory.set(key, value) } } as const;
  const adapter = createMockAdapter(options);
  expect(await adapter.saveErpBrowserSettings({ browserMode: 'headed' })).toMatchObject({ ok: true });
  expect(await createMockAdapter(options).getErpBrowserSettings()).toEqual({ browserMode: 'headed' });
  await adapter.register({ username: '张三', password: 'correct horse' });
  await adapter.login({ username: MOCK_ACCOUNT.username, password: MOCK_PASSWORD });
  const accounts = await adapter.listAccounts();
  const bob = accounts.accounts.find((account) => account.username === '张三');
  if (!bob) throw new Error('registered account missing');
  await adapter.updateAccount(bob.accountId, { approved: true });
  await adapter.login({ username: '张三', password: 'correct horse' });
  expect(await adapter.getErpBrowserSettings()).toEqual({ browserMode: 'headless' });
  await adapter.saveErpBrowserSettings({ browserMode: 'headed' });
  await adapter.resetAll();
  expect(await adapter.getErpBrowserSettings()).toEqual({ browserMode: 'headless' });
  await adapter.login({ username: MOCK_ACCOUNT.username, password: MOCK_PASSWORD });
  expect(await adapter.getErpBrowserSettings()).toEqual({ browserMode: 'headed' });
  await adapter.logout();
  await expect(adapter.getErpBrowserSettings()).rejects.toThrow();
  expect(await adapter.saveErpBrowserSettings({ browserMode: 'headed' })).toMatchObject({ ok: false, settings: null, error: { code: 'unauthenticated' } });
});

test('disconnected mock keeps reads available and returns a settings mutation failure', async () => {
  vi.useFakeTimers();
  try {
    const adapter = createMockAdapter({ seed: null, fault: 'service-disconnected' });
    await expect(adapter.listTasks()).rejects.toThrow();
    expect(await adapter.getErpBrowserSettings()).toEqual({ browserMode: 'headless' });
    expect(await adapter.saveErpBrowserSettings({ browserMode: 'headed' })).toMatchObject({ ok: false, settings: null, error: { code: 'service_unavailable' } });
    expect(await adapter.getErpBrowserSettings()).toEqual({ browserMode: 'headless' });
    await vi.runAllTimersAsync();
  } finally {
    vi.useRealTimers();
  }
});
