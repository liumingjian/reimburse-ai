import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import { useAppStore, useTaskList } from '../adapter/context';
import { ABANDON_TASK_COPY } from '../contract/actions';
import { KERNEL_PHASES, RECONCILE_STATUS_LABEL, STAGE_DEFAULT_PAGE, TASK_STAGE_LABELS, TASK_STAGE_PHASES } from '../contract/stage';
import { TASK_ERP_OUTCOME_LABELS, type TaskListItem } from '../contract/task-list';
import { formatDateTime, formatPeriod } from '../format';
import { NEW_TASK_HASH, TASKS_HASH, navigate, taskHash } from '../router';
import { AppShell } from '../shell/AppShell';
import { ConfirmDialog } from '../shell/Dialog';
import { Icon, type IconName } from '../shell/Icon';
import { NewTaskDialog } from './NewTaskDialog';

export const TASK_LIST_COPY = {
  lead: '每次出差一个任务，材料、确认数据与打印设置都存在任务目录里。',
  tableTitle: '全部任务',
  search: '搜索任务名或草稿号',
  filterGroup: '按状态筛选',
  all: '全部',
  active: '进行中',
  handedOver: '已交接',
  noMatch: '没有符合条件的任务。',
} as const;

// 状态列（DESIGN.md「状态色」）：服务端给出的写入结局优先（已转人工 warning / 回读不一致 danger），其次是对账中（warning）、
// 已交接（完成，success），其余都是进行中（info）。全部照服务端字段判读，页面不推断别的。
type StatusKey = 'active' | 'reconcile' | 'handed_off' | 'readback_mismatch' | 'done';
type Tone = 'info' | 'success' | 'warning' | 'danger';
type Status = { key: StatusKey; label: string; tone: Tone; icon: IconName };

function statusOf(task: TaskListItem): Status {
  if (task.erpOutcome === 'handed_off') return { key: 'handed_off', label: TASK_ERP_OUTCOME_LABELS.handed_off, tone: 'warning', icon: 'warning--alt--filled' };
  if (task.erpOutcome === 'readback_mismatch') return { key: 'readback_mismatch', label: TASK_ERP_OUTCOME_LABELS.readback_mismatch, tone: 'danger', icon: 'error--filled' };
  if (task.stage === 'reconcile') return { key: 'reconcile', label: RECONCILE_STATUS_LABEL, tone: 'warning', icon: 'warning--alt--filled' };
  if (task.stage === 'done') return { key: 'done', label: TASK_LIST_COPY.handedOver, tone: 'success', icon: 'checkmark--filled' };
  return { key: 'active', label: TASK_LIST_COPY.active, tone: 'info', icon: 'in-progress' };
}

// 筛选项：进行中、对账中、已交接常驻；已转人工与回读不一致只在列表里有这种任务时出现。
const FILTERS: readonly { key: StatusKey; label: string; always: boolean }[] = [
  { key: 'active', label: TASK_LIST_COPY.active, always: true },
  { key: 'reconcile', label: RECONCILE_STATUS_LABEL, always: true },
  { key: 'handed_off', label: TASK_ERP_OUTCOME_LABELS.handed_off, always: false },
  { key: 'readback_mismatch', label: TASK_ERP_OUTCOME_LABELS.readback_mismatch, always: false },
  { key: 'done', label: TASK_LIST_COPY.handedOver, always: true },
];

function StatusTag({ status }: { status: Status }) {
  return (
    <span className={`tag tag-${status.tone}`}>
      <Icon name={status.icon} />
      {status.label}
    </span>
  );
}

// 进度列：内核 10 阶段的序号画成细条，旁边是「N/10 阶段名」。写入结局不是 none 时状态列已经说明结局，这里只留细条（契约：结局代替阶段名）。
function Progress({ task, status }: { task: TaskListItem; status: Status }) {
  const phase = KERNEL_PHASES.indexOf(TASK_STAGE_PHASES[task.stage]) + 1;
  const tone = status.key === 'active' ? 'info' : status.tone;
  return (
    <div className="progress">
      <span className={`bar tone-${tone}`} role="img" aria-label={`${phase}/10`}>
        <i style={{ width: `${phase * 10}%` }} />
      </span>
      {task.erpOutcome === 'none' ? <span className="step-label">{TASK_STAGE_LABELS[task.stage]}</span> : null}
    </div>
  );
}

