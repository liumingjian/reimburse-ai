// The executor seam (spec #177 Testing Decisions): fill jobs driven through the job protocol against the fake ERP,
// with the real server channel persisting events and attempts on SQLite `:memory:`.
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/database';
import { createTaskService } from '../tasks';
import { tempDataDir } from '../test/harness';
import { runFillJob } from './executor/job';
import { createFakeErp, type FakeErp } from './executor/testing/fake-erp';
import { createErpJobs, serverChannel, type ErpJobs } from './jobs';
import { createDraftJudge } from './judge';
import type { ExecutorChannel, ExecutorEvent } from './protocol';
import { blobSource, FAST_PACE, fakeErpOptions, fillPlan, judgeInputs } from './testing/scenario';

let db: Db;
let dataDir: string;
let taskId: string;
let jobs: ErpJobs;

beforeEach(async () => {
  dataDir = tempDataDir();
  db = await openDatabase(':memory:');
  taskId = (await createTaskService(db, dataDir).create('合肥')).task.taskId;
  jobs = createErpJobs(db);
});
afterEach(async () => {
  await db.destroy();
  rmSync(dataDir, { recursive: true, force: true });
});

type Wrap = (event: ExecutorEvent, forward: () => Promise<any>) => Promise<any>;

/** The real server channel, optionally wrapped so a test can act between persistence and acknowledgement. */
function channelFor(wrap: Wrap = (_event, forward) => forward()): ExecutorChannel {
  const inner = serverChannel({ jobs, jobId: `job-${taskId}`, taskId, judge: createDraftJudge(judgeInputs(taskId)) });
  const emit = (event: ExecutorEvent) => wrap(event, () => (inner.emit as (e: ExecutorEvent) => Promise<any>)(event));
  return { emit: emit as ExecutorChannel['emit'] };
}

const run = (fake: FakeErp, channel = channelFor(), plan = fillPlan(taskId)) =>
  runFillJob(plan, { browser: fake.browser, blobs: blobSource(), channel, pace: FAST_PACE, probeWaitMs: 0 });

const inputEvents = (fake: FakeErp) => fake.commands.filter((c) => c.method.startsWith('Input.') || c.method === 'DOM.setFileInputFiles');

