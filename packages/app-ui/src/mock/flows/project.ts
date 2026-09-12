import { PROJECT_ASSIGNMENT_ERRORS, ProjectAssignmentInputSchema } from '../../contract/actions';
import type { AppAdapter } from '../../contract/adapter';
import { PROJECT_CHANGED_NOTICE, type StepKind, type TaskSnapshot } from '../../contract/snapshot';
import type { MockBus } from '../bus';
import { confirmationDigest, projectAssignmentSubmitted } from '../fixtures/projects';

// 项目归属提交，以及其后服务端自动执行的报销信息核对（catalog）与报销材料准备（preparation）（mock 服务端的角色）。
// 顺序照 Skill：project_unassigned → catalog_unverified → preparation_package_pending → preparation_confirmation。
// 这两步在本票是占位：按定时器自动通过，最后形成绑定项目归属的整单确认摘要，进入整单确认。

// catalog → preparation → review 每步的推进间隔（毫秒）；测试可以调小。
const DEFAULT_AUTO_STEP_MS = 600;

// 接受提交项目归属的当前 step：进入项目归属时；以及整单确认前后、ERP 写入开始之前的改派。
const SUBMIT_STEP_KINDS: ReadonlySet<StepKind> = new Set<StepKind>(['assign_projects', 'confirm_review', 'choose_action']);

export type ProjectFlow = Pick<AppAdapter, 'submitProjectAssignment'> & {
  // `?seed=catalog` / `?seed=preparation` 打开时让自动步骤接着走完。
  resumeAutoSteps(taskId: string): void;
};

// 报销信息核对与材料准备都通过：摘要绑定盘点版本、事由与逐条项目归属，进入整单确认。
// 旧确认因材料或项目变更失效的，保持 invalidated 与提示，直到用户重新确认。
function readyForReview(snapshot: TaskSnapshot): void {
  const taskId = snapshot.task.taskId;
  const digest = confirmationDigest(taskId, snapshot.inventory.versionId, snapshot.projectAssignment);
  snapshot.confirmation = {
    ...snapshot.confirmation,
    status: snapshot.confirmation.status === 'invalidated' ? 'invalidated' : 'unconfirmed',
    confirmedAt: null,
    digest,
  };
  snapshot.stage = 'review';
  snapshot.step = { kind: 'confirm_review', stepToken: `tok-${taskId}-review-${digest.slice(-8)}` };
}

export function createProjectFlow(bus: MockBus): ProjectFlow {
  const autoStepMs = bus.options.autoStepMs ?? DEFAULT_AUTO_STEP_MS;
  // 每个任务当前这一轮自动步骤的编号；定时器只推进自己那一轮（再次提交或材料变更后旧定时器作废）。
  const runs = new Map<string, number>();
  let nextRun = 1;

  const schedule = (taskId: string, from: 'catalog' | 'preparation') => {
    const run = nextRun;
    nextRun += 1;
    runs.set(taskId, run);
    const advance = (stage: 'catalog' | 'preparation') => {
      setTimeout(() => {
        const current = bus.draft(taskId);
        if (runs.get(taskId) !== run || current.stage !== stage) return;
        current.task.updatedAt = bus.now();
        if (stage === 'catalog') {
          current.stage = 'preparation';
          bus.push(current);
          advance('preparation');
          return;
        }
        readyForReview(current);
        bus.push(current);
      }, autoStepMs);
    };
    advance(from);
    return run;
  };

  return {
    // 提交项目归属：事由 1-100 字；每条明细都要有项目；项目必须在允许列表里且可选；不认识的明细拒绝。
    // 通过后记下归属与事由，阶段推到报销信息核对，随后自动准备材料并进入整单确认。
    // 确认之后再提交：归属与事由都没变，确认仍然有效；变了，确认失效（摘要绑定项目归属），须重新确认。
    submitProjectAssignment: async (taskId, input, stepToken) =>
      bus.withStep(taskId, stepToken, (snapshot) => {
        if (!SUBMIT_STEP_KINDS.has(snapshot.step.kind) || snapshot.erp.status !== 'idle') {
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
        const digest = confirmationDigest(taskId, snapshot.inventory.versionId, snapshot.projectAssignment);
        if (snapshot.confirmation.status === 'confirmed' && snapshot.confirmation.digest === digest) return snapshot;
        if (snapshot.confirmation.status === 'confirmed') {
          snapshot.confirmation = { ...snapshot.confirmation, status: 'invalidated', confirmedAt: null, notice: PROJECT_CHANGED_NOTICE };
        }
        snapshot.confirmation.digest = null;
        snapshot.stage = 'catalog';
        const run = schedule(taskId, 'catalog');
        snapshot.step = { kind: 'none', stepToken: `tok-${taskId}-catalog-${run}` };
        return snapshot;
      }),
    resumeAutoSteps(taskId) {
      const { stage } = bus.draft(taskId);
      if (stage === 'catalog' || stage === 'preparation') schedule(taskId, stage);
    },
  };
}
