import { OCCUPANCY_COPY, type Blocker } from '@baox/contract';
import type { Claim } from './inventory-view';

// 发票占用 (invoice occupancy) over real facts: every other task that still holds invoices (open, or handed off
// after touching ERP) claims the invoice identities of its current inventory. A voided task holds nothing.
// Between two tasks the earlier upload holds the invoice; a handed-off task always does (ERP may have consumed it).
// #195 adds imported legacy holdings as more `Holding`s.
//
// Every occupancy is owned by the 报销任务 (reimbursement task) that created it: `Holding.taskId`. That ownership is
// what decides whether it blocks an import. The ERP-side 收票占用 (receipt occupancy) an import leaves behind is the
// same hold read from the other side and is owned by the same task, so one rule covers both (ADR-0025).

export type Holding = { accountId: string; taskId: string; taskName: string; handedOff: boolean; claims: readonly Claim[] };

// Times have second precision: uploads in the same second fall back to the global upload order (material rowid),
// never to the random material id.
const precedes = (a: Claim, b: Claim) => a.at < b.at || (a.at === b.at && a.seq < b.seq);

// The holding that occupies `mine`, as the claim sees it: a holding counts only if its hold precedes the claim, or it
// was handed off.
function occupantOf(holdings: readonly Holding[], mine: Claim): Holding | undefined {
  return holdings.find((holding) => {
    const claim = holding.claims.find((candidate) => candidate.key === mine.key);
    return claim && (holding.handedOff || precedes(claim, mine));
  });
}

export const OCCUPANCY_REASON = {
  ownTask: (name: string) => `这张发票在报销任务「${name}」里也在，那个任务仍占用它。`,
} as const;

// The `duplicate_across_tasks` blockers of the claims `importingTaskId` is about to take into ERP. Another account's
// task is never named (ADR-0018).
//
// An occupancy the importing task owns is not a blocker on that task: re-importing invoices this same 报销任务
// already holds is permitted, which is what keeps a recovery after an import that was never saved reachable
// (ADR-0026). An occupancy owned by any other task stays a hard block, unchanged from ADR-0007.
// 发票占用 is global across accounts (ADR-0018): the owner sees their own task, any other account learns only that
// another account's task holds the invoice.
export async function occupancyBlockers(holdings: readonly Holding[], viewerAccountId: string, importingTaskId: string, claims: readonly Claim[]): Promise<Blocker[]> {
  const others = holdings.filter((holding) => holding.taskId !== importingTaskId);
  const blockers: Blocker[] = [];
  for (const claim of claims) {
    const occupant = occupantOf(others, claim);
    if (!occupant) continue;
    const base = { kind: 'duplicate_across_tasks' as const, materialId: claim.materialId, fileName: claim.fileName, resolver: '要你处理' as const };
    blockers.push(occupant.accountId === viewerAccountId
      ? { ...base, reason: OCCUPANCY_REASON.ownTask(occupant.taskName), tasks: [{ taskId: occupant.taskId, name: occupant.taskName }] }
      : { ...base, reason: OCCUPANCY_COPY.otherAccount, tasks: [] });
  }
  return blockers;
}