function continueLabel(task: TaskListItem): string | null {
  if (task.stage === 'reconcile') return '查看对账';
  if (task.stage === 'done') return task.erpOutcome === 'none' ? null : '查看结果';
  return '继续';
}

// 「作废」：能否作废由服务端判定；不能时是带锁的不可用按钮，服务端给出的原因放在提示里（悬停或聚焦时出现），不在单元格里挤一段话。
function AbandonControl({ task, onAbandon }: { task: TaskListItem; onAbandon: (task: TaskListItem) => void }) {
  const reasonId = `abandon-reason-${task.taskId}`;
  if (task.abandonable) {
    return (
      <span className="abandon">
        <button className="btn btn-tertiary btn-sm" type="button" aria-label={`作废 ${task.name}`} onClick={() => onAbandon(task)}>
          作废
        </button>
      </span>
    );
  }
  return (
    <span className="abandon has-tip">
      <button className="btn btn-tertiary btn-sm" type="button" aria-label={`作废 ${task.name}`} disabled aria-describedby={reasonId}>
        <Icon name="locked" />
        作废
      </button>
      <span className="tip" role="tooltip" id={reasonId}>
        {task.abandonBlockedReason ?? ABANDON_TASK_COPY.blockedReason}
      </span>
    </span>
  );
}

function TaskRow({ task, onAbandon }: { task: TaskListItem; onAbandon: (task: TaskListItem) => void }) {
  const href = taskHash(task.taskId, STAGE_DEFAULT_PAGE[task.stage]);
  const label = continueLabel(task);
  const status = statusOf(task);
  const onRowClick = (event: MouseEvent<HTMLTableRowElement>) => {
    if (!label) return;
    if ((event.target as HTMLElement).closest('a, button, .abandon')) return;
    navigate(href);
  };
  return (
    <tr className={label ? 'task-row clickable' : 'task-row'} onClick={onRowClick}>
      {/* 任务名不折行：窗口放不下时整张表横向滚动，任务名固定在左。 */}
      <td className="sticky-start nowrap">
        <span className="task-name">{task.name}</span>
      </td>
      <td className="nowrap">{formatPeriod(task.period)}</td>
      <td>
        <StatusTag status={status} />
      </td>
      <td>
        <Progress task={task} status={status} />
      </td>
      <td className="num">{task.grossTotal ?? <span className="muted">未确认</span>}</td>
      <td className="nowrap">{task.erpDraftNo ? <span className="code">{task.erpDraftNo}</span> : <span className="muted">尚无</span>}</td>
      <td className="nowrap muted">{formatDateTime(task.updatedAt)}</td>
      <td className="sticky-end">
        <div className="row-actions">
          {label ? (
            <a className="btn btn-secondary btn-sm" href={href}>
              {label}
            </a>
          ) : null}
          <AbandonControl task={task} onAbandon={onAbandon} />
        </div>
      </td>
    </tr>
  );
}

