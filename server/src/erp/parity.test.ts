// Parity (spec #177): a job driven through the protocol on the fake ERP produces the same read-backs as the kernel
// on the same inputs. The kernel handed the form over unsaved; the job now goes on to 暂存 it (ADR-0037), so it writes
// the kernel's mutations with the ownership marker after the 事由, then presses 暂存. The golden was recorded by driving the kernel's own CDP path (50931a3:kernel/src/erpwrite-cdp.mjs,
// erp-browser-adapters.mjs, erp-cdp-read.mjs + erpreconcile.mjs readReconciliation, erp-write-readback.mjs,
// erp-draft-flow.mjs) against a fresh fake ERP with the same scenario; see the golden's `_origin`.
//
// It runs twice: once with the executor attached to the fake ERP directly, as the server's CDP executor attaches to its
// Chromium, and once through the 本地执行器's runner (`@baox/local-executor/runner`), with the fake ERP standing in
// for its headless Chromium: the plan arrives as `erp.fill` with the 凭据, and every event goes back through the job's
// link. Same golden for both: the runner changes the transport around the page logic, and nothing it reads or writes.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTaskService } from '../tasks';
import { createTestServer, type TestServer } from '../test/harness';
import { runFillJob } from '@baox/erp-executor/job';
import { createFakeErp, type FakeErp } from '@baox/erp-executor/testing/fake-erp';
import { channelWatch } from '@baox/channel/connection';
import { createLocalRunner } from '@baox/local-executor/runner';
import { createErpJobs, serverChannel } from './jobs';
import { createDraftJudge } from './judge';
import type { ExecutorChannel, ExecutorEvent, FillPlan, ResultEvent } from '@baox/erp-executor/protocol';
import { EXECUTOR_METHODS, type JobEventRequest } from '@baox/erp-executor/wire';
import { blobSource, DRAFT_MARK_OF_TEST, ERP_ORIGIN, FAST_PACE, fakeErpOptions, fillPlan, withoutLayout } from '@baox/erp-executor/testing/scenario';
import { judgeInputs } from './testing/judge-inputs';

const golden = JSON.parse(readFileSync(new URL('./testing/kernel-parity.golden.json', import.meta.url), 'utf8'));

let server: TestServer;
beforeEach(async () => { server = await createTestServer(); });
afterEach(() => server.close());

type Route = (fake: FakeErp, plan: FillPlan, emit: ExecutorChannel['emit']) => Promise<ResultEvent>;
const directly: Route = (fake, plan, emit) => runFillJob(plan, { browser: fake.browser, blobs: blobSource(), channel: { emit }, pace: FAST_PACE, probeWaitMs: 0 });
const throughTheLocalExecutor: Route = async (fake, plan, emit) => {
  const connection = channelWatch();
  connection.status({ state: 'ready', accountId: 'account-parity' });
  const run = createLocalRunner({
    request: async (method, payload) => (method === EXECUTOR_METHODS.event ? (emit as (event: ExecutorEvent) => Promise<unknown>)((payload as JobEventRequest).event) : null),
    connection,
    blobs: blobSource(),
    launch: async () => ({ port: 0, browser: fake.browser, close: async () => {} }),
    pace: FAST_PACE,
  });
  return await run(EXECUTOR_METHODS.fill, { plan, trigger: 'start', credentials: { account: 'zhangsan', password: 'erp-Pa55' } }) as ResultEvent;
};

describe.each([
  ['attached directly', directly],
  ['through the 本地执行器\'s runner', throughTheLocalExecutor],
])('kernel parity of the fill job, %s', (_how, routeOf) => {
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
    const result = await routeOf(fake, fillPlan(taskId, { jobId: 'job-parity' }), emit as ExecutorChannel['emit']);

    const strip = (stage: string) => JSON.parse(JSON.stringify(observed[stage] ?? null));
    for (const stage of ['after_import', 'after_fill', 'before_hand_over']) {
      expect(strip(stage), stage).toEqual(golden.readbacks[stage]);
    }
    expect(previewDigest).toBe(golden.previewDigest);
    const marked = (golden.mutations as Array<{ kind: string; detail: string }>)
      .map((m) => (m.kind === 'header' && m.detail.startsWith('FCAUSA=') ? { ...m, detail: `${m.detail} ${DRAFT_MARK_OF_TEST}` } : m));
    expect(fake.mutations).toEqual([...marked, { kind: 'draft', detail: expect.any(String) }]);
    expect(golden.result).toEqual({ status: 'handed_over', billNo: null });
    expect({ status: result.status, billNo: result.billNo }).toEqual({ status: 'drafted', billNo: null });
  });
});
