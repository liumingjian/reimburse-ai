// Scripted fill executors for server tests (spec #177 Testing Decisions: server tests run the ERP job on a fake
// executor). Each script speaks the job protocol through the real server channel, exactly as `runFillJob` would, but
// decides the outcome up front: no sign-in, catalog mismatch, abort before any attempt, write result unknown after
// attempts, or ERP 草稿已交接 (a 暂存 draft, ADR-0037). `scripted()` plays one script per job run; the last one repeats.

import type { FillExecutor } from '../fill-jobs';
import type { ReconcileExecutor } from '../reconcile-job';
import type { ErpAccount, ExecutorChannel, FillPlan, Mutation, ResultEvent, ResultStatus } from '@baox/erp-executor/protocol';

export type Script = (plan: FillPlan, channel: ExecutorChannel) => Promise<ResultEvent>;

export const TEST_ERP_ACCOUNT: ErpAccount = { displayName: '测试员', account: 'erp.tester', tenant: '测试账套' };

async function result(channel: ExecutorChannel, status: ResultStatus, code: string | null, message: string | null, billNo: string | null = null): Promise<ResultEvent> {
  const event: ResultEvent = { type: 'result', status, code, message, billNo, capture: null };
  await channel.emit(event);
  return event;
}

async function reachLogin(channel: ExecutorChannel) {
  await channel.emit({ type: 'step', step: 'chromium', status: 'running' });
  await channel.emit({ type: 'step', step: 'chromium', status: 'done' });
  await channel.emit({ type: 'step', step: 'login', status: 'running' });
}

async function attempt(plan: FillPlan, channel: ExecutorChannel, action: Mutation, n: number, erpAccount: ErpAccount, expectedPostconditions: Record<string, unknown> = {}) {
  await channel.emit({
    type: 'attempt_started', attemptId: `${plan.jobId}.${action}`, action,
    preconditions: { targetId: 'erp-page-1', url: `${plan.erpOrigin}/k3cloud/html5/index.aspx`, formInstanceId: 'form-1', formMode: 'new', billNo: null, receiptRowCount: n === 0 ? 0 : plan.invoices.length, detailRowCount: 1 },
    expectedPostconditions, compatibility: plan.compatibility, erpAccount,
  });
}

async function pastCatalog(channel: ExecutorChannel) {
  await reachLogin(channel);
  await channel.emit({ type: 'step', step: 'login', status: 'done' });
  await channel.emit({ type: 'step', step: 'catalog', status: 'running' });
  await channel.emit({ type: 'step', step: 'catalog', status: 'done' });
}

/** ERP sits on its login page and the job had no 凭据 to sign in with: it ends with no attempt. */
export const notSignedIn: Script = async (_plan, channel) => {
  await reachLogin(channel);
  await channel.emit({ type: 'step', step: 'login', status: 'failed' });
  return result(channel, 'aborted', 'erp_login', '报销系统没有登录，本地执行器也没能用报销系统账号登录。请在设置页保存报销系统账号和密码后再试。');
};

/** 报销信息核对 cannot find the first project in ERP: aborts before import. */
export const catalogMismatch: Script = async (plan, channel) => {
  await reachLogin(channel);
  await channel.emit({ type: 'step', step: 'login', status: 'done' });
  await channel.emit({ type: 'step', step: 'catalog', status: 'running' });
  const project = plan.catalog.projects[0]!;
  await channel.emit({ type: 'catalog_mismatch', problems: [{ kind: 'project', code: project.code, verdict: 'missing', expectedName: project.name, erpName: null }] });
  return result(channel, 'catalog_mismatch', 'catalog_mismatch', `project ${project.code}: missing`);
};

/** Stops before the first attempt_started (e.g. the compatibility fingerprint): nothing was written. */
export const abortBeforeAttempt: Script = async (_plan, channel) => {
  await pastCatalog(channel);
  await channel.emit({ type: 'step', step: 'compatibility', status: 'running' });
  await channel.emit({ type: 'step', step: 'compatibility', status: 'failed' });
  return result(channel, 'aborted', 'compatibility_mismatch', '报销系统的版本与上次核对时不一致，没有继续：期望 8.2.830.9 / ER_ExpReimbursement，实际 8.3.101.2 / ER_ExpReimbursement。报销系统没有被改动。');
};

