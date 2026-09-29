import { CONFIRM_REVIEW_ERRORS, ERP_ACTION_ERRORS, PROJECT_ASSIGNMENT_ERRORS, type Blocker } from '@baox/contract';
import { describe, expect, it } from 'vitest';
import { NO_ERP } from './erp/fill-state';
import { ACTION_COPY, STALE_JOB, taskPolicy, type ActionName, type Admission, type ErpFacts, type TaskFacts } from './task-policy';

// The task policy (ADR-0014) over hand-built facts: every stage reachable, and every answer of the write gate.
const base: TaskFacts = { taskId: 't', revision: 7, lifecycle: 'open', origin: 'app', versionNo: 0, includedMaterialCount: 0, lastRun: null, lastReopenRevision: null, parse: null, project: null, confirmation: 'unconfirmed' };
const run = { versionNo: 1, includedMaterialCount: 2, lastRun: { versionNo: 1, revision: 5 } };
const clean = { ...run, parse: { waiting: 0, openPendingItems: 0, blockers: [] } };
const submitted = { ...clean, project: { lineCount: 2, selectableCount: 1, workingCount: 2, submitted: true } };
const confirmed: Partial<TaskFacts> = { ...submitted, confirmation: 'confirmed' };
const blocker: Blocker = { kind: 'duplicate_across_tasks', materialId: 'm1', fileName: 'a.pdf', reason: '这张发票在别的报销任务里也在。', resolver: '要你处理', tasks: [{ taskId: 'other', name: '别的任务' }] };
const job = (phase: ErpFacts['phase'], patch: Partial<ErpFacts> = {}): ErpFacts => ({ jobId: 'j', trigger: 'start', revision: 6, phase, reassign: false, reconciling: false, ...patch });
const facts = (patch: Partial<TaskFacts>): TaskFacts => ({ ...base, ...patch });

describe('taskPolicy: stage and step', () => {
  it.each<[string, Partial<TaskFacts>, string, string]>([
    ['a new task waits for materials', {}, 'upload', 'upload_materials'],
    ['an un-inventoried version asks to start inventory', { versionNo: 1, includedMaterialCount: 2 }, 'upload', 'start_inventory'],
    ['every material excluded: nothing to inventory', { versionNo: 1, includedMaterialCount: 0 }, 'upload', 'upload_materials'],
    ['the current version inventoried', run, 'inventory', 'none'],
    ['a batch after the run forms an un-inventoried version', { versionNo: 2, includedMaterialCount: 3, lastRun: { versionNo: 1, revision: 5 } }, 'upload', 'start_inventory'],
    ['upload reopened after the run', { ...run, lastReopenRevision: 6 }, 'upload', 'start_inventory'],
    ['a reopen older than the latest run is spent', { ...run, lastReopenRevision: 4 }, 'inventory', 'none'],
    ['voided, whatever else is true', { lifecycle: 'voided', versionNo: 1, includedMaterialCount: 2 }, 'voided', 'none'],
    ['the parser job still has materials to parse', { ...run, parse: { waiting: 1, openPendingItems: 1, blockers: [] } }, 'inventory', 'none'],
    ['parsed, with open pending items', { ...run, parse: { waiting: 0, openPendingItems: 2, blockers: [] } }, 'pending', 'answer_pending'],
    // #188 项目归属
    ['clean, without candidate lines', { ...clean, project: { lineCount: 0, selectableCount: 1, workingCount: 0, submitted: false } }, 'inventory', 'none'],
    ['clean, nothing selectable and nothing drafted', { ...clean, project: { lineCount: 2, selectableCount: 0, workingCount: 0, submitted: false } }, 'project', 'maintain_project_book'],
    ['clean, a draft survives an emptied book', { ...clean, project: { lineCount: 2, selectableCount: 0, workingCount: 1, submitted: false } }, 'project', 'assign_projects'],
    ['clean, with selectable projects', { ...clean, project: { lineCount: 2, selectableCount: 1, workingCount: 0, submitted: false } }, 'project', 'assign_projects'],
    ['submitted on the current lines', submitted, 'review', 'confirm_review'],
    ['parsed clean: rests in inventory until project assignment (#188)', clean, 'inventory', 'none'],
    ['results of a reopened run no longer count', { ...run, lastReopenRevision: 6, parse: { waiting: 1, openPendingItems: 0, blockers: [] } }, 'upload', 'start_inventory'],
    // #189 整单明细确认
    ['confirmed: choose the next action', confirmed, 'actions', 'choose_action'],
    ['a confirmation invalidated by a later change: review again', { ...submitted, confirmation: 'invalidated' }, 'review', 'confirm_review'],
    // #191 去报销 and #192 对账
    ['a fill job running', { ...confirmed, erp: job('running') }, 'erp', 'none'],
    ['a fill job paused at the ERP login', { ...confirmed, erp: job('waiting_login') }, 'erp', 'erp_login'],
    ['the login pause cancelled: back to the actions', { ...confirmed, erp: job('cancelled') }, 'actions', 'choose_action'],
    ['aborted before any write: back to the actions', { ...confirmed, erp: job('aborted') }, 'actions', 'choose_action'],
    ['a catalog mismatch sends the task back to assignment', { ...confirmed, erp: job('catalog_mismatch', { reassign: true }) }, 'project', 'assign_projects'],
    ['ERP 单据已交接 (handed over): done', { ...confirmed, erp: job('handed_over') }, 'done', 'none'],
    ['a reconcile proved the save: done', { ...confirmed, erp: job('saved') }, 'done', 'none'],
    ['ERP 写入结果未知: reconcile', { ...confirmed, erp: job('unknown') }, 'reconcile', 'reconcile'],
    ['a reconcile job running on it', { ...confirmed, erp: job('unknown', { reconciling: true }) }, 'reconcile', 'none'],
    ['转人工 (handed off)', { ...confirmed, lifecycle: 'handed_off', erp: job('unknown') }, 'reconcile', 'none'],
    // #195 legacy import
    ['a legacy task whose draft was saved', { lifecycle: 'handed_off', origin: 'legacy', legacyOutcome: 'draft_handed_over' }, 'done', 'none'],
    ['a legacy task handed off', { lifecycle: 'handed_off', origin: 'legacy', legacyOutcome: 'handed_off' }, 'reconcile', 'none'],
  ])('%s', (_name, patch, stage, step) => {
    const policy = taskPolicy(facts(patch), NO_ERP);
    expect(policy.stage).toBe(stage);
    expect(policy.step.kind).toBe(step);
    expect(policy.blockers).toEqual([]);
  });

  it('a batch held by another task (发票占用) stops in inventory with its blockers', () => {
    const policy = taskPolicy(facts({ ...run, parse: { waiting: 0, openPendingItems: 0, blockers: [blocker] } }), NO_ERP);
    expect(policy.stage).toBe('inventory');
    expect(policy.step.kind).toBe('none');
    expect(policy.blockers).toEqual([blocker]);
  });

  it('the stepToken is the task id and revision', () => {
    expect(taskPolicy(base, null).step.stepToken).toBe('t.7');
    expect(taskPolicy(facts({ revision: 8 }), null).step.stepToken).not.toBe('t.7');
  });
});

