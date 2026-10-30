// The 去报销 (fill ERP) state of a task, derived from stored facts (ADR-0014): the latest `erp_job`, its persisted
// executor events, and the task's `erp_attempt` rows. Nothing about the phase is stored. The snapshot's
// `erp`, `readback`, `reconcile` and `catalog` sections are worded from this record in `task-snapshot/erp.ts`.

import { sql } from 'kysely';
import type { Db } from '../db/database';
import type { ErpHandOffTable, ErpJobTable } from '../db/schema';
import type { ErpFacts, ErpPhase } from '../task-policy';
import type { FrozenJob } from './fill-plan';
import { type ApprovedPreview, type ErpAccount, type ExecutorEvent, type Preconditions, type ReadbackEvent, type ResultEvent } from '@baox/erp-executor/protocol';
import type { DraftLookup } from '@baox/erp-executor/draft';
import { noFormOpen, type ReconcileVerdict } from './reconcile';
import { storedEvents } from './jobs';
import { withProjectNames } from './project-names';
import { reconcileFromEvents } from './reconcile-job';

// One judged reconcile read-back: the verdict (after the form-instance / target check), the bill number it read, and
// the terminal it can prove. `saved`: the draft saved exactly as approved (已保存, identity holds, strict per-line
// match passed). A form filled and ready to save is no terminal (ADR-0037): nothing is handed over unsaved.
// `noForm`: 对账 found no 费用报销单 open on the page at all — the employee closed the tab, or the ERP browser was
// cleaned. It is a normal state, not evidence about this task, and it is told apart from every other 未知 because
// nothing else can be read once the form is gone.
export type ReconcileJudgement = { verdict: ReconcileVerdict; billNo: string | null; saved: boolean; noForm: boolean; draft?: DraftJudgement };

// A 对账 after 暂存 (line 2 item 5) judges the draft found by the 暂存 job's ownership marker, not a page. `drafted`:
// exactly one draft carries any of the task's marks, it is the 暂存 job's, still 暂存 with no 单据编号, and its View
// agrees with the read-back the fill verified: ERP 草稿已交接. `unread`: a query or the View did not answer, which
// says nothing either way: 对账 may run again. Every other outcome is 转人工: `none` (no draft: whether 暂存 landed
// cannot be told, and a fresh 去报销 could make a second bill), `several`, `saved` (it has a 单据编号 or left 暂存:
// someone took it on), `mismatch`, `unproved` (no verified read-back to compare with). `several`: any draft but the
// 暂存 job's own one, under its mark or an earlier job's.
export type DraftOutcome = 'drafted' | 'unread' | 'none' | 'several' | 'saved' | 'mismatch' | 'unproved';
export type DraftJudgement = { outcome: DraftOutcome; draftId: string | null; found: number };

// The latest reconcile run on the fill job: running until its result, and the newest judgement of any run.
export type ReconcileState = { jobId: string; result: ResultEvent | null; judged: ReconcileJudgement | null };

export type ErpRecord = {
  // null when the task never started 去报销.
  facts: ErpFacts | null;
  // Any ERP action attempt of the task (from any job): the freeze point of ADR-0014.
  attempted: boolean;
  job: ErpJobTable | null;
  frozen: FrozenJob | null;
  events: ExecutorEvent[];
  result: ResultEvent | null;
  // When the latest job wrote nothing but an earlier one of the task did: that earlier job's result, whose reason is
  // why the write result is unknown (the latest job's own reason only says why it wrote nothing).
  writerResult: ResultEvent | null;
  // The ERP account and 账套 of the task's latest attempt: recorded, shown, never compared (ADR-0016).
  erpAccount: ErpAccount | null;
  // The preview the judge approved after import, if the job got that far.
  preview: ApprovedPreview | null;
  // What the latest attempt of the fill job observed right before its mutation (form-instance UUID, CDP target).
  attempt: Preconditions | null;
  // The ownership marker the latest fill job's last attempt 暂存'd under (ADR-0029); null when it pressed no 暂存.
  draftMark: string | null;
  // 对账 (#192) on the latest fill job, and the task's 转人工.
  reconcile: ReconcileState | null;
  handOff: ErpHandOffTable | null;
};

export const NO_ERP: ErpRecord = { facts: null, attempted: false, job: null, frozen: null, events: [], result: null, writerResult: null, erpAccount: null, preview: null, attempt: null, draftMark: null, reconcile: null, handOff: null };

const eventsOf = async (tx: Db, jobId: string): Promise<ExecutorEvent[]> =>
  storedEvents(await tx.selectFrom('erp_job_event').select('payload').where('job_id', '=', jobId).orderBy('seq').execute());
const lastResult = (events: readonly ExecutorEvent[]): ResultEvent | null => [...events].reverse().find((event): event is ResultEvent => event.type === 'result') ?? null;

/**
 * Judge a reconcile job's read-back against the fill it reconciles. The job reads whatever single form is open, so a
 * form under another form-instance UUID or in another CDP target than the fill's last attempt proves nothing about
 * this task: 未知 (wait), with the reason. Null when the job produced no read-back.
 */
