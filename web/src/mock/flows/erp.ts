import { ERP_ACTION_ERRORS, type AppAdapter, type TaskSnapshot } from '@baox/contract';
import type { MockBus } from '../bus';
import { ERP_STEP_INDEX, applyAbortAtHandover, applyErpDone, applyReadbackMismatch, applyReadbackStop, applyStopBeforeWrite, emptyReconcile, erpProgress, erpRunning, erpStageAt, erpSteps, handedOffBanner, idleErp, loginNotDetected } from '../fixtures/erp';
import { catalogMismatch } from '../fixtures/preparation';
import { T1_DRAFT_NO } from '../fixtures/tasks';

// The mock simulates the server-owned ERP fill, strict read-back, and reconciliation states.
// Confirming a claim opens its task-specific ERP tab; once login is detected, the simulated fill advances automatically.
// 写入的结局按故障决定：erp-stopped-before-write 在打开报销单时停下（退回去报销前）；readback-mismatch 在填写明细后的
// 严格回读停下、erp-write-aborted 在交接步中止，两者都停在对账，等第一次对账（readback-mismatch 对账后读到逐行不一致的草稿，只能转人工）。

const DEFAULT_ERP_STEP_MS = 300;
const DEFAULT_ERP_LOGIN_AUTO_MS = 2500;
// `?fault=erp-login-missing`：前两次「我已登录，继续」都探测不到登录，第三次才检测到；该故障下服务端不会自己探测到。
const LOGIN_MISSING_ATTEMPTS = 2;

export type ErpFlow = Pick<AppAdapter, 'startErpWrite' | 'confirmLogin' | 'cancelErpWrite' | 'reconcile' | 'handOff' | 'refill'>;

