// The 去报销 (fill ERP) state of a task, derived from stored facts (ADR-0014): the latest `erp_job`, its persisted
// executor events, its cancel, and the task's `erp_attempt` rows. Nothing about the phase is stored. The views below
// turn the record into the snapshot's `erp`, `readback`, `reconcile` and `catalog` sections.

import { READBACK_FIELD_LABELS, type Catalog, type Erp, type ErpStep, type Line, type Readback, type ReadbackField, type ReadbackRow, type Reconcile } from '@baox/contract';
import type { Db } from '../db/database';
import type { ErpJobTable } from '../db/schema';
import type { ErpFacts, ErpPhase } from '../projection';
import type { FrozenJob } from './fill-plan';
import { ExecutorEventSchema, type ApprovedPreview, type ErpAccount, type ExecutorEvent, type ResultEvent } from './protocol';

export type ErpRecord = {
  // null when the task never started 去报销.
  facts: ErpFacts | null;
  // Any ERP action attempt of the task (from any job): the freeze point of ADR-0014.
  attempted: boolean;
  job: ErpJobTable | null;
  frozen: FrozenJob | null;
  events: ExecutorEvent[];
  result: ResultEvent | null;
  // The ERP account and 账套 of the task's latest attempt: recorded, shown, never compared (ADR-0016).
  erpAccount: ErpAccount | null;
  // The preview the judge approved after import, if the job got that far.
  preview: ApprovedPreview | null;
};

export const NO_ERP: ErpRecord = { facts: null, attempted: false, job: null, frozen: null, events: [], result: null, erpAccount: null, preview: null };

/** The job's phase from its result (none yet = running) and whether its login pause was cancelled. */
export function phaseOf(result: ResultEvent | null, cancelled: boolean): ErpPhase {
  if (!result) return 'running';
  switch (result.status) {
    case 'waiting_login':
      return cancelled ? 'cancelled' : 'waiting_login';
    case 'catalog_mismatch':
      return 'catalog_mismatch';
    case 'saved':
      return 'saved';
    case 'unknown':
      return 'unknown';
    default:
      // `aborted`, and `read` which a fill job never sends: nothing was written.
      return 'aborted';
  }
}

export async function loadErp(tx: Db, taskId: string): Promise<ErpRecord> {
  const attempt = await tx.selectFrom('erp_attempt').select(['erp_account', 'erp_tenant', 'erp_display_name']).where('task_id', '=', taskId).orderBy('started_at', 'desc').executeTakeFirst();
  const erpAccount = attempt ? { displayName: attempt.erp_display_name, account: attempt.erp_account, tenant: attempt.erp_tenant } : null;
  const job = await tx.selectFrom('erp_job').selectAll().where('task_id', '=', taskId).orderBy('revision', 'desc').executeTakeFirst();
  if (!job) return { ...NO_ERP, attempted: attempt !== undefined, erpAccount };
  const rows = await tx.selectFrom('erp_job_event').select('payload').where('job_id', '=', job.job_id).orderBy('seq').execute();
  const events = rows.map((row) => ExecutorEventSchema.parse(JSON.parse(row.payload)));
  const result = [...events].reverse().find((event): event is ResultEvent => event.type === 'result') ?? null;
  const cancelled = (await tx.selectFrom('erp_job_cancel').select('cancel_id').where('job_id', '=', job.job_id).executeTakeFirst()) !== undefined;
  const phase = phaseOf(result, cancelled);
  // A catalog mismatch sends the task back to project assignment until a new submission answers it.
  let reassign = false;
  if (phase === 'catalog_mismatch') {
    const submission = await tx.selectFrom('project_submission').select('revision').where('task_id', '=', taskId).orderBy('revision', 'desc').executeTakeFirst();
    reassign = !submission || submission.revision < job.revision;
  }
  const approved = await tx.selectFrom('erp_approved_preview').select('preview').where('job_id', '=', job.job_id).executeTakeFirst();
  return {
    facts: { jobId: job.job_id, trigger: job.trigger, revision: job.revision, phase, reassign },
    attempted: attempt !== undefined,
    job,
    frozen: JSON.parse(job.plan) as FrozenJob,
    events,
    result,
    erpAccount,
    preview: approved ? (JSON.parse(approved.preview) as ApprovedPreview) : null,
  };
}

// ---- views ----

