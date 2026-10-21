// The v1 in-process ERP executor: one fill plan in, protocol events out (ADR-0016).
//
// Job order: Chromium ready -> login probe (signing in with the hosted ERP 凭据) -> 报销信息核对 (catalog check) ->
// navigate + compatibility fingerprint -> import -> fill -> strict read-back -> 暂存 -> 核对暂存单. The job never
// clicks 保存 (save): it presses 暂存 and ends at the draft, found by its marker, which the employee checks and submits
// (ADR-0029, ADR-0037). Before each mutation the executor observes its preconditions,
// sends `attempt_started`, waits for the server to persist it, and re-checks target, form-instance UUID, 新增 mode
// and URL. Failure before the first attempt aborts cleanly (retryable); anything after it is ERP 写入结果未知
// (write result unknown) and goes to reconcile, never to replay. The executor never judges read-backs: it sends
// them as `readback` and acts on the server's verdict.

import {
  FillPlanSchema, filledRows, markedPurpose, type Approval, type ApprovedPreview, type BlobSource, type Compatibility, type ErpAccount,
  type ExecutorChannel, type Mutation, type Preconditions, type ReadbackStage, type ResultEvent, type ResultStatus, type FreshGate,
  type Step, type StepProgress,
} from './protocol';
import { evalIn, type CdpSession } from './cdp';
import { checkCatalog } from './catalog';
import { ExecutorError, type ChromiumPage } from './page';
import { compareDraft, findDrafts, pressDraft, viewDraft, waitDrafted } from './draft';
import { fillApprovedPreview, handOverApprovedPreview, type CurrentReadings } from './draft-flow';
import { leaveEdit, selectOption, writeCell, writeHeader } from './erpform';
import { checkRerun, RECEIPT_INVOICE_NO, rerunRefusal } from './occupancy';
import { DEFAULT_PACE, waitFor, type Pace } from './pace';
import { COMPATIBILITY_SNIPPET, probeIdentity, sameOrigin } from './probe';
import { pageUrl, protocolReadings, readForm, type FormReadings } from './reader';
import {
  addDetailRow, captureErpError, closeErpDialogs, invoiceUploadGroups, openInvoiceAssistant, openNewReimbursement,
  importInvoices, uploadInvoices, type WritePage,
} from './steps';
import type { StagedInvoices } from './invoice-files';
import { stageInvoices } from './staging';
import { prepareErpWrite } from './write-context';

/** How the executor reaches Chromium. v1: the dedicated profile over CDP; tests: the fake ERP. */
export type BrowserPort = {
  listPages(): Promise<ChromiumPage[]>;
  attach(page: ChromiumPage): Promise<ChromiumPage & { session: CdpSession }>;
};

export type ExecutorPorts = {
  browser: BrowserPort;
  blobs: BlobSource;
  channel: ExecutorChannel;
  /** Parent directory for each job's invoice staging directory (`invoice-files.ts`; default: the OS temp dir). */
  stagingRoot?: string;
  pace?: Pace;
  /** How long the login probe waits for a slow ERP first screen. */
  probeWaitMs?: number;
  /**
   * Sign in with the employee's ERP 凭据 when the probe finds the login page (ADR-0033). Without it a login page ends
   * the job, before any attempt: nobody is there to log in (ADR-0037).
   */
  signIn?: (session: CdpSession) => Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  /** The 费用报销单 field an 自动重新去报销 asks ERP about (`occupancy.ts`); null stops every re-run as unanswered. */
  occupancyField?: string | null;
  newId?: () => string;
};

class DriftError extends ExecutorError {
  constructor(readonly reasons: string[]) {
    super('erp_drift', `ERP 页面在动作前发生漂移：${reasons.join('；')}`);
  }
}

// The job found no logged-in ERP and had nothing to sign in with (or signing in left it on the login page).
export const NOT_SIGNED_IN_CODE = 'erp_login';
export const notSignedIn = (hint: string | null | undefined) =>
  `报销系统没有登录，本地执行器也没能用报销系统账号登录。请在设置页保存报销系统账号和密码后再试。${hint ? `（${hint}）` : ''}`;

