// Parity (spec #177): a job driven through the protocol on the fake ERP produces the same read-backs as the kernel
// on the same inputs. The golden was recorded by driving the kernel's own CDP path (50931a3:kernel/src/erpwrite-cdp.mjs,
// erp-browser-adapters.mjs, erp-cdp-read.mjs + erpreconcile.mjs readReconciliation, erp-write-readback.mjs,
// erp-draft-flow.mjs) against a fresh fake ERP with the same scenario; see the golden's `_origin`.
//
// It runs twice: once with the executor attached to the fake ERP directly, as the server's CDP executor attaches to its
// Chromium, and once through the browser extension's `chrome.debugger` adapter and dedicated-tab browser, with
// `chrome.*` faked over the same fake ERP (spec #246, seam 1). Same golden for both: the extension changes the
// transport under the page logic, and nothing the page logic reads or writes.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTaskService } from '../tasks';
import { createTestServer, type TestServer } from '../test/harness';
import { runFillJob, type BrowserPort } from '@baox/erp-executor/job';
import { createFakeErp, type FakeErp } from '@baox/erp-executor/testing/fake-erp';
import { dedicatedErpTab } from '@baox/extension/erp-tab';
import { fakeChrome } from '@baox/extension/testing/fake-chrome';
import { createErpJobs, serverChannel } from './jobs';
import { createDraftJudge } from './judge';
import type { ExecutorChannel, ExecutorEvent } from '@baox/erp-executor/protocol';
import { blobSource, ERP_ORIGIN, FAST_PACE, fakeErpOptions, fillPlan, judgeInputs, withoutLayout } from './testing/scenario';

const golden = JSON.parse(readFileSync(new URL('./testing/kernel-parity.golden.json', import.meta.url), 'utf8'));

let server: TestServer;
beforeEach(async () => { server = await createTestServer(); });
afterEach(() => server.close());

const directly = (fake: FakeErp): BrowserPort => fake.browser;
const throughTheExtension = (fake: FakeErp): BrowserPort => {
  const chrome = fakeChrome(fake.session);
  return dedicatedErpTab({ erpOrigin: ERP_ORIGIN, tabs: chrome.tabs, windows: chrome.windows, debugger: chrome.debugger, pollMs: 1 });
};

describe.each([
  ['attached directly', directly],
  ['through the extension\'s chrome.debugger adapter', throughTheExtension],
])('kernel parity of the fill job, %s', (_how, browserOf) => {
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
      browser: browserOf(fake), blobs: blobSource(), channel: { emit: emit as ExecutorChannel['emit'] }, pace: FAST_PACE, probeWaitMs: 0,
    });

    const strip = (stage: string) => JSON.parse(JSON.stringify(observed[stage] ?? null));
    for (const stage of ['after_import', 'after_fill', 'before_hand_over']) {
      expect(strip(stage), stage).toEqual(golden.readbacks[stage]);
    }
    expect(previewDigest).toBe(golden.previewDigest);
    expect(fake.mutations).toEqual(golden.mutations);
    expect({ status: result.status, billNo: result.billNo }).toEqual(golden.result);
  });
});
