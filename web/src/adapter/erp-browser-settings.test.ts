// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import { UnauthenticatedError } from '@baox/contract';
import { createHttpAdapter, parseErpBrowserSettingsActionResponse, parseErpBrowserSettingsResponse } from './http-adapter';

afterEach(() => vi.unstubAllGlobals());

test('browser settings validate response mode and authentication', () => {
  expect(parseErpBrowserSettingsResponse(200, { browserMode: 'headless' })).toEqual({ browserMode: 'headless' });
  expect(() => parseErpBrowserSettingsResponse(200, { browserMode: 'visible' })).toThrow(/契约/);
  expect(() => parseErpBrowserSettingsResponse(401, {})).toThrow(UnauthenticatedError);
  expect(() => parseErpBrowserSettingsResponse(503, {})).toThrow(/HTTP 503/);
  expect(parseErpBrowserSettingsActionResponse(200, { browserMode: 'headed' })).toEqual({ ok: true, settings: { browserMode: 'headed' } });
  expect(parseErpBrowserSettingsActionResponse(200, {})).toMatchObject({ ok: false, settings: null, error: { code: 'invalid_response' } });
  expect(parseErpBrowserSettingsActionResponse(400, { error: { code: 'invalid_input', message: '无效设置' } })).toEqual({ ok: false, settings: null, error: { code: 'invalid_input', message: '无效设置' } });
  expect(parseErpBrowserSettingsActionResponse(502, null)).toMatchObject({ ok: false, settings: null, error: { code: 'http_502' } });
});

test('browser preference requests use the independent GET and POST endpoint', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ browserMode: 'headless' })).mockResolvedValueOnce(Response.json({ browserMode: 'headed' }));
  vi.stubGlobal('fetch', fetch);
  const adapter = createHttpAdapter();
  expect(await adapter.getErpBrowserSettings()).toEqual({ browserMode: 'headless' });
  expect(await adapter.saveErpBrowserSettings({ browserMode: 'headed' })).toEqual({ ok: true, settings: { browserMode: 'headed' } });
  expect(fetch.mock.calls).toEqual([
    ['/api/erp-browser-settings'],
    ['/api/erp-browser-settings', { method: 'POST', body: JSON.stringify({ browserMode: 'headed' }), headers: { 'content-type': 'application/json' } }],
  ]);
});

test('network errors preserve the mutation failure shape and reject reads', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  const adapter = createHttpAdapter();
  await expect(adapter.getErpBrowserSettings()).rejects.toThrow();
  expect(await adapter.saveErpBrowserSettings({ browserMode: 'headed' })).toMatchObject({ ok: false, settings: null, error: { code: 'network' } });
});
