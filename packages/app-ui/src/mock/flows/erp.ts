import { ERP_ACTION_ERRORS, PROJECT_ASSIGNMENT_ERRORS, ProjectAssignmentInputSchema } from '../../contract/actions';
import type { AppAdapter } from '../../contract/adapter';
import { RECONCILE_ACTION_LABELS, type TaskSnapshot } from '../../contract/snapshot';
import type { MockBus } from '../bus';
import { ERP_STEP_INDEX, applyAbortAtSave, applyErpDone, applyReadbackMismatch, erpIdle, erpSteps, handedOffBanner, loginNotDetected } from '../fixtures/erp';
import { projectAssignmentSubmitted } from '../fixtures/projects';
import { T1_DRAFT_NO } from '../fixtures/tasks';

// 项目归属提交、ERP 填报（定时推进、登录交接）、严格回读与对账（mock 服务端的角色）。
// 保存与严格回读的结局按故障决定：erp-write-aborted 在保存步中止（停在对账）；readback-mismatch 停在完成页等待转人工。

const DEFAULT_ERP_STEP_MS = 300;
const DEFAULT_ERP_LOGIN_AUTO_MS = 2500;
// `?fault=erp-login-missing`：前两次「我已登录，继续」都探测不到登录，第三次才检测到；该故障下服务端不会自己探测到。
const LOGIN_MISSING_ATTEMPTS = 2;