/** Imports and fills, then the strict read-back before save fails: ERP 写入结果未知. */
export const readbackMismatch: Script = async (plan, channel) => {
  await pastCatalog(channel);
  await attempt(plan, channel, 'import', 0, TEST_ERP_ACCOUNT);
  await channel.emit({ type: 'step', step: 'import', status: 'done' });
  await attempt(plan, channel, 'fill', 1, TEST_ERP_ACCOUNT);
  await channel.emit({ type: 'step', step: 'fill', status: 'running' });
  await channel.emit({ type: 'step', step: 'fill', status: 'failed' });
  return result(channel, 'unknown', 'strict_readback_failed', 'ERP 明细「申请报销金额」合计 1000.00 与任务合计 1006.00 不一致');
};

/**
 * Every 去报销's ending (ADR-0029, ADR-0037): imports, fills, 暂存s under the plan's marker and finds the draft again
 * (内码 119946): ERP 草稿已交接. The draft has no 单据编号 until the employee saves it.
 */
export const draftedAs = (erpAccount: ErpAccount): Script => async (plan, channel) => {
  await pastCatalog(channel);
  await channel.emit({ type: 'step', step: 'navigate', status: 'running' });
  await channel.emit({ type: 'step', step: 'navigate', status: 'done' });
  await attempt(plan, channel, 'import', 0, erpAccount);
  await channel.emit({ type: 'step', step: 'import', status: 'done' });
  await attempt(plan, channel, 'fill', 1, erpAccount);
  // 去报销进度 (#420) as a real run reports it: 填写明细 with its row count (one row here).
  await channel.emit({ type: 'step', step: 'fill', status: 'running', progress: { done: 0, total: 1 } });
  await channel.emit({ type: 'step', step: 'fill', status: 'done', progress: { done: 1, total: 1 } });
  await channel.emit({ type: 'step', step: 'handover', status: 'done' });
  await attempt(plan, channel, 'save', 2, erpAccount, { formMode: 'modify', billNo: null, draftMark: plan.draft.mark });
  await channel.emit({ type: 'step', step: 'save', status: 'done' });
  await channel.emit({ type: 'step', step: 'draft_check', status: 'done' });
  const event: ResultEvent = { type: 'result', status: 'drafted', code: null, message: null, billNo: null, capture: null, draftId: '119946' };
  await channel.emit(event);
  return event;
};
export const drafted: Script = draftedAs(TEST_ERP_ACCOUNT);

/** 暂存 was pressed under the plan's marker and the tab never turned to 修改: ERP 写入结果未知, a bill may have landed. */
export const uncertainDraft: Script = async (plan, channel) => {
  await pastCatalog(channel);
  await attempt(plan, channel, 'import', 0, TEST_ERP_ACCOUNT);
  await attempt(plan, channel, 'fill', 1, TEST_ERP_ACCOUNT);
  await attempt(plan, channel, 'save', 2, TEST_ERP_ACCOUNT, { formMode: 'modify', billNo: null, draftMark: plan.draft.mark });
  const event: ResultEvent = { type: 'result', status: 'unknown', code: 'draft_not_observed', message: '点了「暂存」之后页签没有变成「修改」', billNo: null, capture: null };
  await channel.emit(event);
  return event;
};

/**
 * 暂存 landed (内码 119985) but the draft read back by its 内码 disagrees with what the fill verified: ERP 写入结果未知,
 * with the 内码 on the result (as in QA on 2026-10-16).
 */
export const draftReadbackMismatch: Script = async (plan, channel) => {
  await pastCatalog(channel);
  await attempt(plan, channel, 'import', 0, TEST_ERP_ACCOUNT);
  await attempt(plan, channel, 'fill', 1, TEST_ERP_ACCOUNT);
  await attempt(plan, channel, 'save', 2, TEST_ERP_ACCOUNT, { formMode: 'modify', billNo: null, draftMark: plan.draft.mark });
  const event: ResultEvent = { type: 'result', status: 'unknown', code: 'draft_readback_mismatch', message: '暂存单（内码 119985）和填写时回读的不一致：申请报销金额 1000.00 ≠ 1006.00', billNo: null, capture: null, draftId: '119985' };
  await channel.emit(event);
  return event;
};

