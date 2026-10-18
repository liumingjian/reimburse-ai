import { CONFIRM_REVIEW_ERRORS, ERP_ACTION_ERRORS, EXECUTOR_NOT_PAIRED_CODE, HOME_CITY_ERRORS, PROJECT_ASSIGNMENT_ERRORS, REOPEN_UPLOAD_ERRORS, TASK_ACTIONS, type Blocker, type ReconcileBucket, type TaskAction } from '@baox/contract';
import { describe, expect, it } from 'vitest';
import { NO_ERP, type ErpRecord, type ReconcileJudgement } from './erp/fill-state';
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
    ['aborted before any write: back to the actions', { ...confirmed, erp: job('aborted') }, 'actions', 'choose_action'],
    ['a catalog mismatch sends the task back to assignment', { ...confirmed, erp: job('catalog_mismatch', { reassign: true }) }, 'project', 'assign_projects'],
    ['ERP 草稿已交接 (the 暂存 draft found again): done', { ...confirmed, erp: job('drafted') }, 'done', 'none'],
    ['a reconcile proved the save: done', { ...confirmed, erp: job('saved') }, 'done', 'none'],
    ['ERP 写入结果未知: reconcile', { ...confirmed, erp: job('unknown') }, 'reconcile', 'reconcile'],
    ['a reconcile job running on it', { ...confirmed, erp: job('unknown', { reconciling: true }) }, 'reconcile', 'none'],
    ['handed off to a human (转人工)', { ...confirmed, lifecycle: 'handed_off', erp: job('unknown') }, 'reconcile', 'none'],
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
const notAllowed = { code: 'action_not_allowed', message: ERP_ACTION_ERRORS.notAllowed };
const inUse = { code: 'erp_in_use', message: ERP_ACTION_ERRORS.inUse };
// The ERP record beside the facts: what only the record knows (the attempt, the 对账 verdict, the fill's result). The
// phase is the facts' (`TaskFacts.erp`); the policy never reads the record's copy, so these records leave it null.
const record = (extra: Partial<ErpRecord> = {}): ErpRecord => ({ ...NO_ERP, ...extra });
const notReady = { code: 'not_ready', message: ERP_ACTION_ERRORS.notReady };
const notReconciling = { code: 'not_reconciling', message: ERP_ACTION_ERRORS.notReconciling };
// The refusal names the 设置页 in words and as a link target, so the page can offer the way there.
const notPaired = { code: EXECUTOR_NOT_PAIRED_CODE, message: '先在设置页安装本地执行器。', link: 'settings' } as const;

