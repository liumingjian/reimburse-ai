// Parity (spec #177): a job driven through the protocol on the fake ERP produces the same read-backs as the kernel
// on the same inputs. The golden was recorded by driving the kernel's own CDP path (50931a3:kernel/src/erpwrite-cdp.mjs,
// erp-browser-adapters.mjs, erp-cdp-read.mjs + erpreconcile.mjs readReconciliation, erp-write-readback.mjs,
// erp-draft-flow.mjs) against a fresh fake ERP with the same scenario; see the golden's `_origin`.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTaskService } from '../tasks';
import { createTestServer, type TestServer } from '../test/harness';
import { runFillJob } from './executor/job';
import { createFakeErp } from './executor/testing/fake-erp';
import { createErpJobs, serverChannel } from './jobs';
import { createDraftJudge } from './judge';
import type { ExecutorChannel, ExecutorEvent } from './protocol';
import { blobSource, FAST_PACE, fakeErpOptions, fillPlan, judgeInputs, withoutLayout } from './testing/scenario';

const golden = JSON.parse(readFileSync(new URL('./testing/kernel-parity.golden.json', import.meta.url), 'utf8'));

let server: TestServer;
beforeEach(async () => { server = await createTestServer(); });
afterEach(() => server.close());

describe('kernel parity of the fill job', () => {
  it('reads back what the kernel reads back, verdict for verdict, and writes the same ERP mutations', async () => {
    // The golden's task id is fixed; create a task row for the FK and judge with the golden's id in the facts.
    const { account } = await server.signIn('alice');
    const taskId = (await createTaskService(server.db, server.dataDir, account.accountId).create('合肥')).task.taskId;
    const inner = serverChannel({ jobs: createErpJobs(server.db), jobId: 'job-parity', taskId, judge: createDraftJudge(judgeInputs(golden.taskId)) });
    const observed: Record<string, unknown> = {};
    let previewDigest: string | undefined;
    const emit = async (event: ExecutorEvent) => {
      const reply = await (inner.emit as (e: ExecutorEvent) => Promise<any>)(event);
      if (event.type === 'readback') {
        observed[event.stage] = { ...withoutLayout(event.readings), taskMatch: event.stage === 'after_import' ? undefined : reply.ok };
        if (event.stage === 'after_import') previewDigest = reply.preview?.previewDigest;
      }
      return reply;
    };
    const fake = await createFakeErp(fakeErpOptions({ assumeReceiptLink: true }));
    const result = await runFillJob(fillPlan(taskId, { jobId: 'job-parity' }), {
      browser: fake.browser, blobs: blobSource(), channel: { emit: emit as ExecutorChannel['emit'] }, pace: FAST_PACE, probeWaitMs: 0,
    });

    const strip = (stage: string) => JSON.parse(JSON.stringify(observed[stage] ?? null));
    for (const stage of ['after_import', 'after_fill', 'before_save', 'after_save']) {
      expect(strip(stage), stage).toEqual(golden.readbacks[stage]);
    }
    expect(previewDigest).toBe(golden.previewDigest);
    expect(fake.mutations).toEqual(golden.mutations);
    expect({ status: result.status, billNo: result.billNo }).toEqual(golden.result);
  });
});