// A 1×1 PNG: stands in for the cropped screenshot of ERP's error dialog.
export const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
export const UNCERTAIN_SAVE_ERP_TEXT = '保存未完成：报销系统没有返回处理结果。';

/** Imports and fills, then the save times out with an ERP dialog: ERP 写入结果未知, with ERP's own text and a screenshot. */
export const uncertainSave: Script = async (plan, channel) => {
  await pastCatalog(channel);
  await attempt(plan, channel, 'import', 0, TEST_ERP_ACCOUNT);
  await channel.emit({ type: 'step', step: 'import', status: 'done' });
  await attempt(plan, channel, 'fill', 1, TEST_ERP_ACCOUNT);
  await channel.emit({ type: 'step', step: 'fill', status: 'done' });
  await attempt(plan, channel, 'save', 2, TEST_ERP_ACCOUNT);
  await channel.emit({ type: 'step', step: 'save', status: 'running' });
  await channel.emit({ type: 'step', step: 'save', status: 'failed' });
  const event: ResultEvent = { type: 'result', status: 'unknown', code: 'save_result_unknown', message: '保存后没有读到报销系统的结果', billNo: null, capture: { erpText: [UNCERTAIN_SAVE_ERP_TEXT], screenshot: TINY_PNG } };
  await channel.emit(event);
  return event;
};

/** A reconcile job that finds no expense form open: every reading unreadable, so the server judges 未知. */
export const noFormOpen: ReconcileExecutor = async (_plan, channel) => {
  const reason = '页面上没有打开的费用报销单';
  await channel.emit({ type: 'step', step: 'chromium', status: 'running' });
  await channel.emit({ type: 'step', step: 'chromium', status: 'done' });
  await channel.emit({
    type: 'readback', stage: 'reconcile',
    readings: { formMode: { readable: false, value: null, reason }, billNo: { readable: false, value: null, reason }, receiptsGrid: { ok: false, reason }, detailGrid: { ok: false, reason } },
  });
  return result(channel, 'read', null, null);
};

/** Wraps a script so it waits for `release()` right after Chromium is ready: the job is observably running. */
export function gated(script: Script) {
  let release!: () => void;
  let entered!: () => void;
  const opened = new Promise<void>((resolve) => { release = resolve; });
  const running = new Promise<void>((resolve) => { entered = resolve; });
  const wrapped: Script = async (plan, channel) => {
    await channel.emit({ type: 'step', step: 'chromium', status: 'running' });
    entered();
    await opened;
    return script(plan, channel);
  };
  return { script: wrapped, running, release: () => release() };
}

export type ScriptedExecutor = FillExecutor & {
  // Replaces the scripts every task plays, including those a task had queued for itself.
  queue: (...scripts: Script[]) => void;
  // Replaces the scripts one task plays; other tasks keep playing the shared queue.
  queueFor: (taskId: string, ...scripts: Script[]) => void;
  runs: () => Array<{ plan: FillPlan; trigger: string }>;
};

/** Plays one queued script per job run (the task's own queue if it has one); the last script repeats. */
export function scripted(...initial: Script[]): ScriptedExecutor {
  let queue = [...initial];
  const perTask = new Map<string, Script[]>();
  const runs: Array<{ plan: FillPlan; trigger: string }> = [];
  const executor = (async (plan, channel, { trigger }) => {
    runs.push({ plan, trigger });
    const scripts = perTask.get(plan.taskId) ?? queue;
    const script = scripts.length > 1 ? scripts.shift()! : scripts[0];
    if (!script) throw new Error('scripted executor: no script queued');
    return script(plan, channel);
  }) as ScriptedExecutor;
  executor.queue = (...scripts) => {
    queue = [...scripts];
    perTask.clear();
  };
  executor.queueFor = (taskId, ...scripts) => { perTask.set(taskId, [...scripts]); };
  executor.runs = () => runs;
  return executor;
}
