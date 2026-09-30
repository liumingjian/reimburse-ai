import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import {
  Button,
  ContentSwitcher,
  InlineLoading,
  Tooltip,
  ProgressBar,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  TableToolbar,
  TableToolbarContent,
  TableToolbarSearch,
} from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { useAppStore, useTaskList } from '../adapter/context';
import { ABANDON_TASK_COPY, KERNEL_PHASES, RECONCILE_STATUS_LABEL, STAGE_DEFAULT_PAGE, TASK_STAGE_LABELS, TASK_STAGE_PHASES, TASK_ERP_OUTCOME_LABELS, type TaskListItem } from '@baox/contract';
import { formatDateTime, formatPeriod } from '../format';
import { NEW_TASK_HASH, TASKS_HASH, navigate, taskHash } from '../router';
import { AppShell } from '../shell/AppShell';
import { ConfirmDialog } from '../shell/Dialog';
import { PageHeader } from '../shell/PageHeader';
import { StatusTag } from '../shell/StatusTag';
import { NewTaskDialog } from './NewTaskDialog';

export const TASK_LIST_COPY = {
  lead: '在同一个任务里整理本次报销材料，确认后可打印或自动填写报销系统。',
  tableTitle: '全部任务',
  toolbar: '任务表工具栏',
  search: '搜索任务名或单据编号',
  clearSearch: '清除搜索',
  filterGroup: '按状态筛选',
  all: '全部',
  active: '进行中',
  handedOver: '已交接',
  noMatch: '没有符合条件的任务。',
} as const;

// 状态列：服务端给出的写入结局优先（已转人工需要注意 / 回读不一致出错），其次是对账中（需要注意）、
// 已交接（完成），其余都是进行中。全部照服务端字段判读，页面不推断别的。
// Tags go through the shared StatusTag, so the warning tone looks the same on every page.
type StatusKey = 'active' | 'reconcile' | 'handed_off' | 'readback_mismatch' | 'done';
type Tone = 'info' | 'success' | 'warning' | 'danger';
type Status = { key: StatusKey; label: string; tone: Tone };

const TASK_LIST_TITLE_ID = 'task-list-title';

function statusOf(task: TaskListItem): Status {
  if (task.erpOutcome === 'handed_off') return { key: 'handed_off', label: TASK_ERP_OUTCOME_LABELS.handed_off, tone: 'warning' };
  if (task.erpOutcome === 'readback_mismatch') return { key: 'readback_mismatch', label: TASK_ERP_OUTCOME_LABELS.readback_mismatch, tone: 'danger' };
  if (task.stage === 'reconcile') return { key: 'reconcile', label: RECONCILE_STATUS_LABEL, tone: 'warning' };
  if (task.stage === 'done') return { key: 'done', label: TASK_LIST_COPY.handedOver, tone: 'success' };
  return { key: 'active', label: TASK_LIST_COPY.active, tone: 'info' };
}

// 筛选项：进行中、对账中、已交接常驻；已转人工与回读不一致只在列表里有这种任务时出现。
const FILTERS: readonly { key: StatusKey; label: string; always: boolean }[] = [
  { key: 'active', label: TASK_LIST_COPY.active, always: true },
  { key: 'reconcile', label: RECONCILE_STATUS_LABEL, always: true },
  { key: 'handed_off', label: TASK_ERP_OUTCOME_LABELS.handed_off, always: false },
  { key: 'readback_mismatch', label: TASK_ERP_OUTCOME_LABELS.readback_mismatch, always: false },
  { key: 'done', label: TASK_LIST_COPY.handedOver, always: true },
];

// 进度列：内核 10 阶段的序号画成 Carbon 进度条，旁边是「N/10 阶段名」。写入结局不是 none 时状态列已经说明结局，这里只留进度条（契约：结局代替阶段名）。
function Progress({ task, status }: { task: TaskListItem; status: Status }) {
  const phase = KERNEL_PHASES.indexOf(TASK_STAGE_PHASES[task.stage]) + 1;
  const barStatus = status.tone === 'danger' ? 'error' : status.key === 'done' ? 'finished' : 'active';
  return (
    <div className="app-progress">
      <ProgressBar label={`${phase}/10`} hideLabel value={phase} max={10} size="small" status={barStatus} />
      {task.erpOutcome === 'none' ? <span>{TASK_STAGE_LABELS[task.stage]}</span> : null}
    </div>
  );
}

function continueLabel(task: TaskListItem): string | null {
  if (task.stage === 'reconcile') return '查看对账';
  if (task.stage === 'done') return task.erpOutcome === 'none' ? null : '查看结果';
  return '继续';
}

