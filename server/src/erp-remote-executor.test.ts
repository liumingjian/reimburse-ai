import { ERP_ACTION_ERRORS, EXECUTOR_NOT_PAIRED_CODE, PAIRING_PATH, CLIENT_VERSION, PairingViewSchema, PairingTokenSchema, type ChannelMessage } from '@baox/contract';
import { runFillJob } from '@baox/erp-executor/job';
import type { ExecutorChannel, ExecutorEvent, FillPlan, ResultEvent } from '@baox/erp-executor/protocol';
import { createFakeErp, type FakeErp, type FakeErpOptions } from '@baox/erp-executor/testing/fake-erp';
import { EXECUTOR_METHODS, RECONNECT_WINDOW_MS, type PageObservation } from '@baox/erp-executor/wire';
import { serverBlobs } from '@baox/channel/blobs';
import { channelWatch, createChannelClient, type ClientSocket } from '@baox/channel/connection';
import { createLocalRunner } from '@baox/local-executor/runner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalogMismatch, noFormOpen, notSignedIn, TEST_ERP_ACCOUNT, uncertainSave } from './erp/testing/fake-executor';
import { FILL_JOB_DEADLINE_MS, JOB_DEADLINE_CODE } from './erp/fill-jobs';
import { fakeExtension, type FakeExtension, type FillRunner, type ReconcileRunner } from './erp/testing/fake-extension';
import { COMPATIBILITY, ERP_ACCOUNT, ERP_ORIGIN, FAST_PACE } from '@baox/erp-executor/testing/scenario';
import { BACKSTOP_MS } from './test/deadlines';
import type { TestClient } from './test/harness';
import { scenario, scenarioServer, type Scene, type ScenarioServer } from './test/scenario';
import { fakeErpFor, SCENE_RECEIPT_NUMBER } from './test/scene-erp';
import { attemptedActions } from './test/erp-records';
import { manualTimers } from './test/timers';

// #254: the server drives an executor in the 应用账号's paired client over its channel (spec #246 seam 2). No executor
// is passed to the app, so every job goes to the paired 本地执行器, as in production (ADR-0037): with the account's
// authorised 凭据, and every fill 暂存s. A fake client runs the executor on its side of the wire. The judgement, the
// attempt discipline and the lease stay the server's.
// The job's event journal (erp_job_event), its action attempts (动作尝试, erp_attempt) and erp_job rows are read from the database: the
// snapshot shows the job's outcome, not the record these tests are about.

const EXTENSION_ORIGIN = 'chrome-extension://kmbhfnaoapecjdgphfnbkejnnojfeeih';

let server: ScenarioServer;
let alice: TestClient;
let fakeOptions: FakeErpOptions;
let fake: FakeErp | null = null;
let timers: ReturnType<typeof manualTimers>;


beforeEach(async () => {
  fake = null;
  timers = manualTimers();
  server = await scenarioServer({ erpExecutor: 'extension', erpConfig: { origin: ERP_ORIGIN, compatibility: COMPATIBILITY }, schedule: timers.schedule, autoRerun: false });
  alice = await server.signIn('alice');
});
afterEach(() => server.close());

async function pair(owner: TestClient): Promise<string> {
  const issued = PairingViewSchema.parse(await (await owner.post('/api/extension/pairing/code', {})).json());
  const redeemed = await server.app.request(PAIRING_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: EXTENSION_ORIGIN },
    body: JSON.stringify({ code: issued.code, browser: 'Chrome 142 Windows', version: CLIENT_VERSION }),
  });
  await server.authoriseErpCredentials(owner.account.accountId);
  return PairingTokenSchema.parse(await redeemed.json()).token;
}

async function connected(token: string, runners: { fill?: FillRunner; reconcile?: ReconcileRunner }): Promise<FakeExtension> {
  const extension = fakeExtension(server.app.extensionChannel, token, runners);
  await extension.connect();
  return extension;
}

// The executor on the fake ERP, run on the client's side of the wire: the invoices fetched from the app's blob route
// with the pairing token (#256), and staged on disk as the 本地执行器 stages them.
const realExecutor = (token: string): FillRunner => async (plan, channel) => {
  fake = await createFakeErp(fakeOptions);
  const blobs = serverBlobs({ origin: 'http://localhost', token: async () => token, fetch: async (url, init) => server.app.request(url, init) });
  return runFillJob(plan, { browser: fake.browser, blobs, channel, pace: FAST_PACE, probeWaitMs: 0 });
};

// The default scene at 去报销 (hotel e-invoice + folio on P-2307, confirmed), on a fake ERP that knows its invoice.
async function actionsOnFakeErp(): Promise<Scene> {
  const scene = await scenario(server, alice).at('actions');
  fakeOptions = fakeErpFor(scene.reached, { assumeReceiptLink: true });
  return scene;
}

