import { TASK_STAGE_LABELS, pageAllowed, stageRank, stageReached, type TaskPage, type TaskStage } from '../contract/stage';
import type { TaskSnapshot } from '../contract/snapshot';
import { taskHash } from '../router';

// 侧栏阶段列表：六个条目沿用原型；print / project / erp 三个页面都归到「去打印 / 去报销」。
type Entry = { stage: TaskStage; label: string; page: TaskPage };

export const SIDEBAR_ENTRIES: readonly Entry[] = [
  { stage: 'upload', label: '上传材料', page: 'upload' },
  { stage: 'inventory', label: '材料盘点', page: 'inventory' },
  { stage: 'pending', label: '待确认项', page: 'pending' },
  { stage: 'review', label: '整单明细确认', page: 'review' },
  { stage: 'actions', label: '去打印 / 去报销', page: 'review' },
  { stage: 'done', label: '完成', page: 'done' },
];

const ACTIVE_ENTRY: Readonly<Record<TaskPage, TaskStage>> = {
  upload: 'upload',
  inventory: 'inventory',
  pending: 'pending',
  review: 'review',
  print: 'actions',
  project: 'actions',
  erp: 'actions',
  done: 'done',
  reconcile: 'done',
};

export function Sidebar({ snapshot, page }: { snapshot: TaskSnapshot; page: TaskPage }) {
  const { stage } = snapshot;
  if (stage === 'reconcile') {
    // 已转人工是对账的终态：应用不再写入 ERP，徽标与说明随服务端的对账状态变化。
    const handedOff = snapshot.reconcile.status === 'handed_off';
    return (
      <aside className="sidebar">
        <h3>当前报销任务</h3>
        <div className="task-name">{snapshot.task.name}</div>
        <h3>状态</h3>
        <p className="status">
          <span className="badge badge-warn">{handedOff ? '已转人工' : TASK_STAGE_LABELS.reconcile}</span>
        </p>
        <p className="caption status">
          {handedOff ? '已转人工处理，应用不再写入 ERP。' : '写入结果不确定后停在这里。处置只有原地等待或转人工。'}
        </p>
      </aside>
    );
  }
  const activeStage = ACTIVE_ENTRY[page];
  const openCount = snapshot.inventory.summary?.openPendingItemCount ?? 0;
  return (
    <aside className="sidebar">
      <h3>当前报销任务</h3>
      <div className="task-name">{snapshot.task.name}</div>
      <h3>流程阶段</h3>
      <ul className="stage-list" aria-label="流程阶段">
        {SIDEBAR_ENTRIES.map((entry, index) => {
          // 待确认项页在盘点完成后就能进（阶段还停在 inventory 时也一样），其余条目按阶段先后。
          const reached = entry.stage === 'pending' ? pageAllowed(stage, 'pending') : stageReached(stage, entry.stage);
          const active = entry.stage === activeStage;
          const done = !active && (stageRank(stage) > stageRank(entry.stage) || stage === 'done');
          const className = [active ? 'current' : '', reached ? '' : 'locked', done ? 'done' : '', 'stage'].filter(Boolean).join(' ');
          const count = entry.stage === 'pending' && stageReached(stage, 'inventory') ? openCount : 0;
          const inner = (
            <>
              <span className="idx">{done ? '✓' : index + 1}</span>
              {entry.label}
              {count > 0 ? <span className="count">{count}</span> : null}
            </>
          );
          return (
            <li key={entry.stage}>
              {reached ? (
                <a className={className} href={taskHash(snapshot.task.taskId, entry.page)} aria-current={active ? 'step' : undefined}>
                  {inner}
                </a>
              ) : (
                <span className={className}>{inner}</span>
              )}
            </li>
          );
        })}
      </ul>
      <h3 className="rules">规则</h3>
      <p className="caption status">阶段不可跳过。材料变更会使已有盘点与确认失效。</p>
    </aside>
  );
}
