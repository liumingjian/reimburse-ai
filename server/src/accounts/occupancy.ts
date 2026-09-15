import { OCCUPANCY_COPY } from '@baox/contract';

// 发票占用 (invoice occupancy) is global: a legal invoice is reimbursed once, by anyone (ADR-0018). What a clash may
// reveal depends on who asks: the owner sees their own task; any other account learns only that another account's
// task holds it. #187 implements `OccupancyLedger` over its occupancy facts and builds blockers from the clash.

export type Occupant = { accountId: string; taskId: string; taskName: string };

export interface OccupancyLedger {
  // The task that currently occupies this invoice identity, or null when it is free.
  occupant(invoiceKey: string): Occupant | null | Promise<Occupant | null>;
}

export type OccupancyClash =
  | { scope: 'own_task'; task: { taskId: string; name: string } }
  | { scope: 'other_account'; reason: string };

export async function occupancyClash(ledger: OccupancyLedger, viewerAccountId: string, invoiceKey: string): Promise<OccupancyClash | null> {
  const occupant = await ledger.occupant(invoiceKey);
  if (!occupant) return null;
  if (occupant.accountId === viewerAccountId) return { scope: 'own_task', task: { taskId: occupant.taskId, name: occupant.taskName } };
  return { scope: 'other_account', reason: OCCUPANCY_COPY.otherAccount };
}
