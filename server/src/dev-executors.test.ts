import { describe, expect, it } from 'vitest';
import { devExecutors } from './dev-executors';

// QA 2026-10-18: the dev instance never sent a 去报销 to the paired 本地执行器, so 暂存 (only in plans bound for one,
// `erp/remote-executor.ts`) could not be QA'd there. `BAOX_DEV_ERP=paired` hands ERP jobs back to the server's own
// routing, the production entry's.
describe('the development entry', () => {
  it('runs ERP jobs on the dedicated Chromium by default', () => {
    for (const value of [undefined, 'cdp']) {
      const overrides = devExecutors(value, '/tmp/baox-dev');
      expect(overrides.erpExecutor).toBeDefined();
      expect(overrides.reconcileExecutor).toBeDefined();
    }
  });

  it('leaves ERP jobs to the paired 本地执行器 when asked, as the production entry does', () => {
    expect(devExecutors('paired', '/tmp/baox-dev')).toEqual({});
  });

  it('refuses a value it does not know rather than guess', () => {
    expect(() => devExecutors('local', '/tmp/baox-dev')).toThrow(/BAOX_DEV_ERP/);
  });
});
