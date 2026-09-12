import type { TaskSnapshot } from '../contract/snapshot';
import { TASKS_HASH, taskHash } from '../router';
import { PAGE_COPY } from './page-copy';
import { ReadbackTable } from './ReadbackTable';

// 完成页：ERP 草稿号与逐条回读表。只有服务端判定回读全部一致（readback.status = matched）才显示完成态。
export function DonePage({ snapshot }: { snapshot: TaskSnapshot }) {
  const taskId = snapshot.task.taskId;
  const copy = PAGE_COPY.done;
  const { erp, readback, reconcile } = snapshot;
  const matched = readback.status === 'matched';

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{copy.title}</h1>
          <p className="lead">{copy.lead}</p>
        </div>
        <div className="actions">
          <a className="btn btn-secondary" href={taskHash(taskId, 'print')}>
            打印稿
          </a>
          <a className="btn btn-primary" href={TASKS_HASH}>
            返回任务列表
          </a>
        </div>
      </div>

      <div className="badge-row">
        <span className="caption">ERP 草稿号</span>
        <span className="mono" data-testid="draft-no">
          {erp.draftNo ?? '尚无'}
        </span>
        {readback.summary ? <span className={matched ? 'badge badge-ok' : 'badge badge-err'}>{readback.summary}</span> : null}
      </div>

      {matched ? (
        <div className="notice notice-ok" role="status">
          已完成：草稿 <span className="mono">{erp.draftNo}</span> 已保存，逐行回读与本地确认一致。接下来去 ERP 提交审批。
        </div>
      ) : readback.status === 'mismatched' ? (
        <div className="notice notice-err" role="alert">
          回读与本地确认不一致：{readback.summary}。
        </div>
      ) : null}
      {reconcile.banner ? <div className="notice notice-info">{reconcile.banner}</div> : null}

      {readback.rows.length > 0 ? (
        <section className="panel table">
          <ReadbackTable label="逐条回读" rows={readback.rows} localTotal={readback.localTotal} erpTotal={readback.erpTotal} />
        </section>
      ) : null}
    </>
  );
}