// 工具栏的搜索与状态筛选只是在页面已拿到的这张列表里挑行显示（与「N 份材料」取文件清单长度同理），不改服务端的顺序。
function TaskTable({ tasks, onAbandon }: { tasks: readonly TaskListItem[]; onAbandon: (task: TaskListItem) => void }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<StatusKey | 'all'>('all');
  const keyed = tasks.map((task) => ({ task, status: statusOf(task) }));
  const countOf = (key: StatusKey) => keyed.filter((item) => item.status.key === key).length;
  const needle = query.trim();
  const visible = keyed.filter(
    ({ task, status }) => (filter === 'all' || status.key === filter) && (needle === '' || task.name.includes(needle) || (task.erpDraftNo ?? '').includes(needle)),
  );
  const options = FILTERS.filter((option) => option.always || countOf(option.key) > 0);
  return (
    <>
      <div className="toolbar bleed" role="toolbar" aria-label="任务表工具栏">
        <h2>{TASK_LIST_COPY.tableTitle}</h2>
        <span className="toolbar-count">{visible.length} 个</span>
        <label className="search">
          <Icon name="search" />
          <input type="search" placeholder={TASK_LIST_COPY.search} aria-label={TASK_LIST_COPY.search} value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <div className="segmented" role="group" aria-label={TASK_LIST_COPY.filterGroup}>
          <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
            {TASK_LIST_COPY.all} <span className="n">{tasks.length}</span>
          </button>
          {options.map((option) => (
            <button key={option.key} type="button" aria-pressed={filter === option.key} onClick={() => setFilter(option.key)}>
              {option.label} <span className="n">{countOf(option.key)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="table-scroll bleed">
        <table className="data tall" aria-label="报销任务">
          <thead>
            <tr>
              <th className="sticky-start">任务</th>
              <th>费用期间</th>
              <th>状态</th>
              <th>进度</th>
              <th className="num">价税合计</th>
              <th>草稿号</th>
              <th>更新时间</th>
              <th className="sticky-end num">操作</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(({ task }) => (
              <TaskRow key={task.taskId} task={task} onAbandon={onAbandon} />
            ))}
            {visible.length === 0 ? (
              <tr>
                <td className="muted" colSpan={8}>
                  {TASK_LIST_COPY.noMatch}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}

// newTask：路由是 `#/tasks/new` 时在列表上打开新建任务弹层；关闭或取消回到 `#/tasks`。
export function TaskListPage({ newTask }: { newTask: boolean }) {
  const store = useAppStore();
  const taskList = useTaskList();
  const closeNewTask = useCallback(() => navigate(TASKS_HASH), []);
  const [abandoning, setAbandoning] = useState<TaskListItem | null>(null);
  const [abandonBusy, setAbandonBusy] = useState(false);
  const [abandonError, setAbandonError] = useState<string | null>(null);
  const closeAbandon = useCallback(() => {
    setAbandoning(null);
    setAbandonError(null);
  }, []);
  // 每次回到任务列表都向服务端重新要一次：任务可能在任务页里推进过（如转人工），列表行要跟上服务端。
  useEffect(() => {
    void store.loadTaskList();
  }, [store]);

  // 作废：服务端再核一次能否作废；成功后换上服务端给出的新列表（这个任务不在其中）。
  const abandon = async (task: TaskListItem) => {
    setAbandonBusy(true);
    setAbandonError(null);
    const outcome = await store.abandonTask(task.taskId);
    setAbandonBusy(false);
    if (outcome.ok) setAbandoning(null);
    else setAbandonError(outcome.error.message);
  };

  return (
    <AppShell nav="tasks">
      <div className="page-head">
        <div>
          <h1>报销任务</h1>
          <p className="lead">{TASK_LIST_COPY.lead}</p>
        </div>
        <div className="actions">
          <button className="btn btn-primary" type="button" onClick={() => navigate(NEW_TASK_HASH)}>
            <Icon name="add" />
            新建报销任务
          </button>
        </div>
      </div>
      {taskList.status === 'error' ? (
        <div className="empty">
          <h2>任务列表加载失败</h2>
          <p>{taskList.error}</p>
          <button className="btn btn-secondary" type="button" onClick={() => void store.loadTaskList()}>
            重试
          </button>
        </div>
      ) : taskList.data ? (
        taskList.data.tasks.length === 0 ? (
          <div className="empty">
            <h2>还没有报销任务</h2>
            <p>新建一个任务，然后把这次出差的材料拖进来。</p>
          </div>
        ) : (
          <TaskTable tasks={taskList.data.tasks} onAbandon={setAbandoning} />
        )
      ) : (
        <p className="caption loading">{taskList.offline ? '正在等待本地服务恢复，恢复后自动加载…' : '正在加载任务列表…'}</p>
      )}
      {newTask ? <NewTaskDialog taskList={taskList.data} onClose={closeNewTask} /> : null}
      {abandoning ? (
        <ConfirmDialog
          title={ABANDON_TASK_COPY.dialogTitle}
          confirmLabel={ABANDON_TASK_COPY.confirm}
          busy={abandonBusy}
          error={abandonError}
          onConfirm={() => void abandon(abandoning)}
          onCancel={closeAbandon}
        >
          <p>
            「{abandoning.name}」{ABANDON_TASK_COPY.dialogBody}
          </p>
        </ConfirmDialog>
      ) : null}
    </AppShell>
  );
}
