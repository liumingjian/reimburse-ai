// Scripted fill executors for server tests (spec #177 Testing Decisions: server tests run the ERP job on a fake
// executor). Each script speaks the job protocol through the real server channel, exactly as `runFillJob` would, but
// decides the outcome up front: login wall, catalog mismatch, abort before any attempt, write result unknown after
// attempts, or a saved draft. `scripted()` plays one script per job run; the last one repeats.

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

async function attempt(plan: FillPlan, channel: ExecutorChannel, action: Mutation, n: number, erpAccount: ErpAccount) {
  await channel.emit({
    type: 'attempt_started', attemptId: `${plan.jobId}.${action}`, action,
    preconditions: { targetId: 'erp-page-1', url: `${plan.erpOrigin}/k3cloud/html5/index.aspx`, formInstanceId: 'form-1', formMode: 'new', billNo: null, receiptRowCount: n === 0 ? 0 : plan.invoices.length, detailRowCount: 1 },
    expectedPostconditions: {}, compatibility: plan.compatibility, erpAccount,
  });
}

async function pastCatalog(channel: ExecutorChannel) {
  await reachLogin(channel);
  await channel.emit({ type: 'step', step: 'login', status: 'done' });
  await channel.emit({ type: 'step', step: 'catalog', status: 'running' });
  await channel.emit({ type: 'step', step: 'catalog', status: 'done' });
}

/** ERP sits on its login page: the job pauses with no attempt. */
export const loginWall: Script = async (_plan, channel) => {
  await reachLogin(channel);
  await channel.emit({ type: 'step', step: 'login', status: 'done' });
  await channel.emit({ type: 'waiting_login', hint: '请在为这次报销打开的报销系统标签页中登录' });
  return result(channel, 'waiting_login', 'erp_login', '请在为这次报销打开的报销系统标签页中登录');
};

/** 报销信息核对 finds the first project renamed in ERP: aborts before import. */
export const catalogMismatch: Script = async (plan, channel) => {
  await reachLogin(channel);
  await channel.emit({ type: 'step', step: 'login', status: 'done' });
  await channel.emit({ type: 'step', step: 'catalog', status: 'running' });
  const project = plan.catalog.projects[0]!;
  await channel.emit({ type: 'catalog_mismatch', problems: [{ kind: 'project', code: project.code, verdict: 'name_mismatch', expectedName: project.name, erpName: '改过名的项目' }] });
  return result(channel, 'catalog_mismatch', 'catalog_mismatch', `project ${project.code}: name_mismatch`);
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

/** Imports, fills and hands the filled, unsaved 费用报销单 over: no save attempt and no 单据编号 (ADR-0028). */
export const handedOver = (erpAccount = TEST_ERP_ACCOUNT): Script => async (plan, channel) => {
  await pastCatalog(channel);
  await channel.emit({ type: 'step', step: 'navigate', status: 'running' });
  await channel.emit({ type: 'step', step: 'navigate', status: 'done' });
  await attempt(plan, channel, 'import', 0, erpAccount);
  await channel.emit({ type: 'step', step: 'import', status: 'done' });
  await attempt(plan, channel, 'fill', 1, erpAccount);
  await channel.emit({ type: 'step', step: 'fill', status: 'done' });
  await channel.emit({ type: 'step', step: 'handover', status: 'done' });
  return result(channel, 'handed_over', null, null, null);
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

export type ScriptedExecutor = FillExecutor & { queue: (...scripts: Script[]) => void; runs: () => Array<{ plan: FillPlan; trigger: string }> };

/** Plays one queued script per job run; the last script repeats. */
export function scripted(...initial: Script[]): ScriptedExecutor {
  let queue = [...initial];
  const runs: Array<{ plan: FillPlan; trigger: string }> = [];
  const executor = (async (plan, channel, { trigger }) => {
    runs.push({ plan, trigger });
    const script = queue.length > 1 ? queue.shift()! : queue[0];
    if (!script) throw new Error('scripted executor: no script queued');
    return script(plan, channel);
  }) as ScriptedExecutor;
  executor.queue = (...scripts) => { queue = [...scripts]; };
  executor.runs = () => runs;
  return executor;
}
