// The ERP control lease, ERP 自动化控制权 (ERP automation control) (ADR-0016), partitioned by 应用账号 (app account)
// id (ADR-0019): at most one job per account drives that account's ERP at a time, and two accounts never block each
// other. The action that starts a job acquires it (`tasks.ts`); the job gives it back on every result: login wait,
// abort, catalog mismatch, error and done.
//
// Within an account the lease is keyed by job, not by task. One task runs several jobs one after another (去报销 again
// after a login pause, 重新对账 after an uncertain write), and an older job's clean-up must never free the lease a newer
// job of the same task has just taken -- that would let two ERP drivers run at once.
//
// `release` and `releaseTask` name no account because job ids and task ids are unique across accounts: each can match
// the holder of at most one partition.
//
// In memory on purpose: one server process owns the data directory (data-dir lock), and a restart ends every job it
// was running, so a lease never needs to outlive the process. There is no heartbeat for the same reason.
//
// A job run in the paired 本地执行器 (local executor) keeps its lease across a lost connection: inside the
// reconnection window the job is interrupted, not over, and a second 去报销 of the same account must not start while
// the first may still resume (ADR-0020). It gives the lease back when it ends, like every job — resumed and finished,
// or past the window (`erp/remote-executor.ts`).

export type LeaseHolder = { accountId: string; taskId: string; jobId: string };

export interface ErpLease {
  // The job driving ERP for this account, if any. Another account's job is never the answer.
  holder(accountId: string): LeaseHolder | null;
  // False when another job of the same account already holds it; re-acquiring by the same job succeeds.
  acquire(holder: LeaseHolder): boolean;
  // Only the job that holds the lease gives it back; an older job's release is a no-op.
  release(jobId: string): void;
  // 转人工 (hand off) and other task-level ends: gives up whatever this task still holds, whichever job took it.
  releaseTask(taskId: string): void;
}

export function createInMemoryErpLease(): ErpLease {
  const byAccount = new Map<string, LeaseHolder>();
  const forget = (match: (held: LeaseHolder) => boolean) => {
    for (const [accountId, held] of byAccount) if (match(held)) byAccount.delete(accountId);
  };
  return {
    holder: (accountId) => byAccount.get(accountId) ?? null,
    acquire(holder) {
      const current = byAccount.get(holder.accountId);
      if (current && current.jobId !== holder.jobId) return false;
      byAccount.set(holder.accountId, holder);
      return true;
    },
    release(jobId) {
      forget((held) => held.jobId === jobId);
    },
    releaseTask(taskId) {
      forget((held) => held.taskId === taskId);
    },
  };
}