describe('taskPolicy: admit', () => {
  it.each<[string, Partial<TaskFacts>, boolean, ActionName, string | null, Admission]>([
    ['dining evidence with unrelated pending work', { ...clean, parse: { waiting: 0, openPendingItems: 3, blockers: [] } }, false, 'change_dining_evidence', TOKEN, 'ok'],
    ['dining evidence before confirmation', submitted, false, 'change_dining_evidence', TOKEN, 'ok'],
    ['dining evidence with cross-task blockers', { ...clean, parse: { waiting: 0, openPendingItems: 0, blockers: [blocker] } }, false, 'change_dining_evidence', TOKEN, { code: 'not_ready', message: '当前材料盘点完成后才能修改餐饮材料。' }],
    ['dining evidence before current inventory', { ...clean, versionNo: 2 }, false, 'change_dining_evidence', TOKEN, { code: 'not_ready', message: '当前材料盘点完成后才能修改餐饮材料。' }],
    ['dining evidence after confirmation', confirmed, false, 'change_dining_evidence', TOKEN, { code: 'dining_evidence_locked', message: '整单明细已确认，请先重新打开上传再修改餐饮材料。' }],
    ['dining evidence after ERP attempt', { ...confirmed, erp: job('unknown') }, true, 'change_dining_evidence', TOKEN, erpStarted],
    ['dining evidence while parsing', { ...run, parse: { waiting: 1, openPendingItems: 0, blockers: [] } }, false, 'change_dining_evidence', TOKEN, 'stale'],
    ['dining evidence after void', { ...clean, lifecycle: 'voided' }, false, 'change_dining_evidence', TOKEN, closed],
    ['stale dining evidence token beats void', { ...clean, lifecycle: 'voided' }, false, 'change_dining_evidence', 't.6', 'stale'],
    // stepToken
    ['the current token', {}, false, 'upload', TOKEN, 'ok'],
    ['an old token is stale', {}, false, 'upload', 't.6', 'stale'],
    ['a stale token beats a closed task', { lifecycle: 'voided' }, false, 'upload', 't.6', 'stale'],
    ['an action without a token skips the check', {}, false, 'upload', null, 'ok'],
    // closed tasks
    ['a voided task', { lifecycle: 'voided' }, false, 'exclude_material', TOKEN, closed],
    ['a handed-off task', { lifecycle: 'handed_off', erp: job('unknown') }, true, 'hand_off', TOKEN, closed],
    ['a job write on a voided task', { lifecycle: 'voided' }, false, 'job', null, closed],
    ['ERP 草稿已交接 closes the task', { ...confirmed, erp: job('drafted') }, true, 'upload', TOKEN, closed],
    ['a saved draft closes the task', { ...confirmed, erp: job('saved') }, true, 'upload', TOKEN, closed],
    // print
    ['print outlives 转人工', { ...confirmed, lifecycle: 'handed_off', erp: job('unknown') }, true, 'print', TOKEN, 'ok'],
    ['print outlives the handed-over draft', { ...confirmed, erp: job('drafted') }, true, 'print', TOKEN, 'ok'],
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
    ['a fill job running refuses another 去报销', { ...confirmed, erp: job('running') }, false, 'start_erp_write', TOKEN, 'stale'],
    // write result unknown and the ADR-0014 freeze
    ['a write result unknown refuses facts changes', { ...confirmed, erp: job('unknown') }, true, 'exclude_material', TOKEN, erpStarted],
    ['a write result unknown refuses even the actions that own the freeze', { ...confirmed, erp: job('unknown') }, true, 'set_home_city', TOKEN, erpStarted],
    ['a write result unknown admits 对账', { ...confirmed, erp: job('unknown') }, true, 'reconcile', TOKEN, 'ok'],
    ['a write result unknown admits 转人工', { ...confirmed, erp: job('unknown') }, true, 'hand_off', TOKEN, 'ok'],
    ['重新去报销 waits for a 对账 verdict that offers it', { ...confirmed, erp: job('unknown') }, true, 'refill', TOKEN, notAllowed],
    ['an attempt freezes the materials', { ...confirmed, erp: job('aborted') }, true, 'upload', null, erpStarted],
    ['an attempt freezes 去报销 again', { ...confirmed, erp: job('aborted') }, true, 'start_erp_write', TOKEN, erpStarted],
    ['an attempt freezes assignment', { ...confirmed, erp: job('aborted') }, true, 'assign_project_lines', TOKEN, erpStarted],
    ['修改常驻城市 gives its own reason on a frozen task', { ...confirmed, erp: job('aborted') }, true, 'set_home_city', TOKEN, { code: 'home_city_locked', message: HOME_CITY_ERRORS.locked }],
    ['追加材料 gives its own reason on a frozen task', { ...confirmed, erp: job('aborted') }, true, 'reopen_upload', TOKEN, { code: 'erp_started', message: REOPEN_UPLOAD_ERRORS.erpStarted }],
    ['no attempt, no freeze', { ...confirmed, erp: job('aborted') }, false, 'upload', null, 'ok'],
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
    expect(taskPolicy(facts(patch), record({ attempted: erpAttempted })).admit(action, token)).toEqual(admission);
  });
});

// A 对账 read of the fill: `bucket` and the classifier's suggested disposition, the 单据编号 read (if any), and
// whether the page had no 费用报销单 open at all.
const judged = (bucket: ReconcileBucket, action: '原地等待' | '转人工', extra: Partial<ReconcileJudgement> = {}): Pick<ErpRecord, 'reconcile'> => ({
  reconcile: {
    jobId: 'r',
    result: null,
    judged: { verdict: { bucket, action, identity: { applicable: false, receiptsCents: null, detailCents: null, equal: false }, reasons: [] }, billNo: null, saved: false, noForm: false, ...extra },
  },
});

