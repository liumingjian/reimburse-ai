import { useState } from 'react';
import { RECONCILE_STATUS_LABEL, pageAllowed, stageRank, stageReached, type TaskPage, type TaskStage } from '../contract/stage';
import type { TaskSnapshot } from '../contract/snapshot';
import { taskHash } from '../router';

// 侧栏阶段列表，顺序照 Skill：项目归属在整单明细确认之前；print / erp 两个页面归到「去打印 / 去报销」。
type Entry = { stage: TaskStage; label: string; page: TaskPage };

export const SIDEBAR_ENTRIES: readonly Entry[] = [
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

export const SIDEBAR_COPY = {
  collapse: '收起侧栏',
  expand: '展开侧栏',
  lockedHint: '阶段不可跳过，请按顺序完成。',
  reconcileWaiting: '写入结果待对账。',
  reconcileHandedOff: '已转人工处理，应用不再写入报销系统。',
} as const;

// 侧栏收起与否是界面偏好（不是业务状态），存在 localStorage；读不到（测试环境、隐私模式）时退回默认展开。
export const SIDEBAR_COLLAPSED_KEY = 'baox.sidebar.collapsed';

function readCollapsed(): boolean {
  try {
    return window.localStorage?.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean): void {
  try {
    window.localStorage?.setItem(SIDEBAR_COLLAPSED_KEY, value ? '1' : '0');
  } catch {
    // 存不了就只在本次会话里生效。
  }
}

function SidebarHead({ name, collapsed, onToggle }: { name: string; collapsed: boolean; onToggle: () => void }) {
  const label = collapsed ? SIDEBAR_COPY.expand : SIDEBAR_COPY.collapse;
  return (
    <div className="sidebar-head">
      <div className="task-name" title={name}>
        {name}
      </div>
      <button className="sidebar-toggle" type="button" aria-expanded={!collapsed} aria-label={label} title={label} onClick={onToggle}>
        <span aria-hidden="true">{collapsed ? '›' : '‹'}</span>
      </button>
    </div>
  );
}

export function Sidebar({ snapshot, page }: { snapshot: TaskSnapshot; page: TaskPage }) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [lockedHint, setLockedHint] = useState(false);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    writeCollapsed(next);
  };
  const className = collapsed ? 'sidebar is-collapsed' : 'sidebar';
  const { stage } = snapshot;
  const head = <SidebarHead name={snapshot.task.name} collapsed={collapsed} onToggle={toggle} />;

  if (stage === 'reconcile') {
    // 已转人工是对账的终态：应用不再写入报销系统，徽标与说明随服务端的对账状态变化。
    const handedOff = snapshot.reconcile.status === 'handed_off';
    return (
      <aside className={className}>
        {head}
        <p className="sidebar-status">
          <span className="badge badge-warn">{handedOff ? '已转人工' : RECONCILE_STATUS_LABEL}</span>
          <span className="caption">{handedOff ? SIDEBAR_COPY.reconcileHandedOff : SIDEBAR_COPY.reconcileWaiting}</span>
        </p>
      </aside>
    );
  }

  // 守卫页（阶段不可跳过）不算「当前」：被拦下的那一步不能显示成正在进行。
  const activeStage = pageAllowed(stage, page) ? ACTIVE_ENTRY[page] : null;
  const openCount = snapshot.inventory.summary?.openPendingItemCount ?? 0;
  return (
    <aside className={className}>
      {head}
      <ul className="stage-list" aria-label="流程阶段">
        {SIDEBAR_ENTRIES.map((entry, index) => {
          // 条目能否进入跟随页面守卫（待确认项页在盘点完成后就能进；整单确认页在项目归属提交后就能进）；
          // 「去打印 / 去报销」按阶段先后（确认之后）。
          const reached = entry.stage === 'actions' ? stageReached(stage, 'actions') : pageAllowed(stage, entry.page);
          const active = entry.stage === activeStage;
          const done = !active && (stageRank(stage) > stageRank(entry.stage) || stage === 'done');
          const itemClass = ['stage', active ? 'current' : '', reached ? '' : 'locked', done ? 'done' : ''].filter(Boolean).join(' ');
          const count = entry.stage === 'pending' && stageReached(stage, 'inventory') ? openCount : 0;
          // 收起时只剩一个紧凑标记，可访问名称与悬停提示都是阶段名。
          const railName = collapsed ? entry.label : undefined;
          const inner = (
            <>
              {collapsed ? (
                <span className="marker" aria-hidden="true">
                  {index + 1}
                </span>
              ) : null}
              {done ? (
                <span className="check" aria-hidden="true">
                  ✓
                </span>
              ) : null}
              <span className="stage-label">{entry.label}</span>
              {count > 0 ? <span className="count">{count}</span> : null}
            </>
          );
          return (
            <li key={entry.stage}>
              {reached ? (
                <a
                  className={itemClass}
                  href={taskHash(snapshot.task.taskId, entry.page)}
                  aria-current={active ? 'step' : undefined}
                  aria-label={railName}
                  title={railName}
                >
                  {inner}
                </a>
              ) : (
                <button
                  className={itemClass}
                  type="button"
                  aria-disabled="true"
                  aria-label={railName}
                  title={railName}
                  onClick={() => setLockedHint(true)}
                >
                  {inner}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {lockedHint ? (
        <p className="caption sidebar-hint" role="status">
          {SIDEBAR_COPY.lockedHint}
        </p>
      ) : null}
    </aside>
  );
}
