import {
  AssignProjectLinesInputSchema,
  PROJECT_ASSIGNMENT_ERRORS,
  ProjectAssignmentInputSchema,
  type AppAdapter,
  PROJECT_CHANGED_NOTICE,
  type StepKind,
  type TaskSnapshot,
} from '@baox/contract';
import type { MockBus } from '../bus';
import { catalogPending, preparationReady } from '../fixtures/preparation';
import { assignWorking, confirmationDigest, deadlineWarningsOf, projectAssignmentSubmitted, withLineProjects } from '../fixtures/projects';

// Project assignment (项目归属) submission, in the mock server's role. Like the server, submitting goes straight to
// the review (整单确认): the catalog is checked later, inside the ERP job (flows/erp.ts, `?fault=catalog-mismatch`),
// and the material preparation has nothing left to wait for once the digest exists.

// Step kinds that accept an assignment: entering project assignment (including the reassignment after a catalog
// mismatch), and reassignment before and after the review is confirmed, until the ERP write starts.
const SUBMIT_STEP_KINDS: ReadonlySet<StepKind> = new Set<StepKind>(['assign_projects', 'confirm_review', 'choose_action']);

export type ProjectFlow = Pick<AppAdapter, 'assignProjectLines' | 'submitProjectAssignment'>;

// The digest binds the inventory version, the purpose and every line's project; the review's line, invoice and total
// counts come with it (the server leaves them empty until there is a digest to confirm). An earlier confirmation
// invalidated by a material or project change stays `invalidated`, with its notice, until the user confirms again.
function readyForReview(snapshot: TaskSnapshot): void {
  const taskId = snapshot.task.taskId;
  const digest = confirmationDigest(taskId, snapshot.inventory.versionId, snapshot.projectAssignment);
  const invoices = new Set(snapshot.lines.map((line) => line.voucherMaterialId)).size;
  const cents = snapshot.lines.reduce((sum, line) => sum + Math.round(Number(line.grossAmount) * 100), 0);
  snapshot.catalog = catalogPending();
  snapshot.preparation = preparationReady();
  snapshot.confirmation = {
    ...snapshot.confirmation,
    status: snapshot.confirmation.status === 'invalidated' ? 'invalidated' : 'unconfirmed',
    confirmedAt: null,
    digest,
    lineCount: snapshot.lines.length,
    invoiceCount: invoices,
    grossTotal: (cents / 100).toFixed(2),
  };
  snapshot.stage = 'review';
  snapshot.step = { kind: 'confirm_review', stepToken: `tok-${taskId}-review-${digest.slice(-8)}` };
}