// The progress list of the ERP page. Executor steps map onto these; `compatibility` belongs to opening the form, and
// the executor's `readback` step is the receipt read-back after import.
const DISPLAY_STEPS: ReadonlyArray<{ key: string; title: string; description: string; from: readonly string[] }> = [
  { key: 'chromium', title: '启动浏览器', description: '打开报销专用浏览器窗口（独立的用户数据目录，不碰你日常用的浏览器）。', from: ['chromium'] },
  { key: 'login', title: '登录', description: '在专用浏览器窗口里用本人账号登录报销系统。应用不会替你输入账号密码。', from: ['login'] },
  { key: 'catalog', title: '报销信息核对', description: '只读核对项目与费用项目：在报销系统里存在、名称一致、已审核且未禁用。', from: ['catalog'] },
  { key: 'navigate', title: '打开空白报销单', description: '打开费用报销单新增页，核对报销系统版本，确认是唯一一张空白单据。', from: ['navigate', 'compatibility'] },
  { key: 'import', title: '导入发票', description: '在发票助手里选择「不生成费用明细」，导入这次的发票。', from: ['import'] },
  { key: 'receipt', title: '收票回读', description: '逐票回读收票单号、发票号码、不含税金额、税额与价税合计。', from: ['readback'] },
  { key: 'fill', title: '填写明细', description: '按统一业务序号逐行写入明细，每个值写入后从单元格回读。', from: ['fill'] },
  { key: 'save', title: '保存草稿', description: '只保存一次草稿，不提交审批；保存后逐行严格回读。', from: ['save'] },
];

function stepsOf(record: ErpRecord): ErpStep[] {
  const phase = record.facts?.phase;
  const latest = new Map<string, 'running' | 'done' | 'failed'>();
  for (const event of record.events) if (event.type === 'step') latest.set(event.step, event.status);
  const steps = DISPLAY_STEPS.map(({ key, title, description, from }): ErpStep => {
    let status: ErpStep['status'] = 'todo';
    for (const step of from) {
      const seen = latest.get(step);
      if (seen === 'failed') status = 'failed';
      else if (seen === 'running' && status !== 'failed') status = 'running';
      else if (seen === 'done' && status === 'todo') status = 'done';
    }
    if (phase === 'saved') status = 'done';
    if (phase === 'waiting_login' && key === 'login') status = 'waiting';
    return { key, title, description, status };
  });
  if (phase === 'running' && steps.every((step) => step.status === 'todo')) steps[0] = { ...steps[0]!, status: 'running' };
  return steps;
}

const LOGIN_NOT_DETECTED = '还没有检测到登录。请在报销专用浏览器窗口里登录报销系统（登录页上显示的上次账号不算已登录），完成后再点一次「我已登录，继续」。';

export function erpView(record: ErpRecord): Erp {
  const idle: Erp = { status: 'idle', steps: [], draftNo: null, abortReason: null, loginNotice: null, erpAccount: record.erpAccount };
  const facts = record.facts;
  if (!facts) return idle;
  const reason = record.result?.message ?? record.result?.code ?? '';
  switch (facts.phase) {
    case 'running':
      return { ...idle, status: 'running', steps: stepsOf(record) };
    case 'waiting_login':
      return { ...idle, status: 'waiting_login', steps: stepsOf(record), loginNotice: facts.trigger === 'confirm_login' ? LOGIN_NOT_DETECTED : null };
    case 'aborted':
      return { ...idle, abortReason: `上次去报销在写入报销系统之前就停止了，报销系统没有被改动，可以再去报销。原因：${reason}` };
    case 'saved':
      return { ...idle, status: 'done', steps: stepsOf(record), draftNo: record.result?.billNo ?? null };
    case 'unknown':
      return { ...idle, status: 'aborted', steps: stepsOf(record), draftNo: record.result?.billNo ?? null, abortReason: `写入报销系统的结果不确定，应用已停止写入，不会重放。原因：${reason}` };
    default:
      // Cancelled login pause, or a catalog mismatch (its problems are in the catalog section): nothing was written.
      return idle;
  }
}

const EMPTY_READBACK: Readback = { status: 'none', rows: [], summary: null, localTotal: null, erpTotal: null };

const money = (cents: number) => (cents / 100).toFixed(2);
const centsOf = (amount: string | null | undefined) => {
  const [whole = '0', fraction = ''] = String(amount ?? '0').split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
};