export type ErpFlow = Pick<AppAdapter, 'submitProjectAssignment' | 'startErpWrite' | 'confirmLogin' | 'reconcile' | 'handOff'>;

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

  // 探测到登录：从导入发票开始逐步推进。
  const loginDetected = (snapshot: TaskSnapshot, run: number) => {
    const taskId = snapshot.task.taskId;
    snapshot.erp.status = 'running';
    snapshot.erp.loginNotice = null;
    snapshot.erp.steps = erpSteps(ERP_STEP_INDEX.import, 'running');
    snapshot.step = { kind: 'none', stepToken: `tok-${taskId}-erp-write-${run}` };
    setTimeout(() => finishErpStep(taskId, run, ERP_STEP_INDEX.import), erpStepMs);
  };

  // 第 index 步结束：保存步在 erp-write-aborted 下中止；严格回读按 readback-mismatch 决定一致或停在完成页等待转人工。
  const finishErpStep = (taskId: string, run: number, index: number) => {
    const current = bus.draft(taskId);
    if (!erpRunLive(current, run, 'running')) return;
    current.task.updatedAt = bus.now();
    if (index === ERP_STEP_INDEX.save && options.fault === 'erp-write-aborted') {
      applyAbortAtSave(current);
      bus.push(current);
      return;
    }
    if (index === ERP_STEP_INDEX.save) current.erp.draftNo = T1_DRAFT_NO;
    if (index === ERP_STEP_INDEX.readback) {
      const draftNo = current.erp.draftNo ?? T1_DRAFT_NO;
      if (options.fault === 'readback-mismatch') applyReadbackMismatch(current, draftNo);
      else applyErpDone(current, draftNo);
      bus.push(current);
      return;
    }
    current.erp.steps = erpSteps(index + 1, 'running');
    bus.push(current);
    setTimeout(() => finishErpStep(taskId, run, index + 1), erpStepMs);
  };

  return {
    // 提交项目归属（服务端角色）：事由 1-100 字；每条明细都要有项目；项目必须在允许列表里且可选；不认识的明细拒绝。
    // 通过后记下归属与事由，阶段推到 erp，ERP 填报入口开放。整单明细确认不动（摘要不含项目与事由）。
    submitProjectAssignment: async (taskId, input, stepToken) =>
      bus.withStep(taskId, stepToken, (snapshot) => {
        if (snapshot.step.kind !== 'choose_action' && snapshot.step.kind !== 'assign_projects') {
          return { error: { code: 'not_ready', message: PROJECT_ASSIGNMENT_ERRORS.notReady } };
        }
        const parsed = ProjectAssignmentInputSchema.safeParse(input);
        if (!parsed.success) return { error: { code: 'invalid_purpose', message: PROJECT_ASSIGNMENT_ERRORS.purpose } };
        const { purpose, projects } = parsed.data;
        const lineIds = new Set(snapshot.lines.map((line) => line.lineId));
        const unknown = Object.keys(projects).find((lineId) => !lineIds.has(lineId));
        if (unknown) return { error: { code: 'unknown_line', message: PROJECT_ASSIGNMENT_ERRORS.unknownLine(unknown) } };
        const allowed = new Set(snapshot.projectAssignment.projects.filter((project) => project.selectable).map((project) => project.number));
        if (allowed.size === 0) return { error: { code: 'project_book_empty', message: PROJECT_ASSIGNMENT_ERRORS.bookEmpty } };
        for (const line of snapshot.lines) {
          const number = projects[line.lineId];
          if (!number) return { error: { code: 'line_unassigned', message: PROJECT_ASSIGNMENT_ERRORS.lineUnassigned(line.no) } };
          if (!allowed.has(number)) return { error: { code: 'project_not_allowed', message: PROJECT_ASSIGNMENT_ERRORS.projectNotAllowed(line.no, number) } };
        }
        const at = bus.now();
        snapshot.projectAssignment = projectAssignmentSubmitted({ purpose, homeCity: snapshot.task.homeCity, projects, submittedAt: at });
        snapshot.task.updatedAt = at;
        snapshot.stage = 'erp';
        snapshot.erp = erpIdle();
        snapshot.step = { kind: 'start_erp_write', stepToken: `tok-${taskId}-erp` };
        return snapshot;
      }),
    // 开始填报：第一步「启动浏览器」进行中，随后登录步等待。写入进行中没有待答 step（none）。
    startErpWrite: async (taskId, stepToken) =>
      bus.withStep(taskId, stepToken, (snapshot) => {
        if (snapshot.step.kind !== 'start_erp_write') return { error: { code: 'not_ready', message: ERP_ACTION_ERRORS.notReady } };
        const run = nextErpRun;
        nextErpRun += 1;
        erpRuns.set(taskId, run);
        loginAttempts.set(taskId, 0);
        snapshot.erp = { status: 'running', steps: erpSteps(ERP_STEP_INDEX.browser, 'running'), draftNo: null, abortReason: null, loginNotice: null };
        snapshot.step = { kind: 'none', stepToken: `tok-${taskId}-erp-run-${run}` };
        snapshot.task.updatedAt = bus.now();
        setTimeout(() => reachLogin(taskId, run), erpStepMs);
        return snapshot;
      }),
    // 「我已登录，继续」= 请服务端再探测一次。探测不到：留在登录步，给出说明并换新凭据（摆给用户看的内容变了）。
    confirmLogin: async (taskId, stepToken) =>
      bus.withStep(taskId, stepToken, (snapshot) => {
        if (snapshot.step.kind !== 'erp_login') return { error: { code: 'not_waiting_login', message: ERP_ACTION_ERRORS.notWaitingLogin } };
        const run = erpRuns.get(taskId) ?? 0;
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
    // 重新对账：只读 ERP 再判定一次。保存步中止的任务读到草稿且逐行一致 ⇒ 完成；仍有不一致的行 ⇒ 原地等待，结果写进横幅。
    reconcile: async (taskId, stepToken) =>
      bus.withStep(taskId, stepToken, (snapshot) => {
        if (snapshot.step.kind !== 'reconcile') return { error: { code: 'not_reconciling', message: ERP_ACTION_ERRORS.notReconciling } };
        const count = (reconcileCounts.get(taskId) ?? 0) + 1;
        reconcileCounts.set(taskId, count);
        snapshot.task.updatedAt = bus.now();
        if (snapshot.reconcile.rows.length === 0 && snapshot.lines.length > 0) {
          applyErpDone(snapshot, T1_DRAFT_NO);
          snapshot.reconcile = {
            ...snapshot.reconcile,
            status: 'none',
            bucket: '已保存',
            action: RECONCILE_ACTION_LABELS.wait,
            actionCode: 'wait',
            banner: `重新对账：ERP 中已有草稿 ${T1_DRAFT_NO}，${snapshot.readback.rows.length} 行明细逐行一致。`,
            draftNo: T1_DRAFT_NO,
            reasons: [],
          };
          return snapshot;
        }
        const bad = snapshot.reconcile.rows.filter((row) => !row.matched).length;
        snapshot.reconcile.status = 'waiting';
        snapshot.reconcile.banner = `已重新对账（第 ${count} 次）：ERP 草稿 ${snapshot.reconcile.draftNo ?? ''} 仍有 ${bad} 行与本地确认不一致。你在 ERP 中修正后可以再次对账，或者转人工。`;
        snapshot.step = { kind: 'reconcile', stepToken: `tok-${taskId}-reconcile-${count}` };
        return snapshot;
      }),
    // 转人工：终止后续 ERP 写入，任务停在原阶段（对账页或回读不一致的完成页）并标记为已转人工（终态），对账记录保留。
    handOff: async (taskId, stepToken) =>
      bus.withStep(taskId, stepToken, (snapshot) => {
        if (snapshot.step.kind !== 'reconcile' && snapshot.step.kind !== 'hand_off') {
          return { error: { code: 'not_reconciling', message: ERP_ACTION_ERRORS.notReconciling } };
        }
        erpRuns.delete(taskId);
        snapshot.reconcile = {
          ...snapshot.reconcile,
          status: 'handed_off',
          action: RECONCILE_ACTION_LABELS.hand_off,
          actionCode: 'hand_off',
          banner: handedOffBanner(snapshot.reconcile.draftNo),
        };
        snapshot.step = { kind: 'none', stepToken: `tok-${taskId}-handed-off` };
        snapshot.task.updatedAt = bus.now();
        return snapshot;
      }),
  };
}
