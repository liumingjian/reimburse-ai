import { useState } from 'react';
import { ProgressIndicator, ProgressStep, Tag } from '@carbon/react';
import { WarningAltFilled } from '@carbon/icons-react';
import { RECONCILE_STATUS_LABEL, pageAllowed, stageRank, stageReached, type TaskPage, type TaskStage } from '../contract/stage';
import type { TaskSnapshot } from '../contract/snapshot';
import { formatPeriod } from '../format';
import { navigate, taskHash } from '../router';

// 步骤条：任务页工作区顶部一条，左边任务名与费用期间，右边 7 步横排的 Carbon progress indicator。
// 顺序照 Skill：项目归属在整单明细确认之前；print / erp 两个页面归到「去打印 / 去报销」。
// 已到的步骤可点（进入对应页面）；未到的步骤是 aria-disabled，点了给出一句「阶段不可跳过」。
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
  region: '任务进度',
  lockedHint: '阶段不可跳过，请按顺序完成。',
  reconcileWaiting: '写入结果待对账。',
  reconcileHandedOff: '已转人工处理，应用不再写入报销系统。',
  periodTitle: '费用期间',
  pendingCount: (count: number) => `${count} 项待处理`,
} as const;

// Carbon 每一步里给读屏的状态文字（默认是英文 Complete / Current / Incomplete / Invalid）。
export const STEP_STATUS_TEXT = {
  complete: '已完成',
  current: '当前',
  reached: '未完成',
  locked: '未开放',
  invalid: '无效',
} as const;

function stepStatusText(id: string, reached: boolean): string {
  if (id === 'carbon.progress-step.complete') return STEP_STATUS_TEXT.complete;
  if (id === 'carbon.progress-step.current') return STEP_STATUS_TEXT.current;
  if (id === 'carbon.progress-step.invalid') return STEP_STATUS_TEXT.invalid;
  return reached ? STEP_STATUS_TEXT.reached : STEP_STATUS_TEXT.locked;
}

function TaskTitle({ snapshot }: { snapshot: TaskSnapshot }) {
  const { name, period } = snapshot.task;
  return (
    <div className="app-stepbar-task">
      <div className="app-stepbar-name" title={name}>
        {name}
      </div>
      {/* 费用期间由服务端给出（盘点前为 null，此时不显示这一行）。 */}
      {period ? (
        <p className="app-stepbar-period" title={STEP_BAR_COPY.periodTitle}>
          {formatPeriod(period)}
        </p>
      ) : null}
    </div>
  );
}

export function StepBar({ snapshot, page }: { snapshot: TaskSnapshot; page: TaskPage }) {
  const [lockedHint, setLockedHint] = useState(false);
  const { stage } = snapshot;
  const taskId = snapshot.task.taskId;

  if (stage === 'reconcile') {
    // 已转人工是对账的终态：应用不再写入报销系统，标签与说明随服务端的对账状态变化。
    const handedOff = snapshot.reconcile.status === 'handed_off';
    return (
      <section className="app-stepbar" aria-label={STEP_BAR_COPY.region}>
        <div className="app-stepbar-row">
          <TaskTitle snapshot={snapshot} />
          <p className="app-stepbar-status">
            <Tag type="warm-gray" renderIcon={WarningAltFilled}>
              {handedOff ? '已转人工' : RECONCILE_STATUS_LABEL}
            </Tag>
            <span>{handedOff ? STEP_BAR_COPY.reconcileHandedOff : STEP_BAR_COPY.reconcileWaiting}</span>
          </p>
        </div>
      </section>
    );
  }

  // 守卫页（阶段不可跳过）不算「当前」：被拦下的那一步不能显示成正在进行（currentIndex = -1）。
  const activeStage = pageAllowed(stage, page) ? ACTIVE_ENTRY[page] : null;
  const openCount = snapshot.inventory.summary?.openPendingItemCount ?? 0;
  const steps = STEP_ENTRIES.map((entry) => {
    // 能否进入跟随页面守卫（待确认项页在盘点完成后就能进；整单确认页在项目归属提交后就能进）；
    // 「去打印 / 去报销」按阶段先后（确认之后）。
    const reached = entry.stage === 'actions' ? stageReached(stage, 'actions') : pageAllowed(stage, entry.page);
    const active = entry.stage === activeStage;
    const done = !active && (stageRank(stage) > stageRank(entry.stage) || stage === 'done');
    const count = entry.stage === 'pending' && stageReached(stage, 'inventory') ? openCount : 0;
    return { entry, reached, active, done, count };
  });
  const currentIndex = steps.findIndex((step) => step.active);

  const onChange = (index: number) => {
    const step = steps[index];
    if (!step) return;
    if (step.reached) navigate(taskHash(taskId, step.entry.page));
    else setLockedHint(true);
  };

  return (
    <section className="app-stepbar" aria-label={STEP_BAR_COPY.region}>
      <div className="app-stepbar-row">
        <TaskTitle snapshot={snapshot} />
        <ProgressIndicator className="app-stepbar-steps" currentIndex={currentIndex} spaceEqually onChange={onChange} aria-label="流程阶段">
          {steps.map((step) => (
            <ProgressStep
              key={step.entry.stage}
              label={step.entry.label}
              complete={step.done}
              translateWithId={(id: string) => stepStatusText(id, step.reached)}
              {...(step.count > 0 ? { secondaryLabel: STEP_BAR_COPY.pendingCount(step.count) } : {})}
              {...(step.reached ? {} : { className: 'app-step-locked', 'aria-disabled': true })}
              {...(step.active ? { 'aria-current': 'step' } : {})}
            />
          ))}
        </ProgressIndicator>
      </div>
      {lockedHint ? (
        <p className="app-stepbar-hint" role="status">
          {STEP_BAR_COPY.lockedHint}
        </p>
      ) : null}
    </section>
  );
}
