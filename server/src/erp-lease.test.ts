import { describe, expect, it } from 'vitest';
import { createInMemoryErpLease } from './erp-lease';

// The ERP 自动化控制权 lease is keyed by job, not by task. One task runs several jobs one after another (去报销 again
// after a login pause, 重新对账 after an uncertain write), and every job releases the lease twice: on its result and
// again in its `finally`. Keyed by task, that second release freed whatever the task held -- including a newer job's
// lease -- and two ERP drivers could then drive the browser at once.

const holder = (taskId: string, jobId: string) => ({ accountId: 'account-1', taskId, jobId });

describe('the ERP control lease', () => {
  it('refuses another job while one holds it, and lets the holder re-acquire', () => {
    const lease = createInMemoryErpLease();
    expect(lease.acquire(holder('task-1', 'job-1'))).toBe(true);
    expect(lease.acquire(holder('task-2', 'job-2'))).toBe(false);
    // Another job of the same task is still another job: it waits like everyone else.
    expect(lease.acquire(holder('task-1', 'job-2'))).toBe(false);
    expect(lease.acquire(holder('task-1', 'job-1'))).toBe(true);
    expect(lease.holder()).toEqual(holder('task-1', 'job-1'));
  });

  it("an older job's release never frees a newer job's lease", () => {
    const lease = createInMemoryErpLease();
    // The first job of the task takes the lease and ends: it gives its own back.
    expect(lease.acquire(holder('task-1', 'job-1'))).toBe(true);
    lease.release('job-1');
    expect(lease.holder()).toBeNull();

    // The task starts its next job (我已登录，继续 / 重新对账), which takes the lease.
    expect(lease.acquire(holder('task-1', 'job-2'))).toBe(true);
    // The old job's second release (its `finally`) arrives late. It must be a no-op.
    lease.release('job-1');
    expect(lease.holder()).toEqual(holder('task-1', 'job-2'));
    // So no other task can slip in while job-2 still drives ERP.
    expect(lease.acquire(holder('task-2', 'job-3'))).toBe(false);
  });

  it('releases by task only for 转人工, whichever job of it holds the lease', () => {
    const lease = createInMemoryErpLease();
    expect(lease.acquire(holder('task-1', 'job-9'))).toBe(true);
    // Hand-off is terminal for the task and does not know the job id.
    lease.releaseTask('task-1');
    expect(lease.holder()).toBeNull();
    expect(lease.acquire(holder('task-2', 'job-10'))).toBe(true);
    // Another task's hand-off leaves this one alone.
    lease.releaseTask('task-1');
    expect(lease.holder()).toEqual(holder('task-2', 'job-10'));
  });
});