export function judgeReconcile(events: ExecutorEvent[], preview: ApprovedPreview | null, attempt: Preconditions | null): ReconcileJudgement | null {
  const derived = reconcileFromEvents(events, preview);
  if (!derived) return null;
  const readback = [...events].reverse().find((event): event is ReadbackEvent => event.type === 'readback' && event.stage === 'reconcile')!;
  const read = { ...readback.readings, ...readback.form };
  const elsewhere: string[] = [];
  if (attempt) {
    if (read.formInstanceId && read.formInstanceId !== attempt.formInstanceId) elsewhere.push(`报销系统里打开的表单实例（${read.formInstanceId}）不是这次写入的那一张（${attempt.formInstanceId}），读到的内容不能说明这次写入的结果`);
    if (read.targetId && attempt.targetId && read.targetId !== attempt.targetId) elsewhere.push('报销系统所在的浏览器标签页不是这次写入时的那一个，读到的内容不能说明这次写入的结果');
  }
  const verdict: ReconcileVerdict = elsewhere.length ? { ...derived.verdict, bucket: '未知', action: '原地等待', reasons: [...elsewhere, ...derived.verdict.reasons] } : derived.verdict;
  // The terminal rests on the strict per-line match (`taskMatch`). The classifier is untouched: it says what the ERP
  // shows, this layer says what that means for the task (ADR-0027).
  const strictMatch = elsewhere.length === 0 && preview !== null && verdict.action === '原地等待' && derived.readings.taskMatch?.ok === true;
  const saved = strictMatch && verdict.bucket === '已保存';
  return { verdict, billNo: read.billNo.readable ? read.billNo.value : null, saved, noForm: noFormOpen(derived.readings) };
}

const NOT_SUMMED = { applicable: false, receiptsCents: null, detailCents: null, equal: false };

/** Judge a 对账 by ownership marker (`draft_lookup`) of the 暂存 job whose marker is `mark`. Null when the run sent none. */
export function judgeDraftLookup(events: ExecutorEvent[], mark: string): ReconcileJudgement | null {
  const lookup = [...events].reverse().find((event): event is DraftLookup => event.type === 'draft_lookup');
  if (!lookup) return null;
  const judged = (outcome: DraftOutcome, bucket: ReconcileVerdict['bucket'], reasons: string[], draft: DraftLookup['drafts'][number] | null = null): ReconcileJudgement => ({
    verdict: { bucket, action: outcome === 'unread' || outcome === 'drafted' ? '原地等待' : '转人工', identity: NOT_SUMMED, reasons },
    billNo: draft?.billNo ?? null, saved: false, noForm: false,
    draft: { outcome, draftId: draft?.id ?? null, found: lookup.drafts.length },
  });
  if (lookup.failure) return judged('unread', '未知', [lookup.failure]);
  const [only] = lookup.drafts;
  if (!only) return judged('none', '未知', ['按这次的归属标记，报销系统里没有找到暂存单。']);
  if (lookup.drafts.length > 1 || only.mark !== mark) {
    const own = lookup.drafts.filter((d) => d.mark === mark).length;
    return judged('several', '不自洽', [`这次暂存的标记下找到 ${own} 张暂存单，此前任务的标记下找到 ${lookup.drafts.length - own} 张（内码 ${lookup.drafts.map((d) => d.id).join('、')}），应当只有这次暂存的一张。`]);
  }
  if (only.billNo || only.status !== 'Z') return judged('saved', '已保存', [only.billNo ? `这张暂存单已经有了单据编号 ${only.billNo}。` : `这张单据的状态是 ${only.status}，已经不是暂存。`], only);
  if (lookup.problems === null) return judged('unproved', '未知', ['没有暂存前核对过的回读可比，证明不了这张暂存单和确认的明细一致。'], only);
  if (lookup.problems.length) return judged('mismatch', '不自洽', lookup.problems, only);
  return judged('drafted', '未保存·就绪待保存', [], only);
}

/** The job's phase from its result (none yet = running). */
export function phaseOf(result: ResultEvent | null): ErpPhase {
  if (!result) return 'running';
  switch (result.status) {
    case 'catalog_mismatch':
      return 'catalog_mismatch';
    case 'drafted':
      return 'drafted';
    case 'saved':
      return 'saved';
    case 'unknown':
      return 'unknown';
    default:
      // `aborted`, and `read` which a fill job never sends: nothing was written.
      return 'aborted';
  }
}

/** The ownership marker of a 暂存 attempt (ADR-0029), or null: a 保存 attempt from before ADR-0028 carries none. */
export function attemptDraftMark(attempt: { action: string; expected_postconditions: string } | undefined): string | null {
  if (attempt?.action !== 'save') return null;
  const mark = (JSON.parse(attempt.expected_postconditions) as { draftMark?: unknown }).draftMark;
  return typeof mark === 'string' ? mark : null;
}

