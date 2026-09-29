// @vitest-environment node
import type { TaskSnapshot } from '@baox/contract';
import { GOLDENS, type GoldenScenario } from '@baox/contract/goldens';
import { describe, expect, test, vi } from 'vitest';
import { createMockAdapter, type MockAdapter, type MockOptions } from './mock-adapter';

// Mock ↔ server parity (#316): each scenario the server records a golden for (server/src/snapshot-goldens.test.ts) is
// driven through the mock adapter the way a page would, and the mock's snapshot must behave like the golden.
// "Behave" is `behaviourOf`: stage, step, the allowed actions, the ERP phase and the reconcile disposition: what the
// pages branch on. Material data, ids, amounts and wording are not compared: the mock's fixture task (T1) has other
// materials than the server's scenario, on purpose.
//
// A failure here means the mock drifted from the server. Fix the mock flow (or its fixture) to do what the server does;
// never edit a golden by hand (re-record it on the server when the server's projection changed on purpose).
//
// Not compared (known drift, see the maintainer): `catalog`. The server checks the catalog inside the ERP job
// (ADR-0014) and never projects the catalog / preparation stages; the mock still runs them as auto-steps between
// project submission and review, so its review snapshot shows catalog `matched` and its `?catalog=mismatch` has no
// ERP-time counterpart. The `catalog-mismatch` golden is left out for the same reason.

function behaviourOf(snapshot: TaskSnapshot) {
  const { erp, reconcile } = snapshot;
  return {
    stage: snapshot.stage,
    step: snapshot.step.kind,
    blockers: snapshot.blockers.map((blocker) => blocker.kind),
    allowedActions: snapshot.allowedActions,
    inventory: snapshot.inventory.status,
    openPending: snapshot.pendingItems.some((item) => item.status === 'open'),
    projectAssignment: snapshot.projectAssignment.status,
    confirmation: { status: snapshot.confirmation.status, digest: snapshot.confirmation.digest !== null },
    preparation: snapshot.preparation.status,
    printSheet: snapshot.printSheet.status,
    readback: snapshot.readback.status,
    erp: {
      status: erp.status,
      currentStage: erp.currentStage,
      externalWait: erp.externalWait,
      outcome: erp.outcome,
      allowedActions: erp.allowedActions,
      failedStep: erp.steps.find((step) => step.status === 'failed')?.key ?? null,
      waitingStep: erp.steps.find((step) => step.status === 'waiting')?.key ?? null,
      draftNo: erp.draftNo !== null,
      abortReason: erp.abortReason !== null,
      loginNotice: erp.loginNotice !== null,
      erpAccount: erp.erpAccount !== null,
    },
    reconcile: {
      status: reconcile.status,
      bucket: reconcile.bucket,
      actionCode: reconcile.actionCode,
      allowedActions: reconcile.allowedActions,
      humanReview: reconcile.humanReview,
      draftNo: reconcile.draftNo !== null,
      banner: reconcile.banner !== null,
      rows: reconcile.rows.length > 0,
    },
  };
}

// Timers of the simulated server, shortened. The login is detected on its own unless a fault says otherwise.
const FAST: Partial<MockOptions> = { inventoryPhaseMs: 1, autoStepMs: 1, erpStepMs: 1, erpLoginAutoMs: 1 };

function mock(options: Partial<MockOptions> = {}): MockAdapter {
  return createMockAdapter({ seed: null, fault: null, ...FAST, ...options });
}

async function settled(adapter: MockAdapter, taskId: string, done: (snapshot: TaskSnapshot) => boolean): Promise<TaskSnapshot> {
  await vi.waitFor(async () => expect(done(await adapter.getSnapshot(taskId))).toBe(true));
  return adapter.getSnapshot(taskId);
}

function ok<T extends { ok: boolean }>(outcome: T): T {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  return outcome;
}

// The server's scenario uploads these files into a new task; the mock recognises them by business file name.
const UPLOADED = GOLDENS.upload.batches.flatMap((batch) => batch.files.map((file) => file.fileName));

async function uploaded(adapter: MockAdapter): Promise<{ taskId: string; snapshot: TaskSnapshot }> {
  const created = await adapter.createTask({ homeCity: GOLDENS.upload.task.homeCity });
  if (!created.ok) throw new Error(created.error.message);
  const taskId = created.snapshot.task.taskId;
  const files = UPLOADED.map((name) => new File([`bytes of ${name}`], name, { type: 'application/pdf' }));
  const outcome = await adapter.uploadBatch(taskId, files);
  if (!outcome.ok) throw new Error(outcome.error.message);
  return { taskId, snapshot: outcome.snapshot };
}

// 去报销 from T1 at choose_action, with the mock's fault standing in for the server's scripted ERP outcome, until `done`.
// The mock detects the login by itself (FAST.erpLoginAutoMs), like the scenario builder's scripts do.
async function afterErpWrite(fault: MockOptions['fault'], done: (snapshot: TaskSnapshot) => boolean): Promise<TaskSnapshot> {
  const adapter = mock({ seed: 'actions', fault });
  const before = await adapter.getSnapshot('T1');
  ok(await adapter.startErpWrite('T1', before.step.stepToken));
  return settled(adapter, 'T1', done);
}

type Driven = Exclude<GoldenScenario, 'catalog-mismatch'>;

const SCENES: Record<Driven, () => Promise<TaskSnapshot>> = {
  upload: async () => (await uploaded(mock())).snapshot,
  async pending() {
    const adapter = mock();
    const { taskId, snapshot } = await uploaded(adapter);
    ok(await adapter.startInventory(taskId, snapshot.step.stepToken));
    return settled(adapter, taskId, (current) => current.inventory.status === 'done');
  },
  project: () => mock({ seed: 'project' }).getSnapshot('T1'),
  review: () => mock({ seed: 'review' }).getSnapshot('T1'),
  'choose-action': () => mock({ seed: 'actions' }).getSnapshot('T1'),
  // erp-login-missing keeps the mock from detecting the login by itself: the task stays at the login wall.
  async 'erp-login-wall'() {
    const adapter = mock({ seed: 'actions', fault: 'erp-login-missing' });
    const before = await adapter.getSnapshot('T1');
    ok(await adapter.startErpWrite('T1', before.step.stepToken));
    return settled(adapter, 'T1', (snapshot) => snapshot.step.kind === 'erp_login');
  },
  'erp-stopped-before-write': () => afterErpWrite('erp-stopped-before-write', (snapshot) => snapshot.stage === 'actions'),
  'erp-unknown': () => afterErpWrite('erp-write-aborted', (snapshot) => snapshot.stage === 'reconcile'),
  'reconcile-readback-mismatch': () => afterErpWrite('readback-mismatch', (snapshot) => snapshot.stage === 'reconcile'),
  done: () => afterErpWrite(null, (snapshot) => snapshot.stage === 'done'),
  async voided() {
    const adapter = mock();
    const { taskId } = await uploaded(adapter);
    ok(await adapter.abandonTask(taskId));
    return adapter.getSnapshot(taskId);
  },
};

describe('mock ↔ 服务端对照（黄金快照）', () => {
  test.each(Object.keys(SCENES) as Driven[])('%s', async (name) => {
    const snapshot = await SCENES[name]();
    expect(behaviourOf(snapshot)).toEqual(behaviourOf(GOLDENS[name]));
  });
});
