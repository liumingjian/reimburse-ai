import { useCallback, useState } from 'react';
import { PROJECT_ASSIGNMENT_ERRORS, PROJECT_CONFLICT_COPY, PURPOSE_MAX_LENGTH } from '../contract/actions';
import type { Line, ProjectOption, TaskSnapshot } from '../contract/snapshot';
import { navigate, taskHash } from '../router';
import { ActionError } from '../shell/ActionError';
import { ConfirmDialog } from '../shell/Dialog';
import { useAction } from '../shell/useAction';
import { PAGE_COPY } from './page-copy';

// 项目归属页（只在「去报销」路径上）：规则照内核现有项目归属页面（project-workbench.mjs Variant B）。
// 左边是候选明细，勾选一条或多条后在右边的个人项目簿里「归入」某个项目；批量归入碰到已有其他项目的明细时，
// 弹出「只处理未归属 / 确认覆盖 / 取消」。页头填报销事由。提交前的逐条选择只是表单输入；
// 项目是否可用、归属是否成立由服务端判定（允许列表里的 selectable 与提交结果）。

// 本页正在编辑、尚未提交的逐条归属：lineId → 项目号。以快照里服务端已记下的归属为初值。
type PendingAssignments = Readonly<Record<string, string>>;
// 批量归入的方式：只给还没有项目的明细归入，或把已勾选的明细全部改为这个项目。
type AssignMode = 'fill-empty' | 'overwrite';
type Conflict = { project: ProjectOption; count: number };

function savedAssignments(snapshot: TaskSnapshot): PendingAssignments {
  return Object.fromEntries(snapshot.projectAssignment.assignments.map((item) => [item.lineId, item.projectNumber]));
}

function matches(project: ProjectOption, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return project.number.toLowerCase().includes(needle) || project.name.toLowerCase().includes(needle);
}

