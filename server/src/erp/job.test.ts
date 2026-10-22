// The server's end of the fill job protocol (spec #177 Testing Decisions): the real server channel persisting events
// and attempts on SQLite `:memory:` and judging read-backs, with the real fill job on the fake ERP at the other end.
// The job's own ERP behaviour is tested in the executor package (erp-executor/src/job.test.ts), against a stub of
// this channel.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/database';
import { createTaskService } from '../tasks';
import { createTestServer, type TestServer } from '../test/harness';
import { runFillJob } from '@baox/erp-executor/job';
import { createFakeErp, type FakeErp } from '@baox/erp-executor/testing/fake-erp';
import { approvedPreview, blobSource, FAST_PACE, fakeErpOptions, fillPlan, freshGateOf } from '@baox/erp-executor/testing/scenario';
import { createErpJobs, serverChannel, type ErpJobs } from './jobs';
import { createDraftJudge } from './judge';
import type { ExecutorChannel, ExecutorEvent } from '@baox/erp-executor/protocol';
import { judgeInputs } from './testing/judge-inputs';

let server: TestServer;
let db: Db;
let taskId: string;
let jobs: ErpJobs;

beforeEach(async () => {
  server = await createTestServer();
  db = server.db;
  const { account } = await server.signIn('alice');
  taskId = (await createTaskService(db, server.dataDir, account.accountId).create('合肥')).task.taskId;
  jobs = createErpJobs(db);
});
afterEach(() => server.close());

type Wrap = (event: ExecutorEvent, forward: () => Promise<any>) => Promise<any>;

/** The real server channel, optionally wrapped so a test can act between persistence and acknowledgement. */
function channelFor(wrap: Wrap = (_event, forward) => forward()): ExecutorChannel {
  const inner = serverChannel({ jobs, jobId: `job-${taskId}`, taskId, judge: createDraftJudge(judgeInputs(taskId)) });
  const emit = (event: ExecutorEvent) => wrap(event, () => (inner.emit as (e: ExecutorEvent) => Promise<any>)(event));
  return { emit: emit as ExecutorChannel['emit'] };
}

const run = (fake: FakeErp, channel = channelFor()) =>
  runFillJob(fillPlan(taskId), { browser: fake.browser, blobs: blobSource(), channel, pace: FAST_PACE, probeWaitMs: 0 });

describe('the server channel under a fill job on the fake ERP', () => {
  it('persists an attempt before import, fill and 暂存, with what the executor saw, and the job\'s events in order', async () => {
    const fake = await createFakeErp(fakeErpOptions({ assumeReceiptLink: true }));
    const result = await run(fake);
    expect(result, JSON.stringify(result)).toMatchObject({ type: 'result', status: 'drafted', billNo: null, code: null });

    const attempts = await jobs.attempts(`job-${taskId}`);
    expect(attempts.map((a) => a.action)).toEqual(['import', 'fill', 'save']);
    for (const attempt of attempts) {
      expect(attempt.compatibility).toEqual({ erpBuild: '8.2.830.9', formId: 'ER_ExpReimbursement' });
      expect(attempt.erpAccount).toEqual({ displayName: '刘明建', account: 'luo.liu', tenant: 'tenant-a' });
      expect(attempt.preconditions).toMatchObject({ targetId: 'erp-page-1', formInstanceId: 'a1b2c3d4e5f6', formMode: 'new', billNo: null,
        url: 'http://erp.antute.com.cn/k3cloud/html5/index.aspx' });
    }
    expect(attempts[0]!.preconditions.receiptRowCount).toBe(0);
    expect(attempts[1]!.preconditions.receiptRowCount).toBe(2);

    const events = await jobs.events(`job-${taskId}`);
    expect(events.filter((e) => e.type === 'readback').map((e) => (e as { stage: string }).stage)).toEqual(['after_import', 'after_fill', 'before_hand_over']);
    expect(events.at(-1)).toMatchObject({ type: 'result', status: 'drafted' });
  });

  it('acknowledges attempt_started only once the attempt row is durable', async () => {
    const fake = await createFakeErp(fakeErpOptions({ assumeReceiptLink: true }));
    const durableAtAck: boolean[] = [];
    const channel = channelFor(async (event, forward) => {
      const reply = await forward();
      if (event.type === 'attempt_started') {
        durableAtAck.push((await jobs.attempts(`job-${taskId}`)).some((a) => a.attemptId === event.attemptId));
      }
      return reply;
    });
    expect((await run(fake, channel)).status).toBe('drafted');
    expect(durableAtAck).toEqual([true, true, true]);
  });

  // The executor tests stand in for this judge with a recorded preview (erp-executor/src/testing/scenario.ts). If
  // the judge's preview changes, re-record it there, or the executor tests go on filling a form the server would no
  // longer approve.
  it('approves after import exactly the preview the executor tests stand in with', async () => {
    const fake = await createFakeErp(fakeErpOptions({ assumeReceiptLink: true }));
    const verdicts: any[] = [];
    await run(fake, channelFor(async (event, forward) => {
      const reply = await forward();
      if (event.type === 'readback' && event.stage === 'after_import') verdicts.push(reply);
      return reply;
    }));
    const expected = approvedPreview(taskId);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ ok: true, preview: expected, approval: { digest: expected.previewDigest }, freshGate: freshGateOf(expected) });
  });

  // 「不生成费用明细」 leaves 收票单号 empty on every 费用明细行 — ERP's behaviour, recorded in the research and
  // reproduced by the fake. It used to fail the read-back and end 13 correctly filled rows as 结果不确定. The owner
  // decided 2026-09-20 that the totals are what must agree, so an empty link no longer stops the hand-over (ADR-0023).
  it('暂存s a filled form whose 收票单号 ERP left empty, because the totals still agree', async () => {
    const fake = await createFakeErp(fakeErpOptions());
    const result = await run(fake);
    expect(result).toMatchObject({ type: 'result', status: 'drafted' });
    expect(fake.mutations.some((m) => m.kind === 'save')).toBe(false);
    expect((await jobs.attempts(`job-${taskId}`)).map((a) => a.action)).toEqual(['import', 'fill', 'save']);
  });
});
