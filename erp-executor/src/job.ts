// The v1 in-process ERP executor: one fill plan in, protocol events out (ADR-0016).
//
// Job order: Chromium ready -> login probe -> 报销信息核对 (catalog check) -> navigate + compatibility fingerprint
// -> import -> fill -> strict read-back -> hand-over. The job never clicks 保存 (save): it ends with the 费用报销单
// filled and unsaved, and the employee commits it (ADR-0028). Before each mutation the executor observes its preconditions,
// sends `attempt_started`, waits for the server to persist it, and re-checks target, form-instance UUID, 新增 mode
// and URL. Failure before the first attempt aborts cleanly (retryable); anything after it is ERP 写入结果未知
// (write result unknown) and goes to reconcile, never to replay. The executor never judges read-backs: it sends
// them as `readback` and acts on the server's verdict.

import {
  FillPlanSchema, type Approval, type ApprovedPreview, type BlobSource, type Compatibility, type ErpAccount,
  type ExecutorChannel, type Mutation, type Preconditions, type ReadbackStage, type ResultEvent, type ResultStatus, type FreshGate,
} from './protocol';
import { evalIn, type CdpSession } from './cdp';
import { checkCatalog } from './catalog';
import { ExecutorError, type ChromiumPage } from './page';
import { fillApprovedPreview, handOverApprovedPreview, type CurrentReadings } from './draft-flow';
import { leaveEdit, selectOption, writeCell, writeHeader } from './erpform';
import { DEFAULT_PACE, waitFor, type Pace } from './pace';
import { COMPATIBILITY_SNIPPET, probeIdentity, sameOrigin } from './probe';
import { pageUrl, protocolReadings, readForm, type FormReadings } from './reader';
import {
  addDetailRow, captureErpError, closeErpDialogs, invoiceUploadGroups, openInvoiceAssistant, openNewReimbursement,
  importInvoices, uploadInvoices, type WritePage,
} from './steps';
import { discardStagedInvoices, stageInvoices } from './staging';
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
  /** Parent directory for the per-job staging directory (default: the OS temp dir). */
  stagingRoot?: string;
  pace?: Pace;
  /** How long the login probe waits for a slow ERP first screen. */
  probeWaitMs?: number;
  newId?: () => string;
};

class DriftError extends ExecutorError {
  constructor(readonly reasons: string[]) {
    super('erp_drift', `ERP 页面在动作前发生漂移：${reasons.join('；')}`);
  }
}

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
  let stagingDir: string | null = null;
  let attempted = false;
  let erpAccount: ErpAccount | null = null;
  let compatibility: Compatibility | null = null;
  let currentStep: Parameters<typeof step>[0] | null = null;

  async function step(name: 'chromium' | 'login' | 'catalog' | 'compatibility' | 'navigate' | 'import' | 'fill' | 'handover' | 'readback', status: 'running' | 'done' | 'failed') {
    currentStep = status === 'running' ? name : null;
    await channel.emit({ type: 'step', step: name, status });
  }

  async function finish(status: ResultStatus, code: string | null, message: string | null, billNo: string | null = null): Promise<ResultEvent> {
    if (currentStep && status !== 'handed_over') await step(currentStep, 'failed');
    const capture = status === 'aborted' || status === 'unknown' ? (write ? await captureErpError(write) : null) : null;
    const event: ResultEvent = { type: 'result', status, code, message, billNo, capture };
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

    // 2. Login probe. Not logged in: pause for the user, holding nothing (no attempt exists yet).
    await step('login', 'running');
    const probe = await probeIdentity({
      origin: plan.erpOrigin, waitMs: ports.probeWaitMs ?? 30_000, pollMs: pace.pollMs, transport: 'chromium-cdp',
      listTabs: async () => pages,
      evaluate: async (page, expression) => evalIn((await attach(page as ChromiumPage)).session, expression, { timeout: 10_000 }),
    });
    if (probe.status === 'not_logged_in' || probe.status === 'no_tab') {
      await step('login', 'done');
      await channel.emit({ type: 'waiting_login', hint: probe.hint ?? '' });
      return await finish('waiting_login', 'erp_login', probe.hint ?? null);
    }
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
    await step('catalog', 'done');

    // Invoices by content, staged before any page action; a bad file stops here.
    const staged = await stageInvoices(plan.invoices, ports.blobs, ports.stagingRoot);
    stagingDir = staged.dir;
    invoiceUploadGroups(staged.paths);

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
      navigate: (p) => openNewReimbursement(p, { timeoutMs: 45_000, replaceNewForms: plan.replaceAbandonedForm === true }),
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
    await uploadInvoices(write, staged.paths);
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
    await step('fill', 'running');
    const filled = await fillApprovedPreview(write, {
      approvedPreview: preview, approval, freshGate, readCurrent: reader('after_fill'),
      addRow: (p) => addDetailRow(p), ops, witnessDelayMs: pace.quietMs,
    });
    if (!filled.ok) return await finish('unknown', filled.problems[0]?.code ?? 'fill_failed', filled.problems.map(problemText).join('；'));
    await step('fill', 'done');

    // 7. The strict hand-over read-back, then the hand-over itself: no attempt is started, because nothing is written.
    await step('handover', 'running');
    const handOver = await handOverApprovedPreview({
      approvedPreview: preview, approval, freshGate, fillResult: filled,
      readCurrent: reader('before_hand_over'),
    });
    if (handOver.status !== 'handed_over') return await finish('unknown', handOver.problems?.[0]?.code ?? 'hand_over_failed', handOver.problems?.map(problemText).join('；') ?? null);
    await step('handover', 'done');
    // ERP 单据已交接: the form is filled and unsaved, so there is no 单据编号 (bill number) to report.
    return await finish('handed_over', null, null, null);
  } catch (error: any) {
    return await finish(attempted ? 'unknown' : 'aborted', error?.code ?? 'executor_error', error?.message ?? String(error));
  } finally {
    if (stagingDir) await discardStagedInvoices(stagingDir);
    for (const page of attached.values()) { try { page.session.close(); } catch { /* already closed */ } }
  }
}
