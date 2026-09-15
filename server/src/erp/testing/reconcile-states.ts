// Recorded draft states for the reconcile parity test: each drives the fake ERP with the real fill job (scenario.ts)
// and stops it at one point, leaving the form as a crash there would. The kernel golden
// (reconcile-parity.golden.json) was recorded from the same states.

import { runFillJob } from '../executor/job';
import { createFakeErp, type FakeErp } from '../executor/testing/fake-erp';
import { createDraftJudge } from '../judge';
import type { ApprovedPreview, ExecutorChannel, ExecutorEvent, Mutation, ResultEvent } from '../protocol';
import { blobSource, FAST_PACE, fakeErpOptions, fillPlan, judgeInputs } from './scenario';

export const RECONCILE_STATES = [
  'no_form', // logged in, no expense form open
  'blank_form', // new form opened, stopped before import (the fixture's blank detail row is unreadable)
  'blank_form_no_detail_row', // same, with the blank detail row removed
  'imported', // stopped before fill: receipts imported, no detail written
  'filled', // stopped before save, detail rows linked to receipts
  'filled_unlinked', // fill done but 收票单号 left empty (research default); the strict read-back fails
  'saved', // the whole fill job ran and saved
] as const;
export type ReconcileState = (typeof RECONCILE_STATES)[number];

const STOP_BEFORE: Partial<Record<ReconcileState, Mutation>> = {
  blank_form: 'import', blank_form_no_detail_row: 'import', imported: 'fill', filled: 'save',
};

/** The fake ERP left in `state`, and the approved preview the fill had reached (null before import). */
export async function driveTo(state: ReconcileState, taskId = 'task-reconcile'): Promise<{ fake: FakeErp; preview: ApprovedPreview | null; fill: ResultEvent | null }> {
  const fake = await createFakeErp(fakeErpOptions({ assumeReceiptLink: state !== 'filled_unlinked' }));
  if (state === 'no_form') return { fake, preview: null, fill: null };
  const judge = createDraftJudge(judgeInputs(taskId));
  let preview: ApprovedPreview | null = null;
  const emit = async (event: ExecutorEvent) => {
    if (event.type === 'attempt_started') {
      if (event.action === STOP_BEFORE[state]) throw new Error(`stopped before ${event.action}`);
      return { persisted: true };
    }
    if (event.type === 'readback') {
      const verdict = await judge(event, { erpAccount: null });
      if (verdict.ok && verdict.preview) preview = verdict.preview;
      return verdict;
    }
    return undefined;
  };
  const fill = await runFillJob(fillPlan(taskId), {
    browser: fake.browser, blobs: blobSource(), channel: { emit: emit as ExecutorChannel['emit'] }, pace: FAST_PACE, probeWaitMs: 0,
  });
  if (state === 'blank_form_no_detail_row') fake.document.querySelector('.kd-grid-panel[data-grid="detail"] tbody tr.k-master-row')?.remove();
  return { fake, preview, fill };
}
