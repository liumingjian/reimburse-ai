// The v1 in-process ERP executor: one fill plan in, protocol events out (ADR-0016).
//
// Job order: Chromium ready -> login probe -> 报销信息核对 (catalog check) -> navigate + compatibility fingerprint
// -> import -> fill -> strict read-back -> hand-over. The job never clicks 保存 (save): it ends with the 费用报销单
// filled and unsaved, and the employee commits it (ADR-0028). Before each mutation the executor observes its preconditions,
// sends `attempt_started`, waits for the server to persist it, and re-checks target, form-instance UUID, 新增 mode
// and URL. Failure before the first attempt aborts cleanly (retryable); anything after it is ERP 写入结果未知
// (write result unknown) and goes to reconcile, never to replay. The executor never judges read-backs: it sends
// them as `readback` and acts on the server's verdict.

import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import {
  FillPlanSchema, type Approval, type ApprovedPreview, type BlobRef, type BlobSource, type Compatibility, type ErpAccount,
  type ExecutorChannel, type Mutation, type Preconditions, type ReadbackStage, type ResultEvent, type ResultStatus, type FreshGate,
} from '../protocol';
import { evalIn, type CdpSession } from './cdp';
import { checkCatalog } from './catalog';
import { ExecutorError, type ChromiumPage } from './chromium';
import { fillApprovedPreview, handOverApprovedPreview, type CurrentReadings } from './draft-flow';
import { leaveEdit, selectOption, writeCell, writeHeader } from './erpform';
import { DEFAULT_PACE, type Pace } from './pace';
import { COMPATIBILITY_SNIPPET, probeIdentity, sameOrigin } from './probe';
import { pageUrl, protocolReadings, readForm, type FormReadings } from './reader';
import {
  addDetailRow, captureErpError, invoiceUploadGroups, openInvoiceAssistant, openNewReimbursement,
  uploadAndImportInvoices, type WritePage,
} from './steps';
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

const MIME_EXTENSIONS: Record<string, string> = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg' };

// A draft-flow problem as the result message: its own sentence, then the server's reasons (strict read-back).
const problemText = (problem: { message: string; [extra: string]: unknown }) =>
  [problem.message, ...(Array.isArray(problem['reasons']) ? (problem['reasons'] as unknown[]).map(String) : [])].join('：');

/** Fetch invoice bytes by content, verify the hash, and stage them for `DOM.setFileInputFiles`. */
async function stageInvoices(refs: BlobRef[], blobs: BlobSource, root: string) {
  const dir = await mkdtemp(join(root, 'baox-erp-invoices-'));
  const paths: string[] = [];
  for (const [index, ref] of refs.entries()) {
    const bytes = await blobs.read(ref);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== ref.sha256) throw new ExecutorError('BLOB_HASH_MISMATCH', `发票文件 ${ref.fileName} 的内容与计划中的 sha256 不一致`);
    const ext = extname(ref.fileName).toLowerCase() || MIME_EXTENSIONS[ref.mime] || '';
    const safeBase = ref.fileName.replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60) || 'invoice';
    const path = join(dir, `${String(index + 1).padStart(2, '0')}-${safeBase}${ext}`);
    await writeFile(path, bytes, { mode: 0o600 });
    paths.push(path);
  }
  return { dir, paths };
}

export async function runFillJob(rawPlan: unknown, ports: ExecutorPorts): Promise<ResultEvent> {
  const plan = FillPlanSchema.parse(rawPlan);
  const { browser, channel } = ports;
  const pace = ports.pace ?? DEFAULT_PACE;
  const newId = ports.newId ?? randomUUID;
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
    const staged = await stageInvoices(plan.invoices, ports.blobs, ports.stagingRoot ?? tmpdir());
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

    // 4. Navigate to one blank new form, check the compatibility fingerprint, open the assistant; then attempt import.
    await step('navigate', 'running');
    await prepareErpWrite({
      page: write,
      navigate: (p) => openNewReimbursement(p, { timeoutMs: 45_000 }),
      read: async () => {
        const readings = await readForm(session);
        await step('compatibility', 'running');
        const probed = await evalIn<{ erpBuild: string | null; formIds: string[] }>(session, COMPATIBILITY_SNIPPET);
        const formId = probed?.formIds?.length === 1 ? probed.formIds[0]! : null;
        if (probed?.erpBuild !== plan.compatibility.erpBuild || formId !== plan.compatibility.formId) {
          throw new ExecutorError('compatibility_mismatch',
            `ERP 兼容指纹不符：期望 ${plan.compatibility.erpBuild} / ${plan.compatibility.formId}，实际 ${probed?.erpBuild ?? '读不到'} / ${formId ?? `${probed?.formIds?.length ?? 0} 个表单`}`);
        }
        compatibility = { erpBuild: probed.erpBuild, formId };
        await step('compatibility', 'done');
        currentStep = 'navigate';
        baseline = { url: await pageUrl(session), formInstanceId: readings.formInstanceId ?? '' };
        return readings;
      },
      openAssistant: (p) => openInvoiceAssistant(p, { timeoutMs: 90_000 }),
      mark: async () => {
        await step('navigate', 'done');
        await startAttempt('import', { formMode: 'new', billNo: null, receiptRowCount: plan.invoices.length });
      },
    });

    // 5. Import.
    await step('import', 'running');
    await uploadAndImportInvoices(write, staged.paths);
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
      leaveEdit: (p: WritePage, options: { label: string }) => leaveEdit(p.session, { ...options, settleMs: pace.settleMs }),
    };

    // 6. Fill.
    await startAttempt('fill', { formMode: 'new', billNo: null, detailRowCount: preview.lines.length });
    await step('fill', 'running');
    const filled = await fillApprovedPreview(write, {
      approvedPreview: preview, approval, freshGate, readCurrent: reader('after_fill'),
      addRow: (p) => addDetailRow(p), ops,
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
    if (stagingDir) await rm(stagingDir, { recursive: true, force: true });
    for (const page of attached.values()) { try { page.session.close(); } catch { /* already closed */ } }
  }
}
