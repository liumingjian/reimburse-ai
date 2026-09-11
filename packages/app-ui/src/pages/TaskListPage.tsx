import type { MouseEvent } from 'react';
import { useAppStore, useTaskList } from '../adapter/context';
import { STAGE_DEFAULT_PAGE, TASK_STAGE_LABELS, type TaskStage } from '../contract/stage';
import type { TaskListItem } from '../contract/task-list';
import { formatDateTime, formatPeriod } from '../format';
import { NEW_TASK_HASH, navigate, taskHash } from '../router';
import { AppShell } from '../shell/AppShell';

function badgeClass(stage: TaskStage): string {
  if (stage === 'done') return 'badge badge-ok';
  if (stage === 'reconcile') return 'badge badge-warn';
  return 'badge badge-primary';
}

function continueLabel(stage: TaskStage): string | null {
  if (stage === 'done') return null;
  if (stage === 'reconcile') return '查看对账 →';
  return '继续 →';
}

function TaskRow({ task }: { task: TaskListItem }) {
  const href = taskHash(task.taskId, STAGE_DEFAULT_PAGE[task.stage]);
  const label = continueLabel(task.stage);
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
        <span className={badgeClass(task.stage)}>{TASK_STAGE_LABELS[task.stage]}</span>
      </td>
      <td className="num">{task.grossTotal ?? <span className="muted">未确认</span>}</td>
      <td className="mono">{task.erpDraftNo ?? <span className="muted">尚无</span>}</td>
      <td className="muted mono">{formatDateTime(task.updatedAt)}</td>
      <td>{label ? <a href={href}>{label}</a> : null}</td>
    </tr>
  );
}

export function TaskListPage() {
  const store = useAppStore();
  const taskList = useTaskList();
  return (
    <AppShell nav="tasks">
      <div className="page-head">
        <div>
          <h1>报销任务</h1>
          <p className="lead">每次出差一个任务。任务目录里保存原件、盘点结果、确认数据与打印设置。</p>
        </div>
        <div className="actions">
          <a className="btn btn-primary" href={NEW_TASK_HASH}>
            新建报销任务
          </a>
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
          <p className="caption loading">正在加载任务列表…</p>
        )}
      </section>
    </AppShell>
  );
}
