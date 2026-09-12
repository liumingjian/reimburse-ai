import { HUMAN_REVIEW_NOTICE, SAVE_COMPLETED_NOTICE, type TaskSnapshot } from '../contract/snapshot';
import { TASKS_HASH, taskHash } from '../router';
import { ActionError } from '../shell/ActionError';
import { useAction } from '../shell/useAction';
import { PAGE_COPY } from './page-copy';
import { ReadbackTable } from './ReadbackTable';

// 完成页：草稿号与逐条回读表。只有服务端判定回读全部一致（readback.status = matched）才显示完成态与固定句
// 「报销草稿已保存。请打开报销系统检查，是否提交由你决定。」（user-interaction-contract.md:70，逐字不改）。
// 严格回读不一致时任务也停在这里，但不算完成：差异行按服务端逐行判定着色并可展开；对账结果是转人工（human_review）时显示固定句，
// 当前待答 step 是 hand_off 且允许转人工时出现「转人工」，转人工后显示已转人工（终态）。

const MISMATCH_LEAD = '草稿已保存，但严格回读与本地确认不一致。这份草稿不算完成。';

export function DonePage({ snapshot }: { snapshot: TaskSnapshot }) {
  const taskId = snapshot.task.taskId;
  const copy = PAGE_COPY.done;
  const { erp, readback, reconcile, step } = snapshot;
  const matched = readback.status === 'matched';
  const mismatched = readback.status === 'mismatched';
  const handedOff = reconcile.status === 'handed_off';
  const canHandOff = step.kind === 'hand_off' && reconcile.allowedActions.includes('hand_off');
  const { busy, error, run } = useAction(taskId);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{copy.title}</h1>
          <p className="lead">{mismatched ? MISMATCH_LEAD : copy.lead}</p>
        </div>
        <div className="actions">
          <a className="btn btn-secondary" href={taskHash(taskId, 'print')}>
            打印稿
          </a>
          <a className={mismatched ? 'btn btn-secondary' : 'btn btn-primary'} href={TASKS_HASH}>
            返回任务列表
          </a>
        </div>
      </div>

      <div className="badge-row">
        <span className="caption">草稿号</span>
        <span className="mono" data-testid="draft-no">
          {erp.draftNo ?? '尚无'}
        </span>
        {readback.summary ? <span className={matched ? 'badge badge-ok' : 'badge badge-err'}>{readback.summary}</span> : null}
        {handedOff ? <span className="badge badge-warn">已转人工</span> : null}
      </div>

      {matched ? (
        <div className="notice notice-ok" role="status" data-testid="save-completed">
          {SAVE_COMPLETED_NOTICE}
        </div>
      ) : mismatched ? (
        <div className="notice notice-err" role="alert">
          回读与本地确认不一致：{readback.summary}。这份草稿不算完成，不要直接在报销系统里提交审批。
        </div>
      ) : null}
      {reconcile.humanReview ? (
        <div className="notice notice-warn" role="status" data-testid="human-review">
          {HUMAN_REVIEW_NOTICE}
        </div>
      ) : null}
      {reconcile.banner ? (
        <div className={handedOff || matched ? 'notice notice-info' : 'notice notice-warn'} role="status">
          {reconcile.banner}
        </div>
      ) : null}
      {mismatched && reconcile.reasons.length > 0 ? (
        <ul className="reconcile-reasons">
          {reconcile.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}

      {readback.rows.length > 0 ? (
        <section className="panel table">
          <ReadbackTable label="逐条回读" rows={readback.rows} localTotal={readback.localTotal} erpTotal={readback.erpTotal} />
        </section>
      ) : null}

      {canHandOff ? (
        <section className="panel" aria-label="转人工">
          <h2>转人工</h2>
          <p className="lead">应用不会自动改写报销系统里的行，也不会重试写入。转人工后任务标记为人工处理，保留回读记录，之后不再自动写入报销系统。</p>
          <div className="btn-row">
            <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void run((adapter) => adapter.handOff(taskId, step.stepToken))}>
              转人工
            </button>
            <ActionError message={error} />
          </div>
        </section>
      ) : null}
    </>
  );
}
