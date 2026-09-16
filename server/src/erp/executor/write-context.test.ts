// Origin: 50931a3:kernel/test/erp-write-context.test.mjs (translated to Vitest; inputs and expected outputs kept).
// The ego task-space case is dropped with ego itself (ADR-0016). "mark" is the kernel's upload_dispatched marker,
// which the job protocol replaces with `attempt_started`.
import { describe, expect, it } from 'vitest';
import { chromiumCdpTransport } from './chromium';
import { authorizeErpWritePage, prepareErpWrite } from './write-context';

describe('ERP write context (写入上下文)', () => {
  it('asks for the Chromium transport and attaches the same page after authorisation', async () => {
    let received: { transport: unknown } | undefined;
    let attached: { page: unknown; options: { env: Record<string, string | undefined> } } | undefined;
    const result = await authorizeErpWritePage({
      env: { BAOX_BROWSER: 'system' },
      authorize: async (options) => {
        received = options;
        return { ok: true, page: { transport: 'default', browserFamily: 'chromium', url: 'https://erp.example/k3/index.aspx' } };
      },
      attach: async (page, options) => {
        attached = { page, options };
        return { ...page, automation: 'cdp', session: { send: async () => ({}), close() {} } };
      },
    });
    expect(received!.transport).toEqual(chromiumCdpTransport({ env: { BAOX_BROWSER: 'system' } }));
    expect((attached!.page as { transport: string }).transport).toBe('default');
    expect(attached!.options.env.BAOX_BROWSER).toBe('system');
    expect((result.page as { automation: string }).automation).toBe('cdp');
  });

  it('records no mark when navigation fails', async () => {
    let marked = false;
    await expect(prepareErpWrite({
      page: { transport: 'default' },
      navigate: async () => { throw new Error('navigate failed'); },
      read: async () => { throw new Error('read must not run'); },
      openAssistant: async () => { throw new Error('assistant must not run'); },
      mark: async () => { marked = true; return { erpWriteState: 'upload_dispatched' }; },
    })).rejects.toThrow(/navigate failed/);
    expect(marked).toBe(false);
  });

  it('marks only after a blank new form and a ready invoice assistant', async () => {
    const calls: string[] = [];
    const result = await prepareErpWrite({
      page: { transport: 'default' },
      navigate: async () => { calls.push('navigate'); },
      read: async () => ({ formMode: { value: 'new' }, billNo: { value: null }, receiptsGrid: { rows: [] } }),
      openAssistant: async () => { calls.push('assistant'); },
      mark: async () => { calls.push('mark'); return { erpWriteState: 'upload_dispatched' }; },
    });
    expect(calls).toEqual(['navigate', 'assistant', 'mark']);
    expect(result.markedTask.erpWriteState).toBe('upload_dispatched');
  });
});
