import { ERP_ACTION_ERRORS, type AppAdapter, type TaskSnapshot } from '@baox/contract';
import type { MockBus } from '../bus';
import { ERP_STEP_INDEX, applyAbortAtHandover, applyErpDone, applyReadbackMismatch, applyReadbackStop, applyStopBeforeWrite, emptyReconcile, erpProgress, erpRunning, erpStageAt, erpSteps, handedOffBanner, idleErp } from '../fixtures/erp';
import { catalogMismatch } from '../fixtures/preparation';
import { T1_DRAFT_NO } from '../fixtures/tasks';

// The mock simulates the server-owned ERP fill, strict read-back, and reconciliation states.
// 去报销 runs by itself from start to end: nothing waits for the employee to log in (ADR-0037).
// 写入的结局按故障决定：erp-stopped-before-write 在打开报销单时停下（退回去报销前）；readback-mismatch 在填写明细后的
// 严格回读停下、erp-write-aborted 在交接步中止，两者都停在对账，等第一次对账（readback-mismatch 对账后读到逐行不一致的草稿，只能转人工）。

const DEFAULT_ERP_STEP_MS = 300;

export type ErpFlow = Pick<AppAdapter, 'startErpWrite' | 'reconcile' | 'handOff' | 'refill'>;

export function createErpFlow(bus: MockBus): ErpFlow {
  const { options } = bus;
  // 去报销的方式 the mock plays (#423): the 浏览器扩展 by default, or `?route=local_executor`, which shows its own steps
  // and ends with the bill 暂存'd. Neither waits for a login.
  const route = options.erpRoute ?? 'extension';
  const erpStepMs = options.erpStepMs ?? DEFAULT_ERP_STEP_MS;
  // 每个任务当前这一轮 ERP 写入的编号与重新对账次数；定时器只推进自己那一轮。
  const erpRuns = new Map<string, number>();
  const reconcileCounts = new Map<string, number>();
  let nextErpRun = 1;

  const erpRunLive = (snapshot: TaskSnapshot, run: number, status: TaskSnapshot['erp']['status']) =>
    erpRuns.get(snapshot.task.taskId) === run && snapshot.erp.status === status;

  // 第 index 步结束：填写明细后的严格回读在 readback-mismatch 下停下；交接步在 erp-write-aborted 下中止。
  const finishErpStep = (taskId: string, run: number, index: number) => {
    const current = bus.draft(taskId);
    if (!erpRunLive(current, run, 'running')) return;
    current.task.updatedAt = bus.now();
    // `?fault=catalog-mismatch`: the catalog step finds a project renamed in the ERP. Nothing was imported; like the
    // server, the job ends, the ERP view is idle again and the task goes back to project assignment (项目归属) with the
    // catalog problems. The confirmation stands until the assignment changes.
    const mismatch = index === ERP_STEP_INDEX.catalog && options.fault === 'catalog-mismatch' ? catalogMismatch(current.projectAssignment) : null;
    if (mismatch) {
      erpRuns.delete(taskId);
      current.catalog = mismatch;
      current.erp = idleErp();
      current.stage = 'project';
      current.step = { kind: 'assign_projects', stepToken: bus.rotateToken(`tok-${taskId}-catalog-mismatch`) };
      bus.push(current);
      return;
    }
    // 写入前就停下：报销系统没有被改动，阶段退回整单确认页，这一轮结束。
    if (index === ERP_STEP_INDEX.navigate && options.fault === 'erp-stopped-before-write') {
      erpRuns.delete(taskId);
      applyStopBeforeWrite(current, route);
      current.step = { kind: 'choose_action', stepToken: bus.rotateToken(`tok-${taskId}-actions`) };
      bus.push(current);
      return;
    }
    if (index === ERP_STEP_INDEX.fill && options.fault === 'readback-mismatch') {
      erpRuns.delete(taskId);
      applyReadbackStop(current, route);
      bus.push(current);
      return;
    }
    if (index === ERP_STEP_INDEX.handover) {
      if (options.fault === 'erp-write-aborted') applyAbortAtHandover(current, route);
      // 本地执行器暂存后结束（drafted，ERP 草稿已交接）：暂存单还没有单据编号。浏览器扩展这条路线随 #437 删除。
      else applyErpDone(current, null, route);
      bus.push(current);
      return;
    }
    current.erp.steps = erpSteps(index + 1, 'running', route);
    current.erp.currentStage = erpStageAt(index + 1);
    current.erp.progress = erpProgress(index + 1, current.lines.length, 0, route);
    current.erp.externalWait = 'erp_response';
    current.erp.outcome = 'none';
    current.erp.allowedActions = ['refresh'];
    bus.push(current);
    if (index + 1 === ERP_STEP_INDEX.fill) setTimeout(() => fillRow(taskId, run, 1), rowMs(current));
    else setTimeout(() => finishErpStep(taskId, run, index + 1), erpStepMs);
  };

  // 填写明细逐行推进（去报销进度）：每写完一行，进度条的「填写明细 n/m」与百分比前进一格，像真实的执行器那样。
  // 整步仍只用一个 erpStepMs，行数多也不拖慢。
  const rowMs = (snapshot: TaskSnapshot) => erpStepMs / Math.max(1, snapshot.lines.length);
  const fillRow = (taskId: string, run: number, rowsDone: number) => {
    const current = bus.draft(taskId);
    if (!erpRunLive(current, run, 'running')) return;
    const rows = Math.max(1, current.lines.length);
    current.erp.progress = erpProgress(ERP_STEP_INDEX.fill, rows, rowsDone, route);
    bus.push(current);
    if (rowsDone >= rows) setTimeout(() => finishErpStep(taskId, run, ERP_STEP_INDEX.fill), rowMs(current));
    else setTimeout(() => fillRow(taskId, run, rowsDone + 1), rowMs(current));
  };

  const newRun = (taskId: string) => {
    const run = nextErpRun;
    nextErpRun += 1;
    erpRuns.set(taskId, run);
    return run;
  };

  return {
    // A confirmed claim enters the ERP stage and the fill runs through by itself.
    // 写入进行中没有待答 step（none），也没有「开始填报」这道确认。
    startErpWrite: async (taskId, stepToken) =>
      bus.withStep(taskId, stepToken, (snapshot) => {
        if (snapshot.step.kind !== 'choose_action' || snapshot.confirmation.status !== 'confirmed') {
          return { error: { code: 'not_ready', message: ERP_ACTION_ERRORS.notReady } };
        }
        const run = newRun(taskId);
        snapshot.stage = 'erp';
        snapshot.erp = erpRunning(ERP_STEP_INDEX.chromium, snapshot.lines.length, route);
        snapshot.step = { kind: 'none', stepToken: `tok-${taskId}-erp-run-${run}` };
        snapshot.task.updatedAt = bus.now();
        setTimeout(() => finishErpStep(taskId, run, ERP_STEP_INDEX.chromium), erpStepMs);
        return snapshot;
      }),
    // 开始对账 / 重新对账（原地等待）：只读报销系统再判定一次，只在对账结果允许原地等待时接受。
    // readback-mismatch 下第一次对账读到员工保存过、逐行不一致的草稿 ⇒ 只能转人工；否则留在原地，结果写进横幅。
    // 读到填好、没保存的单据也不算完成：没有暂存就没有交接（ADR-0037，服务端同此）。
    reconcile: async (taskId, stepToken) =>
      bus.withStep(taskId, stepToken, (snapshot) => {
        if (snapshot.step.kind !== 'reconcile') return { error: { code: 'not_reconciling', message: ERP_ACTION_ERRORS.notReconciling } };
        if (!snapshot.reconcile.allowedActions.includes('wait')) return { error: { code: 'action_not_allowed', message: ERP_ACTION_ERRORS.notAllowed } };
        const count = (reconcileCounts.get(taskId) ?? 0) + 1;
        reconcileCounts.set(taskId, count);
        snapshot.task.updatedAt = bus.now();
        if (options.fault === 'readback-mismatch' && snapshot.reconcile.bucket === null) {
          applyReadbackMismatch(snapshot, snapshot.erp.draftNo ?? T1_DRAFT_NO);
          return snapshot;
        }
        snapshot.reconcile.status = 'waiting';
        snapshot.reconcile.banner = `已重新对账（第 ${count} 次）：还没有读到可以确认的单据。你在报销系统中查看后可以再次对账。`;
        snapshot.step = { kind: 'reconcile', stepToken: `tok-${taskId}-reconcile-${count}` };
        return snapshot;
      }),
    // 重新去报销：发票已导入、明细还没写、报销系统里还没有单据编号时的那条出路。重开一张单据，从头再走一遍去报销。
    refill: async (taskId, stepToken) =>
      bus.withStep(taskId, stepToken, (snapshot) => {
        if (snapshot.step.kind !== 'reconcile') return { error: { code: 'not_reconciling', message: ERP_ACTION_ERRORS.notReconciling } };
        if (!snapshot.reconcile.allowedActions.includes('refill')) return { error: { code: 'action_not_allowed', message: ERP_ACTION_ERRORS.notAllowed } };
        const run = newRun(taskId);
        snapshot.stage = 'erp';
        snapshot.erp = erpRunning(ERP_STEP_INDEX.chromium, snapshot.lines.length, route);
        snapshot.reconcile = emptyReconcile();
        snapshot.step = { kind: 'none', stepToken: `tok-${taskId}-erp-run-${run}` };
        snapshot.task.updatedAt = bus.now();
        setTimeout(() => finishErpStep(taskId, run, ERP_STEP_INDEX.chromium), erpStepMs);
        return snapshot;
      }),
    // 转人工：终止后续写入，只在对账结果允许转人工时接受；任务停在原阶段（对账页或回读不一致的完成页）并标记为已转人工（终态）。
    handOff: async (taskId, stepToken) =>
      bus.withStep(taskId, stepToken, (snapshot) => {
        if (snapshot.step.kind !== 'reconcile' && snapshot.step.kind !== 'hand_off') {
          return { error: { code: 'not_reconciling', message: ERP_ACTION_ERRORS.notReconciling } };
        }
        if (!snapshot.reconcile.allowedActions.includes('hand_off')) return { error: { code: 'action_not_allowed', message: ERP_ACTION_ERRORS.notAllowed } };
        erpRuns.delete(taskId);
        snapshot.reconcile = {
          ...snapshot.reconcile,
          status: 'handed_off',
          allowedActions: [],
          banner: handedOffBanner(snapshot.reconcile.draftNo),
        };
        snapshot.step = { kind: 'none', stepToken: `tok-${taskId}-handed-off` };
        snapshot.task.updatedAt = bus.now();
        return snapshot;
      }),
  };
}