export function ProjectPage({ snapshot }: { snapshot: TaskSnapshot }) {
  const taskId = snapshot.task.taskId;
  const copy = PAGE_COPY.project;
  const assignment = snapshot.projectAssignment;
  const submitted = assignment.status === 'submitted';
  const { lines } = snapshot;

  const [pendingAssignments, setPendingAssignments] = useState<PendingAssignments>(() => savedAssignments(snapshot));
  const [purpose, setPurpose] = useState(assignment.purpose ?? '');
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [onlyUnassigned, setOnlyUnassigned] = useState(false);
  const [query, setQuery] = useState('');
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const { busy, error, run, clearError } = useAction(taskId);

  // 已提交就只显示服务端记下的归属；否则显示本页正在编辑的选择。
  const current: PendingAssignments = submitted ? savedAssignments(snapshot) : pendingAssignments;
  const nameOf = (number: string) =>
    assignment.projects.find((project) => project.number === number)?.name ??
    assignment.assignments.find((item) => item.projectNumber === number)?.projectName ??
    number;

  const visible = onlyUnassigned ? lines.filter((line) => !current[line.lineId]) : lines;
  const allVisibleSelected = visible.length > 0 && visible.every((line) => selected.has(line.lineId));
  const shownProjects = assignment.projects.filter((project) => matches(project, query));
  const assignedCount = lines.filter((line) => current[line.lineId]).length;
  // 提交按钮只看本页尚未提交的表单（每条明细都已归属、事由非空）：这是 #105 要求的输入校验
  // （「提交按钮在任一明细未归属或事由为空时不可用」），不是业务判定；项目能否用、归属是否成立仍由服务端在提交时判定。
  const complete = assignedCount === lines.length && lines.length > 0 && purpose.trim().length > 0;

  const toggleLine = (lineId: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(lineId)) next.delete(lineId);
      else next.add(lineId);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((previous) => {
      const next = new Set(previous);
      for (const line of visible) {
        if (allVisibleSelected) next.delete(line.lineId);
        else next.add(line.lineId);
      }
      return next;
    });
  };

  const toggleOnlyUnassigned = () => {
    setOnlyUnassigned((value) => !value);
    setSelected(new Set());
  };

  const assignSelected = (number: string, mode: AssignMode) => {
    setPendingAssignments((previous) => {
      const next: Record<string, string> = { ...previous };
      for (const lineId of selected) if (mode === 'overwrite' || !next[lineId]) next[lineId] = number;
      return next;
    });
    setSelected(new Set());
    setConflict(null);
    clearError();
  };

  // 冲突检测拿已勾选明细在表单里的现有归属（初值即快照里已记下的归属）与目标项目比较，只用来决定是否弹出三选一提示。
  const assign = (project: ProjectOption) => {
    const conflicts = [...selected].filter((lineId) => {
      const existing = pendingAssignments[lineId];
      return existing !== undefined && existing !== project.number;
    });
    if (conflicts.length > 0) setConflict({ project, count: conflicts.length });
    else assignSelected(project.number, 'overwrite');
  };

  const cancelConflict = useCallback(() => setConflict(null), []);

  const submit = async () => {
    const projects: Record<string, string> = {};
    for (const line of lines) {
      const number = pendingAssignments[line.lineId];
      if (number) projects[line.lineId] = number;
    }
    const outcome = await run((adapter) => adapter.submitProjectAssignment(taskId, { purpose: purpose.trim(), projects }, snapshot.step.stepToken));
    if (outcome.ok) navigate(taskHash(taskId, 'erp'));
  };

  return (
    <>
      <div className="page-head">
        <div className="head-main">
          <h1>{copy.title}</h1>
          <p className="lead">{copy.lead}</p>
          <div className="head-fields">
            <div className="field">
              <label htmlFor="purpose">报销事由</label>
              <input
                id="purpose"
                className="input"
                value={purpose}
                maxLength={PURPOSE_MAX_LENGTH}
                required
                disabled={submitted}
                placeholder="如：上海产品评审出差"
                onChange={(event) => setPurpose(event.target.value)}
              />
            </div>
            <p className="caption">常驻城市：{assignment.homeCity ?? '未确认'}</p>
          </div>
        </div>
      </div>

      {submitted ? (
        <div className="notice notice-ok" role="status">
          项目归属已确认。
          <div className="btn-row">
            <a className="btn btn-primary" href={taskHash(taskId, 'erp')}>
              进入 ERP 填报
            </a>
          </div>
        </div>
      ) : null}

      <div className="project-split">
        <section className="panel table" aria-label="费用明细">
          <div className="assign-toolbar">
            <label className="check">
              <input type="checkbox" checked={allVisibleSelected} disabled={submitted || visible.length === 0} onChange={toggleAll} />
              全选当前明细
            </label>
            <label className="check">
              <input type="checkbox" checked={onlyUnassigned} disabled={submitted} onChange={toggleOnlyUnassigned} />
              仅未归属
            </label>
            <span className="caption" role="status">
              已选 {selected.size} 条
            </span>
          </div>
          {visible.length > 0 ? (
            <table className="data" aria-label="项目归属明细">
              <thead>
                <tr>
                  <th className="pick" aria-label="选择" />
                  <th>No.</th>
                  <th>日期</th>
                  <th>费用类别</th>
                  <th>说明</th>
                  <th className="num">价税合计</th>
                  <th>项目</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((line) => (
                  <LineRow
                    key={line.lineId}
                    line={line}
                    project={current[line.lineId] ?? null}
                    nameOf={nameOf}
                    checked={selected.has(line.lineId)}
                    disabled={submitted}
                    onToggle={() => toggleLine(line.lineId)}
                  />
                ))}
              </tbody>
            </table>
          ) : (
            <p className="empty caption">所有明细都已归属。</p>
          )}
        </section>

        <aside className="panel project-aside" role="complementary" aria-label="项目工作台">
          <h2>个人项目簿中的可选项目</h2>
          <input
            className="input"
            type="search"
            placeholder="查找项目号或名称"
            aria-label="查找个人项目簿"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {assignment.projects.length === 0 ? (
            <p className="caption project-empty">{PROJECT_ASSIGNMENT_ERRORS.bookEmpty}</p>
          ) : shownProjects.length === 0 ? (
            <p className="caption project-empty" role="status">
              没有匹配的可选项目
            </p>
          ) : (
            <ul className="project-options" aria-label="项目列表">
              {shownProjects.map((project) => (
                <li key={project.number} className={project.selectable ? undefined : 'locked'}>
                  <div>
                    <div className="name">{project.name}</div>
                    <div className="mono caption">{project.number}</div>
                  </div>
                  {project.selectable ? (
                    <button
                      className="btn btn-secondary btn-sm"
                      type="button"
                      aria-label={`归入 ${project.number} ${project.name}`}
                      disabled={submitted || selected.size === 0}
                      onClick={() => assign(project)}
                    >
                      归入
                    </button>
                  ) : (
                    <span className="badge badge-warn">{project.statusLabel}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="caption">先在左边勾选明细，再点项目的「归入」。</p>
        </aside>
      </div>

      <section className="panel assign-footer" aria-label="提交项目归属">
        <p data-testid="assign-summary">
          已归属 <span className="mono">{assignedCount}</span> / <span className="mono">{lines.length}</span> 条 · 合计{' '}
          <span className="mono">{snapshot.confirmation.grossTotal ?? ''}</span> 元
        </p>
        <div className="btn-row">
          {!submitted && !complete ? <span className="caption">{PROJECT_ASSIGNMENT_ERRORS.incomplete}</span> : null}
          <ActionError message={error} />
          <button className="btn btn-primary" type="button" disabled={submitted || busy || !complete || conflict !== null} onClick={() => void submit()}>
            确认项目归属
          </button>
        </div>
      </section>

      {conflict ? (
        <ConfirmDialog
          title={PROJECT_CONFLICT_COPY.title(conflict.count)}
          confirmLabel={PROJECT_CONFLICT_COPY.overwrite}
          cancelLabel={PROJECT_CONFLICT_COPY.cancel}
          extraLabel={PROJECT_CONFLICT_COPY.onlyEmpty}
          onExtra={() => assignSelected(conflict.project.number, 'fill-empty')}
          onConfirm={() => assignSelected(conflict.project.number, 'overwrite')}
          onCancel={cancelConflict}
        >
          <p className="lead">
            要归入 {conflict.project.number} {conflict.project.name}。「只处理未归属」只给还没有项目的明细归入；「确认覆盖」把已勾选的明细全部改为这个项目。
          </p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

function LineRow({
  line,
  project,
  nameOf,
  checked,
  disabled,
  onToggle,
}: {
  line: Line;
  project: string | null;
  nameOf: (number: string) => string;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <tr>
      <td className="pick">
        <input type="checkbox" aria-label={`选择明细 No.${line.no}`} checked={checked} disabled={disabled} onChange={onToggle} />
      </td>
      <td className="mono">{line.no}</td>
      <td className="mono">
        {line.date}
        {line.endDate ? <div className="caption">至 {line.endDate}</div> : null}
      </td>
      <td>{line.category.label}</td>
      <td>{line.description}</td>
      <td className="num">{line.grossAmount}</td>
      <td data-testid={`project-of-${line.no}`}>
        {project ? (
          <>
            <span className="mono">{project}</span> · {nameOf(project)}
          </>
        ) : (
          <span className="badge">未归属</span>
        )}
      </td>
    </tr>
  );
}
