// The executor seam (spec #177 Testing Decisions): fill jobs driven through the job protocol against the fake ERP,
// with the real server channel persisting events and attempts on SQLite `:memory:`.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/database';
import { createTaskService } from '../tasks';
import { createTestServer, type TestServer } from '../test/harness';
import { runFillJob } from './executor/job';
import { captureErpError, importInvoices, openInvoiceAssistant, openNewReimbursement, uploadInvoices, type WritePage } from './executor/steps';
import { createFakeErp, type FakeErp } from './executor/testing/fake-erp';
import { createErpJobs, serverChannel, type ErpJobs } from './jobs';
import { createDraftJudge } from './judge';
import type { ExecutorChannel, ExecutorEvent } from './protocol';
import { driveTo } from './testing/reconcile-states';
import { blobSource, FAST_PACE, fakeErpOptions, fillPlan, INVOICES, judgeInputs } from './testing/scenario';

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

const run = (fake: FakeErp, channel = channelFor(), plan = fillPlan(taskId)) =>
  runFillJob(plan, { browser: fake.browser, blobs: blobSource(), channel, pace: FAST_PACE, probeWaitMs: 0 });

const inputEvents = (fake: FakeErp) => fake.commands.filter((c) => c.method.startsWith('Input.') || c.method === 'DOM.setFileInputFiles');

/** The grid as a page reader sees it: data rows only, one column's text per row. */
const column = (fake: FakeErp, grid: 'detail' | 'receipts', index: number) =>
  [...fake.document.querySelectorAll(`.kd-grid-panel[data-grid="${grid}"] tbody tr`)]
    .filter((tr) => !tr.classList.contains('k-footer-template'))
    .map((tr) => String(tr.children[index]?.textContent ?? '').trim());
/** 收票单 (receipt number), the identity ERP keys a 收票行 (receipt row) by. */
const receiptNumbers = (fake: FakeErp) => column(fake, 'receipts', 0);
/** The 收票单号 link each 费用明细行 (detail row) carries, empty ones dropped. */
const receiptLinks = (fake: FakeErp) => column(fake, 'detail', 0).filter(Boolean);
/** The 收票信息 footer's 价税合计 total. */
const receiptTotal = (fake: FakeErp) =>
  String(fake.document.querySelector('.kd-grid-panel[data-grid="receipts"] tr.k-footer-template')?.children[6]?.textContent ?? '').trim();

const writePage = (fake: FakeErp): WritePage => ({ session: fake.session, pace: FAST_PACE });

/**
 * The fill job's own import step over an ERP form that is already open. A whole second fill job cannot reach it:
 * the pre-import preflight refuses a form that is not one blank 费用报销单-新增.
 */
