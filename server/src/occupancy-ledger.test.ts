import { OCCUPANCY_COPY } from '@baox/contract';
import { describe, expect, it } from 'vitest';
import type { Claim } from './inventory-view';
import { occupancyBlockers, OCCUPANCY_REASON, type Holding } from './occupancy-ledger';

// Every occupancy records the 报销任务 (reimbursement task) that owns it, and that ownership decides the verdict:
// the owning task may take the same invoices into ERP again (#238, ADR-0026), any other task is hard-blocked
// (ADR-0007).

const INVOICE = 'einvoice-20:23317000000012345678';

// What the importing task claims: uploaded after the holding below, so it never wins on time.
const mine: Claim = { key: INVOICE, materialId: 'mat-mine', fileName: '高铁票.pdf', at: '2026-09-02T09:00:00Z', seq: 7 };

function holding(over: Partial<Holding> = {}): Holding {
  return {
    accountId: 'acc-alice',
    taskId: 'task-first',
    taskName: '2026-08 上海出差',
    handedOff: false,
    claims: [{ key: INVOICE, materialId: 'mat-held', fileName: '高铁票.pdf', at: '2026-09-01T09:00:00Z', seq: 3 }],
    ...over,
  };
}

const blockersFor = (holdings: readonly Holding[], importingTaskId: string, viewerAccountId = 'acc-alice') =>
  occupancyBlockers(holdings, viewerAccountId, importingTaskId, [mine]);

describe('occupancy ownership', () => {
  it('does not block the task that owns the occupancy: the same 报销任务 may import its invoices again', async () => {
    expect(await blockersFor([holding({ taskId: 'task-mine' })], 'task-mine')).toEqual([]);
  });

  it('does not block the owning task once it has handed off either: ownership beats the handed-off hold', async () => {
    expect(await blockersFor([holding({ taskId: 'task-mine', handedOff: true })], 'task-mine')).toEqual([]);
  });

  it('blocks another task of the same account, naming the task that holds the invoice', async () => {
    expect(await blockersFor([holding()], 'task-second')).toEqual([
      {
        kind: 'duplicate_across_tasks',
        materialId: mine.materialId,
        fileName: mine.fileName,
        reason: OCCUPANCY_REASON.ownTask('2026-08 上海出差'),
        resolver: '要你处理',
        tasks: [{ taskId: 'task-first', name: '2026-08 上海出差' }],
      },
    ]);
  });

  it('blocks another account task without naming it (ADR-0018)', async () => {
    expect(await blockersFor([holding({ accountId: 'acc-bob' })], 'task-second')).toEqual([
      { kind: 'duplicate_across_tasks', materialId: mine.materialId, fileName: mine.fileName, reason: OCCUPANCY_COPY.otherAccount, resolver: '要你处理', tasks: [] },
    ]);
  });
});
