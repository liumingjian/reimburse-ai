// 自动重新去报销 (ADR-0034) on the executor's side: a plan with `rerun` asks ERP, read-only and before anything is
// uploaded, whether the task's bill already landed. Any sign of it, or no answer, ends the run with nothing written.
import { beforeEach, describe, expect, it } from 'vitest';
import { runFillJob } from './job';
import { createFakeErp, type FakeErpOptions } from './testing/fake-erp';
import { blobSource, FAST_PACE, fakeErpOptions, fillPlan, INVOICES } from './testing/scenario';
import { stubServer, type StubServer } from './testing/stub-server';

const taskId = 'task-rerun';
const EARLIER = 'baox-0a1b2c3d4e';
const MARK = 'baox-k3m9q2x7v1';
let server: StubServer;
beforeEach(() => { server = stubServer({ taskId }); });

const rerun = async (options: Partial<FakeErpOptions> = {}, occupancyField?: string | null) => {
  const fake = await createFakeErp(fakeErpOptions({ assumeReceiptLink: true, ...options }));
  const plan = { ...fillPlan(taskId), draft: { mark: MARK }, rerun: { invoiceNos: INVOICES.map((invoice) => invoice.invoiceNumber), marks: [EARLIER] } };
  const result = await runFillJob(plan, { browser: fake.browser, blobs: blobSource(), channel: server.channel, pace: FAST_PACE, probeWaitMs: 0, ...(occupancyField !== undefined ? { occupancyField } : {}) });
  return { fake, result };
};
const wrote = (fake: Awaited<ReturnType<typeof createFakeErp>>) => fake.mutations.filter((m) => m.kind === 'import' || m.kind === 'draft' || m.kind === 'save');

describe('自动重新去报销 on the executor', () => {
  it('goes on to a draft when no bill holds the invoices and no earlier mark was drafted', async () => {
    const { result } = await rerun();
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'drafted' });
    expect(server.attempts.map((a) => a.action)).toEqual(['import', 'fill', 'save']);
  });

  it('stops before uploading, with no attempt, when a bill already holds one of the invoices', async () => {
    const { fake, result } = await rerun({ heldInvoices: { [INVOICES[1]!.invoiceNumber]: 'FYBX20260911000011' } });
    expect(result).toMatchObject({ status: 'aborted', code: 'rerun_invoice_held' });
    expect(result.message).toContain('FYBX20260911000011');
    expect(result.message).not.toMatch(/ERP|[\u2013\u2014]/);
    expect(server.attempts).toEqual([]);
    expect(wrote(fake)).toEqual([]);
  });

  it('counts a 暂存 draft with no 单据编号 as holding the invoice', async () => {
    const { result } = await rerun({ heldInvoices: { [INVOICES[0]!.invoiceNumber]: '' } });
    expect(result).toMatchObject({ status: 'aborted', code: 'rerun_invoice_held' });
    expect(result.message).toContain('暂存单');
  });

  it('stops when a draft carries the mark of an earlier job of the task', async () => {
    const { fake, result } = await rerun({ draftsBefore: [`出差 ${EARLIER}`] });
    expect(result).toMatchObject({ status: 'aborted', code: 'rerun_draft_found' });
    expect(server.attempts).toEqual([]);
    expect(wrote(fake)).toEqual([]);
  });

  it('stops when ERP cannot answer, rather than taking silence for a clear field', async () => {
    const { fake, result } = await rerun({ occupancyQueryFails: true });
    expect(result).toMatchObject({ status: 'aborted', code: 'rerun_check_failed' });
    expect(result.message).not.toMatch(/ERP|字段/);
    expect(wrote(fake)).toEqual([]);
  });

  it('stops every re-run as unanswered when it has no field to ask about', async () => {
    const { fake, result } = await rerun({}, null);
    expect(result).toMatchObject({ status: 'aborted', code: 'rerun_check_failed' });
    expect(wrote(fake)).toEqual([]);
  });

  it('asks nothing on a first run', async () => {
    const fake = await createFakeErp(fakeErpOptions({ assumeReceiptLink: true, heldInvoices: { [INVOICES[0]!.invoiceNumber]: 'FYBX20260911000011' }, draftsBefore: [`出差 ${EARLIER}`] }));
    const result = await runFillJob({ ...fillPlan(taskId), draft: { mark: MARK } }, { browser: fake.browser, blobs: blobSource(), channel: server.channel, pace: FAST_PACE, probeWaitMs: 0 });
    expect(result).toMatchObject({ status: 'drafted' });
  });
});