async function uploadAndImport(page: WritePage, invoices: typeof INVOICES) {
  const dir = mkdtempSync(join(tmpdir(), 'baox-reimport-'));
  try {
    const paths = invoices.map((invoice, index) => {
      const path = join(dir, `${index + 1}-${invoice.materialId}.pdf`);
      writeFileSync(path, invoice.bytes);
      return path;
    });
    await openInvoiceAssistant(page, { timeoutMs: 2000 });
    await uploadInvoices(page, paths);
    return await importInvoices(page);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('fill job through the protocol on the fake ERP', () => {
  it('hands over a filled, unsaved form, persisting an attempt before import and fill', async () => {
    const fake = await createFakeErp(fakeErpOptions({ assumeReceiptLink: true }));
    const result = await run(fake);
    expect(result, JSON.stringify(result)).toMatchObject({ type: 'result', status: 'handed_over', billNo: null, code: null });

    const attempts = await jobs.attempts(`job-${taskId}`);
    expect(attempts.map((a) => a.action)).toEqual(['import', 'fill']);
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
    expect(events.at(-1)).toMatchObject({ type: 'result', status: 'handed_over' });
    expect(fake.mutations.map((m) => m.kind).filter((k, i, all) => all.indexOf(k) === i)).toEqual(['import', 'header', 'cell', 'option', 'addRow']);
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
    // While the acknowledgement is held, the ERP form is untouched. The upload has already run, and is allowed to:
    // it consumes nothing (ADR-0025). What must not have happened yet is the 发票导入单据 click.
    expect(fake.mutations).toEqual([]);
    expect(fake.commands.some((c) => c.method === 'DOM.setFileInputFiles')).toBe(true);
    release();
    expect((await job).status).toBe('handed_over');
    expect(persistedBeforeAck).toBe(true);

    const at = (label: string) => order.indexOf(label);
    expect(at('attempt:import')).toBe(0);
    expect(order.indexOf('import')).toBeGreaterThan(at('attempt:import'));
    const fillWrites = order.map((kind, index) => ({ kind, index })).filter((m) => ['header', 'cell', 'option', 'addRow'].includes(m.kind));
    expect(fillWrites.length).toBeGreaterThan(0);
    expect(Math.min(...fillWrites.map((m) => m.index))).toBeGreaterThan(at('attempt:fill'));
    // The fill writes are the last thing that happens: the job ends at the hand-over, so there is no save attempt
    // and no save mutation to order against (ADR-0028).
    expect(Math.max(...fillWrites.map((m) => m.index))).toBe(order.length - 1);
    expect(order).not.toContain('attempt:save');
    expect(order).not.toContain('save');
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

  it('starts no attempt when the upload fails: nothing was consumed, so the task stays retryable and voidable', async () => {
    // The live failure of 2026-09-19: 电脑端选取 was clicked on its caption instead of its anchor, so the assistant
    // stayed on its entry menu. The attempt used to be recorded when the assistant opened, which marked the task as
    // written-to over a run that imported nothing and left it unvoidable for good.
    const fake = await createFakeErp(fakeErpOptions({ assistantStuckOnEntryMenu: true }));
    const result = await run(fake);
    expect(result.status).toBe('aborted');
    expect(result.message).toContain('上传发票影像');
    expect(await jobs.attempts(`job-${taskId}`)).toEqual([]);
    expect(fake.mutations).toEqual([]);
  });

  it('scrolls a menu item that opened below the fold into view instead of clicking a point that hits nothing', async () => {
    // The live failure of 2026-09-19 (job 37dcd84b, INVOICE_ASSISTANT_NOT_FOUND after a 90s wait): 收票信息 had not
    // finished scrolling, so 不生成费用明细 opened at y=941 in a viewport 908 high. The item was measured, the click
    // was dispatched at that point, `document.elementFromPoint` there was null, and the assistant never opened.
    const fake = await createFakeErp(fakeErpOptions({ notFillEntryBelowFold: true, assumeReceiptLink: true }));
    const result = await run(fake);
    expect(result.status).toBe('handed_over');
    expect(fake.mutations.map((m) => m.kind)).toContain('import');
  });

  it('stops before 发票导入单据 when the operator brake is set, having uploaded and ticked but imported nothing', async () => {
    // The brake exists because a live QA round that only wants to verify 勾选 has no reason to spend the one
    // irreversible act. It must land before startAttempt, or the task stops being cleanly retryable.
    process.env['BAOX_ERP_STOP_BEFORE_IMPORT'] = '1';
    try {
      const fake = await createFakeErp(fakeErpOptions({ assumeReceiptLink: true }));
      const result = await run(fake);
      expect(result).toMatchObject({ status: 'aborted', code: 'IMPORT_STOPPED_BEFORE_BOUNDARY' });
      expect(await jobs.attempts(`job-${taskId}`)).toEqual([]);
      expect(fake.mutations).toEqual([]);
    } finally {
      delete process.env['BAOX_ERP_STOP_BEFORE_IMPORT'];
    }
  });

  it('imports normally when the brake is unset, which is every real run', async () => {
    delete process.env['BAOX_ERP_STOP_BEFORE_IMPORT'];
    const fake = await createFakeErp(fakeErpOptions({ assumeReceiptLink: true }));
    const result = await run(fake);
    expect(result.status).toBe('handed_over');
    expect(fake.mutations.map((m) => m.kind)).toContain('import');
  });

  it('aborts on a compatibility fingerprint mismatch before any attempt', async () => {
    const fake = await createFakeErp(fakeErpOptions({ erpBuild: '8.3.101.2' }));
    const result = await run(fake);
    expect(result).toMatchObject({ status: 'aborted', code: 'compatibility_mismatch' });
    expect(result.message).toMatch(/8\.3\.101\.2/);
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

  it('stops before the hand-over when the strict read-back fails (no 收票单号 link on detail rows, as research recorded)', async () => {
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

// What ERP does when an invoice the bill already holds is imported again: it rewrites that 收票行 (receipt row),
// which it keys by its 收票单 (receipt number), instead of adding a second one (ADR-0026). Driven through the fill
// job's own import step, for the reason `uploadAndImport` gives.
describe('re-importing an invoice the bill already holds', () => {
  it('rewrites its 收票行 in place and appends only the invoice the bill does not hold yet', async () => {
    const [rail, ride] = INVOICES;
    const fake = await createFakeErp(fakeErpOptions());
    const page = writePage(fake);
    await openNewReimbursement(page, { timeoutMs: 2000 });
    await uploadAndImport(page, [rail!]);
    expect(receiptNumbers(fake)).toEqual([rail!.receiptNumber]);

    await uploadAndImport(page, [rail!, ride!]);
    expect(receiptNumbers(fake)).toEqual([rail!.receiptNumber, ride!.receiptNumber]);

    // Rows and totals are what a single import of the same set leaves behind.
    const once = await createFakeErp(fakeErpOptions());
    const oncePage = writePage(once);
    await openNewReimbursement(oncePage, { timeoutMs: 2000 });
    await uploadAndImport(oncePage, [rail!, ride!]);
    expect(receiptNumbers(fake)).toEqual(receiptNumbers(once));
    expect(receiptTotal(fake)).toEqual(receiptTotal(once));

    // One `import` entry per import, listing the 收票单 it wrote: the mutation log keeps its shape.
    expect(fake.mutations).toEqual([
      { kind: 'import', detail: rail!.receiptNumber },
      { kind: 'import', detail: `${rail!.receiptNumber},${ride!.receiptNumber}` },
    ]);
  });

  it('strands no 费用明细行 on a 收票单号 that no longer holds its invoice', async () => {
    const [rail, ride] = INVOICES;
    // A fill that stopped before the save: 收票行 imported, detail rows written and linked to them.
    const { fake } = await driveTo('filled');
    expect(receiptLinks(fake)).toEqual([rail!.receiptNumber, ride!.receiptNumber]);
    const total = receiptTotal(fake);

    await uploadAndImport(writePage(fake), [rail!, ride!]);
    expect(receiptNumbers(fake)).toEqual([rail!.receiptNumber, ride!.receiptNumber]);
    expect(receiptLinks(fake)).toEqual([rail!.receiptNumber, ride!.receiptNumber]);
    expect(receiptTotal(fake)).toEqual(total);
  });
});

// What the 发票导入单据 click does, measured live on 2026-09-19 with 12 real invoices: the assistant showed
// 「数据导入中...」 then 「完成发票和附件操作...」 for six seconds, and between t+6s and t+7s its OOPIF target
// detached with nothing replacing it, the 发票无忧助手 window vanished, ERP raised a 处理结果 window reading
// 「执行成功：10；执行失败：2」 and the 收票网格 went from its total row alone to ten data rows. Before that
// measurement this step clicked 不生成费用明细 a second time on the assistant's session and every live run died
// there with `Session with given id not found`.
describe('the 发票导入单据 click', () => {
  const windowText = (fake: FakeErp, id: string) => {
    const win = fake.document.querySelector(id) as any;
    return win.style.display === 'none' ? null : String(win.textContent ?? '').replace(/\s+/g, ' ').trim();
  };

  it('is the last thing the assistant is asked: ERP answers in 处理结果, and 退出 closes it before the fill', async () => {
    const [rail, ride] = INVOICES;
    const fake = await createFakeErp(fakeErpOptions());
    const page = writePage(fake);
    await openNewReimbursement(page, { timeoutMs: 2000 });
    const imported = await uploadAndImport(page, [rail!, ride!]);

    // The wording an all-success import actually gets. 「执行成功：2；执行失败：0」 — what this test used to assert —
    // is a string the real ERP never emits: with nothing to fail it writes 全部执行成功 and names no 执行失败 at all,
    // which is precisely why the judge's 执行失败 regex matched nothing live and a 10-of-10 import was reported as
    // 结果不确定.
    expect(imported.report).toContain('全部执行成功：2');
    expect(imported.report).not.toContain('执行失败');
    // One grid row per invoice, keyed 接收发票 with a 状态 — the per-invoice evidence the verdict is taken from.
    expect(imported.report).toContain('序号 设置 关键字 设置 状态 设置 问题描述');
    expect(imported.report).toContain(`1 接收发票 成功 号码为【${rail!.invoiceNumber}】`);
    expect(imported.report).toContain(`生成收票单【${rail!.receiptNumber}】`);
    expect(receiptNumbers(fake)).toEqual([rail!.receiptNumber, ride!.receiptNumber]);
    // 处理结果 floats over the form with no 遮罩, so a toolbar click aimed at the form would land on it instead.
    expect(windowText(fake, '#result-window')).toBeNull();
  });

  it('carries ERP\'s own refusal for the invoices it would not take, and leaves 处理结果 open for the capture', async () => {
    const [rail, ride] = INVOICES;
    // Measured live: two invoices already bound to a SAVED 费用报销单 were refused by name while the other ten bound.
    const refusal = '已经与【费用报销单-FYBX20260911000011】关联，如需覆盖收票，请到对应单据删除收票信息后保存再重新收票';
    const fake = await createFakeErp(fakeErpOptions({ invoices: [{ ...rail!, importRefusal: refusal }, ride!] }));
    const page = writePage(fake);
    await openNewReimbursement(page, { timeoutMs: 2000 });

    await expect(uploadAndImport(page, [rail!, ride!])).rejects.toMatchObject({ code: 'INVOICE_IMPORT_REFUSED' });
    // With something to fail, the summary goes back to the two-count wording, and the failed invoice's row
    // carries a 状态 that is not 成功 — either alone is enough to stop the run.
    expect(windowText(fake, '#result-window')).toContain('执行成功：1；执行失败：1');
    expect(windowText(fake, '#result-window')).toContain(`接收发票 失败 号码为【${rail!.invoiceNumber}】`);
    // The refusal is per invoice, not per import: the other one is bound, and that is what re-import has to live with.
    expect(receiptNumbers(fake)).toEqual([ride!.receiptNumber]);
    expect(windowText(fake, '#result-window')).toContain(refusal);
    expect((await captureErpError(page)).erpText.join(' ')).toContain(refusal);
  });
});