/**
 * The strict read-back of a saved draft. A `saved` result exists only after the server judged the saved form equal to
 * the approved preview on every row and all nine fields, so each field's ERP side equals its local side. Net and tax
 * come from the approved preview (a rail line's come from ERP's receipt), the receipt number from its bindings.
 */
export function readbackView(record: ErpRecord, lines: readonly Line[]): Readback {
  if (record.facts?.phase !== 'saved') return EMPTY_READBACK;
  const previewLine = new Map((record.preview?.lines ?? []).map((line) => [line.lineId, line]));
  const receipt = new Map((record.preview?.receiptBindings ?? []).map((binding) => [binding.voucherMaterialId, binding.receiptNumber]));
  const rows: ReadbackRow[] = lines.map((line) => {
    const approved = previewLine.get(line.lineId);
    const values: Record<(typeof READBACK_FIELD_LABELS)[number], string | null> = {
      申请报销金额: line.grossAmount,
      项目: line.projectName,
      费用项目: line.expenseItemName,
      开始日期: line.date,
      结束日期: line.endDate ?? line.date,
      费用金额: approved?.netAmount ?? line.netAmount,
      税额: approved?.taxAmount ?? line.taxAmount,
      收票单号: receipt.get(line.voucherMaterialId) ?? null,
      // The ERP 发票类型 the fill wrote (the face 票种 mapped onto ERP's enum, `fill-plan.ts`).
      发票类型: approved?.invoiceType ?? line.invoiceType,
    };
    const fields: ReadbackField[] = READBACK_FIELD_LABELS.map((label) => ({ label, local: values[label], erp: values[label], matched: true }));
    return { no: line.no, description: line.description, matched: true, fields, reasons: [] };
  });
  const total = money(lines.reduce((sum, line) => sum + centsOf(line.grossAmount), 0));
  return { status: 'matched', rows, summary: `明细 ${rows.length}/${rows.length} 一致`, localTotal: total, erpTotal: total };
}

/** ERP 写入结果未知 stops in reconcile. The bucket, the allowed actions and the read-only job are #192's. */
export function reconcileView(record: ErpRecord): Reconcile | null {
  if (record.facts?.phase !== 'unknown') return null;
  const message = record.result?.message ?? '';
  return {
    status: 'pending',
    bucket: null,
    action: null,
    actionCode: null,
    allowedActions: [],
    humanReview: false,
    banner: '写入报销系统的结果不确定：应用已停止写入，不会重放。请先在报销系统里查看这张报销单的实际状态。',
    draftNo: record.result?.billNo ?? null,
    rows: [],
    reasons: message ? message.split('；').filter(Boolean) : [],
  };
}

const VERDICT_REASON: Readonly<Record<string, (kind: string, code: string, expected: string, erpName: string | null) => string>> = {
  missing: (kind, code, expected) => `${kind} ${code}「${expected}」在报销系统里查不到`,
  name_mismatch: (kind, code, expected, erpName) => `${kind} ${code} 在报销系统里的名称是「${erpName ?? ''}」，与本地的「${expected}」不一致`,
  unusable: (kind, code, expected) => `${kind} ${code}「${expected}」在报销系统里未审核或已禁用，不能引用`,
  ambiguous: (kind, code) => `${kind}号 ${code} 在报销系统里对应多条记录，不能确定是哪一个`,
};

/** 报销信息核对 problems of a catalog mismatch not yet answered by a new submission. */
export function catalogView(record: ErpRecord): Catalog | null {
  if (!record.facts?.reassign) return null;
  const mismatch = [...record.events].reverse().find((event) => event.type === 'catalog_mismatch');
  const problems = mismatch?.type === 'catalog_mismatch' ? mismatch.problems : [];
  return {
    status: 'mismatch',
    problems: problems.map((problem) => {
      const kind = problem.kind === 'project' ? '项目' : '费用项目';
      const reason = (VERDICT_REASON[problem.verdict] ?? VERDICT_REASON['missing']!)(kind, problem.code, problem.expectedName, problem.erpName);
      return { subject: `${problem.kind === 'project' ? '项目号' : '费用项目'} ${problem.code}`, reference: null, reason, resolver: '要你处理' as const };
    }),
  };
}
