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
import { writeHeader } from './executor/erpform';
import { addDetailRow, captureErpError, importInvoices, openInvoiceAssistant, openNewReimbursement, uploadInvoices, type ImportBudget, type WritePage } from './executor/steps';
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
/** 费用明细 data rows, footer excluded — the count `addDetailRow` has to make true. */
const detailRowCount = (fake: FakeErp) => column(fake, 'detail', 0).length;
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
async function uploadAndImport(page: WritePage, invoices: typeof INVOICES, budget?: ImportBudget) {
  const dir = mkdtempSync(join(tmpdir(), 'baox-reimport-'));
  try {
    const paths = invoices.map((invoice, index) => {
      const path = join(dir, `${index + 1}-${invoice.materialId}.pdf`);
      writeFileSync(path, invoice.bytes);
      return path;
    });
    await openInvoiceAssistant(page, { timeoutMs: 2000 });
    await uploadInvoices(page, paths);
    return await importInvoices(page, budget ? { budget } : {});
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

  // A write is not verified by reading back the cell it was typed into. Live 2026-09-20 three of eleven rows read
  // back both money cells correctly and still carried a 申请报销金额 that was not 费用金额 + 税额, so the bill was
  // 116.52 short of the task. ERP's own computed column is the only witness that the value reached ERP, and it is
  // checked row by row, while the row that got it wrong is still the row being written.
  it('stops on the row whose 申请报销金额 disagrees with 费用金额 + 税额, instead of writing on past it', async () => {
    const fake = await createFakeErp(fakeErpOptions({ assumeReceiptLink: true, moneyWritesNotTaken: [{ row: 1, column: '税额' }] }));
    const result = await run(fake);
    // The refusal now comes from the gate between the two money writes rather than from the witness behind it:
    // a value that never reaches ERP's model never lets the computed column agree with the cells, so the fill
    // stops BEFORE typing anything else into that row. Same row, same defect, one step earlier.
    expect(result).toMatchObject({ type: 'result', status: 'unknown', code: 'money_model_not_settled' });
    expect(String((result as { message?: string }).message)).toContain('明细第 2 行');
    expect(String((result as { message?: string }).message)).toContain('申请报销金额');
    // Both rows' computed column, off the fake form: row 1 adds up, row 2 is exactly its 税额 short.
    expect(column(fake, 'detail', 11)).toEqual(['¥703.00', '¥50.12']);
  });

  // The mechanism behind those two, measured rather than injected (ledger V-59): ERP's model trails the cell, and
  // the SECOND money write of a row, typed while the first is still in flight, is dropped. With the fake holding
  // that lag, a fill that types 费用金额 and 税额 back to back loses one of them and lands on
  // `computed_total_mismatch`; a fill that waits for ERP's own 申请报销金额 to agree with the cells before typing
  // the next one gets both in. The gate is what this asserts — no sleep is involved, only ERP's arithmetic.
  it('answers the assistant\'s 温馨提示 where it BLOCKS, not only before the uploads', async () => {
    // Live 2026-09-20: the announcement was up at ROW SELECTION, after the uploads — an `ant-modal-wrap` at
    // z-index 9999 over the whole (0,0)-(800,530) assistant viewport — and the fill died with
    // «「数电票」里的发票 …7691 的勾选框上面盖着DIV「温馨提示…」，点不到它，没有导入任何发票».
    // The one dismissal the code had sat BEFORE the uploads, on the belief that only a first visit is covered,
    // so it could not have helped: by the time the modal mattered, that moment had long passed.
    const fake = await createFakeErp(fakeErpOptions({ assumeReceiptLink: true, noticeReturnsAfterUpload: true }));
    const result = await run(fake);
    expect(result).toMatchObject({ type: 'result', status: 'handed_over' });
  });

  it('answers ERP\'s idle-timeout prompt with 不退出 and carries on, instead of dying under its overlay', async () => {
    // The live stop, twice, ten days apart (2026-09-19 and 2026-09-20): ERP had raised 金蝶提示「系统闲置时间过长」
    // by itself while the session sat, its overlay covered the header strip, and 打开空白报销单 aborted naming a
    // DIV at x=96 y=61. The hit test was right both times; what was missing was a way to clear what it refused.
    // Here the prompt covers the very control the navigation clicks first, so without the answer nothing opens.
    const fake = await createFakeErp(fakeErpOptions({ assumeReceiptLink: true, idlePromptCovers: 'span[data-action="open-list"]' }));
    const result = await run(fake);
    expect(result).toMatchObject({ type: 'result', status: 'handed_over' });
    // Answered with the button that KEEPS the session: 继续退出 hides the console shortcuts for good, so a run
    // that got as far as 交接单据 cannot have clicked it. And the cover is gone because the prompt was answered,
    // not because something else happened to move it.
    const style = (selector: string) => String(fake.document.querySelector(selector)?.style?.display ?? '');
    expect(style('.kd-mainconsole-shortcuts')).not.toBe('none');
    expect(style('#idle-window')).toBe('none');
    expect(fake.document.querySelector('span[data-action="open-list"]')?.getAttribute('data-covered-by')).toBeNull();
  });

  it('paces the two money cells against ERP\'s computed column, so a lagging model loses neither', async () => {
    // 40 is measured, not picked: the fake counts its lag in PAGE EVALUATIONS, not milliseconds, and `writeCell`
    // burns a good number of them on its own read-back between the two commits. Below ~20 the window is already
    // over before 税额 is typed and the test proves nothing; at 40 the write is dropped with the gate removed and
    // survives with it in place — which is the discrimination the test is for. (Checked both ways by hand.)
    const fake = await createFakeErp(fakeErpOptions({ assumeReceiptLink: true, moneyModelLagTicks: 40 }));
    const result = await run(fake);
    expect(result).toMatchObject({ type: 'result', status: 'handed_over' });
    // Both rows add up in ERP's own column: nothing was typed into a cell and lost on the way to the model.
    // Checked against the form's own 费用金额 and 税额 rather than against numbers copied out of the fixture,
    // so the assertion still means "ERP agrees with itself" if the fixture amounts ever change.
    const asCents = (shown: string) => Math.round(Number(String(shown).replace(/[¥,]/g, '')) * 100);
    const [net, tax, sum] = [9, 10, 11].map((index) => column(fake, 'detail', index));
    expect(sum!.map(asCents)).toEqual(net!.map((amount, index) => asCents(amount) + asCents(tax![index]!)));
  });

  // Live 2026-09-20, with the owner reporting that BOTH money cells fill by hand on this very form: the fill lost
  // 税额 every single time while the identical clicks, keys and Enter, typed by hand with a pause before the
  // commit, took every single time. The difference was never the value, the column or the order — it was that
  // `writeCell` pressed Enter on the heels of the last keystroke. 税额's Enter closes the WHOLE edit row, so a
  // commit that arrives before Kendo has taken the last character shuts the row with the cell empty; 费用金额
  // survives the same race only because its Enter leaves the row open. The fix waits for the editor to hold a
  // settled value before committing, and this is what stops anyone deleting that wait: with the window open,
  // an unwitnessed commit loses the cell and the bill goes out short. 3 is measured, not picked: a commit on the
  // heels of the last character sits exactly 2 CDP commands behind it, and the wait costs two reads more —
  // checked both ways, the test goes red with the wait taken out and green with it in.
  it('waits for the editor to hold the value before committing, so a slow-to-parse cell is not lost', async () => {
    const fake = await createFakeErp(fakeErpOptions({ assumeReceiptLink: true, editorSettleTicks: 3 }));
    const result = await run(fake);
    expect(result).toMatchObject({ type: 'result', status: 'handed_over' });
    const asCents = (shown: string) => Math.round(Number(String(shown).replace(/[¥,]/g, '')) * 100);
    const [net, tax, sum] = [9, 10, 11].map((index) => column(fake, 'detail', index));
    expect(sum!.map(asCents)).toEqual(net!.map((amount, index) => asCents(amount) + asCents(tax![index]!)));
  });

  // Live 2026-09-20, on a freshly added 费用明细行 of a real 费用报销单: 项目 (a 选择类 F7 column) reported a bound,
  // FOCUSED input, and the `111705` typed into it landed nowhere at all — three fresh rows, three failures, while
  // the same write into a row whose editor had been opened before went in every time. A second click and a second
  // typing landed it, and the ERP then resolved the code to the project name within a second. The ERP re-renders
  // the control as it initialises its data source, so the input bound a moment ago is not the one on the page.
  // This is what stops anyone deleting the retype: with the first run swallowed and no second attempt, the whole
  // 去报销 stops on the detail row's very first field. Checked both ways — red without the retype, green with it.
  it('types again when the editor took nothing, so a control the ERP re-rendered does not lose the field', async () => {
    const fake = await createFakeErp(fakeErpOptions({ assumeReceiptLink: true, firstTypingLostOn: '项目' }));
    const result = await run(fake);
    expect(result).toMatchObject({ type: 'result', status: 'handed_over' });
    // Every detail row carries the project, read off the form rather than off the fixture.
    const projects = column(fake, 'detail', 1);
    expect(projects!.length).toBeGreaterThan(0);
    expect(projects!.filter((shown) => String(shown).trim() !== '')).toEqual(projects);
  });

  // The same rule from the other side: a 费用金额 that never reaches the model leaves 申请报销金额 = 税额 alone,
  // which is live row 2's shape (¥15.56 + ¥0.47 -> ¥0.47). Here the loss is on the FIRST money cell, so the gate
  // refuses before 税额 is typed at all — the next write is exactly what it is there to withhold.
  it('catches a 费用金额 that never reached the model just as well as a lost 税额', async () => {
    const fake = await createFakeErp(fakeErpOptions({ assumeReceiptLink: true, moneyWritesNotTaken: [{ row: 0, column: '费用金额' }] }));
    const result = await run(fake);
    expect(result).toMatchObject({ type: 'result', status: 'unknown', code: 'money_model_not_settled' });
    expect(String((result as { message?: string }).message)).toContain('明细第 1 行');
  });

  // The whole point of fixing D-A and D-B together: a report that will not close must never be allowed to turn a
  // successful import into a mystery. The import is done and judged; the fill has not started and will not start
  // over a form with something floating on it — and the refusal is decided BEFORE `attempt_started` for the fill,
  // so no fill attempt is ever recorded for a fill that never touched the form.
  it('stops before the fill attempt when a window will not leave the form, and tells the employee the invoices are bound', async () => {
    const fake = await createFakeErp(fakeErpOptions({ assumeReceiptLink: true, importReportStaysOpen: true }));
    const result = await run(fake);
    expect(result).toMatchObject({ type: 'result', status: 'unknown', code: 'form_obstructed_before_fill' });
    // The first sentence is the part that is certain: the invoices are bound. Then what is in the way.
    expect(result.message).toContain('发票已经全部导入并绑定');
    expect(result.message).toContain('处理结果');
    expect(result.message).not.toContain('结果不确定');
    // One attempt, not two: the fill never started, so the task carries no record of a fill that wrote nothing.
    expect((await jobs.attempts(`job-${taskId}`)).map((a) => a.action)).toEqual(['import']);
    // The import's read-back still ran and still passed; nothing after it did.
    const events = await jobs.events(`job-${taskId}`);
    expect(events.filter((e) => e.type === 'readback').map((e) => (e as { stage: string }).stage)).toEqual(['after_import']);
    // Nothing was typed into the form or into the report.
    expect(fake.mutations.map((m) => m.kind)).toEqual(['import']);
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
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'handed_over' });
    expect(fake.mutations.map((m) => m.kind)).toContain('import');
  });

  // Live 2026-09-19, the round after V-54 was fixed: the very first act of 去报销 after the form opened —
  // clicking the 收票信息 区域锚点 at (312, 145) — hit-tested to an anonymous DIV, the ERP's own blocking overlay
  // over the top bar while the form finishes opening. That is a form that is BUSY, not stuck. Reading the anchor
  // once and refusing stopped a run that would have gone through a second later; clicking it anyway sends the
  // navigation into the overlay and calls a section shown that never was.
  it('outwaits the blocking overlay a form paints over its own section anchors', async () => {
    const fake = await createFakeErp(fakeErpOptions({ assumeReceiptLink: true, sectionOverlayTicks: 6 }));
    const result = await run(fake);
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'handed_over' });
    expect(fake.mutations.map((m) => m.kind)).toContain('import');
  });

  // Live 2026-09-20, the round after the date columns were fixed: the fill had written 项目 and 费用项目 into
  // row 1 and stopped on 「发票类型」的落点（x=629 y=843）上盖着DIV. Read again a minute later, that point answered
  // the cell itself — the cover was momentary, and selectOption read the point exactly once.
  it('outwaits a cover that is over the 发票类型 cell for a moment, instead of refusing on one read', async () => {
    const fake = await createFakeErp(fakeErpOptions({ assumeReceiptLink: true, invoiceTypeCoverTicks: 30 }));
    const result = await run(fake);
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'handed_over' });
    expect(fake.mutations.map((m) => m.kind)).toContain('option');
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
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'handed_over' });
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

  // Live 2026-09-19: `期望 8.2.830.9 / ER_ExpReimbursement，实际 8.2.830.9 / 0 个表单` — the build matched and the
  // form id read as zero, because the fingerprint was read once, the instant the tab opened, while Kendo still had
  // `k-state-active` on the console's own panel. The same page answered `["ER_ExpReimbursement"]` when asked again.
  it('waits for the new tab to become the active panel instead of calling a half-opened tab a version mismatch', async () => {
    const fake = await createFakeErp(fakeErpOptions({ assumeReceiptLink: true, formPanelActiveTicks: 12 }));
    const result = await run(fake);
    expect([result.code, result.message]).toEqual([null, null]);
    expect(result.status).toBe('handed_over');
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
describe('opening a new 费用报销单', () => {
  it('reports the form as opened only when the 费用报销单-新增 tab is actually on screen', async () => {
    const fake = await createFakeErp(fakeErpOptions({ newFormClickDead: true }));
    // The wait's result used to be discarded and `{ok:true}` returned regardless, so the run walked on with no
    // form and failed later, somewhere else, saying something else.
    await expect(openNewReimbursement(writePage(fake), { timeoutMs: 200 }))
      .rejects.toMatchObject({ code: 'ERP_NEW_FORM_NOT_OPENED' });
  });
});

// Live 2026-09-20: a 去报销 wrote 费用明细 row 1 in full — 项目, 费用项目, 发票类型, both dates, both amounts — read
// every one of them back off the real form, clicked 新增行 and stopped on `add_row_not_observed`. The row was on
// the form. The click was never lost; the read was too early, because `addDetailRow` returned `{ok:true}` without
// waiting for anything and `draft-flow.ts` asserted the new row count in the very next read.
describe('adding a 费用明细行', () => {
  it('returns only once the new row is in the grid the caller then reads', async () => {
    const fake = await createFakeErp(fakeErpOptions({ newRowAppearsAfterTicks: 3 }));
    const page = writePage(fake);
    await openNewReimbursement(page, { timeoutMs: 2000 });
    const before = detailRowCount(fake);
    const added = await addDetailRow(page, { timeoutMs: 2000 });
    // The grid is read the way the caller reads it, at the moment the step hands back.
    expect(detailRowCount(fake)).toBe(before + 1);
    expect(added).toMatchObject({ ok: true, rowCount: before + 1, rowIndex: before });
  });

  it('refuses when the row never appears, instead of reporting a click as a row', async () => {
    const fake = await createFakeErp(fakeErpOptions({ newRowAppearsAfterTicks: 100_000 }));
    const page = writePage(fake);
    await openNewReimbursement(page, { timeoutMs: 2000 });
    const before = detailRowCount(fake);
    await expect(addDetailRow(page, { timeoutMs: 200 })).rejects.toMatchObject({ code: 'ERP_DETAIL_ROW_NOT_ADDED' });
    expect(detailRowCount(fake)).toBe(before);
  });

  it('carries a whole fill through an ERP that paints the row late', async () => {
    const fake = await createFakeErp(fakeErpOptions({ newRowAppearsAfterTicks: 3 }));
    // The run still stops where it stopped before — at the strict read-back — and no longer at the add.
    const result = await run(fake);
    expect(result).toMatchObject({ status: 'unknown', code: 'strict_readback_failed' });
    // Two lines over one placeholder row: exactly one 新增行, and it was waited for rather than assumed.
    expect(fake.mutations.filter((m) => m.kind === 'addRow')).toEqual([{ kind: 'addRow', detail: '2' }]);
  });

  // Live 2026-09-20, five 费用明细行 further in than any run had ever got: the sixth row's 发票类型 dropdown opened
  // and the run stopped on 「发票类型」候选项「普通发票」的落点（x=629 y=697）上盖着DIV. The cell's point had been
  // polled since the round before; the ITEM's point was read once, out of the probe that had just waited for the
  // list to appear — the earliest possible read of a list that was still being painted.
  it('waits for the dropdown item it wants to be reachable, not just painted', async () => {
    const fake = await createFakeErp(fakeErpOptions({ optionItemCoverTicks: 3 }));
    const result = await run(fake);
    expect(result).toMatchObject({ status: 'unknown', code: 'strict_readback_failed' });
    expect(fake.mutations.filter((m) => m.kind === 'option')).toEqual([
      { kind: 'option', detail: '发票类型=普通发票' }, { kind: 'option', detail: '发票类型=普通发票' },
    ]);
  });

  // The same read-too-early, one step later: the grid keeps `k-grid-edit-row` on the committed row for a render
  // or two, and `leaveEdit` used to read that state exactly once — reporting a form that is merely still painting
  // as a form stuck in edit (`leave_edit_failed`).
  it('leaves edit mode over a grid that drops its edit row a render late', async () => {
    const fake = await createFakeErp(fakeErpOptions({ editRowLingersTicks: 3 }));
    const result = await run(fake);
    expect(result).toMatchObject({ status: 'unknown', code: 'strict_readback_failed' });
  });
});

// The 选择发票 split menu holds three adjacent items — `tbMergeFillEntry 合并生成费用明细`,
// `tbMappingFillEntry 不合并生成费用明细`, `tbNotFillEntry 不生成费用明细` — and only the last leaves the
// 费用明细 grid alone. D2 (a live run that believed it had chosen 不生成费用明细 and found two rows aggregated by
// 发票类型 with the 收票单号 comma-joined) is exactly the shape 合并生成费用明细 produces, on a page where V-53
// proved a mouse event can be delivered somewhere other than where it was aimed. The mode cannot be re-chosen:
// the next thing that happens is the import.
describe('choosing the import mode on the 选择发票 menu', () => {
  it('proves by element id which item the click reaches, and refuses when that is not 不生成费用明细', async () => {
    const fake = await createFakeErp(fakeErpOptions({ notFillEntryHitsNeighbour: true }));
    const page = writePage(fake);
    await openNewReimbursement(page, { timeoutMs: 2000 });
    await expect(openInvoiceAssistant(page, { timeoutMs: 200 }))
      .rejects.toMatchObject({ code: 'INVOICE_IMPORT_MODE_NOT_SELECTED', message: expect.stringContaining('tbMergeFillEntry') });
    // Refusing is the whole point: not one click of the irreversible path may run in the wrong mode.
    expect(fake.importMode).toBe(null);
    expect(fake.mutations).toEqual([]);
  });

  it('names the item it selected, read back from the page rather than assumed', async () => {
    const fake = await createFakeErp(fakeErpOptions({}));
    const page = writePage(fake);
    await openNewReimbursement(page, { timeoutMs: 2000 });
    const opened = await openInvoiceAssistant(page, { timeoutMs: 2000 });
    expect(opened).toMatchObject({ ok: true, mode: '不生成费用明细' });
    expect(String(opened.selectedId)).toMatch(/tbNotFillEntry$/);
    expect(opened.menuItemIds).toEqual(['tbMergeFillEntry', 'tbMappingFillEntry', 'tbNotFillEntry'].map((id) => expect.stringContaining(id)));
    expect(fake.importMode).toBe('不生成费用明细');
    // V-53 again: the assistant lives in its own OOPIF target, and every tick is clicked into it, so that session
    // is told it is focused too — best-effort there, fatal on the page target.
    expect(fake.commands.filter((c) => c.method === 'Emulation.setFocusEmulationEnabled').map((c) => c.sessionId))
      .toContain('piaozone-session-1');
  });
});

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

  // The sixth live round died here. `importInvoices` borrowed `pace.longMs` (90 s), and at T+90s the 处理结果
  // window held nothing but the word 处理结果 — no toolbar, no summary, no grid; minutes later it held the full
  // ten-row all-success report. A successful irreversible write was reported to the employee as 结果不确定.
  //
  // The proportions are kept and the clock is scaled: `longMs` here is 50 ms standing in for the live 90 s, and
  // the report takes 30 page reads to paint, which is longer. On the old flat deadline this case is
  // INVOICE_IMPORT_NOT_ANSWERED; the import's own budget waits for a window that is still painting.
  it('waits out a 处理结果 that is still painting, rather than the generic slow-ERP deadline', async () => {
    const [rail, ride] = INVOICES;
    const fake = await createFakeErp(fakeErpOptions({ importReportTicks: 30 }));
    const page: WritePage = { session: fake.session, pace: { ...FAST_PACE, longMs: 50 } };
    await openNewReimbursement(page, { timeoutMs: 2000 });
    const imported = await uploadAndImport(page, [rail!, ride!]);
    expect(imported.report).toContain('全部执行成功：2');
    expect(receiptNumbers(fake)).toEqual([rail!.receiptNumber, ride!.receiptNumber]);
  });

  it('gives up on a 处理结果 that has stopped changing, and says which bound it ran out of', async () => {
    const [rail, ride] = INVOICES;
    const fake = await createFakeErp(fakeErpOptions({ importReportStalled: true }));
    const page = writePage(fake);
    await openNewReimbursement(page, { timeoutMs: 2000 });
    const budget = { appearMs: 2000, stallMs: 30, hardCapMs: 4000 };
    await expect(uploadAndImport(page, [rail!, ride!], budget))
      .rejects.toMatchObject({ code: 'INVOICE_IMPORT_NOT_ANSWERED', message: /没有任何变化/ });
  });

  // V-54, and the class behind it: a wait whose verdict is discarded, and a click on a point nobody hit-tested.
  //
  // Live 2026-09-19 a 去报销 imported ten invoices cleanly, judged them cleanly, passed the `after_import`
  // read-back, started 填费用明细 for the first time ever and died 4.1 s later on `header_write_failed`
  // 「点了表头字段 FCAUSA 之后焦点没有落进这个控件」. The locator was right and the field was where it said.
  // The 处理结果 window had survived the import's 退出 and floated over the form at z-index 10005 with no 遮罩:
  // `elementFromPoint(371, 334)` answered a SPAN「接收发票」 inside the report. `importInvoices` had clicked a
  // point it never hit-tested and thrown away the verdict of the wait that followed, so it returned `{ok:true}`
  // over a report that was still standing.
  it('says whether 处理结果 actually closed, instead of returning ok over a report that is still up', async () => {
    const [rail, ride] = INVOICES;
    const fake = await createFakeErp(fakeErpOptions({ importReportStaysOpen: true }));
    const page = writePage(fake);
    await openNewReimbursement(page, { timeoutMs: 2000 });
    const imported = await uploadAndImport(page, [rail!, ride!]);
    // The import itself went right and still says so: this is not an error, and reporting it as one would call a
    // completed irreversible act a failure.
    expect(imported).toMatchObject({ ok: true, reportClosed: false });
    expect(imported.report).toContain('全部执行成功：2');
    expect(imported.stillOpen.join(' ')).toContain('处理结果');
    expect(windowText(fake, '#result-window')).toContain('处理结果');
  });

  it('writes nothing into a header field the report is sitting on, and names what is in the way', async () => {
    const [rail, ride] = INVOICES;
    const fake = await createFakeErp(fakeErpOptions({ importReportStaysOpen: true }));
    const page = writePage(fake);
    await openNewReimbursement(page, { timeoutMs: 2000 });
    await uploadAndImport(page, [rail!, ride!]);
    const written = await writeHeader(fake.session, 'FCAUSA', '客户支持', { pace: FAST_PACE, settleMs: 1 });
    // 「焦点没有落进这个控件」 is what this said live, and it is an accusation against a control that was fine.
    expect(written.ok).toBe(false);
    // Names what is at the point — the report's own window — rather than accusing the control.
    expect(written.reason).toContain('盖着SPAN');
    expect(written.reason).not.toContain('焦点没有落进');
    // Refused before the click, so nothing was typed anywhere — not into the report, not into the form.
    expect(fake.mutations.map((m) => m.kind)).not.toContain('header');
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