// Waits until the running job is interrupted: its reconnection window is open.
async function interrupted(): Promise<void> {
  const deadline = Date.now() + BACKSTOP_MS;
  while (timers.pending(RECONNECT_WINDOW_MS) === 0) {
    if (Date.now() > deadline) throw new Error('no job was interrupted');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const windowCloses = () => timers.elapse(RECONNECT_WINDOW_MS);

const journal = async (taskId: string) =>
  (await server.db.selectFrom('erp_job_event').select(['type', 'payload']).where('task_id', '=', taskId).orderBy('created_at').orderBy('seq').execute()).map((row) => JSON.parse(row.payload) as ExecutorEvent);
const resultsOf = async (taskId: string) => (await journal(taskId)).filter((event): event is ResultEvent => event.type === 'result');

// The page the jobs below were on when they were interrupted, as the extension re-observes it: the form and identity
// `attemptStarted` records, the 发票助手 open.
const PAGE: PageObservation = { erpAccount: TEST_ERP_ACCOUNT, form: { targetId: 'erp-page-1', formInstanceId: 'form-1', formMode: 'new', billNo: null }, assistant: 'open' };

const attemptStarted = (plan: FillPlan): Extract<ExecutorEvent, { type: 'attempt_started' }> => ({
  type: 'attempt_started', attemptId: `${plan.jobId}.import`, action: 'import',
  preconditions: { targetId: 'erp-page-1', url: `${plan.erpOrigin}/k3cloud/html5/index.aspx`, formInstanceId: 'form-1', formMode: 'new', billNo: null, receiptRowCount: 0, detailRowCount: 1 },
  expectedPostconditions: {}, compatibility: plan.compatibility, erpAccount: TEST_ERP_ACCOUNT,
});

describe('去报销 in the paired 浏览器扩展', () => {
  it('hands the plan down with the 凭据, takes every event back in order, and ends at the 暂存 draft', async () => {
    // At each ack, what the extension can observe: is the attempt already durable, and has ERP been touched yet?
    const acks: Array<{ action: string; durable: boolean; mutationsBefore: string[] }> = [];
    const watched = (channel: ExecutorChannel): ExecutorChannel => ({
      emit: (async (event: ExecutorEvent) => {
        const reply = await (channel.emit as (event: ExecutorEvent) => Promise<unknown>)(event);
        if (event.type === 'attempt_started') {
          const row = await server.db.selectFrom('erp_attempt').select('attempt_id').where('attempt_id', '=', event.attemptId).executeTakeFirst();
          acks.push({ action: event.action, durable: row !== undefined, mutationsBefore: fake!.mutations.map((mutation) => mutation.kind) });
        }
        return reply;
      }) as ExecutorChannel['emit'],
    });
    const token = await pair(alice);
    const extension = await connected(token, { fill: (plan, channel, trigger) => realExecutor(token)(plan, watched(channel), trigger) });
    const scene = await actionsOnFakeErp();

    const done = await scene.run('start-erp-write');

    expect(done.erp.abortReason, JSON.stringify(done.erp)).toBeNull();
    expect(done).toMatchObject({ stage: 'done', erp: { status: 'done', outcome: 'drafted', erpAccount: ERP_ACCOUNT }, readback: { status: 'matched' } });
    expect(extension.asked()).toEqual([{ method: EXECUTOR_METHODS.fill, payload: {
      trigger: 'start',
      plan: expect.objectContaining({ kind: 'fill', taskId: scene.task.taskId, draft: { mark: expect.stringMatching(/^baox-/) } }),
      credentials: { account: 'zhangsan', password: 'erp-Pa55' },
    } }]);
    // Every event the extension sent is on the job's record, in the order sent; the verdicts it acted on were the server's.
    expect((await journal(scene.task.taskId)).map((event) => event.type)).toEqual(extension.sent().map((event) => event.type));
    expect(new Set(extension.sent().map((event) => event.type))).toEqual(new Set(['step', 'attempt_started', 'readback', 'result']));
    // `attempt_started` was durable before its ack reached the extension, and the ack came before that action's write.
    expect(acks.map(({ action, durable }) => ({ action, durable }))).toEqual([
      { action: 'import', durable: true },
      { action: 'fill', durable: true },
      { action: 'save', durable: true },
    ]);
    expect(acks[0]!.mutationsBefore).toEqual([]);
    expect(acks[1]!.mutationsBefore).toEqual(['import']);
    expect(acks[2]!.mutationsBefore).not.toContain('draft');
    expect(server.erpLease.holder(alice.account.accountId)).toBeNull();
  });

  it.each([
    ['stops at an ERP login it cannot sign in to', notSignedIn, 'step', 'aborted'],
    ['stops on a 报销信息核对 mismatch', catalogMismatch, 'catalog_mismatch', 'catalog_mismatch'],
  ] as const)('%s with the event the extension sent', async (_name, script, event, status) => {
    const extension = await connected(await pair(alice), { fill: (plan, channel) => script(plan, channel) });
    const scene = await actionsOnFakeErp();

    await scene.run('start-erp-write');

    expect(extension.sent().map((sent) => sent.type)).toContain(event);
    expect((await journal(scene.task.taskId)).map((logged) => logged.type)).toEqual(extension.sent().map((sent) => sent.type));
    expect((await resultsOf(scene.task.taskId)).map((result) => result.status)).toEqual([status]);
    expect(await attemptedActions(server.db, scene.task.taskId)).toEqual([]);
  });

  it('runs the read-only 对账 in the extension too', async () => {
    const extension = await connected(await pair(alice), { fill: (plan, channel) => uncertainSave(plan, channel), reconcile: noFormOpen });
    const scene = await actionsOnFakeErp();
    expect(await scene.run('start-erp-write')).toMatchObject({ stage: 'reconcile', reconcile: { status: 'pending' } });

    const judged = await scene.run('reconcile');

    expect(extension.asked().map((asked) => asked.method)).toEqual([EXECUTOR_METHODS.fill, EXECUTOR_METHODS.reconcile]);
    expect(judged).toMatchObject({ stage: 'reconcile', reconcile: { bucket: '未知' } });
  });

  // Story 13 and ADR-0037: said before starting, with no job created, and the two causes told apart. With nothing
  // paired the refusal also carries the 设置页 as its link target.
  it.each([
    ['no 本地执行器 is paired', false, { code: EXECUTOR_NOT_PAIRED_CODE, message: ERP_ACTION_ERRORS.notPaired, link: 'settings' }],
    ['the paired 本地执行器 is not connected', true, { code: 'extension_offline', message: ERP_ACTION_ERRORS.executorOffline }],
  ])('refuses 去报销 before any job exists when %s, and points at the settings page', async (_case, paired, error) => {
    if (paired) await pair(alice);
    const scene = await actionsOnFakeErp();

    const refused = await scene.act('start-erp-write');

    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: unknown }).error).toEqual(error);
    expect(error.message).toContain('设置页');
    expect(await server.db.selectFrom('erp_job').select('job_id').where('task_id', '=', scene.task.taskId).execute()).toEqual([]);
    expect(server.erpLease.holder(alice.account.accountId)).toBeNull();
    expect((await scene.snapshot()).erp.status).toBe('idle');
  });

  it('still stops before anything is written when the socket goes between the check and the dispatch', async () => {
    await pair(alice);
    const scene = await actionsOnFakeErp();
    // The check sees a connection; by the time the plan is sent, there is none.
    vi.spyOn(server.app.extensionChannel, 'connected').mockReturnValue(true);

    const stopped = await scene.run('start-erp-write');

    expect(stopped.erp.abortReason).toContain('本地执行器');
    expect(stopped.erp).toMatchObject({ status: 'idle', externalWait: 'executor_connection', outcome: 'none', allowedActions: ['refresh'] });
    expect(await resultsOf(scene.task.taskId)).toMatchObject([{ status: 'aborted', code: 'extension_offline' }]);
    expect(await attemptedActions(server.db, scene.task.taskId)).toEqual([]);
    expect(server.erpLease.holder(alice.account.accountId)).toBeNull();
  });

  it("refuses another account's extension speaking for a running job", async () => {
    let release!: () => void;
    let entered!: (jobId: string) => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = new Promise<string>((resolve) => {
      entered = resolve;
    });
    await connected(await pair(alice), {
      fill: async (plan, channel) => {
        entered(plan.jobId);
        await gate;
        return notSignedIn(plan, channel);
      },
    });
    const bob = await server.signIn('bob');
    const mallory = await connected(await pair(bob), {});
    const scene = await actionsOnFakeErp();
    await scene.accept('start-erp-write');
    const jobId = await running;

    const spoken = mallory.request(EXECUTOR_METHODS.event, { jobId, event: { type: 'step', step: 'chromium', status: 'running' } });

    await expect(spoken).rejects.toMatchObject({ code: 'unknown_job' });
    expect(await journal(scene.task.taskId)).toEqual([]);
    release();
    await scene.settled();
  });
});