// Every task action the policy admits, per ERP phase and 对账 verdict. These are the snapshot's `allowedActions`: the
// buttons the pages show and the page gate, the 重新去报销 path and 任务作废 all read this one answer.
describe('taskPolicy: allowed actions by ERP phase', () => {
  const beforeErp: TaskAction[] = ['upload', 'reopen_upload', 'exclude_material', 'answer_pending', 'set_home_city', 'assign_project_lines', 'submit_project_assignment', 'start_erp_write', 'print', 'void_task'];
  const unknown = { ...confirmed, erp: job('unknown') };
  it.each<[string, Partial<TaskFacts>, Partial<ErpRecord>, TaskAction[]]>([
    ['confirmed, no job yet: 去报销 and every change before it', confirmed, {}, beforeErp],
    ['a fill job running: nothing, not even 作废', { ...confirmed, erp: job('running') }, {}, []],
    ['aborted before any attempt: as before 去报销', { ...confirmed, erp: job('aborted') }, {}, beforeErp],
    ['an attempt without a write result: frozen, print and 作废 remain', { ...confirmed, erp: job('aborted') }, { attempted: true }, ['print', 'void_task']],
    ['a catalog mismatch: reassign, no 去报销 until resubmitted', { ...confirmed, erp: job('catalog_mismatch', { reassign: true }) }, {}, beforeErp.filter((action) => action !== 'start_erp_write')],
    ['write result unknown, not read yet: 开始对账 or 转人工', unknown, { attempted: true }, ['reconcile', 'hand_off', 'print', 'void_task']],
    ['对账 says 原地等待: 重新对账 or 转人工', unknown, { attempted: true, ...judged('未知', '原地等待') }, ['reconcile', 'hand_off', 'print', 'void_task']],
    ['对账 says 转人工: only 转人工', unknown, { attempted: true, ...judged('不自洽', '转人工') }, ['hand_off', 'print', 'void_task']],
    ['imported, not filled, no 单据编号: 重新去报销 or 转人工', unknown, { attempted: true, ...judged('未保存·已导入未写明细', '转人工') }, ['hand_off', 'refill', 'print', 'void_task']],
    ['imported, not filled, a 单据编号 read: only 转人工', unknown, { attempted: true, ...judged('未保存·已导入未写明细', '转人工', { billNo: 'BX-1' }) }, ['hand_off', 'print', 'void_task']],
    ['the fill result carried a 单据编号: no 重新去报销', unknown, { attempted: true, result: { type: 'result', status: 'unknown', code: null, message: null, billNo: 'BX-1', capture: null }, ...judged('未保存·已导入未写明细', '转人工') }, ['hand_off', 'print', 'void_task']],
    ['no 费用报销单 open: 重新去报销, 重新对账 or 转人工', unknown, { attempted: true, ...judged('未知', '原地等待', { noForm: true }) }, ['reconcile', 'hand_off', 'refill', 'print', 'void_task']],
    ['after 暂存, not looked up yet: 开始对账 or 转人工, never 重新去报销', { ...confirmed, erp: job('unknown', { drafting: true }) }, { attempted: true }, ['reconcile', 'hand_off', 'print', 'void_task']],
    ['after 暂存, the lookup got no answer: 重新对账 or 转人工', { ...confirmed, erp: job('unknown', { drafting: true }) }, { attempted: true, ...judged('未知', '原地等待', { draft: { outcome: 'unread', draftId: null, found: 0 } }) }, ['reconcile', 'hand_off', 'print', 'void_task']],
    ['after 暂存, no draft found: only 转人工, not 重新去报销 even with no form', { ...confirmed, erp: job('unknown', { drafting: true }) }, { attempted: true, ...judged('未知', '转人工', { noForm: true, draft: { outcome: 'none', draftId: null, found: 0 } }) }, ['hand_off', 'print', 'void_task']],
    ['a 对账 job running: nothing, not even 作废', { ...confirmed, erp: job('unknown', { reconciling: true }) }, { attempted: true }, []],
    ['ERP 草稿已交接: print and 作废', { ...confirmed, erp: job('drafted', { drafting: true }) }, { attempted: true }, ['print', 'void_task']],
    ['a saved draft: print and 作废', { ...confirmed, erp: job('saved') }, { attempted: true }, ['print', 'void_task']],
    ['转人工: print and 作废', { ...confirmed, lifecycle: 'handed_off', erp: job('unknown') }, { attempted: true }, ['print', 'void_task']],
    ['voided: nothing', { ...confirmed, lifecycle: 'voided' }, {}, []],
    ['an imported legacy task: only 作废', { lifecycle: 'handed_off', origin: 'legacy', legacyOutcome: 'draft_handed_over' }, {}, ['void_task']],
    ['the parser job running: nothing, not even 作废', { ...run, parse: { waiting: 1, openPendingItems: 0, blockers: [] } }, {}, []],
  ])('%s', (_name, patch, erp, allowed) => {
    const policy = taskPolicy(facts(patch), record(erp));
    expect([...policy.allowedActions].sort()).toEqual([...allowed].sort());
    // The set is exactly what admit answers 'ok' to on the current token.
    for (const action of TASK_ACTIONS) expect(policy.admit(action, TOKEN) === 'ok', action).toBe(allowed.includes(action));
  });
});

