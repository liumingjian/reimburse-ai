import { OCCUPANCY_COPY } from '@baox/contract';
import { describe, expect, it } from 'vitest';
import { occupancyClash, type OccupancyLedger } from './occupancy';

// 发票占用 (invoice occupancy) is global across accounts (ADR-0018); how a clash reads depends on who asks.
// The ledger is a stub here: #187 plugs in the real one.

const ledger: OccupancyLedger = {
  occupant: (invoiceKey) =>
    invoiceKey === 'inv-1' ? { accountId: 'acc-alice', taskId: 'task-alice', taskName: '2026-08 上海出差' } : null,
};

describe('occupancy clash', () => {
  it('is no clash for a free invoice', async () => {
    expect(await occupancyClash(ledger, 'acc-bob', 'inv-2')).toBeNull();
  });

  it("names the owner's own task", async () => {
    expect(await occupancyClash(ledger, 'acc-alice', 'inv-1')).toEqual({ scope: 'own_task', task: { taskId: 'task-alice', name: '2026-08 上海出差' } });
  });

  it("says only 'occupied by another account's task' across accounts", async () => {
    const clash = await occupancyClash(ledger, 'acc-bob', 'inv-1');
    expect(clash).toEqual({ scope: 'other_account', reason: OCCUPANCY_COPY.otherAccount });
    const text = JSON.stringify(clash);
    for (const leak of ['acc-alice', 'task-alice', '上海出差']) expect(text).not.toContain(leak);
  });
});
