import type { ActionOutcome, AppAdapter } from '../contract/adapter';
import { HUMAN_REVIEW_NOTICE, type Reconcile, type TaskSnapshot } from '../contract/snapshot';
import { TASKS_HASH, navigate, taskHash } from '../router';
import { ActionError } from '../shell/ActionError';
import { useAction } from '../shell/useAction';
import { PAGE_COPY } from './page-copy';
import { ReadbackTable } from './ReadbackTable';

// 对账页：写入中止后停在这里。显示中止原因、当前对账状态（对账中断点、建议处置、草稿号）与逐行比对。
// 处置只渲染服务端允许的那些（reconcile.allowedActions）：原地等待 = 重新对账（只读报销系统再判定一次）；转人工 = 终止后续写入。
// 对账结果是转人工（humanReview）时显示固定句，且没有「重新对账」。结论全部来自服务端；页面不重试写入、不改报销系统。

const STATUS_LABEL: Readonly<Record<Reconcile['status'], string>> = {
  none: '无',
  pending: '等待你处置',
  waiting: '原地等待',
  handed_off: '已转人工',
};

export function ReconcilePage({ snapshot }: { snapshot: TaskSnapshot }) {
  const taskId = snapshot.task.taskId;
  const copy = PAGE_COPY.reconcile;
  const { erp, reconcile, step } = snapshot;
  const handedOff = reconcile.status === 'handed_off';
  const canAct = step.kind === 'reconcile';
  const allowWait = reconcile.allowedActions.includes('wait');
  const allowHandOff = reconcile.allowedActions.includes('hand_off');
  const { busy, error, run } = useAction(taskId);

  const act = async (action: (adapter: AppAdapter) => Promise<ActionOutcome>) => {
    const outcome = await run(action);
    if (outcome.ok && outcome.snapshot.stage === 'done') navigate(taskHash(taskId, 'done'));
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{copy.title}</h1>
          <p className="lead">{copy.lead}</p>
        </div>
        <div className="actions">
          <a className="btn btn-tertiary" href={TASKS_HASH}>
            返回任务列表
          </a>
        </div>
      </div>

      {erp.abortReason ? (
        <section className="panel" aria-label="中止原因">
          <h2>中止原因</h2>
          <p className="abort-reason">{erp.abortReason}</p>
        </section>
      ) : null}

      <section className="panel" aria-label="当前对账状态">
        <h2>当前对账状态</h2>
        {reconcile.humanReview ? (
          <div className="notice notice-warn" role="status" data-testid="human-review">
            {HUMAN_REVIEW_NOTICE}
          </div>
        ) : null}
        {reconcile.banner ? (
          <div className={handedOff ? 'notice notice-info' : 'notice notice-warn'} role="status">
            {reconcile.banner}
          </div>
        ) : null}
        <dl className="kv compact">
          <div className="kv-row">
            <dt>处置状态</dt>
            <dd data-testid="reconcile-status">{STATUS_LABEL[reconcile.status]}</dd>
          </div>
          <div className="kv-row">
            <dt>对账中断点</dt>
            <dd data-testid="reconcile-bucket">{reconcile.bucket ?? '尚未判定'}</dd>
          </div>
          <div className="kv-row">
            <dt>建议处置</dt>
            <dd>{reconcile.action ?? '尚未判定'}</dd>
          </div>
          <div className="kv-row">
            <dt>草稿号</dt>
            <dd className="mono">{reconcile.draftNo ?? '尚未读到草稿'}</dd>
          </div>
        </dl>
        {reconcile.reasons.length > 0 ? (
          <ul className="reconcile-reasons">
            {reconcile.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : null}
      </section>

      {reconcile.rows.length > 0 ? (
        <section className="panel table">
          <ReadbackTable label="逐行比对" rows={reconcile.rows} localTotal={snapshot.readback.localTotal} erpTotal={snapshot.readback.erpTotal} />
        </section>
      ) : (
        <p className="caption">还没有读到可以逐行比对的报销系统明细。</p>
      )}

      {handedOff || (!allowWait && !allowHandOff) ? null : (
        <section className="panel" aria-label="处置">
          <h2>处置</h2>
          <p className="lead">只给出当前对账结果允许的处置。应用不会自动改写报销系统里的行，也不会重试写入。</p>
          <div className="two-actions">
            {allowWait ? (
              <div className="action-card">
                <h3>原地等待</h3>
                <p>你在报销系统中查看后，点重新对账。应用只读报销系统，不写入。</p>
                <button className="btn btn-primary" type="button" disabled={busy || !canAct} onClick={() => void act((adapter) => adapter.reconcile(taskId, step.stepToken))}>
                  重新对账
                </button>
              </div>
            ) : null}
            {allowHandOff ? (
              <div className="action-card">
                <h3>转人工</h3>
                <p>任务标记为人工处理，保留对账记录，之后不再自动写入报销系统。</p>
                <button className="btn btn-primary" type="button" disabled={busy || !canAct} onClick={() => void act((adapter) => adapter.handOff(taskId, step.stepToken))}>
                  转人工
                </button>
              </div>
            ) : null}
          </div>
          <ActionError message={error} />
        </section>
      )}
    </>
  );
}