describe('taskPolicy: ERP actions refused by phase and verdict', () => {
  const unknown = { ...confirmed, erp: job('unknown') };
  it.each<[string, Partial<TaskFacts>, Partial<ErpRecord>, TaskAction, Admission]>([
    ['去报销 before the confirmation', submitted, {}, 'start_erp_write', { code: 'not_ready', message: ERP_ACTION_ERRORS.notReady }],
    ['对账 on a task whose write result is known', { ...confirmed, erp: job('aborted') }, {}, 'reconcile', { code: 'not_reconciling', message: ERP_ACTION_ERRORS.notReconciling }],
    ['转人工 on a task whose write result is known', { ...confirmed, erp: job('aborted') }, {}, 'hand_off', { code: 'not_reconciling', message: ERP_ACTION_ERRORS.notReconciling }],
    ['重新去报销 on a task whose write result is known', confirmed, {}, 'refill', { code: 'not_reconciling', message: ERP_ACTION_ERRORS.notReconciling }],
    ['重新对账 after a 转人工 verdict', unknown, { attempted: true, ...judged('不自洽', '转人工') }, 'reconcile', notAllowed],
    ['重新去报销 once a 单据编号 was read', unknown, { attempted: true, ...judged('未保存·已导入未写明细', '转人工', { billNo: 'BX-1' }) }, 'refill', notAllowed],
    ['重新去报销 on offer', unknown, { attempted: true, ...judged('未保存·已导入未写明细', '转人工') }, 'refill', 'ok'],
    // The account's one ERP lease (ADR-0019): another task's job holds it. 409; a fill start is refused for it before
    // its own precondition, a 对账 only once its verdict allows it (the order the API has always answered in).
    ['去报销 while a job of another task holds the ERP lease', { ...confirmed, erpLease: 'other' }, {}, 'start_erp_write', inUse],
    ['去报销 at the wrong step while the lease is elsewhere: still in use', { ...submitted, erpLease: 'other' }, {}, 'start_erp_write', inUse],
    ['重新去报销 not on offer while the lease is elsewhere: in use', { ...unknown, erpLease: 'other' }, { attempted: true, ...judged('不自洽', '转人工') }, 'refill', inUse],
    ['对账 while a job of another task holds the ERP lease', { ...unknown, erpLease: 'other' }, { attempted: true }, 'reconcile', inUse],
    ['对账 on a known write result while the lease is elsewhere: not reconciling', { ...confirmed, erp: job('aborted'), erpLease: 'other' }, {}, 'reconcile', notReconciling],
    ['重新对账 after a 转人工 verdict while the lease is elsewhere: not allowed', { ...unknown, erpLease: 'other' }, { attempted: true, ...judged('不自洽', '转人工') }, 'reconcile', notAllowed],
    // No ERP configured on this server: the actions that take the lease say not_ready before anything else about ERP.
    ['去报销 without an ERP, the lease elsewhere', { ...confirmed, erpConfigured: false, erpLease: 'other' }, {}, 'start_erp_write', notReady],
    ['重新去报销 without an ERP, not on offer', { ...unknown, erpConfigured: false }, { attempted: true, ...judged('不自洽', '转人工') }, 'refill', notReady],
    ['对账 without an ERP, on a known write result', { ...confirmed, erp: job('aborted'), erpConfigured: false }, {}, 'reconcile', notReady],
    // ADR-0037: the 本地执行器 is the only way to 去报销. With none paired to the account, every action that starts an
    // ERP job is refused with the way out (the 设置页), once the action's own step would admit it.
    ['去报销 with no 本地执行器 paired', { ...confirmed, executorPaired: false }, {}, 'start_erp_write', notPaired],
    ['去报销 with the 本地执行器 paired', { ...confirmed, executorPaired: true }, {}, 'start_erp_write', 'ok'],
    ['去报销 before the confirmation, nothing paired: not ready first', { ...submitted, executorPaired: false }, {}, 'start_erp_write', notReady],
    ['重新去报销 on offer, nothing paired', { ...unknown, executorPaired: false }, { attempted: true, ...judged('未保存·已导入未写明细', '转人工') }, 'refill', notPaired],
    ['对账 with nothing paired', { ...unknown, executorPaired: false }, { attempted: true }, 'reconcile', notPaired],
    ['转人工 needs no 本地执行器', { ...unknown, executorPaired: false }, { attempted: true }, 'hand_off', 'ok'],
    ['转人工 needs no ERP', { ...unknown, erpConfigured: false }, { attempted: true }, 'hand_off', 'ok'],
    ['转人工 takes no lease', { ...unknown, erpLease: 'other' }, { attempted: true }, 'hand_off', 'ok'],
    ['the lease held by a job of this task does not refuse 去报销 here', { ...confirmed, erpLease: 'own' }, {}, 'start_erp_write', 'ok'],
    ['重新去报销 on offer, but the confirmation is gone', { ...unknown, confirmation: 'invalidated' }, { attempted: true, ...judged('未保存·已导入未写明细', '转人工') }, 'refill', { code: 'not_ready', message: ERP_ACTION_ERRORS.notReady }],
  ])('%s', (_name, patch, erp, action, admission) => {
    expect(taskPolicy(facts(patch), record(erp)).admit(action, TOKEN)).toEqual(admission);
  });
});

