import { describe, expect, it } from 'vitest';
import { storedEvents } from './stored-event';
import { phaseOf } from './fill-state';
import type { ResultEvent } from '@baox/erp-executor/protocol';

// Jobs recorded before #436 still carry the attended path's events; reading them must not fail the task list.
const result = (status: string, code: string | null = null) =>
  ({ payload: JSON.stringify({ type: 'result', status, code, message: null, billNo: null, capture: null }) });

describe('reading stored job events', () => {
  it('reads a legacy handed_over result as saved, a closed task', () => {
    const [event] = storedEvents([result('handed_over')]);
    expect(event).toMatchObject({ type: 'result', status: 'saved' });
    expect(phaseOf(event as ResultEvent)).toBe('saved');
  });

  it('reads a legacy waiting_login result as aborted erp_login, and drops the waiting_login notice', () => {
    const events = storedEvents([
      { payload: JSON.stringify({ type: 'step', step: 'login', status: 'running' }) },
      { payload: JSON.stringify({ type: 'waiting_login', hint: '请在为这次报销打开的报销系统标签页中登录' }) },
      result('waiting_login', 'erp_login'),
    ]);
    expect(events.map((event) => event.type)).toEqual(['step', 'result']);
    expect(events[1]).toMatchObject({ status: 'aborted', code: 'erp_login' });
  });

  it('still refuses a payload no protocol ever had', () => {
    expect(() => storedEvents([result('mystery')])).toThrow();
  });
});
