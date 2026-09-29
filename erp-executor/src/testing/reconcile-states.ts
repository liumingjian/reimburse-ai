// Recorded draft states for the reconcile tests: each drives the fake ERP with the real fill job (scenario.ts) and
// stops it at one point, leaving the form as a crash there would. The kernel golden
// (server/src/erp/testing/reconcile-parity.golden.json) was recorded from the same states.

import { runFillJob } from '../job';
import { createFakeErp, type FakeErp } from './fake-erp';
import type { ApprovedPreview, ExecutorChannel, ExecutorEvent, Mutation, ResultEvent } from '../protocol';
import { blobSource, FAST_PACE, fakeErpOptions, fillPlan } from './scenario';
import { stubServer } from './stub-server';

export const RECONCILE_STATES = [
  'no_form', // logged in, no expense form open
  'blank_form', // new form opened, stopped before import (the fixture's blank detail row is unreadable)
  'blank_form_no_detail_row', // same, with the blank detail row removed
  'imported', // stopped before fill: receipts imported, no detail written
  'filled', // the fill job ran to its hand-over: detail rows linked to receipts, nothing saved
  'filled_unlinked', // fill done but receipt number (收票单号) left empty, as ERP leaves it; the strict read-back tolerates that (ADR-0023)
  'saved', // the fill job handed over and then the employee clicked 保存 (save) themselves (ADR-0028)
] as const;
export type ReconcileState = (typeof RECONCILE_STATES)[number];

// `filled` needs no stop: the job's last step is a read-only hand-over, so it leaves the same filled, unsaved form.
const STOP_BEFORE: Partial<Record<ReconcileState, Mutation>> = {
  blank_form: 'import', blank_form_no_detail_row: 'import', imported: 'fill',
};

/** The fake ERP left in `state`, and the approved preview the fill had reached (null before import). */
export async function driveTo(state: ReconcileState, taskId = 'task-reconcile'): Promise<{ fake: FakeErp; preview: ApprovedPreview | null; fill: ResultEvent | null }> {
  const fake = await createFakeErp(fakeErpOptions({ assumeReceiptLink: state !== 'filled_unlinked' }));
  if (state === 'no_form') return { fake, preview: null, fill: null };
  const server = stubServer({ taskId });
  let preview: ApprovedPreview | null = null;
  const emit = async (event: ExecutorEvent) => {
    if (event.type === 'attempt_started' && event.action === STOP_BEFORE[state]) throw new Error(`stopped before ${event.action}`);
    const reply = await (server.channel.emit as (e: ExecutorEvent) => Promise<any>)(event);
    if (event.type === 'readback' && reply?.preview) preview = reply.preview;
    return reply;
  };
  const fill = await runFillJob(fillPlan(taskId), {
    browser: fake.browser, blobs: blobSource(), channel: { emit: emit as ExecutorChannel['emit'] }, pace: FAST_PACE, probeWaitMs: 0,
  });
  if (state === 'saved') fake.employeeSaves();
  if (state === 'blank_form_no_detail_row') fake.document.querySelector('.kd-grid-panel[data-grid="detail"] tbody tr.k-master-row')?.remove();
  return { fake, preview, fill };
}