// A refusal of the request's own input (修改常驻城市's invalid city) ranks after the gate and before the action's own
// precondition, where the task service has always checked it.
describe('taskPolicy: request input refusals', () => {
  const invalidCity = { code: 'invalid_home_city', message: HOME_CITY_ERRORS.invalid };
  const frozen = { ...confirmed, erp: job('aborted') };
  it.each<[string, Partial<TaskFacts>, boolean, string | null, Admission]>([
    ['an invalid city on an open task', confirmed, false, TOKEN, invalidCity],
    ['an invalid city on a frozen task: invalid before locked', frozen, true, TOKEN, invalidCity],
    ['a stale token still beats it', frozen, true, 't.6', 'stale'],
    ['a closed task still beats it', { ...confirmed, lifecycle: 'voided' }, false, TOKEN, closed],
    ['a write result unknown still beats it', { ...confirmed, erp: job('unknown') }, true, TOKEN, erpStarted],
  ])('%s', (_name, patch, attempted, token, admission) => {
    expect(taskPolicy(facts(patch), record({ attempted })).admit('set_home_city', token, invalidCity)).toEqual(admission);
  });

  it('no request refusal leaves the precondition to answer', () => {
    expect(taskPolicy(facts({ ...confirmed, erp: job('aborted') }), record({ attempted: true })).admit('set_home_city', TOKEN, null)).toEqual({ code: 'home_city_locked', message: HOME_CITY_ERRORS.locked });
  });
});

// Voiding the task (任务作废, ADR-0030): any lifecycle and any ERP phase; only a job of this very task in flight holds it back.
describe('taskPolicy: void', () => {
  it.each<[string, Partial<TaskFacts>, Partial<ErpRecord>, Admission]>([
    ['a new task', {}, {}, 'ok'],
    ['write result unknown', { ...confirmed, erp: job('unknown') }, { attempted: true }, 'ok'],
    ['对账 said 不自洽', { ...confirmed, erp: job('unknown') }, { attempted: true, ...judged('不自洽', '转人工') }, 'ok'],
    ['handed off', { ...confirmed, lifecycle: 'handed_off', erp: job('unknown') }, { attempted: true }, 'ok'],
    ['ERP 草稿已交接', { ...confirmed, erp: job('drafted') }, { attempted: true }, 'ok'],
    ['an imported legacy task', { lifecycle: 'handed_off', origin: 'legacy', legacyOutcome: 'handed_off' }, {}, 'ok'],
    ['the parser job running', { ...run, parse: { waiting: 1, openPendingItems: 0, blockers: [] } }, {}, 'stale'],
    ['a fill job running', { ...confirmed, erp: job('running') }, {}, 'stale'],
    ['a 对账 job running', { ...confirmed, erp: job('unknown', { reconciling: true }) }, { attempted: true }, 'stale'],
    ['a job of this task holds the ERP lease', { ...confirmed, erpLease: 'own' }, {}, 'stale'],
    ['a job of another task holds the ERP lease', { ...confirmed, erpLease: 'other' }, {}, 'ok'],
    ['voided already', { lifecycle: 'voided' }, {}, closed],
  ])('%s', (_name, patch, erp, admission) => {
    expect(taskPolicy(facts(patch), record(erp)).admit('void_task', null)).toEqual(admission);
  });
});