// #257, ADR-0020: a reconnect restores the channel, not the page. A lost socket or a detached debugger interrupts the
// job; within the window the extension resumes it by `jobId` with what it re-observed, and past it the server decides
// the job's end by whether an attempt is on record.
describe('an interrupted 去报销', () => {
  // A fill that sends one step, then loses its socket; the job it ran in is handed to the test.
  function droppedAfterOneStep(token: string) {
    let started!: (plan: FillPlan) => void;
    const plan = new Promise<FillPlan>((resolve) => {
      started = resolve;
    });
    const extension = fakeExtension(server.app.extensionChannel, token, {
      fill: async (fillPlan, channel) => {
        started(fillPlan);
        await channel.emit({ type: 'step', step: 'chromium', status: 'running' });
        extension.disconnect();
        await channel.emit({ type: 'step', step: 'chromium', status: 'done' });
        throw new Error('unreachable: the channel is gone');
      },
    });
    return { extension, plan };
  }

  it('resumes by jobId inside the window, over the new socket, and carries the job to its end', async () => {
    const token = await pair(alice);
    const { extension, plan } = droppedAfterOneStep(token);
    await extension.connect();
    const scene = await actionsOnFakeErp();
    await scene.accept('start-erp-write');
    const { jobId } = await plan;
    await interrupted();

    const back = await connected(token, {});
    expect(await back.resume(jobId, PAGE, PAGE)).toEqual({ ok: true, recorded: 1 });
    const wire = back.channel(jobId);
    await wire.emit({ type: 'step', step: 'chromium', status: 'done' });
    await wire.emit({ type: 'result', status: 'aborted', code: 'erp_login', message: '请登录报销系统', billNo: null, capture: null });
    const stopped = await scene.settled();

    expect(stopped.erp).toMatchObject({ status: 'idle', abortReason: expect.stringContaining('请登录报销系统') });
    expect((await journal(scene.task.taskId)).map((event) => event.type)).toEqual(['step', 'step', 'result']);
    // The plan went down once, to the first socket; the window closed with the resume.
    expect(back.asked()).toEqual([]);
    expect(timers.pending(RECONNECT_WINDOW_MS)).toBe(0);
    expect(server.erpLease.holder(alice.account.accountId)).toBeNull();
  });

  // The extension's resume is answered over a socket that is gone by the time the verdict is ready: the extension
  // never hears it, retries, and must find the job interrupted again rather than live with nobody on the other end.
  async function resumeLostInFlight() {
    const token = await pair(alice);
    const { extension, plan } = droppedAfterOneStep(token);
    await extension.connect();
    const scene = await actionsOnFakeErp();
    await scene.accept('start-erp-write');
    const { jobId } = await plan;
    await interrupted();

    const back = await connected(token, {});
    const unheard = back.resume(jobId, PAGE, PAGE);
    back.disconnect();
    await expect(unheard).rejects.toMatchObject({ code: 'channel_closed' });
    return { token, scene, jobId };
  }

  it('opens the window again when the socket goes while its resume is being judged, and the next resume carries on', async () => {
    const { token, scene, jobId } = await resumeLostInFlight();

    await interrupted();
    expect((await scene.snapshot()).erp.status).toBe('running');
    const again = await connected(token, {});
    expect(await again.resume(jobId, PAGE, PAGE)).toEqual({ ok: true, recorded: 1 });
    const wire = again.channel(jobId);
    await wire.emit({ type: 'result', status: 'aborted', code: 'erp_login', message: '请登录报销系统', billNo: null, capture: null });

    expect((await scene.settled()).erp).toMatchObject({ status: 'idle', abortReason: expect.stringContaining('请登录报销系统') });
    expect(timers.pending(RECONNECT_WINDOW_MS)).toBe(0);
    expect(server.erpLease.holder(alice.account.accountId)).toBeNull();
  });

  it('ends the job past the reopened window when the extension does not come back after an unheard resume', async () => {
    const { scene } = await resumeLostInFlight();
    await interrupted();

    windowCloses();
    const stopped = await scene.settled();

    expect(await resultsOf(scene.task.taskId)).toMatchObject([{ status: 'aborted', code: 'extension_reconnect_expired' }]);
    expect(stopped.erp.status).toBe('idle');
    expect(server.erpLease.holder(alice.account.accountId)).toBeNull();
  });

  it('holds the lease through the window, then aborts in place past it and says plainly that nothing was written', async () => {
    const token = await pair(alice);
    const { extension, plan } = droppedAfterOneStep(token);
    await extension.connect();
    const scene = await actionsOnFakeErp();
    await scene.accept('start-erp-write');
    const { jobId } = await plan;
    await interrupted();

    // Mid-window the job still holds its account's lease, so the account's other 去报销 cannot start. That other job
    // is staged on the lease: one account owns one active task (#249).
    const other = { accountId: alice.account.accountId, taskId: 'her-other-task', jobId: 'her-other-job' };
    expect(server.erpLease.holder(alice.account.accountId)).toMatchObject({ jobId });
    expect(server.erpLease.acquire(other)).toBe(false);
    expect((await scene.snapshot()).erp.status).toBe('running');

    windowCloses();
    const stopped = await scene.settled();

    expect(await resultsOf(scene.task.taskId)).toMatchObject([{ status: 'aborted', code: 'extension_reconnect_expired' }]);
    expect(await attemptedActions(server.db, scene.task.taskId)).toEqual([]);
    expect(stopped.erp.status).toBe('idle');
    expect(stopped.erp.abortReason).toBe('上次去报销在写入报销系统之前就停止了，报销系统没有被改动，可以再去报销。原因：本地执行器和报销系统页面之间的连接中断了，两分钟内没有恢复。');
    expect(server.erpLease.acquire(other)).toBe(true);
    server.erpLease.release(other.jobId);
    // Too late to resume: the job reads like no job at all.
    const late = await connected(token, {});
    await expect(late.resume(jobId, PAGE, PAGE)).rejects.toMatchObject({ code: 'unknown_job' });
  });

  it('goes to 对账 past the window when an attempt is on record, and never mutates or replays', async () => {
    const token = await pair(alice);
    let mutated = false;
    const extension: FakeExtension = await connected(token, {
      fill: async (plan, channel) => {
        await channel.emit({ type: 'step', step: 'import', status: 'running' });
        const ack = channel.emit(attemptStarted(plan));
        // The socket goes with the attempt in flight: the server may make it durable, but no ack reaches the executor.
        extension.disconnect();
        await ack;
        mutated = true;
        throw new Error('unreachable: an unacknowledged attempt is never followed by a write');
      },
    });
    const scene = await actionsOnFakeErp();
    await scene.accept('start-erp-write');
    await interrupted();

    windowCloses();
    const stopped = await scene.settled();

    expect(mutated).toBe(false);
    expect(stopped).toMatchObject({ stage: 'reconcile', reconcile: { status: 'pending' } });
    expect(await attemptedActions(server.db, scene.task.taskId)).toEqual(['import']);
    // The result follows the attempt on record, and the server's guard made it 写入结果未知.
    expect((await journal(scene.task.taskId)).map((event) => event.type)).toEqual(['step', 'attempt_started', 'result']);
    expect(await resultsOf(scene.task.taskId)).toMatchObject([{ status: 'unknown', code: 'extension_reconnect_expired' }]);
    expect(server.erpLease.holder(alice.account.accountId)).toBeNull();

    // The extension comes back: nothing is re-sent to it.
    const back = await connected(token, { fill: realExecutor(token) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(back.asked()).toEqual([]);
    expect(extension.asked()).toHaveLength(1);
  });

  it('takes nothing from a resumed extension before its re-observation, and ends the job when the page is not the one it left', async () => {
    const token = await pair(alice);
    const { extension, plan } = droppedAfterOneStep(token);
    await extension.connect();
    const scene = await actionsOnFakeErp();
    await scene.accept('start-erp-write');
    const { jobId } = await plan;
    await interrupted();
    const back = await connected(token, {});

    // Acting first: refused, and nothing lands on the record.
    await expect(back.channel(jobId).emit({ type: 'step', step: 'navigate', status: 'running' })).rejects.toMatchObject({ code: 'resume_required' });
    expect(await journal(scene.task.taskId)).toHaveLength(1);

    // The 发票助手 was closed during the gap: it is one-shot, so the stream coming back says nothing about the page.
    const verdict = await back.resume(jobId, PAGE, { ...PAGE, assistant: 'closed' });
    const stopped = await scene.settled();

    expect(verdict).toEqual({ ok: false, reasons: ['发票助手的状态和中断前不一样'] });
    expect(await resultsOf(scene.task.taskId)).toMatchObject([{ status: 'aborted', code: 'reobservation_mismatch' }]);
    expect(stopped.erp.abortReason).toContain('报销系统没有被改动，可以再去报销');
    await expect(back.channel(jobId).emit({ type: 'step', step: 'navigate', status: 'running' })).rejects.toMatchObject({ code: 'unknown_job' });
    expect(server.erpLease.holder(alice.account.accountId)).toBeNull();
  });

  it('sends a job whose re-observed form is not the attempted one to 对账', async () => {
    const token = await pair(alice);
    const extension: FakeExtension = await connected(token, {
      fill: async (plan, channel) => {
        await channel.emit(attemptStarted(plan));
        extension.disconnect();
        throw new Error('the channel is gone');
      },
    });
    const scene = await actionsOnFakeErp();
    await scene.accept('start-erp-write');
    await interrupted();
    const [attempt] = await server.db.selectFrom('erp_attempt').select('job_id').where('task_id', '=', scene.task.taskId).execute();

    // Consistent before and after, but not the form the attempt was made on.
    const elsewhere: PageObservation = { ...PAGE, form: { ...PAGE.form!, formInstanceId: 'form-2' } };
    const back = await connected(token, {});
    const verdict = await back.resume(attempt!.job_id, elsewhere, elsewhere);
    const stopped = await scene.settled();

    expect(verdict).toEqual({ ok: false, reasons: ['打开的报销单不是这次写入的那一张'] });
    expect(stopped).toMatchObject({ stage: 'reconcile', reconcile: { status: 'pending' } });
    expect(await resultsOf(scene.task.taskId)).toMatchObject([{ status: 'unknown', code: 'reobservation_mismatch' }]);
  });

  it('replays nothing across a resume: every event is on record once, and the plan is never asked again', async () => {
    const token = await pair(alice);
    let jobPlan!: FillPlan;
    const extension: FakeExtension = await connected(token, {
      fill: async (plan, channel) => {
        jobPlan = plan;
        await channel.emit({ type: 'step', step: 'import', status: 'running' });
        const ack = channel.emit(attemptStarted(plan));
        extension.disconnect();
        await ack;
        throw new Error('unreachable: the ack went with the socket');
      },
    });
    const scene = await actionsOnFakeErp();
    await scene.accept('start-erp-write');
    await interrupted();

    const back = await connected(token, {});
    const verdict = await back.resume(jobPlan.jobId, PAGE, PAGE);
    // The attempt whose ack was lost is on record, and so counts as acknowledged: the extension does not send it again.
    expect(verdict).toEqual({ ok: true, recorded: 2 });
    const wire = back.channel(jobPlan.jobId);
    // An extension that re-sent it anyway gets no second acknowledgement, so it could never write twice.
    await expect(wire.emit(attemptStarted(jobPlan))).rejects.toBeDefined();
    await wire.emit({ type: 'step', step: 'import', status: 'done' });
    await wire.emit({ type: 'result', status: 'aborted', code: 'test_stop', message: '测试到此为止', billNo: null, capture: null });
    await scene.settled();

    expect((await journal(scene.task.taskId)).map((event) => event.type)).toEqual(['step', 'attempt_started', 'step', 'result']);
    expect(await attemptedActions(server.db, scene.task.taskId)).toEqual(['import']);
    expect(extension.asked().map((asked) => asked.method)).toEqual([EXECUTOR_METHODS.fill]);
    expect(back.asked()).toEqual([]);
  });

  describe('a chrome.debugger detach is the same event as a disconnect', () => {
    it('resumes on the same socket once the page is re-observed', async () => {
      const token = await pair(alice);
      const extension: FakeExtension = await connected(token, {
        fill: async (plan, channel) => {
          await channel.emit({ type: 'step', step: 'chromium', status: 'running' });
          await extension.detached(plan.jobId);
          await expect(channel.emit({ type: 'step', step: 'chromium', status: 'done' })).rejects.toMatchObject({ code: 'resume_required' });
          expect(await extension.resume(plan.jobId, PAGE, PAGE)).toEqual({ ok: true, recorded: 1 });
          return notSignedIn(plan, channel);
        },
      });
      const scene = await actionsOnFakeErp();

      const paused = await scene.run('start-erp-write');

      expect(paused.erp).toMatchObject({ status: 'idle', abortReason: expect.stringContaining('设置页') });
      expect((await journal(scene.task.taskId)).map((event) => event.type)).toEqual(['step', ...extension.sent().slice(2).map((event) => event.type)]);
      expect(timers.pending(RECONNECT_WINDOW_MS)).toBe(0);
    });

    it('ends past the window exactly as a lost socket does, and ignores the executor’s late answer', async () => {
      const token = await pair(alice);
      const extension: FakeExtension = await connected(token, {
        fill: async (plan, channel) => {
          await channel.emit({ type: 'step', step: 'chromium', status: 'running' });
          await extension.detached(plan.jobId);
          // The executor's own run fails with the page gone; that answer describes nothing the server may act on.
          throw new Error('Debugger is not attached to the tab');
        },
      });
      const scene = await actionsOnFakeErp();
      await scene.accept('start-erp-write');
      await interrupted();
      expect(server.erpLease.holder(alice.account.accountId)).not.toBeNull();

      windowCloses();
      const stopped = await scene.settled();

      expect(await resultsOf(scene.task.taskId)).toMatchObject([{ status: 'aborted', code: 'extension_reconnect_expired' }]);
      expect(stopped.erp.abortReason).toContain('报销系统没有被改动，可以再去报销');
      expect(server.erpLease.holder(alice.account.accountId)).toBeNull();
    });
  });
});

// An extension that stays connected but never finishes (a page that hangs, a runner stuck on an await): the socket is
// healthy, so no window ever opens. The server's own deadline is what ends the job.
describe('a job that outlives its deadline', () => {
  async function hanging(onPlan: (plan: FillPlan, channel: ExecutorChannel) => Promise<void>) {
    let wire!: ExecutorChannel;
    // Set once every event `onPlan` sent has been acknowledged, so the deadline never races one still on the wire.
    let acknowledged = false;
    await connected(await pair(alice), {
      fill: async (plan, channel) => {
        wire = channel;
        await onPlan(plan, channel);
        acknowledged = true;
        return new Promise<never>(() => undefined);
      },
    });
    const scene = await actionsOnFakeErp();
    await scene.accept('start-erp-write');
    const deadline = Date.now() + BACKSTOP_MS;
    while (!acknowledged || timers.pending(FILL_JOB_DEADLINE_MS) === 0) {
      if (Date.now() > deadline) throw new Error('the job never started');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return { scene, wire: () => wire };
  }

  it('is ended by the server before any attempt: nothing written, the lease free, the executor heard no more', async () => {
    const { scene, wire } = await hanging(async (_plan, channel) => {
      await channel.emit({ type: 'step', step: 'chromium', status: 'running' });
    });

    timers.elapse(FILL_JOB_DEADLINE_MS);
    const stopped = await scene.settled();

    expect(await resultsOf(scene.task.taskId)).toMatchObject([{ status: 'aborted', code: JOB_DEADLINE_CODE }]);
    expect(stopped.erp.status).toBe('idle');
    expect(stopped.erp.abortReason).toContain('报销系统没有被改动');
    expect(server.erpLease.holder(alice.account.accountId)).toBeNull();
    // The executor's late word reads like no job at all: it can never write after the server gave up on it.
    await expect(wire().emit({ type: 'step', step: 'chromium', status: 'done' })).rejects.toMatchObject({ code: 'unknown_job' });
    expect((await journal(scene.task.taskId)).map((event) => event.type)).toEqual(['step', 'result']);
  });

  it('goes to 对账 when an attempt is on record, and never replays it', async () => {
    const { scene, wire } = await hanging(async (plan, channel) => {
      await channel.emit({ type: 'step', step: 'import', status: 'running' });
      await channel.emit(attemptStarted(plan));
    });

    timers.elapse(FILL_JOB_DEADLINE_MS);
    const stopped = await scene.settled();

    expect(stopped).toMatchObject({ stage: 'reconcile', reconcile: { status: 'pending' } });
    expect(await resultsOf(scene.task.taskId)).toMatchObject([{ status: 'unknown', code: JOB_DEADLINE_CODE }]);
    expect(await attemptedActions(server.db, scene.task.taskId)).toEqual(['import']);
    await expect(wire().emit({ type: 'step', step: 'import', status: 'done' })).rejects.toMatchObject({ code: 'unknown_job' });
    expect(server.erpLease.holder(alice.account.accountId)).toBeNull();
  });

  it('also ends a job that is waiting out its reconnection window', async () => {
    const token = await pair(alice);
    const extension = fakeExtension(server.app.extensionChannel, token, {
      fill: async (_plan, channel) => {
        await channel.emit({ type: 'step', step: 'chromium', status: 'running' });
        extension.disconnect();
        return new Promise<never>(() => undefined);
      },
    });
    await extension.connect();
    const scene = await actionsOnFakeErp();
    await scene.accept('start-erp-write');
    await interrupted();

    timers.elapse(FILL_JOB_DEADLINE_MS);
    await scene.settled();

    expect(await resultsOf(scene.task.taskId)).toMatchObject([{ status: 'aborted', code: JOB_DEADLINE_CODE }]);
    // The window closed with the job: nothing is left to fire.
    expect(timers.pending(RECONNECT_WINDOW_MS)).toBe(0);
  });
});

// #257's client side against this server: the real 本地执行器 runner (`@baox/local-executor/runner`), channel client
// and job link on the app's real channel, with the fake ERP standing in for its headless Chromium. Only the socket is a
// stand-in. `cut` sees every frame the app sends; answering true drops the socket instead of delivering it, as a Wi-Fi
// blip would, and the client redials on its own. `delivered` sees every frame the 本地执行器 sends, once the app has it,
// and may drop the socket right after it.
type Hooks = {
  cut?: (message: ChannelMessage, sent: ChannelMessage[]) => boolean;
  delivered?: (message: ChannelMessage, drop: () => void) => void;
};

describe('the real 本地执行器 across an interruption', () => {
  async function realLocalExecutor(token: string, { cut, delivered }: Hooks = {}) {
    fake = await createFakeErp(fakeOptions);
    const erp = fake;
    const sent: ChannelMessage[] = [];
    const browsers = { launched: 0, closed: 0 };
    const connection = channelWatch();
    const open = (): ClientSocket => {
      let gone = false;
      const socket: ClientSocket = { send: () => undefined, close: () => undefined, onopen: null, onmessage: null, onclose: null, onerror: null };
      const drop = () => {
        if (gone) return;
        gone = true;
        session.closed();
        socket.onclose?.({ code: 1006, reason: '' });
      };
      const session = server.app.extensionChannel.open({
        send: (data) => {
          if (gone) return;
          if (cut?.(JSON.parse(data) as ChannelMessage, sent)) return drop();
          socket.onmessage?.({ data });
        },
        close: drop,
      });
      socket.send = (data) => {
        if (gone) return;
        const message = JSON.parse(data) as ChannelMessage;
        sent.push(message);
        void session.message(data);
        delivered?.(message, drop);
      };
      socket.close = drop;
      queueMicrotask(() => socket.onopen?.());
      return socket;
    };
    // What the 本地执行器 asked of the app, by method; an event by its type.
    const asked = () => sent.flatMap((message) => (message.type === 'request' && message.method !== 'ping'
      ? [message.method === EXECUTOR_METHODS.event ? (message.payload as { event: ExecutorEvent }).event.type : message.method] : []));
    const run = createLocalRunner({
      request: (method, payload) => client.request(method, payload),
      connection,
      // As the real 本地执行器 fetches them: from the app's owner-checked blob route, with the pairing token (#256).
      blobs: serverBlobs({ origin: 'http://localhost', token: async () => token, fetch: async (url, init) => server.app.request(url, init) }),
      launch: async () => {
        browsers.launched += 1;
        return { port: 0, browser: erp.browser, close: async () => { browsers.closed += 1; } };
      },
      pace: FAST_PACE,
    });
    const client = createChannelClient({ origin: 'http://127.0.0.1:4319', token, open, onRequest: run, onStatus: connection.status });
    await connection.ready();
    // The job is over for the app at its result; the runner then signs out and closes its browser.
    const closedOnce = async () => {
      const deadline = Date.now() + BACKSTOP_MS;
      while (browsers.closed === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      return { ...browsers };
    };
    return { asked, closedOnce, stop: () => client.stop() };
  }

  // The request id of the first `erp.event` carrying `type`: the frame whose answer a test loses.
  const idOf = (sent: ChannelMessage[], type: ExecutorEvent['type']) => sent.flatMap((message) =>
    (message.type === 'request' && message.method === EXECUTOR_METHODS.event && (message.payload as { event: ExecutorEvent }).event.type === type ? [message.id] : []))[0];

  const onceEach = async (taskId: string) => {
    const logged = (await journal(taskId)).map((event) => JSON.stringify(event));
    return new Set(logged).size === logged.length;
  };

  it('resumes after the socket drops under the import attempt’s answer, and 暂存s with nothing replayed', async () => {
    const token = await pair(alice);
    const scene = await actionsOnFakeErp();
    let cutOnce = false;
    const local = await realLocalExecutor(token, {
      cut: (message, sent) => {
        if (cutOnce || message.type !== 'response' || message.id !== idOf(sent, 'attempt_started')) return false;
        cutOnce = true;
        return true;
      },
    });

    const done = await scene.run('start-erp-write');

    expect(cutOnce).toBe(true);
    expect(done.erp.abortReason, JSON.stringify(done.erp)).toBeNull();
    expect(done).toMatchObject({ stage: 'done', erp: { status: 'done', outcome: 'drafted' }, readback: { status: 'matched' } });
    expect(local.asked()).not.toContain(EXECUTOR_METHODS.detached);
    expect(local.asked().filter((method) => method === EXECUTOR_METHODS.resume)).toHaveLength(1);
    // One attempt per action went out, the one whose answer was lost included; nothing is on record twice.
    expect(local.asked().filter((type) => type === 'attempt_started')).toHaveLength(3);
    expect(await attemptedActions(server.db, scene.task.taskId)).toEqual(['import', 'fill', 'save']);
    expect(await onceEach(scene.task.taskId)).toBe(true);
    expect(fake!.mutations.filter((mutation) => mutation.kind === 'import')).toHaveLength(1);
    expect(timers.pending(RECONNECT_WINDOW_MS)).toBe(0);
    // One browser for the job, closed at its end (ADR-0033): the resume went back to the same page, not a new browser.
    expect(await local.closedOnce()).toEqual({ launched: 1, closed: 1 });
    local.stop();
  });

  it('resumes after the socket drops between commands, on the same page, and 暂存s', async () => {
    const token = await pair(alice);
    const scene = await actionsOnFakeErp();
    let droppedOnce = false;
    const local = await realLocalExecutor(token, {
      // Dropped while the executor waits for the app to take `step navigate running`: no command is under way.
      delivered: (message, drop) => {
        const event = message.type === 'request' && message.method === EXECUTOR_METHODS.event ? (message.payload as { event: ExecutorEvent }).event : null;
        if (droppedOnce || event?.type !== 'step' || event.step !== 'navigate' || event.status !== 'running') return;
        droppedOnce = true;
        drop();
      },
    });

    const done = await scene.run('start-erp-write');

    expect(droppedOnce).toBe(true);
    expect(done.erp.abortReason, JSON.stringify(done.erp)).toBeNull();
    expect(done).toMatchObject({ stage: 'done', erp: { status: 'done', outcome: 'drafted' } });
    expect(local.asked().filter((method) => method === EXECUTOR_METHODS.resume)).toHaveLength(1);
    expect(await onceEach(scene.task.taskId)).toBe(true);
    expect(await attemptedActions(server.db, scene.task.taskId)).toEqual(['import', 'fill', 'save']);
    expect(await local.closedOnce()).toEqual({ launched: 1, closed: 1 });
    local.stop();
  });
});
