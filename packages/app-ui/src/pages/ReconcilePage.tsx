import { useState } from 'react';
import { useAppStore } from '../adapter/context';
import { ActionError, failureMessage } from '../shell/ActionError';
import type { ActionOutcome, AppAdapter } from '../contract/adapter';
import type { Reconcile, TaskSnapshot } from '../contract/snapshot';
import { TASKS_HASH, navigate, taskHash } from '../router';
import { PAGE_COPY } from './page-copy';
import { ReadbackTable } from './ReadbackTable';

// ERP 对账页：写入中止或严格回读不一致后停在这里。显示中止原因、当前对账状态（对账中断点、建议处置、草稿号）与逐行比对，
// 处置只有两种：重新对账（只读 ERP 再判定一次）或转人工。结论全部来自服务端；页面不重试写入、不改 ERP。

const STATUS_LABEL: Readonly<Record<Reconcile['status'], string>> = {
  none: '无',
  pending: '等待你选择处置',
  waiting: '原地等待',
  handed_off: '已转人工',
};

export function ReconcilePage({ snapshot }: { snapshot: TaskSnapshot }) {
  const store = useAppStore();
  const taskId = snapshot.task.taskId;
  const copy = PAGE_COPY.reconcile;
  const { erp, reconcile, step } = snapshot;
  const handedOff = reconcile.status === 'handed_off';
  const canAct = step.kind === 'reconcile';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: (adapter: AppAdapter) => Promise<ActionOutcome>) => {
    setBusy(true);
    setError(null);
    const outcome = await store.act(taskId, action);
    setBusy(false);
    if (outcome.ok && outcome.snapshot.stage === 'done') navigate(taskHash(taskId, 'done'));
    else setError(failureMessage(outcome));
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
            <dd>{reconcile.bucket ?? '尚未判定'}</dd>
          </div>
          <div className="kv-row">
            <dt>建议处置</dt>
            <dd>{reconcile.action ?? '尚未判定'}</dd>
          </div>
          <div className="kv-row">
            <dt>ERP 草稿</dt>
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
        <p className="caption">还没有读到可以逐行比对的 ERP 明细。</p>
      )}

      {handedOff ? null : (
        <section className="panel" aria-label="处置">
          <h2>处置</h2>
          <p className="lead">只有两种：原地等待，或转人工。应用不会自动改写 ERP 里的行，也不会重试写入。</p>
          <div className="two-actions">
            <div className="action-card">
              <h3>原地等待</h3>
              <p>你在 ERP 中查看或修正后，点重新对账。应用只读 ERP，不写入。</p>
              <button
                className={reconcile.action === '原地等待' ? 'btn btn-primary' : 'btn btn-secondary'}
                type="button"
                disabled={busy || !canAct}
                onClick={() => void run((adapter) => adapter.reconcile(taskId, step.stepToken))}
              >
                重新对账
              </button>
            </div>
            <div className="action-card">
              <h3>转人工</h3>
              <p>任务标记为人工处理，保留对账记录，之后不再自动写入 ERP。</p>
              <button
                className={reconcile.action === '转人工' ? 'btn btn-primary' : 'btn btn-secondary'}
                type="button"
                disabled={busy || !canAct}
                onClick={() => void run((adapter) => adapter.handOff(taskId, step.stepToken))}
              >
                转人工
              </button>
            </div>
          </div>
          <ActionError message={error} />
        </section>
      )}
    </>
  );
}