// Keep abandonment visible beside the primary action. A focusable wrapper exposes the server's refusal reason
// on hover or keyboard focus even though the underlying destructive action remains disabled.
function AbandonButton({ task, onAbandon }: { task: TaskListItem; onAbandon: (task: TaskListItem) => void }) {
  if (task.abandonable) return <Button kind="danger--ghost" size="sm" onClick={() => onAbandon(task)}>{ABANDON_TASK_COPY.confirm}</Button>;
  const reasonId = `abandon-reason-${task.taskId}`;
  return (
    <Tooltip autoAlign align="bottom-end" description={<span id={reasonId}>{task.abandonBlockedReason ?? ABANDON_TASK_COPY.blockedReason}</span>}>
      <span tabIndex={0} aria-label="无法作废的原因" className="app-abandon-disabled">
        <Button kind="danger--ghost" size="sm" disabled aria-describedby={reasonId}>{ABANDON_TASK_COPY.confirm}</Button>
      </span>
    </Tooltip>
  );
}

function TaskRow({ task, onAbandon }: { task: TaskListItem; onAbandon: (task: TaskListItem) => void }) {
  const href = taskHash(task.taskId, STAGE_DEFAULT_PAGE[task.stage]);
  const label = continueLabel(task);
  const status = statusOf(task);
  const summaryStatus = task.summaryStatus ?? (task.grossTotal !== null ? 'confirmed' : task.period ? 'pending' : 'unavailable');
  const onRowClick = (event: MouseEvent<HTMLTableRowElement>) => {
    if (!label) return;
    if ((event.target as HTMLElement).closest('a, button, .cds--popover-container')) return;
    navigate(href);
  };
  return (
    <TableRow className={label ? 'app-clickable' : ''} onClick={onRowClick}>
      {/* 任务名不折行：窗口放不下时整张表横向滚动，任务名固定在左。 */}
      <TableCell className="app-sticky-start app-nowrap">
        <span className="app-task-name">{task.name}</span>
      </TableCell>
      <TableCell className="app-nowrap">
        {summaryStatus === 'unavailable' || !task.period ? (
          '暂无可用日期'
        ) : (
          <>
            {formatPeriod(task.period)}
            <span className="app-caption app-cell-sub">{summaryStatus === 'confirmed' ? '已确认' : '待确认'}</span>
          </>
        )}
      </TableCell>
      <TableCell>
        <StatusTag tone={status.tone}>{status.label}</StatusTag>
      </TableCell>
      <TableCell>
        <Progress task={task} status={status} />
      </TableCell>
      <TableCell className="app-num">{task.grossTotal !== null ? <>{task.grossTotal}<span className="app-caption app-cell-sub">已确认</span></> : <span className="app-muted">{summaryStatus === 'pending' ? '待整单确认' : '暂无可用金额'}</span>}</TableCell>
      <TableCell className="app-nowrap">{task.erpDraftNo ? <span className="app-code">{task.erpDraftNo}</span> : <span className="app-muted">尚无</span>}</TableCell>
      <TableCell className="app-nowrap app-muted">{formatDateTime(task.updatedAt)}</TableCell>
      <TableCell className="app-sticky-end app-task-actions">
        <div className="app-row-actions">
          {label ? (
            <Button kind="ghost" size="sm" href={href}>
              {label}
            </Button>
          ) : null}
          <AbandonButton task={task} onAbandon={onAbandon} />
        </div>
      </TableCell>
    </TableRow>
  );
}