export function createProjectFlow(bus: MockBus): ProjectFlow {
  return {
    // 归入 (assign): only the assignment being edited (working) changes; the bus projection recounts what is assigned.
    // The state changed, so a new stepToken is issued. A new assignment may only use a selectable project (the allow
    // list); unknown lines are refused.
    assignProjectLines: async (taskId, input, stepToken) =>
      bus.withStep(taskId, stepToken, (snapshot) => {
        if (!SUBMIT_STEP_KINDS.has(snapshot.step.kind) || snapshot.erp.status !== 'idle') {
          return { error: { code: 'not_ready', message: PROJECT_ASSIGNMENT_ERRORS.notReady } };
        }
        const parsed = AssignProjectLinesInputSchema.safeParse(input);
        if (!parsed.success) return { error: { code: 'no_lines', message: PROJECT_ASSIGNMENT_ERRORS.noLinesSelected } };
        const { lineIds, projectNumber, onlyUnassigned } = parsed.data;
        const known = new Set(snapshot.lines.map((line) => line.lineId));
        const unknown = lineIds.find((lineId) => !known.has(lineId));
        if (unknown) return { error: { code: 'unknown_line', message: PROJECT_ASSIGNMENT_ERRORS.unknownLine(unknown) } };
        if (!snapshot.projectAssignment.projects.some((project) => project.number === projectNumber)) {
          return { error: { code: 'project_not_allowed', message: PROJECT_ASSIGNMENT_ERRORS.projectNotSelectable(projectNumber) } };
        }
        snapshot.projectAssignment.working = assignWorking(snapshot.projectAssignment, lineIds, projectNumber, onlyUnassigned);
        snapshot.step = { ...snapshot.step, stepToken: bus.rotateToken(snapshot.step.stepToken) };
        return snapshot;
      }),
    // Submit the assignment: a purpose of 1-100 characters, a project on every line, no unknown lines.
    // Projects are checked against the current selectable set (kernel submitSelection): a new assignment must use a
    // selectable project; a deleted or inactive project cannot be newly assigned, but a line may keep the project it
    // already had (an earlier valid choice).
    // Accepted: the assignment and purpose are recorded and the task goes to the review.
    // Submitted again after the confirmation: unchanged, the confirmation stays valid; changed, it is invalidated
    // (the digest binds the assignment) and must be confirmed again.
    submitProjectAssignment: async (taskId, input, stepToken) =>
      bus.withStep(taskId, stepToken, (snapshot) => {
        if (!SUBMIT_STEP_KINDS.has(snapshot.step.kind) || snapshot.erp.status !== 'idle') {
          return { error: { code: 'not_ready', message: PROJECT_ASSIGNMENT_ERRORS.notReady } };
        }
        const parsed = ProjectAssignmentInputSchema.safeParse(input);
        if (!parsed.success) return { error: { code: 'invalid_purpose', message: PROJECT_ASSIGNMENT_ERRORS.purpose } };
        const { purpose, projects, acceptDeadlineWarnings } = parsed.data;
        const lineIds = new Set(snapshot.lines.map((line) => line.lineId));
        const unknown = Object.keys(projects).find((lineId) => !lineIds.has(lineId));
        if (unknown) return { error: { code: 'unknown_line', message: PROJECT_ASSIGNMENT_ERRORS.unknownLine(unknown) } };
        const allowed = new Set(snapshot.projectAssignment.projects.map((project) => project.number));
        const previous = new Map(snapshot.projectAssignment.assignments.map((item) => [item.lineId, item.projectNumber]));
        for (const line of snapshot.lines) {
          const number = projects[line.lineId];
          if (!number) return { error: { code: 'line_unassigned', message: PROJECT_ASSIGNMENT_ERRORS.lineUnassigned(line.no) } };
          if (allowed.has(number) || previous.get(line.lineId) === number) continue;
          if (allowed.size === 0) return { error: { code: 'project_book_empty', message: PROJECT_ASSIGNMENT_ERRORS.bookEmpty } };
          return { error: { code: 'project_not_allowed', message: PROJECT_ASSIGNMENT_ERRORS.projectNotAllowed(line.no, number) } };
        }
        const nextAssignment = projectAssignmentSubmitted({
          purpose,
          homeCity: snapshot.task.homeCity,
          projects,
          submittedAt: snapshot.task.updatedAt,
          allowList: snapshot.projectAssignment.projects,
          previous: snapshot.projectAssignment.assignments,
        });
        if (deadlineWarningsOf(snapshot.lines, nextAssignment.assignments, nextAssignment.projects).length > 0 && !acceptDeadlineWarnings) {
          return { error: { code: 'deadline_confirmation_required', message: PROJECT_ASSIGNMENT_ERRORS.deadlineConfirmationRequired } };
        }
        const at = bus.now();
        snapshot.projectAssignment = { ...nextAssignment, submittedAt: at };
        snapshot.lines = withLineProjects(snapshot.lines, snapshot.projectAssignment);
        snapshot.task.updatedAt = at;
        const digest = confirmationDigest(taskId, snapshot.inventory.versionId, snapshot.projectAssignment);
        // Unchanged after the confirmation: it stays valid and the task is back at 去打印 / 去报销 (print / claim),
        // also when a catalog mismatch had sent it here.
        if (snapshot.confirmation.status === 'confirmed' && snapshot.confirmation.digest === digest) {
          snapshot.catalog = catalogPending();
          if (snapshot.stage !== 'actions') {
            snapshot.stage = 'actions';
            snapshot.step = { kind: 'choose_action', stepToken: bus.rotateToken(`tok-${taskId}-actions`) };
          }
          return snapshot;
        }
        if (snapshot.confirmation.status === 'confirmed') {
          snapshot.confirmation = { ...snapshot.confirmation, status: 'invalidated', confirmedAt: null, notice: PROJECT_CHANGED_NOTICE };
        }
        readyForReview(snapshot);
        return snapshot;
      }),
  };
}