describe('fill job through the protocol on the fake ERP', () => {
  it('saves a draft, persisting an attempt before import, fill and save', async () => {
    const fake = await createFakeErp(fakeErpOptions({ assumeReceiptLink: true }));
    const result = await run(fake);
    expect(result, JSON.stringify(result)).toMatchObject({ type: 'result', status: 'saved', billNo: 'FYBX2026090001', code: null });

    const attempts = await jobs.attempts(`job-${taskId}`);
    expect(attempts.map((a) => a.action)).toEqual(['import', 'fill', 'save']);
    for (const attempt of attempts) {
      expect(attempt.compatibility).toEqual({ erpBuild: '8.2.0.20250701', formId: 'ER_ExpReimbursement' });
      expect(attempt.erpAccount).toEqual({ displayName: '刘明建', account: 'luo.liu', tenant: 'tenant-a' });
      expect(attempt.preconditions).toMatchObject({ targetId: 'erp-page-1', formInstanceId: 'a1b2c3d4e5f6', formMode: 'new', billNo: null,
        url: 'http://erp.antute.com.cn/k3cloud/html5/index.aspx' });
    }
    expect(attempts[0]!.preconditions.receiptRowCount).toBe(0);
    expect(attempts[1]!.preconditions.receiptRowCount).toBe(2);

    const events = await jobs.events(`job-${taskId}`);
    expect(events.filter((e) => e.type === 'readback').map((e) => (e as { stage: string }).stage)).toEqual(['after_import', 'after_fill', 'before_save', 'after_save']);
    expect(events.at(-1)).toMatchObject({ type: 'result', status: 'saved' });
    expect(fake.mutations.map((m) => m.kind).filter((k, i, all) => all.indexOf(k) === i)).toEqual(['import', 'header', 'cell', 'option', 'addRow', 'save']);
  });

  it('makes no mutation before the server acknowledges attempt_started', async () => {
    const fake = await createFakeErp(fakeErpOptions({ assumeReceiptLink: true }));
    const order: string[] = [];
    fake.hooks.onMutation = (m) => order.push(m.kind);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let persistedBeforeAck = false;
    let heldAt: number | null = null;
    const channel = channelFor(async (event, forward) => {
      if (event.type !== 'attempt_started') return forward();
      const ack = await forward();
      order.push(`attempt:${event.action}`);
      persistedBeforeAck ||= (await jobs.attempts(`job-${taskId}`)).some((a) => a.attemptId === event.attemptId);
      if (event.action === 'import') { heldAt = inputEvents(fake).length; await held; }
      return ack;
    });
    const job = run(fake, channel);
    while (heldAt === null) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 60));
    // While the acknowledgement is held, nothing is written and no upload happens.
    expect(fake.mutations).toEqual([]);
    expect(fake.commands.some((c) => c.method === 'DOM.setFileInputFiles')).toBe(false);
    release();
    expect((await job).status).toBe('saved');
    expect(persistedBeforeAck).toBe(true);

    const at = (label: string) => order.indexOf(label);
    expect(at('attempt:import')).toBe(0);
    expect(order.indexOf('import')).toBeGreaterThan(at('attempt:import'));
    const fillWrites = order.map((kind, index) => ({ kind, index })).filter((m) => ['header', 'cell', 'option', 'addRow'].includes(m.kind));
    expect(fillWrites.length).toBeGreaterThan(0);
    expect(Math.min(...fillWrites.map((m) => m.index))).toBeGreaterThan(at('attempt:fill'));
    expect(Math.max(...fillWrites.map((m) => m.index))).toBeLessThan(at('attempt:save'));
    expect(order.indexOf('save')).toBeGreaterThan(at('attempt:save'));
  });

  it('pauses for login without any attempt or input when ERP sits on the login page', async () => {
    const fake = await createFakeErp(fakeErpOptions({ loggedIn: false }));
    const result = await run(fake);
    expect(result).toMatchObject({ status: 'waiting_login', code: 'erp_login', capture: null });
    const events = await jobs.events(`job-${taskId}`);
    expect(events.some((e) => e.type === 'waiting_login')).toBe(true);
    expect(await jobs.attempts(`job-${taskId}`)).toEqual([]);
    expect(inputEvents(fake)).toEqual([]);
  });

  it('aborts on a catalog mismatch before import, with no attempt and no input', async () => {
    const fake = await createFakeErp(fakeErpOptions({ projects: [{ code: '39163', name: '改过名的项目' }, { code: '38480', name: '中国农业发展银行河南省分行-20-1961', forbidStatus: 'B' }] }));
    const result = await run(fake);
    expect(result.status).toBe('catalog_mismatch');
    const mismatch = (await jobs.events(`job-${taskId}`)).find((e) => e.type === 'catalog_mismatch');
    expect(mismatch).toMatchObject({ problems: [
      { kind: 'project', code: '39163', verdict: 'name_mismatch', erpName: '改过名的项目' },
      { kind: 'project', code: '38480', verdict: 'unusable' },
    ] });
    expect(await jobs.attempts(`job-${taskId}`)).toEqual([]);
    expect(inputEvents(fake)).toEqual([]);
  });

  it('aborts on a compatibility fingerprint mismatch before any attempt', async () => {
    const fake = await createFakeErp(fakeErpOptions({ erpBuild: '8.3.0.20260101' }));
    const result = await run(fake);
    expect(result).toMatchObject({ status: 'aborted', code: 'compatibility_mismatch' });
    expect(result.message).toMatch(/8\.3\.0\.20260101/);
    expect(await jobs.attempts(`job-${taskId}`)).toEqual([]);
    expect(fake.mutations).toEqual([]);
  });

  it('ends as write result unknown when the form instance drifts after the fill attempt is acknowledged', async () => {
    const fake = await createFakeErp(fakeErpOptions({ assumeReceiptLink: true }));
    const channel = channelFor(async (event, forward) => {
      const reply = await forward();
      if (event.type === 'attempt_started' && event.action === 'fill') fake.replaceFormInstance();
      return reply;
    });
    const result = await run(fake, channel);
    expect(result).toMatchObject({ status: 'unknown', code: 'erp_drift' });
    expect(result.message).toMatch(/表单实例 UUID/);
    expect(fake.mutations.map((m) => m.kind)).toEqual(['import']);
    expect((await jobs.attempts(`job-${taskId}`)).map((a) => a.action)).toEqual(['import', 'fill']);
    expect(result.capture).not.toBeNull();
  });

  it('ends as write result unknown when the CDP target disappears after the import attempt', async () => {
    const fake = await createFakeErp(fakeErpOptions());
    const channel = channelFor(async (event, forward) => {
      const reply = await forward();
      if (event.type === 'attempt_started' && event.action === 'import') fake.closeTarget();
      return reply;
    });
    const result = await run(fake, channel);
    expect(result.status).toBe('unknown');
    expect(fake.mutations).toEqual([]);
  });

  it('stops before save when the strict read-back fails (no 收票单号 link on detail rows, as research recorded)', async () => {
    const fake = await createFakeErp(fakeErpOptions());
    const result = await run(fake);
    expect(result).toMatchObject({ status: 'unknown', code: 'strict_readback_failed' });
    expect(fake.mutations.some((m) => m.kind === 'save')).toBe(false);
    expect((await jobs.attempts(`job-${taskId}`)).map((a) => a.action)).toEqual(['import', 'fill']);
  });

  it('aborts before any attempt when an invoice blob does not match its sha256', async () => {
    const fake = await createFakeErp(fakeErpOptions());
    const plan = fillPlan(taskId);
    const result = await runFillJob(plan, { browser: fake.browser, channel: channelFor(), pace: FAST_PACE, probeWaitMs: 0,
      blobs: { read: async () => new TextEncoder().encode('tampered') } });
    expect(result).toMatchObject({ status: 'aborted', code: 'BLOB_HASH_MISMATCH' });
    expect(await jobs.attempts(`job-${taskId}`)).toEqual([]);
    expect(inputEvents(fake)).toEqual([]);
  });
});
