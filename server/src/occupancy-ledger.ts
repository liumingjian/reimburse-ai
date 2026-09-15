import type { Blocker } from '@baox/contract';
import { occupancyClash, type OccupancyLedger } from './accounts/occupancy';
import type { Claim } from './inventory-view';

// 发票占用 (invoice occupancy) over real facts: every other task that still holds invoices (open, or handed off
// after touching ERP) claims the invoice identities of its current inventory. A voided task holds nothing.
// Between two tasks the earlier upload holds the invoice; a handed-off task always does (ERP may have consumed it).
// #195 adds imported legacy holdings as more `Holding`s.

export type Holding = { accountId: string; taskId: string; taskName: string; handedOff: boolean; claims: readonly Claim[] };

const precedes = (a: Claim, b: Claim) => a.at < b.at || (a.at === b.at && a.materialId < b.materialId);

// The ledger as one of the viewer's claims sees it: an occupant only if its hold precedes that claim.
export function ledgerFor(holdings: readonly Holding[], mine: Claim): OccupancyLedger {
  return {
    occupant(invoiceKey) {
      for (const holding of holdings) {
        const claim = holding.claims.find((candidate) => candidate.key === invoiceKey);
        if (claim && (holding.handedOff || precedes(claim, mine))) return { accountId: holding.accountId, taskId: holding.taskId, taskName: holding.taskName };
      }
      return null;
    },
  };
}

export const OCCUPANCY_REASON = {
  ownTask: (name: string) => `这张发票在报销任务「${name}」里也在，那个任务仍占用它。`,
} as const;

// The `duplicate_across_tasks` blockers of the viewer's claims. Another account's task is never named (ADR-0018).
export async function occupancyBlockers(holdings: readonly Holding[], viewerAccountId: string, claims: readonly Claim[]): Promise<Blocker[]> {
  const blockers: Blocker[] = [];
  for (const claim of claims) {
    const clash = await occupancyClash(ledgerFor(holdings, claim), viewerAccountId, claim.key);
    if (!clash) continue;
    const base = { kind: 'duplicate_across_tasks' as const, materialId: claim.materialId, fileName: claim.fileName, resolver: '要你处理' as const };
    blockers.push(clash.scope === 'own_task' ? { ...base, reason: OCCUPANCY_REASON.ownTask(clash.task.name), tasks: [clash.task] } : { ...base, reason: clash.reason, tasks: [] });
  }
  return blockers;
}
