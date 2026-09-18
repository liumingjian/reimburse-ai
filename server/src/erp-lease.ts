// The global ERP control lease, ERP 自动化控制权 (ADR-0016): at most one job drives ERP at a time, across all
// accounts (ADR-0018). The action that starts a job acquires it (`tasks.ts`); the job gives it back on every result:
// login wait, abort, catalog mismatch, error and done.
//
// Keyed by job, not by task. One task runs several jobs one after another (去报销 again after a login pause, 重新对账
// after an uncertain write), and an older job's clean-up must never free the lease a newer job of the same task has
// just taken -- that would let two ERP drivers run at once.
//
// In memory on purpose: one server process owns the data directory (data-dir lock), and a restart ends every job it
// was running, so a lease never needs to outlive the process. There is no heartbeat for the same reason.

export type LeaseHolder = { accountId: string; taskId: string; jobId: string };

export interface ErpLease {
  holder(): LeaseHolder | null;
  // False when another job already holds it; re-acquiring by the same job succeeds.
  acquire(holder: LeaseHolder): boolean;
  // Only the job that holds the lease gives it back; an older job's release is a no-op.
  release(jobId: string): void;
  // 转人工 (hand off) and other task-level ends: gives up whatever this task still holds, whichever job took it.
  releaseTask(taskId: string): void;
}

export type InMemoryErpLease = ErpLease;

export function createInMemoryErpLease(): ErpLease {
  let current: LeaseHolder | null = null;
  return {
    holder: () => current,
    acquire(holder) {
      if (current && current.jobId !== holder.jobId) return false;
      current = holder;
      return true;
    },
    release(jobId) {
      if (current?.jobId === jobId) current = null;
    },
    releaseTask(taskId) {
      if (current?.taskId === taskId) current = null;
    },
  };
}
