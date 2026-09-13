import { useState } from 'react';
import { RECONCILE_STATUS_LABEL, pageAllowed, stageRank, stageReached, type TaskPage, type TaskStage } from '../contract/stage';
import type { TaskSnapshot } from '../contract/snapshot';
import { formatPeriod } from '../format';
import { taskHash } from '../router';
import { Icon } from './Icon';

// 步骤条（DESIGN.md「步骤条」）：任务页工作面顶部一行，左边任务名与费用期间，右边 7 步横排的进度指示（Carbon progress indicator）。
// 顺序照 Skill：项目归属在整单明细确认之前；print / erp 两个页面归到「去打印 / 去报销」。
// 已完成是强调色圆里一个勾，当前是强调色实心圆里的序号，未到是细线圆里的序号；步骤之间一条连线，走过的连线是强调色。
type Entry = { stage: TaskStage; label: string; page: TaskPage };

export const STEP_ENTRIES: readonly Entry[] = [
  { stage: 'upload', label: '上传材料', page: 'upload' },
  { stage: 'inventory', label: '材料盘点', page: 'inventory' },
  { stage: 'pending', label: '待确认项', page: 'pending' },
  { stage: 'project', label: '项目归属', page: 'project' },
  { stage: 'review', label: '整单明细确认', page: 'review' },
  { stage: 'actions', label: '去打印 / 去报销', page: 'review' },
  { stage: 'done', label: '完成', page: 'done' },
];

const ACTIVE_ENTRY: Readonly<Record<TaskPage, TaskStage>> = {
  upload: 'upload',
  inventory: 'inventory',
  pending: 'pending',
  project: 'project',
  review: 'review',
  print: 'actions',
  erp: 'actions',
  done: 'done',
  reconcile: 'done',
};

export const STEP_BAR_COPY = {
  lockedHint: '阶段不可跳过，请按顺序完成。',
  reconcileWaiting: '写入结果待对账。',
  reconcileHandedOff: '已转人工处理，应用不再写入报销系统。',
  periodTitle: '费用期间',
} as const;

function TaskTitle({ snapshot }: { snapshot: TaskSnapshot }) {
  const { name, period } = snapshot.task;
  return (
    <div className="stepbar-task">
      <div className="task-name" title={name}>
        {name}
      </div>
      {/* 费用期间由服务端给出（盘点前为 null，此时不显示这一行）。 */}
      {period ? (
        <p className="task-period" title={STEP_BAR_COPY.periodTitle}>
          {formatPeriod(period)}
        </p>
      ) : null}
    </div>
  );
}

export function StepBar({ snapshot, page }: { snapshot: TaskSnapshot; page: TaskPage }) {
  const [lockedHint, setLockedHint] = useState(false);
  const { stage } = snapshot;

  if (stage === 'reconcile') {
    // 已转人工是对账的终态：应用不再写入报销系统，标签与说明随服务端的对账状态变化。
    const handedOff = snapshot.reconcile.status === 'handed_off';
    return (
      <div className="stepbar bleed">
        <div className="stepbar-row">
          <TaskTitle snapshot={snapshot} />
          <p className="stepbar-status">
            <span className="tag tag-warning">
              <Icon name="warning--alt--filled" />
              {handedOff ? '已转人工' : RECONCILE_STATUS_LABEL}
            </span>
            <span className="caption">{handedOff ? STEP_BAR_COPY.reconcileHandedOff : STEP_BAR_COPY.reconcileWaiting}</span>
          </p>
        </div>
      </div>
    );
  }

  // 守卫页（阶段不可跳过）不算「当前」：被拦下的那一步不能显示成正在进行。
  const activeStage = pageAllowed(stage, page) ? ACTIVE_ENTRY[page] : null;
  const openCount = snapshot.inventory.summary?.openPendingItemCount ?? 0;
  return (
    <div className="stepbar bleed">
      <div className="stepbar-row">
        <TaskTitle snapshot={snapshot} />
        <ol className="stepbar-steps" aria-label="流程阶段">
          {STEP_ENTRIES.map((entry, index) => {
            // 能否进入跟随页面守卫（待确认项页在盘点完成后就能进；整单确认页在项目归属提交后就能进）；
            // 「去打印 / 去报销」按阶段先后（确认之后）。
            const reached = entry.stage === 'actions' ? stageReached(stage, 'actions') : pageAllowed(stage, entry.page);
            const active = entry.stage === activeStage;
            const done = !active && (stageRank(stage) > stageRank(entry.stage) || stage === 'done');
            const state = active ? 'current' : done ? 'done' : reached ? 'reached' : 'locked';
            const count = entry.stage === 'pending' && stageReached(stage, 'inventory') ? openCount : 0;
            const inner = (
              <>
                {/* 序号由 CSS 从 data-n 画出，不进可访问名称与文本；已完成换成勾。 */}
                <span className="stepbar-marker" aria-hidden="true" data-n={done ? undefined : index + 1}>
                  {done ? <Icon name="checkmark" /> : null}
                </span>
                <span className="stepbar-label">{entry.label}</span>
                {count > 0 ? <span className="count">{count}</span> : null}
              </>
            );
            return (
              <li key={entry.stage} className={`is-${state}`}>
                {reached ? (
                  <a className={`stepbar-step ${state}`} href={taskHash(snapshot.task.taskId, entry.page)} aria-current={active ? 'step' : undefined}>
                    {inner}
                  </a>
                ) : (
                  <button className={`stepbar-step ${state}`} type="button" aria-disabled="true" onClick={() => setLockedHint(true)}>
                    {inner}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </div>
      {lockedHint ? (
        <p className="caption stepbar-hint" role="status">
          {STEP_BAR_COPY.lockedHint}
        </p>
      ) : null}
    </div>
  );
}
