import { useCallback, useEffect, type MouseEvent } from 'react';
import { useAppStore, useTaskList } from '../adapter/context';
import { STAGE_DEFAULT_PAGE, TASK_STAGE_LABELS } from '../contract/stage';
import { TASK_ERP_OUTCOME_LABELS, type TaskListItem } from '../contract/task-list';
import { formatDateTime, formatPeriod } from '../format';
import { NEW_TASK_HASH, TASKS_HASH, navigate, taskHash } from '../router';
import { AppShell } from '../shell/AppShell';
import { NewTaskDialog } from './NewTaskDialog';

// 徽标：服务端给出的 ERP 结局（已转人工 / 回读不一致）优先于阶段名。
function Badge({ task }: { task: TaskListItem }) {
  if (task.erpOutcome === 'handed_off') return <span className="badge badge-warn">{TASK_ERP_OUTCOME_LABELS.handed_off}</span>;
  if (task.erpOutcome === 'readback_mismatch') return <span className="badge badge-err">{TASK_ERP_OUTCOME_LABELS.readback_mismatch}</span>;
  const className = task.stage === 'done' ? 'badge badge-ok' : task.stage === 'reconcile' ? 'badge badge-warn' : 'badge badge-primary';
  return <span className={className}>{TASK_STAGE_LABELS[task.stage]}</span>;
}

function continueLabel(task: TaskListItem): string | null {
  if (task.stage === 'reconcile') return '查看对账 →';
  if (task.stage === 'done') return task.erpOutcome === 'none' ? null : '查看结果 →';
  return '继续 →';
}

function TaskRow({ task }: { task: TaskListItem }) {
  const href = taskHash(task.taskId, STAGE_DEFAULT_PAGE[task.stage]);
  const label = continueLabel(task);
  const onRowClick = (event: MouseEvent<HTMLTableRowElement>) => {
    if (!label) return;
    if ((event.target as HTMLElement).closest('a')) return;
    navigate(href);
  };
  return (
    <tr className={label ? 'task-row clickable' : 'task-row'} onClick={onRowClick}>
      <td>{task.name}</td>
      <td className="mono">{formatPeriod(task.period)}</td>
      <td>
        <Badge task={task} />
      </td>
      <td className="num">{task.grossTotal ?? <span className="muted">未确认</span>}</td>
      <td className="mono">{task.erpDraftNo ?? <span className="muted">尚无</span>}</td>
      <td className="muted mono">{formatDateTime(task.updatedAt)}</td>
      <td>{label ? <a href={href}>{label}</a> : null}</td>
    </tr>
  );
}

// newTask：路由是 `#/tasks/new` 时在列表上打开新建任务弹层；关闭或取消回到 `#/tasks`。
export function TaskListPage({ newTask }: { newTask: boolean }) {
  const store = useAppStore();
  const taskList = useTaskList();
  const closeNewTask = useCallback(() => navigate(TASKS_HASH), []);
  // 每次回到任务列表都向服务端重新要一次：任务可能在任务页里推进过（如转人工），列表行要跟上服务端。
  useEffect(() => {
    void store.loadTaskList();
  }, [store]);
  return (
    <AppShell nav="tasks">
      <div className="page-head">
        <div>
          <h1>报销任务</h1>
          <p className="lead">每次出差一个任务。任务目录里保存原件、盘点结果、确认数据与打印设置。</p>
        </div>
        <div className="actions">
          <button className="btn btn-primary" type="button" onClick={() => navigate(NEW_TASK_HASH)}>
            新建报销任务
          </button>
        </div>
      </div>
      <section className="panel table">
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
            <table className="data">
              <thead>
                <tr>
                  <th>任务</th>
                  <th>费用期间</th>
                  <th>状态</th>
                  <th className="num">价税合计</th>
                  <th>ERP 草稿</th>
                  <th>更新</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {taskList.data.tasks.map((task) => (
                  <TaskRow key={task.taskId} task={task} />
                ))}
              </tbody>
            </table>
          )
        ) : (
          <p className="caption loading">{taskList.offline ? '正在等待本地服务恢复，恢复后自动加载…' : '正在加载任务列表…'}</p>
        )}
      </section>
      {newTask ? <NewTaskDialog taskList={taskList.data} onClose={closeNewTask} /> : null}
    </AppShell>
  );
}
