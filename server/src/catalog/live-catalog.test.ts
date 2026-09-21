import { describe, expect, it } from 'vitest';
import { createFakeErp } from '@baox/erp-executor/testing/fake-erp';
import { ERP_ORIGIN, fakeErpOptions } from '../erp/testing/scenario';
import { liveProjectCatalog } from './live-catalog';

// The live project catalog on the fake ERP: `ExecuteBillQuery` on `BJYC_ProJect` inside the logged-in tab, read only.

describe('liveProjectCatalog', () => {
  it('answers confirmed, missing and unusable from the logged-in ERP tab, without any input', async () => {
    const fake = await createFakeErp(fakeErpOptions({ projects: [{ code: 'P-2307', name: '华东客户交付' }, { code: 'P-9', name: '已禁用项目', forbidStatus: 'B' }] }));
    const catalog = liveProjectCatalog({ browser: fake.browser, origin: ERP_ORIGIN });
    expect(await catalog.lookup('P-2307')).toEqual({ ok: true, verdict: 'confirmed', name: '华东客户交付' });
    expect(await catalog.lookup('P-404')).toEqual({ ok: true, verdict: 'missing' });
    expect(await catalog.lookup('P-9')).toEqual({ ok: true, verdict: 'unusable', name: '已禁用项目' });
    expect(fake.mutations).toEqual([]);
    expect(fake.commands.filter((command) => command.method.startsWith('Input.'))).toEqual([]);
  });

  it('does not look up without a logged-in ERP tab, nor with an unsafe number', async () => {
    const loggedOut = await createFakeErp(fakeErpOptions({ loggedIn: false }));
    expect(await liveProjectCatalog({ browser: loggedOut.browser, origin: ERP_ORIGIN }).lookup('P-2307')).toMatchObject({ ok: false, reason: 'not_logged_in' });
    const noBrowser = liveProjectCatalog({ browser: { listPages: async () => { throw new Error('CDP down'); }, attach: async () => { throw new Error('unreachable'); } }, origin: ERP_ORIGIN });
    expect(await noBrowser.lookup('P-2307')).toMatchObject({ ok: false, reason: 'not_logged_in' });
    const fake = await createFakeErp(fakeErpOptions());
    expect(await liveProjectCatalog({ browser: fake.browser, origin: ERP_ORIGIN }).lookup("P' or '1'='1")).toMatchObject({ ok: false, reason: 'query_failed' });
  });
});
