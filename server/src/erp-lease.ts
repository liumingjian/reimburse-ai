// The global ERP control lease, ERP 自动化控制权 (ADR-0016): at most one task drives ERP at a time, across all
// accounts (ADR-0018). The fill job (`erp/fill-jobs.ts`) acquires it when a job starts and releases it on every
// result: login wait, abort, catalog mismatch, error and done.
//
// In memory on purpose: one server process owns the data directory (data-dir lock), and a restart ends every job it
// was running, so a lease never needs to outlive the process. There is no heartbeat for the same reason.

export type LeaseHolder = { accountId: string; taskId: string };

export interface ErpLease {
  holder(): LeaseHolder | null;
  // False when another task already holds it; re-acquiring by the holder succeeds.
  acquire(holder: LeaseHolder): boolean;
  // Only the holder's task releases it.
  release(taskId: string): void;
}

export type InMemoryErpLease = ErpLease;

export function createInMemoryErpLease(): ErpLease {
  let current: LeaseHolder | null = null;
  return {
    holder: () => current,
    acquire(holder) {
      if (current && current.taskId !== holder.taskId) return false;
      current = holder;
      return true;
    },
    release(taskId) {
      if (current?.taskId === taskId) current = null;
    },
  };
}