// A draft-flow problem as the result message: its own sentence, then the server's reasons (strict read-back).
const problemText = (problem: { message: string; [extra: string]: unknown }) =>
  [problem.message, ...(Array.isArray(problem['reasons']) ? (problem['reasons'] as unknown[]).map(String) : [])].join('：');

export async function runFillJob(rawPlan: unknown, ports: ExecutorPorts): Promise<ResultEvent> {
  const plan = FillPlanSchema.parse(rawPlan);
  const { browser, channel } = ports;
  const pace = ports.pace ?? DEFAULT_PACE;
  const newId = ports.newId ?? (() => crypto.randomUUID());
  const attached = new Map<string, ChromiumPage & { session: CdpSession }>();
  let write: WritePage | null = null;
  let staged: StagedInvoices | null = null;
  let attempted = false;
  let erpAccount: ErpAccount | null = null;
  let compatibility: Compatibility | null = null;
  let currentStep: Parameters<typeof step>[0] | null = null;

  async function step(name: Step, status: 'running' | 'done' | 'failed', progress?: StepProgress) {
    currentStep = status === 'running' ? name : null;
    await channel.emit({ type: 'step', step: name, status, ...(progress ? { progress } : {}) });
  }

  async function finish(status: ResultStatus, code: string | null, message: string | null, billNo: string | null = null, draftId: string | null = null): Promise<ResultEvent> {
    if (currentStep && status !== 'drafted') await step(currentStep, 'failed');
    const capture = status === 'aborted' || status === 'unknown' ? (write ? await captureErpError(write) : null) : null;
    const event: ResultEvent = { type: 'result', status, code, message, billNo, capture, ...(draftId ? { draftId } : {}) };
    await channel.emit(event);
    return event;
  }

  const attach = async (page: ChromiumPage) => {
    const key = String(page.cdpTargetId ?? page.url);
    if (!attached.has(key)) attached.set(key, await browser.attach(page));
    return attached.get(key)!;
  };

  try {
    // 1. Chromium ready.
    await step('chromium', 'running');
    const pages = (await browser.listPages()).filter((page) => sameOrigin(page.url, plan.erpOrigin));
    await step('chromium', 'done');

    // 2. Login probe, signing in with the 凭据 on the login page. Still not logged in: the job ends, holding nothing
    //    (no attempt exists yet).
    await step('login', 'running');
    const probeLogin = (tabs: ChromiumPage[]) => probeIdentity({
      origin: plan.erpOrigin, waitMs: ports.probeWaitMs ?? 30_000, pollMs: pace.pollMs, transport: 'chromium-cdp',
      listTabs: async () => tabs,
      evaluate: async (page, expression) => evalIn((await attach(page as ChromiumPage)).session, expression, { timeout: 10_000 }),
    });
    let probe = await probeLogin(pages);
    // A page that is neither console nor login is given to the sign-in too, which loads the entry page again while
    // no form comes: live it was a blank entry page (2026-10-13 2 of 10, 2026-10-19, 2026-10-20 2 of 21). Should no
    // form come of it either, the job stops saying what the page showed, not that no form came.
    if ((probe.status === 'not_logged_in' || probe.status === 'unknown') && probe.page && ports.signIn) {
      const signedIn = await ports.signIn((await attach(probe.page as ChromiumPage)).session);
      if (!signedIn.ok && probe.status === 'unknown' && signedIn.code === 'erp_sign_in_no_form') return await finish('aborted', 'erp_login_unknown', probe.hint ?? null);
      if (!signedIn.ok) return await finish('aborted', signedIn.code, signedIn.message);
      probe = await probeLogin((await browser.listPages()).filter((page) => sameOrigin(page.url, plan.erpOrigin)));
    }
    if (probe.status === 'not_logged_in' || probe.status === 'no_tab') return await finish('aborted', NOT_SIGNED_IN_CODE, notSignedIn(probe.hint));
    if (probe.status !== 'matched' || !probe.identity || !probe.page) return await finish('aborted', `erp_login_${probe.status}`, probe.hint ?? null);
    erpAccount = probe.identity;
    const page = await attach(probe.page as ChromiumPage);
    const session = page.session;
    write = { session, pace };
    const targetId = String(page.cdpTargetId ?? '');
    await step('login', 'done');

    // 3. 报销信息核对: a mismatch aborts before import, with no attempt.
    await step('catalog', 'running');
    const catalog = await checkCatalog(session, plan.catalog);
    if (!catalog.ok) return await finish('aborted', 'catalog_query_failed', catalog.reason);
    if (catalog.problems.length) {
      await channel.emit({ type: 'catalog_mismatch', problems: catalog.problems });
      return await finish('catalog_mismatch', 'catalog_mismatch', catalog.problems.map((p) => `${p.kind} ${p.code}: ${p.verdict}`).join('；'));
    }
    // An 自动重新去报销 (ADR-0034) goes on only while ERP shows the task's bill never landed; otherwise it stops here,
    // with no attempt, and the task goes to 对账.
    if (plan.rerun) {
      const clear = await checkRerun(session, plan.rerun, ports.occupancyField === undefined ? RECEIPT_INVOICE_NO : ports.occupancyField);
      if (!clear.ok) return await finish('aborted', clear.code, rerunRefusal(clear));
    }
    await step('catalog', 'done');

    // Invoices by content, fetched and verified before any page action; a bad file stops here.
    staged = await stageInvoices(plan.invoices, ports.blobs, ports.stagingRoot);
    invoiceUploadGroups(staged.names);

    // Preconditions of the next mutation, and the drift guard against the baseline taken after navigation.
    let baseline: { url: string; formInstanceId: string } | null = null;
    const observe = async (): Promise<{ readings: FormReadings; pre: Preconditions | null; drift: string[] }> => {
      const readings = await readForm(session);
      const url = await pageUrl(session);
      const listed = (await browser.listPages()).some((candidate) => String(candidate.cdpTargetId ?? '') === targetId);
      const drift: string[] = [];
      if (!listed) drift.push(`CDP 目标 ${targetId} 已不在`);
      if (baseline && url !== baseline.url) drift.push(`页面地址从 ${baseline.url} 变成 ${url}`);
      if (!readings.formInstanceId) drift.push('读不到唯一可见的表单实例');
      else if (baseline && readings.formInstanceId !== baseline.formInstanceId) drift.push('可见表单实例 UUID 变了');
      if (readings.formMode.value !== 'new') drift.push(`页签不是唯一的费用报销单-新增（${readings.formMode.value ?? '读不到'}）`);
      const rows = (grid: FormReadings['receiptsGrid']) => (grid.ok ? grid.rows.filter((row) => row.kind === 'data').length : -1);
      const pre = drift.length ? null : {
        targetId, url, formInstanceId: readings.formInstanceId!, formMode: 'new' as const, billNo: readings.billNo.value,
        receiptRowCount: rows(readings.receiptsGrid), detailRowCount: rows(readings.detailGrid),
      };
      return { readings, pre, drift };
    };

    // attempt_started, awaited until durable, then the post-ack re-check. Only then may the caller mutate.
    const startAttempt = async (action: Mutation, expectedPostconditions: Record<string, unknown>) => {
      const before = await observe();
      if (!before.pre) throw new DriftError(before.drift);
      await channel.emit({
        type: 'attempt_started', attemptId: newId(), action, preconditions: before.pre, expectedPostconditions,
        compatibility: compatibility!, erpAccount: erpAccount!,
      });
      attempted = true;
      const after = await observe();
      const moved = [...after.drift];
      if (after.pre && JSON.stringify(after.pre) !== JSON.stringify(before.pre)) moved.push('动作前的表单状态在确认记录之后变了');
      if (moved.length) throw new DriftError(moved);
    };

    // 4. Navigate to one blank new form, check the compatibility fingerprint, open the assistant. Nothing here is a
    //    mutation, so nothing here starts an attempt.
    await step('navigate', 'running');
    await prepareErpWrite({
      page: write,
      navigate: (p) => openNewReimbursement(p, {
        timeoutMs: 45_000, replaceNewForms: plan.replaceAbandonedForm === true,
        ...(ports.signIn ? { signIn: async () => (await ports.signIn!(session)).ok } : {}),
      }),
      read: async () => {
        const readings = await readForm(session);
        await step('compatibility', 'running');
        // Polled, not read once. The fingerprint is taken moments after a tab opened, and until Kendo has moved
        // `k-state-active` onto that tab the 费用报销单 is not on any active panel yet — a single read turned that
        // race into `compatibility_mismatch` on a build that matched (2026-09-19: 实际 8.2.830.9 / 0 个表单), and
        // the same untouched page answered `["ER_ExpReimbursement"]` when asked again. Only a reading that stays
        // wrong for the whole window is a real mismatch.
        //
        // What is waited for is the expected form id being THERE, not the panels holding exactly one id: the
        // console's own active panel carries `BOS_TeamWorkMainConsole`, so «exactly one» is answered by a page
        // that has not opened the form at all. The tripwire is unchanged in what it catches — a moved build or a
        // 费用报销单 that no longer answers to this form id still stops the run before any write.
        const expectedFormId = plan.compatibility.formId;
        const fingerprint = (p: { erpBuild: string | null; formIds: string[] } | null) =>
          p?.erpBuild === plan.compatibility.erpBuild && p?.formIds?.includes(expectedFormId) === true;
        const probed = await waitFor(
          () => evalIn<{ erpBuild: string | null; formIds: string[]; activePanels?: number }>(session, COMPATIBILITY_SNIPPET),
          fingerprint, Math.min(15_000, pace.longMs), pace.pollMs);
        if (!fingerprint(probed)) {
          const seen = probed?.formIds?.length ? probed.formIds.join('、') : `${probed?.formIds?.length ?? 0} 个表单`;
          throw new ExecutorError('compatibility_mismatch',
            `报销系统的版本与上次核对时不一致，没有继续：期望 ${plan.compatibility.erpBuild} / ${expectedFormId}，`
            + `实际 ${probed?.erpBuild ?? '读不到'} / ${seen}。报销系统没有被改动。`);
        }
        // Past the check both halves are known to equal the plan's, so the plan's are what is recorded.
        compatibility = { erpBuild: plan.compatibility.erpBuild, formId: expectedFormId };
        await step('compatibility', 'done');
        currentStep = 'navigate';
        baseline = { url: await pageUrl(session), formInstanceId: readings.formInstanceId ?? '' };
        return readings;
      },
      openAssistant: (p) => openInvoiceAssistant(p, { timeoutMs: 90_000 }),
      mark: async () => {
        await step('navigate', 'done');
      },
    });

    // 5. Import. Upload and recognition are free and repeatable (ADR-0025), so the attempt is recorded between them
    //    and the 发票导入单据 click rather than before the upload. The crash window is unchanged — the row is still
    //    durable before the one irreversible act — but a failure while uploading no longer marks the task as written
    //    to, so it stays retryable and stays voidable.
    await step('import', 'running');
    await uploadInvoices(write, staged.names, { put: staged.put });
    // An operator brake for live QA, and nothing else. Upload and 勾选 are free and repeatable, but the
    // 发票导入单据 click that follows is the one irreversible act, and a QA round that wants to verify selection
    // against the real ERP has no reason to spend it: the invoices get bound to a 费用报销单 that nobody will save.
    // Unset — which is every real run — this changes nothing. It deliberately throws BEFORE startAttempt, so the
    // task keeps a clean `aborted` with no attempt row, and stays both retryable and voidable.
    if (globalThis.process?.env['BAOX_ERP_STOP_BEFORE_IMPORT'] === '1') {
      throw new ExecutorError('IMPORT_STOPPED_BEFORE_BOUNDARY',
        '按 BAOX_ERP_STOP_BEFORE_IMPORT 的要求，在「发票导入单据」之前停下了：发票已上传并全部勾选，但没有导入任何发票。');
    }
    await startAttempt('import', { formMode: 'new', billNo: null, receiptRowCount: plan.invoices.length });
    // The import's own answer is read, not discarded: its 处理结果 text is ERP's verbatim verdict on every
    // invoice, and `reportClosed` says whether the report it opened actually went away. When ERP opens no window
    // at all (live 2026-09-21), the count posted here is what lets the bill's own 收票行 answer instead.
    const importResult = await importInvoices(write, { expectedRows: plan.invoices.length });
    await step('import', 'done');

    await step('readback', 'running');
    const imported = await readForm(session);
    const importVerdict = await channel.emit({ type: 'readback', stage: 'after_import', readings: protocolReadings(imported) });
    if (!importVerdict.ok || !importVerdict.preview || !importVerdict.approval || !importVerdict.freshGate) {
      return await finish('unknown', 'receipt_readback', importVerdict.ok ? '服务器没有给出已批准的草稿预览' : importVerdict.reasons.join('；'));
    }
    await step('readback', 'done');
    const preview: ApprovedPreview = importVerdict.preview;
    const approval: Approval = importVerdict.approval;
    const freshGate: FreshGate = importVerdict.freshGate;

    // Readers for draft-flow: raw readings plus, when a comparison is due, the server's verdict as `taskMatch`.
    const reader = (stage: ReadbackStage) => async (expected: ApprovedPreview | null): Promise<CurrentReadings> => {
      const readings = protocolReadings(await readForm(session));
      if (!expected) return { ...readings, taskMatch: null };
      const verdict = await channel.emit({ type: 'readback', stage, readings });
      return { ...readings, taskMatch: verdict.ok ? { ok: true, reasons: [] } : { ok: false, reasons: verdict.reasons } };
    };
    const ops = {
      writeHeader: (p: WritePage, key: string, value: string) => writeHeader(p.session, key, value, { pace, settleMs: pace.settleMs }),
      writeCell: (p: WritePage, spec: { which: number; row: number; column: string; value: string; expect: { mode: 'equals'; value: string } | null }) => writeCell(p.session, { ...spec, pace }),
      selectOption: (p: WritePage, spec: { which: number; row: number; column: string; option: string }) => selectOption(p.session, { ...spec, pace }),
      leaveEdit: (p: WritePage, options: { label: string }) => leaveEdit(p.session, { ...options, settleMs: pace.settleMs, pace }),
    };

    // 6. Fill. Its preflight comes FIRST, before the attempt is recorded, and the thing it checks is that nothing
    //    is floating over the form.
    //
    //    An ERP dialog has no 遮罩 (modal backdrop): it floats at z-index 10005 and swallows every click aimed at
    //    the form beneath it, silently. V-54 measured exactly that — a 处理结果 that survived the import's 退出,
    //    `elementFromPoint` at the 事由 field answering a SPAN「接收发票」 inside the report, and the fill dying
    //    4.1 s in on `header_write_failed`. The import itself had fully succeeded: ten invoices bound, judged
    //    clean, `after_import` passed. Running the check AFTER `attempt_started` is what turned that into
    //    `status: unknown` — the worst available answer to a write that went right.
    //
    //    So the obstruction is cleared and verified here, while a refusal is still a refusal about the FILL and
    //    the import behind it stands on its own footing. The employee is told what is true: the invoices are
    //    bound, and a window is in the way. It asks even though the import already closed what it opened: over a
    //    clear form that costs one read, and trusting the previous step's word about the page is the habit that
    //    put this whole check on the wrong side of the attempt in the first place.
    const clear = await closeErpDialogs(write);
    if (!clear.ok) {
      return await finish('unknown', 'form_obstructed_before_fill',
        `发票已经全部导入并绑定到这张费用报销单：收票 ${plan.invoices.length} 行已核对通过，`
        + `报销系统的原话是「${(importResult.report || '').slice(0, 200)}」。这一步是好的。`
        + `接下来的「填写费用明细」没有开始，因为报销系统还有窗口盖在表单上，关不掉：${clear.remaining.join(' | ')}。`
        + '请在报销专用浏览器窗口里关掉它，然后回到这个任务继续。');
    }
    await startAttempt('fill', { formMode: 'new', billNo: null, detailRowCount: preview.lines.length });
    // 去报销进度 (#420): the row count goes out with the step's start, then one event per row written.
    await step('fill', 'running', { done: 0, total: preview.lines.length });
    const causa = markedPurpose(preview.purpose, plan.draft.mark);
    const filled = await fillApprovedPreview(write, {
      approvedPreview: preview, approval, freshGate, readCurrent: reader('after_fill'), causa,
      addRow: (p) => addDetailRow(p), ops, witnessDelayMs: pace.quietMs,
      onRowWritten: (done, total) => step('fill', 'running', { done, total }),
    });
    if (!filled.ok) return await finish('unknown', filled.problems[0]?.code ?? 'fill_failed', filled.problems.map(problemText).join('；'));
    await step('fill', 'done');

    // 7. The strict hand-over read-back before 暂存: no attempt is started, because nothing is written.
    await step('handover', 'running');
    const handOver = await handOverApprovedPreview({
      approvedPreview: preview, approval, freshGate, fillResult: filled,
      readCurrent: reader('before_hand_over'),
    });
    if (handOver.status !== 'verified') return await finish('unknown', handOver.problems?.[0]?.code ?? 'hand_over_failed', handOver.problems?.map(problemText).join('；') ?? null);
    await step('handover', 'done');

    // 8. 暂存 (ADR-0029), on the form the hand-over gate has just verified. The attempt is durable
    //    before the press; from the press on, every ending that is not `drafted` is `unknown` (对账), never `aborted`.
    const mark = plan.draft.mark;
    const verified = { causa, receipts: filledRows(handOver.readings?.receiptsGrid), details: filledRows(handOver.readings?.detailGrid) };
    await startAttempt('save', { formMode: 'modify', billNo: null, draftMark: mark, detailRowCount: preview.lines.length });
    await step('save', 'running');
    await pressDraft(session, { timeoutMs: Math.min(10_000, pace.longMs), pollMs: pace.pollMs });
    const drafted = await waitDrafted(async () => (await readForm(session)).formMode.value, { timeoutMs: Math.min(60_000, pace.longMs), pollMs: pace.pollMs });
    if (!drafted) return await finish('unknown', 'draft_not_observed', '点了「暂存」之后页签没有变成「修改」：不知道报销系统有没有暂存这张单。');
    await step('save', 'done');
    // 核对暂存单: find the draft by its marker and read it back by its 内码.
    await step('draft_check', 'running');
    const found = await findDrafts(session, mark);
    if (!found.ok) return await finish('unknown', 'draft_query_failed', `已经点了「暂存」，但按归属标记查暂存单失败：${found.reason}`);
    if (found.drafts.length !== 1) return await finish('unknown', 'draft_not_unique', `已经点了「暂存」，按归属标记找到 ${found.drafts.length} 张暂存单，应当恰好一张。`);
    const draft = found.drafts[0]!;
    const model = await viewDraft(session, draft.id);
    if (!model) return await finish('unknown', 'draft_view_failed', `暂存单（内码 ${draft.id}）找到了，但按内码读不回它。`, null, draft.id);
    const problems = compareDraft(model, verified);
    if (problems.length) return await finish('unknown', 'draft_readback_mismatch', `暂存单（内码 ${draft.id}）和填写时回读的不一致：${problems.join('；')}`, null, draft.id);
    await step('draft_check', 'done');
    // ERP 草稿已交接: found by its marker, read back by its 内码; it has no 单据编号 until the employee saves it.
    return await finish('drafted', null, null, null, draft.id);
  } catch (error: any) {
    return await finish(attempted ? 'unknown' : 'aborted', error?.code ?? 'executor_error', error?.message ?? String(error));
  } finally {
    if (staged) await staged.discard();
    for (const page of attached.values()) { try { page.session.close(); } catch { /* already closed */ } }
  }
}