// 工具栏的搜索与状态筛选只是在页面已拿到的这张列表里挑行显示（与「N 份材料」取文件清单长度同理），不改服务端的顺序。
// 表格不加排序、行选择与行展开（ADR-0012：以后逐项评审）。
function TaskTable({ tasks, onAbandon }: { tasks: readonly TaskListItem[]; onAbandon: (task: TaskListItem) => void }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<StatusKey | 'all'>('all');
  const keyed = tasks.map((task) => ({ task, status: statusOf(task) }));
  const countOf = (key: StatusKey) => keyed.filter((item) => item.status.key === key).length;
  const needle = query.trim();
  const visible = keyed.filter(
    ({ task, status }) => (filter === 'all' || status.key === filter) && (needle === '' || task.name.includes(needle) || (task.erpDraftNo ?? '').includes(needle)),
  );
  const switches: readonly { key: StatusKey | 'all'; label: string; count: number }[] = [
    { key: 'all', label: TASK_LIST_COPY.all, count: tasks.length },
    ...FILTERS.filter((option) => option.always || countOf(option.key) > 0).map((option) => ({ key: option.key, label: option.label, count: countOf(option.key) })),
  ];
  const selectedIndex = Math.max(
    0,
    switches.findIndex((item) => item.key === filter),
  );
  const onSearch = (event: unknown) => {
    const target = typeof event === 'object' && event !== null && 'target' in event ? (event.target as HTMLInputElement | null) : null;
    setQuery(target?.value ?? '');
  };
  return (
    <div className="bleed app-table">
      {/* 不给表格再起标题：页面标题已是「报销任务」，条数在筛选「全部 N」里。 */}
      <TableContainer>
        <TableToolbar aria-label={TASK_LIST_COPY.toolbar}>
          <TableToolbarContent>
            <TableToolbarSearch
              persistent
              labelText={TASK_LIST_COPY.search}
              placeholder={TASK_LIST_COPY.search}
              closeButtonLabelText={TASK_LIST_COPY.clearSearch}
              onChange={onSearch}
            />
            <div className="app-toolbar-filter">
              <ContentSwitcher
                aria-label={TASK_LIST_COPY.filterGroup}
                size="md"
                selectedIndex={selectedIndex}
                onChange={(data: { index?: number }) => setFilter(switches[data.index ?? 0]?.key ?? 'all')}
              >
                {switches.map((item) => (
                  <Switch key={item.key} name={item.key} text={`${item.label} ${item.count}`} />
                ))}
              </ContentSwitcher>
            </div>
          </TableToolbarContent>
        </TableToolbar>
        {/* 表格的可访问名称指向页面标题「报销任务」。 */}
        <Table aria-labelledby={TASK_LIST_TITLE_ID} size="lg">
          <TableHead>
            <TableRow>
              <TableHeader className="app-sticky-start">任务</TableHeader>
              <TableHeader>费用期间</TableHeader>
              <TableHeader>状态</TableHeader>
              <TableHeader>进度</TableHeader>
              <TableHeader className="app-num">价税合计</TableHeader>
              <TableHeader>单据编号</TableHeader>
              <TableHeader>更新时间</TableHeader>
              <TableHeader className="app-sticky-end app-num">操作</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {visible.map(({ task }) => (
              <TaskRow key={task.taskId} task={task} onAbandon={onAbandon} />
            ))}
            {visible.length === 0 ? (
              <TableRow>
                <TableCell className="app-muted" colSpan={8}>
                  {TASK_LIST_COPY.noMatch}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </TableContainer>
    </div>
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
      <PageHeader
        title="报销任务"
        titleId={TASK_LIST_TITLE_ID}
        lead={TASK_LIST_COPY.lead}
        actions={
          // 本地服务断开时不能新建：按钮不可用，恢复后自动可用。
          taskList.data?.tasks.length === 0 ? undefined : <Button kind="tertiary" renderIcon={Add} disabled={taskList.offline} onClick={() => navigate(NEW_TASK_HASH)}>
            新建报销任务
          </Button>
        }
      />
      {taskList.status === 'error' ? (
        <div className="app-empty">
          <h2>任务列表加载失败</h2>
          <p>{taskList.error}</p>
          <Button size="md" kind="secondary" onClick={() => void store.loadTaskList()}>
            重试
          </Button>
        </div>
      ) : taskList.data ? (
        taskList.data.tasks.length === 0 ? (
          <div className="app-empty">
            <h2>还没有报销任务</h2>
            <p>新建一个任务，然后把这次出差的材料拖进来。</p>
            <Button size="md" renderIcon={Add} disabled={taskList.offline} onClick={() => navigate(NEW_TASK_HASH)}>新建报销任务</Button>
          </div>
        ) : (
          <TaskTable tasks={taskList.data.tasks} onAbandon={setAbandoning} />
        )
      ) : (
        <InlineLoading className="app-loading" iconDescription="正在加载" description={taskList.offline ? '正在等待报销服务恢复，恢复后自动加载…' : '正在加载任务列表…'} />
      )}
      {newTask ? <NewTaskDialog taskList={taskList.data} onClose={closeNewTask} /> : null}
      {abandoning ? (
        <ConfirmDialog
          danger
          title={ABANDON_TASK_COPY.dialogTitle}
          confirmLabel={ABANDON_TASK_COPY.confirm}
          busy={abandonBusy}
          error={abandonError}
          onConfirm={() => void abandon(abandoning)}
          onCancel={closeAbandon}
        >
          <p>
            「{abandoning.name}」{abandoning.erpTouched ? ABANDON_TASK_COPY.dialogBodyErpTouched : ABANDON_TASK_COPY.dialogBody}
          </p>
        </ConfirmDialog>
      ) : null}
    </AppShell>
  );
}