const TOKEN = 't.7';
const closed = { code: 'task_closed', message: ACTION_COPY.taskClosed };
const erpStarted = { code: 'erp_started', message: ERP_ACTION_ERRORS.erpStarted };
const attempted = { ...NO_ERP, attempted: true };

describe('taskPolicy: admit', () => {
  it.each<[string, Partial<TaskFacts>, boolean, ActionName, string | null, Admission]>([
    // stepToken
    ['the current token', {}, false, 'upload', TOKEN, 'ok'],
    ['an old token is stale', {}, false, 'upload', 't.6', 'stale'],
    ['a stale token beats a closed task', { lifecycle: 'voided' }, false, 'upload', 't.6', 'stale'],
    ['an action without a token skips the check', {}, false, 'upload', null, 'ok'],
    // closed tasks
    ['a voided task', { lifecycle: 'voided' }, false, 'exclude_material', TOKEN, closed],
    ['a handed-off task', { lifecycle: 'handed_off', erp: job('unknown') }, true, 'hand_off', TOKEN, closed],
    ['a job write on a voided task', { lifecycle: 'voided' }, false, 'job', null, closed],
    ['ERP 单据已交接 closes the task', { ...confirmed, erp: job('handed_over') }, true, 'upload', TOKEN, closed],
    ['a saved draft closes the task', { ...confirmed, erp: job('saved') }, true, 'upload', TOKEN, closed],
    // print
    ['print outlives 转人工', { ...confirmed, lifecycle: 'handed_off', erp: job('unknown') }, true, 'print', TOKEN, 'ok'],
    ['print outlives the handed-over draft', { ...confirmed, erp: job('handed_over') }, true, 'print', TOKEN, 'ok'],
    ['print outlives a write result unknown', { ...confirmed, erp: job('unknown') }, true, 'print', TOKEN, 'ok'],
    ['print stops at a voided task', { lifecycle: 'voided' }, false, 'print', TOKEN, closed],
    ['print stops at a legacy task', { lifecycle: 'handed_off', origin: 'legacy', legacyOutcome: 'draft_handed_over' }, false, 'print', TOKEN, closed],
    ['print waits for a running job', { ...confirmed, erp: job('running') }, true, 'print', TOKEN, 'stale'],
    // jobs running (ADR-0014: every foreign write is a 409)
    ['the parser job running', { ...run, parse: { waiting: 1, openPendingItems: 0, blockers: [] } }, false, 'exclude_material', TOKEN, 'stale'],
    ['the parser job writes its own outcome', { ...run, parse: { waiting: 1, openPendingItems: 0, blockers: [] } }, false, 'record_parse', null, 'ok'],
    ['a parser outcome after the run finished', clean, false, 'record_parse', null, STALE_JOB],
    ['a fill job running', { ...confirmed, erp: job('running') }, false, 'upload', null, 'stale'],
    ['a fill job writes its own facts', { ...confirmed, erp: job('running') }, true, 'job', null, 'ok'],
    ['a reconcile job running', { ...confirmed, erp: job('unknown', { reconciling: true }) }, true, 'reconcile', TOKEN, 'stale'],
    ['the login pause refuses other writes', { ...confirmed, erp: job('waiting_login') }, false, 'upload', null, 'stale'],
    ['the login pause admits 我已登录，继续', { ...confirmed, erp: job('waiting_login') }, false, 'confirm_login', TOKEN, 'ok'],
    ['the login pause admits cancelling the write', { ...confirmed, erp: job('waiting_login') }, false, 'cancel_erp_write', TOKEN, 'ok'],
    // write result unknown and the ADR-0014 freeze
    ['a write result unknown refuses facts changes', { ...confirmed, erp: job('unknown') }, true, 'exclude_material', TOKEN, erpStarted],
    ['a write result unknown refuses even the actions that own the freeze', { ...confirmed, erp: job('unknown') }, true, 'set_home_city', TOKEN, erpStarted],
    ['a write result unknown admits 对账', { ...confirmed, erp: job('unknown') }, true, 'reconcile', TOKEN, 'ok'],
    ['a write result unknown admits 转人工', { ...confirmed, erp: job('unknown') }, true, 'hand_off', TOKEN, 'ok'],
    ['a write result unknown admits 重新去报销', { ...confirmed, erp: job('unknown') }, true, 'refill', TOKEN, 'ok'],
    ['an attempt freezes the materials', { ...confirmed, erp: job('aborted') }, true, 'upload', null, erpStarted],
    ['an attempt freezes 去报销 again', { ...confirmed, erp: job('aborted') }, true, 'start_erp_write', TOKEN, erpStarted],
    ['an attempt freezes assignment', { ...confirmed, erp: job('aborted') }, true, 'assign_project_lines', TOKEN, erpStarted],
    ['修改常驻城市 gives its own reason on a frozen task', { ...confirmed, erp: job('aborted') }, true, 'set_home_city', TOKEN, 'ok'],
    ['追加材料 gives its own reason on a frozen task', { ...confirmed, erp: job('aborted') }, true, 'reopen_upload', TOKEN, 'ok'],
    ['no attempt, no freeze', { ...confirmed, erp: job('cancelled') }, false, 'upload', null, 'ok'],
    // each action's own step
    ['start inventory at start_inventory', { versionNo: 1, includedMaterialCount: 2 }, false, 'start_inventory', TOKEN, 'ok'],
    ['start inventory with nothing to inventory', {}, false, 'start_inventory', TOKEN, { code: 'not_ready', message: ACTION_COPY.notReadyToStart }],
    ['reopen upload after inventory', clean, false, 'reopen_upload', TOKEN, 'ok'],
    ['reopen upload before any inventory', { versionNo: 1, includedMaterialCount: 2 }, false, 'reopen_upload', TOKEN, { code: 'not_ready', message: ACTION_COPY.notReopenable }],
    ['confirm review at confirm_review', submitted, false, 'confirm_review', TOKEN, 'ok'],
    ['confirm review twice', confirmed, false, 'confirm_review', TOKEN, { code: 'not_ready', message: CONFIRM_REVIEW_ERRORS.notReady }],
    ['answer a pending item', { ...run, parse: { waiting: 0, openPendingItems: 1, blockers: [] } }, false, 'answer_pending', TOKEN, 'ok'],
    ['answer before any inventory', {}, false, 'answer_pending', TOKEN, { code: 'not_ready', message: ACTION_COPY.notAnswering }],
    ['answer on a batch held by another task', { ...run, parse: { waiting: 0, openPendingItems: 0, blockers: [blocker] } }, false, 'answer_pending', TOKEN, { code: 'not_ready', message: ACTION_COPY.notAnswering }],
    ['assign at assign_projects', { ...clean, project: { lineCount: 2, selectableCount: 1, workingCount: 0, submitted: false } }, false, 'assign_project_lines', TOKEN, 'ok'],
    ['reassign under confirm_review', submitted, false, 'submit_project_assignment', TOKEN, 'ok'],
    ['reassign under choose_action', confirmed, false, 'assign_project_lines', TOKEN, 'ok'],
    ['assign with pending items open', { ...run, parse: { waiting: 0, openPendingItems: 1, blockers: [] } }, false, 'assign_project_lines', TOKEN, { code: 'not_ready', message: PROJECT_ASSIGNMENT_ERRORS.notReady }],
    ['submit while the book needs maintaining', { ...clean, project: { lineCount: 2, selectableCount: 0, workingCount: 0, submitted: false } }, false, 'submit_project_assignment', TOKEN, { code: 'not_ready', message: PROJECT_ASSIGNMENT_ERRORS.notReady }],
  ])('%s', (_name, patch, erpAttempted, action, token, admission) => {
    expect(taskPolicy(facts(patch), erpAttempted ? attempted : NO_ERP).admit(action, token)).toEqual(admission);
  });
});