export async function loadErp(tx: Db, taskId: string): Promise<ErpRecord> {
  const attempt = await tx.selectFrom('erp_attempt').select(['erp_account', 'erp_tenant', 'erp_display_name']).where('task_id', '=', taskId).orderBy('started_at', 'desc').executeTakeFirst();
  const erpAccount = attempt ? { displayName: attempt.erp_display_name, account: attempt.erp_account, tenant: attempt.erp_tenant } : null;
  const handOff = (await tx.selectFrom('erp_hand_off').selectAll().where('task_id', '=', taskId).orderBy('revision', 'desc').executeTakeFirst()) ?? null;
  const job = await tx.selectFrom('erp_job').selectAll().where('task_id', '=', taskId).orderBy('revision', 'desc').executeTakeFirst();
  if (!job) return { ...NO_ERP, attempted: attempt !== undefined, erpAccount, handOff };
  const events = await eventsOf(tx, job.job_id);
  let result = lastResult(events);
  let phase = phaseOf(result);
  // A later job that wrote nothing does not settle what an earlier one left behind: once any attempt of this task is
  // durable, the task's ERP write result stays unknown until 对账 says otherwise (ADR-0016). Without this, a
  // 重新去报销 that stops before its first attempt (no Chromium, say) would report 「报销系统没有被改动，可以再去
  // 报销」 while every exit is refused — 去报销 and 作废 by the ADR-0014 freeze, 重新去报销 and 对账 and 转人工 by
  // the phase — leaving the task with no way out at all.
  let writerResult: ResultEvent | null = null;
  if (phase === 'aborted' && attempt !== undefined) {
    phase = 'unknown';
    const writer = await tx.selectFrom('erp_attempt').select('job_id').where('task_id', '=', taskId).orderBy('started_at', 'desc').orderBy(sql`rowid`, 'desc').executeTakeFirst();
    if (writer && writer.job_id !== job.job_id) writerResult = lastResult(await eventsOf(tx, writer.job_id));
  }
  const approved = await tx.selectFrom('erp_approved_preview').select('preview').where('job_id', '=', job.job_id).executeTakeFirst();
  const preview = approved ? (JSON.parse(approved.preview) as ApprovedPreview) : null;
  const lastAttempt = await tx.selectFrom('erp_attempt').select(['preconditions', 'action', 'expected_postconditions']).where('job_id', '=', job.job_id).orderBy(sql`rowid`, 'desc').executeTakeFirst();
  const attemptPre = lastAttempt ? (JSON.parse(lastAttempt.preconditions) as Preconditions) : null;
  // The newest reconcile run decides running / its notice; the newest run that read the form decides the bucket.
  let reconcile: ReconcileState | null = null;
  const mark = attemptDraftMark(lastAttempt);
  for (const run of await tx.selectFrom('erp_reconcile_job').select('job_id').where('fill_job_id', '=', job.job_id).orderBy('revision', 'desc').execute()) {
    const runEvents = await eventsOf(tx, run.job_id);
    reconcile ??= { jobId: run.job_id, result: lastResult(runEvents), judged: null };
    // After 暂存 only a lookup by the marker counts: a page read says nothing about a draft (item 5).
    const judged = mark !== null ? judgeDraftLookup(runEvents, mark) : judgeReconcile(runEvents, preview, attemptPre);
    if (judged) {
      reconcile.judged = judged;
      break;
    }
  }
  // A reconcile that proves the draft saved exactly as approved (the same strict test a fill's `saved` passed) is
  // done, not a hand-off.
  if (phase === 'unknown' && reconcile?.judged?.saved) {
    phase = 'saved';
    result = { type: 'result', status: 'saved', code: 'reconciled', message: null, billNo: reconcile.judged.billNo, capture: null };
  }
  // 对账 found the 暂存 job's draft by its marker, alone, and equal to what the fill verified: ERP 草稿已交接, as a run
  // that read its own draft back ends.
  if (phase === 'unknown' && reconcile?.judged?.draft?.outcome === 'drafted') {
    phase = 'drafted';
    result = { type: 'result', status: 'drafted', code: 'reconciled', message: null, billNo: null, capture: null, draftId: reconcile.judged.draft.draftId };
  }
  // A catalog mismatch sends the task back to project assignment until a new submission answers it.
  let reassign = false;
  if (phase === 'catalog_mismatch') {
    const submission = await tx.selectFrom('project_submission').select('revision').where('task_id', '=', taskId).orderBy('revision', 'desc').executeTakeFirst();
    reassign = !submission || submission.revision < job.revision;
  }
  const reconciling = phase === 'unknown' && reconcile !== null && reconcile.result === null;
  return {
    facts: { jobId: job.job_id, trigger: job.trigger, revision: job.revision, phase, reassign, reconciling, drafting: mark !== null },
    attempted: attempt !== undefined,
    job,
    frozen: events.reduce((frozen, event) => event.type === 'catalog_confirmed' ? withProjectNames(frozen, event.projects) : frozen, JSON.parse(job.plan) as FrozenJob),
    events,
    result,
    writerResult,
    erpAccount,
    preview,
    attempt: attemptPre,
    draftMark: mark,
    reconcile,
    handOff,
  };
}
