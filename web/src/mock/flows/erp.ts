import { ERP_ACTION_ERRORS, type AppAdapter, type TaskSnapshot } from '@baox/contract';
import type { MockBus } from '../bus';
import { ERP_STEP_INDEX, applyAbortAtHandover, applyErpDone, applyReadbackMismatch, emptyReconcile, erpSteps, handedOffBanner, loginNotDetected, reconcileVerdict } from '../fixtures/erp';
import { T1_DRAFT_NO } from '../fixtures/tasks';

// ERP 填报（「去报销」即开始：定时推进、登录交接、登录后自动写入）、严格回读与对账（mock 服务端的角色）。
// 没有「开始填报」：整单确认之后点「去报销」启动浏览器，检测到登录就自动导入、写入、回读并交接（内核 erp_write_pending 自动执行）。
// 严格回读与交接的结局按故障决定：erp-write-aborted 在交接步中止（停在对账）；readback-mismatch 停在完成页等待转人工。

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
    snapshot.erp.steps = erpSteps(ERP_STEP_INDEX.navigate, 'running');
    snapshot.step = { kind: 'none', stepToken: `tok-${taskId}-erp-write-${run}` };
    setTimeout(() => finishErpStep(taskId, run, ERP_STEP_INDEX.navigate), erpStepMs);
  };

  // 第 index 步结束：严格回读按 readback-mismatch 决定一致或停在完成页等待转人工；交接步在 erp-write-aborted 下中止。
  const finishErpStep = (taskId: string, run: number, index: number) => {
    const current = bus.draft(taskId);
    if (!erpRunLive(current, run, 'running')) return;
    current.task.updatedAt = bus.now();
    if (index === ERP_STEP_INDEX.readback && options.fault === 'readback-mismatch') {
      applyReadbackMismatch(current, current.erp.draftNo ?? T1_DRAFT_NO);
      bus.push(current);
      return;
    }
    if (index === ERP_STEP_INDEX.handover) {
      if (options.fault === 'erp-write-aborted') applyAbortAtHandover(current);
      else applyErpDone(current, current.erp.draftNo ?? T1_DRAFT_NO);
      bus.push(current);
      return;
    }
    current.erp.steps = erpSteps(index + 1, 'running');
    bus.push(current);
    setTimeout(() => finishErpStep(taskId, run, index + 1), erpStepMs);
  };

  const newRun = (taskId: string) => {
    const run = nextErpRun;
    nextErpRun += 1;
    erpRuns.set(taskId, run);
    loginAttempts.set(taskId, 0);
    return run;
  };

  return {
    // 去报销：整单确认之后才接受（choose_action）。阶段推到 erp，第一步「启动浏览器」进行中，随后登录步等待；
    // 写入进行中没有待答 step（none）。检测到登录后自动写入，不再有「开始填报」这道确认。
    startErpWrite: async (taskId, stepToken) =>
      bus.withStep(taskId, stepToken, (snapshot) => {
        if (snapshot.step.kind !== 'choose_action' || snapshot.confirmation.status !== 'confirmed') {
          return { error: { code: 'not_ready', message: ERP_ACTION_ERRORS.notReady } };
        }
        const run = newRun(taskId);
        snapshot.stage = 'erp';
        snapshot.erp = { status: 'running', steps: erpSteps(ERP_STEP_INDEX.browser, 'running'), draftNo: null, abortReason: null, loginNotice: null, erpAccount: null };
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
        snapshot.erp = { status: 'idle', steps: [], draftNo: null, abortReason: null, loginNotice: null, erpAccount: null };
        snapshot.step = { kind: 'choose_action', stepToken: bus.rotateToken(`tok-${taskId}-actions`) };
        snapshot.task.updatedAt = bus.now();
        return snapshot;
      }),
    // 重新对账（原地等待）：只读报销系统再判定一次，只在对账结果允许原地等待时接受。
    // 交接步中止的任务读到单据且逐行一致 ⇒ 完成；否则留在原地，结果写进横幅。
    reconcile: async (taskId, stepToken) =>
      bus.withStep(taskId, stepToken, (snapshot) => {
        if (snapshot.step.kind !== 'reconcile') return { error: { code: 'not_reconciling', message: ERP_ACTION_ERRORS.notReconciling } };
        if (!snapshot.reconcile.allowedActions.includes('wait')) return { error: { code: 'action_not_allowed', message: ERP_ACTION_ERRORS.notAllowed } };
        const count = (reconcileCounts.get(taskId) ?? 0) + 1;
        reconcileCounts.set(taskId, count);
        snapshot.task.updatedAt = bus.now();
        if (snapshot.reconcile.rows.length === 0 && snapshot.lines.length > 0) {
          applyErpDone(snapshot, T1_DRAFT_NO);
          snapshot.reconcile = {
            ...snapshot.reconcile,
            ...reconcileVerdict('已保存'),
            status: 'none',
            allowedActions: [],
            banner: `重新对账：报销系统中已有草稿 ${T1_DRAFT_NO}，${snapshot.readback.rows.length} 行明细逐行一致。`,
            draftNo: T1_DRAFT_NO,
            reasons: [],
          };
          return snapshot;
        }
        snapshot.reconcile.status = 'waiting';
        snapshot.reconcile.banner = `已重新对账（第 ${count} 次）：还没有读到可以确认的草稿。你在报销系统中查看后可以再次对账。`;
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
        snapshot.erp = { status: 'running', steps: erpSteps(ERP_STEP_INDEX.browser, 'running'), draftNo: null, abortReason: null, loginNotice: null, erpAccount: null };
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
