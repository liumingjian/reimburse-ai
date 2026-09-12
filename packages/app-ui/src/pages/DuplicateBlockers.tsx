import { BLOCKER_TABLE_COLUMNS, DUPLICATE_BLOCKER_COPY, type TaskSnapshot } from '../contract/snapshot';

// 跨任务重复发票（内核 duplicate_blocked）：命中就停整批。表格列照内核 itemTable，行文字与命中的任务由服务端给出；
// 序号按行序写，「参考材料」列内核写破折号，这里留空。盘点页与待确认项页共用。

export function DuplicateBlockers({ snapshot }: { snapshot: TaskSnapshot }) {
  const hits = snapshot.blockers.filter((blocker) => blocker.kind === 'duplicate_across_tasks');
  if (hits.length === 0) return null;
  // 同一个任务可能占着多张发票，只列一次。
  const tasks = [...new Map(hits.flatMap((hit) => hit.tasks).map((task) => [task.taskId, task])).values()];
  return (
    <section className="panel" aria-label="跨任务重复发票">
      <div className="notice notice-err" role="alert">
        {DUPLICATE_BLOCKER_COPY.blocked}
        {DUPLICATE_BLOCKER_COPY.disposal}
      </div>
      <table className="data" aria-label="重复发票">
        <thead>
          <tr>
            {BLOCKER_TABLE_COLUMNS.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {hits.map((hit, index) => (
            <tr key={hit.materialId}>
              <td className="mono">{index + 1}</td>
              <td className="mono">{hit.fileName}</td>
              <td />
              <td>{hit.reason}</td>
              <td>{hit.resolver}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>命中的任务</h2>
      <ul aria-label="命中的任务">
        {tasks.map((task) => (
          <li key={task.taskId}>{task.name}</li>
        ))}
      </ul>
      <p className="caption">{DUPLICATE_BLOCKER_COPY.scope}</p>
    </section>
  );
}
