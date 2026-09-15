// The global ERP control lease (ADR-0016): at most one task drives ERP at a time, across all accounts (ADR-0018).
// Slice #191 owns acquiring and releasing it around the real ERP job; this is the read side the `start-erp-write`
// guard needs, plus an in-memory implementation that tests (and, until #191, the app) use.

export type LeaseHolder = { accountId: string; taskId: string };

export interface ErpLease {
  holder(): LeaseHolder | null;
}

export type InMemoryErpLease = ErpLease & {
  // False when another task already holds it.
  acquire(holder: LeaseHolder): boolean;
  release(taskId: string): void;
};

export function createInMemoryErpLease(): InMemoryErpLease {
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