export function createErpFlow(bus: MockBus): ErpFlow {
  const { options } = bus;
  const erpStepMs = options.erpStepMs ?? DEFAULT_ERP_STEP_MS;
  const erpLoginAutoMs = options.erpLoginAutoMs ?? DEFAULT_ERP_LOGIN_AUTO_MS;
  // 每个任务当前这一轮 ERP 写入的编号、登录探测次数与重新对账次数；定时器只推进自己那一轮。
  const erpRuns = new Map<string, number>();
  const loginAttempts = new Map<string, number>();
  const reconcileCounts = new Map<string, number>();
  let nextErpRun = 1;

  const erpRunLive = (snapshot: TaskSnapshot, run: number, status: TaskSnapshot['erp']['status']) =>
    erpRuns.get(snapshot.task.taskId) === run && snapshot.erp.status === status;

  // 浏览器已启动：登录步进入等待，当前待答 step 变为 erp_login。正常场景下服务端过一会儿自己探测到登录。
  const reachLogin = (taskId: string, run: number) => {
    const current = bus.draft(taskId);
    if (!erpRunLive(current, run, 'running')) return;
    current.erp.status = 'waiting_login';
    current.erp.steps = erpSteps(ERP_STEP_INDEX.login, 'waiting');
    current.erp.currentStage = 'login';
    current.erp.progress = erpProgress(ERP_STEP_INDEX.login, current.lines.length);
    current.erp.externalWait = 'employee_login';
    current.erp.outcome = 'none';
    current.erp.allowedActions = ['refresh', 'confirm_login', 'cancel'];
    current.step = { kind: 'erp_login', stepToken: `tok-${taskId}-erp-login-${run}-1` };
    bus.push(current);
    if (options.fault === 'erp-login-missing') return;
    setTimeout(() => {
      const latest = bus.draft(taskId);
      if (!erpRunLive(latest, run, 'waiting_login')) return;
      loginDetected(latest, run);
      bus.push(latest);
    }, erpLoginAutoMs);
  };

  // 探测到登录：从打开空白报销单开始逐步推进（选择不生成费用明细、导入发票、收票回读、填写明细、严格回读、交接单据）。
  const loginDetected = (snapshot: TaskSnapshot, run: number) => {
    const taskId = snapshot.task.taskId;
    snapshot.erp.status = 'running';
    snapshot.erp.loginNotice = null;
    snapshot.erp.steps = erpSteps(ERP_STEP_INDEX.catalog, 'running');
    snapshot.erp.currentStage = 'catalog';
    snapshot.erp.progress = erpProgress(ERP_STEP_INDEX.catalog, snapshot.lines.length);
    snapshot.erp.externalWait = 'erp_response';
    snapshot.erp.outcome = 'none';
    snapshot.erp.allowedActions = ['refresh'];
    snapshot.step = { kind: 'none', stepToken: `tok-${taskId}-erp-write-${run}` };
    setTimeout(() => finishErpStep(taskId, run, ERP_STEP_INDEX.catalog), erpStepMs);
  };

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
      applyStopBeforeWrite(current);
      current.step = { kind: 'choose_action', stepToken: bus.rotateToken(`tok-${taskId}-actions`) };
      bus.push(current);
      return;
    }
    if (index === ERP_STEP_INDEX.fill && options.fault === 'readback-mismatch') {
      erpRuns.delete(taskId);
      applyReadbackStop(current);
      bus.push(current);
      return;
    }
    if (index === ERP_STEP_INDEX.handover) {
      if (options.fault === 'erp-write-aborted') applyAbortAtHandover(current);
      // 交接：单据填好了但没有保存，所以没有单据编号（服务端 handed_over 同此）。
      else applyErpDone(current);
      bus.push(current);
      return;
    }
    current.erp.steps = erpSteps(index + 1, 'running');
    current.erp.currentStage = erpStageAt(index + 1);
    current.erp.progress = erpProgress(index + 1, current.lines.length);
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
    current.erp.progress = erpProgress(ERP_STEP_INDEX.fill, rows, rowsDone);
    bus.push(current);
    if (rowsDone >= rows) setTimeout(() => finishErpStep(taskId, run, ERP_STEP_INDEX.fill), rowMs(current));
    else setTimeout(() => fillRow(taskId, run, rowsDone + 1), rowMs(current));
  };

  const newRun = (taskId: string) => {
    const run = nextErpRun;
    nextErpRun += 1;
    erpRuns.set(taskId, run);
    loginAttempts.set(taskId, 0);
    return run;
  };

  return {
    // A confirmed claim enters the ERP stage, opens its ERP tab, then waits for employee login.
    // 写入进行中没有待答 step（none）。检测到登录后自动写入，不再有「开始填报」这道确认。
    startErpWrite: async (taskId, stepToken) =>
      bus.withStep(taskId, stepToken, (snapshot) => {
        if (snapshot.step.kind !== 'choose_action' || snapshot.confirmation.status !== 'confirmed') {
          return { error: { code: 'not_ready', message: ERP_ACTION_ERRORS.notReady } };
        }
        const run = newRun(taskId);
        snapshot.stage = 'erp';
        snapshot.erp = erpRunning(ERP_STEP_INDEX.chromium, snapshot.lines.length);
        snapshot.step = { kind: 'none', stepToken: `tok-${taskId}-erp-run-${run}` };
        snapshot.task.updatedAt = bus.now();
        setTimeout(() => reachLogin(taskId, run), erpStepMs);
        return snapshot;
      }),
    // 「我已登录，继续」= 请服务端再探测一次。探测不到：留在登录步，给出说明并换新凭据（摆给用户看的内容变了）。
    // `?seed=erp` 打开时浏览器已在等待登录，但这一轮还没有编号：第一次探测时补上。
    confirmLogin: async (taskId, stepToken) =>
      bus.withStep(taskId, stepToken, (snapshot) => {
        if (snapshot.step.kind !== 'erp_login') return { error: { code: 'not_waiting_login', message: ERP_ACTION_ERRORS.notWaitingLogin } };
        const run = erpRuns.get(taskId) ?? newRun(taskId);
        const attempt = (loginAttempts.get(taskId) ?? 0) + 1;
        loginAttempts.set(taskId, attempt);
        if (options.fault === 'erp-login-missing' && attempt <= LOGIN_MISSING_ATTEMPTS) {
          snapshot.erp.loginNotice = loginNotDetected(attempt);
          snapshot.step = { kind: 'erp_login', stepToken: `tok-${taskId}-erp-login-${run}-${attempt + 1}` };
          return snapshot;
        }
        loginDetected(snapshot, run);
        return snapshot;
      }),
    // 登录等待时放弃这次去报销：什么都没写，回到「去打印 / 去报销」，之后可以再去报销。
    cancelErpWrite: async (taskId, stepToken) =>
      bus.withStep(taskId, stepToken, (snapshot) => {
        if (snapshot.step.kind !== 'erp_login') return { error: { code: 'not_waiting_login', message: ERP_ACTION_ERRORS.notWaitingLogin } };
        erpRuns.delete(taskId);
        snapshot.stage = 'actions';
        snapshot.erp = idleErp();
        snapshot.step = { kind: 'choose_action', stepToken: bus.rotateToken(`tok-${taskId}-actions`) };
        snapshot.task.updatedAt = bus.now();
        return snapshot;
      }),
    // 开始对账 / 重新对账（原地等待）：只读报销系统再判定一次，只在对账结果允许原地等待时接受。
    // readback-mismatch 下第一次对账读到员工保存过、逐行不一致的草稿 ⇒ 只能转人工；
    // 交接步中止的任务读到单据且逐行一致 ⇒ 单据交接完成；否则留在原地，结果写进横幅。
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
        // 读到的是一张填好、待员工保存、逐行一致的单据（对账中断点「未保存·就绪待保存」）：这就是单据交接完成，
        // 不是一个中断点。服务端在 fill-state.ts 里把它提升为 handed_over，对账区随之清空；mock 照做。
        if (snapshot.reconcile.rows.length === 0 && snapshot.lines.length > 0) {
          applyErpDone(snapshot);
          snapshot.reconcile = emptyReconcile();
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
        snapshot.erp = erpRunning(ERP_STEP_INDEX.chromium, snapshot.lines.length);
        snapshot.reconcile = emptyReconcile();
        snapshot.step = { kind: 'none', stepToken: `tok-${taskId}-erp-run-${run}` };
        snapshot.task.updatedAt = bus.now();
        setTimeout(() => reachLogin(taskId, run), erpStepMs);
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
