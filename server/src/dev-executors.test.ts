import { describe, expect, it } from 'vitest';
import { devExecutors } from './dev-executors';

describe('the development entry', () => {
  it('uses the paired local executor by default, as the production entry does', () => {
    expect(devExecutors(undefined, '/tmp/baox-dev')).toEqual({});
  });

  it('accepts an explicit paired executor selection', () => {
    expect(devExecutors('paired', '/tmp/baox-dev')).toEqual({});
  });

  it('keeps the development CDP adapter behind an explicit debugging selection', () => {
    const overrides = devExecutors('cdp', '/tmp/baox-dev');
    expect(overrides.erpExecutor).toBeDefined();
    expect(overrides.reconcileExecutor).toBeDefined();
  });

  it('refuses a value it does not know rather than guess', () => {
    expect(() => devExecutors('local', '/tmp/baox-dev')).toThrow(/BAOX_DEV_ERP/);
  });
});
