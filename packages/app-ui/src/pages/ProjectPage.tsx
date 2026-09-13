import { useCallback, useState } from 'react';
import { PROJECT_ASSIGNMENT_ERRORS, PROJECT_CONFLICT_COPY, PURPOSE_MAX_LENGTH } from '../contract/actions';
import { PROJECT_BOOK_COPY } from '../contract/project-book';
import type { Line, ProjectLineAssignment, StepKind, TaskSnapshot } from '../contract/snapshot';
import { pageAllowed } from '../contract/stage';
import { navigate, taskHash } from '../router';
import { ActionError } from '../shell/ActionError';
import { ConfirmDialog } from '../shell/Dialog';
import { useAction } from '../shell/useAction';
import { PAGE_COPY } from './page-copy';
import { ProjectBookPanel } from './ProjectBookPanel';

// 当前 step 是这些时服务端接受「归入」与提交项目归属：进入项目归属时（含报销信息核对不匹配后的改派），材料包缺项时，
// 以及整单确认前后、ERP 写入开始之前的改派。页面只据此决定按钮是否可用；动作是否成立由服务端判定。
const SUBMIT_STEP_KINDS: ReadonlySet<StepKind> = new Set<StepKind>(['assign_projects', 'resolve_preparation', 'confirm_review', 'choose_action']);

// 项目归属页：待确认项处理完之后、整单确认之前（Skill 的 project_unassigned → select-task），两条路径都要经过。
// 提交后服务端自动做报销信息核对与材料准备，再进入整单确认；确认绑定项目归属，确认后在这里改派会使确认失效。
// ERP 写入开始后只读。形状照内核项目归属页面（project-workbench.mjs Variant B）：
// - 左边明细按费用类别分组（服务端给出的 lines 顺序即内核分类排序），组标题带复选框和条数，可按类别全选；
//   明细卡片展示日期范围、城市、路线和脱敏票号。
// - 右边「本次已归入」区列出本次归属用到的项目，带条数与金额（服务端给出，页面不计算）；其下是个人项目簿中的可选项目
//   （快照只给可选项目），已归入的项目不重复列出。不可选的项目不出现在这里，需要时点「新增项目」在弹层里的项目簿查看。
// 勾选明细后点项目的「归入」，由服务端改本次正在编辑的归属（working）；批量归入碰到已有其他项目的明细时，
// 先弹出「只处理未归属 / 确认覆盖 / 取消」。页头填报销事由；常驻城市只读。

type Target = { number: string; name: string };
type Conflict = { project: Target; count: number };

function byLine(items: readonly ProjectLineAssignment[]): Readonly<Record<string, ProjectLineAssignment>> {
  return Object.fromEntries(items.map((item) => [item.lineId, item]));
}

function matches(project: Target, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return project.number.toLowerCase().includes(needle) || project.name.toLowerCase().includes(needle);
}

// 按费用类别分组，组的先后跟随明细顺序（内核 project-workbench.mjs 以 categoryLabel 分组）。
function groupByCategory(lines: readonly Line[]): { label: string; lines: Line[] }[] {
  const groups: { label: string; lines: Line[] }[] = [];
  for (const line of lines) {
    const group = groups.find((candidate) => candidate.label === line.category.label);
    if (group) group.lines.push(line);
    else groups.push({ label: line.category.label, lines: [line] });
  }
  return groups;
}

// 流程门（内核 project_book_empty）：服务端的当前 step 是 maintain_project_book 时，项目归属页换成个人项目簿维护入口。
// 第一次录入成功后服务端把 step 换回 assign_projects，但本页不自动离开：报销材料可能归属不同项目，用户要把项目录完，
// 点「项目录完了，开始归属」才进入工作台（内核：完成设置并提交后才继续）。按钮只在服务端 step 已离开维护门时可用。
// 「留在维护门」只是界面状态：记下是哪个任务打开时处在维护门，换任务就不再作数，刷新后按服务端 step 重新决定。
export function ProjectPage({ snapshot }: { snapshot: TaskSnapshot }) {
  const taskId = snapshot.task.taskId;
  const atGate = snapshot.step.kind === 'maintain_project_book';
  const [gateTask, setGateTask] = useState<string | null>(atGate ? taskId : null);
  if (atGate && gateTask !== taskId) setGateTask(taskId);
  if (atGate || gateTask === taskId) return <ProjectBookGate canContinue={!atGate} onContinue={() => setGateTask(null)} />;
  return <ProjectWorkbench snapshot={snapshot} />;
}

function ProjectBookGate({ canContinue, onContinue }: { canContinue: boolean; onContinue: () => void }) {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{PROJECT_BOOK_COPY.gateTitle}</h1>
          <p className="lead">{PROJECT_BOOK_COPY.gateLead}</p>
        </div>
        <div className="gate-continue">
          {/* 每屏一个主按钮：可以继续时它是主按钮，录入按钮降为次要；此前录入按钮是主按钮。 */}
          <button className={canContinue ? 'btn btn-primary' : 'btn btn-secondary'} type="button" disabled={!canContinue} onClick={onContinue}>
            {PROJECT_BOOK_COPY.gateContinue}
          </button>
          {canContinue ? null : <span className="caption">{PROJECT_BOOK_COPY.gateContinueHint}</span>}
        </div>
      </div>
      <ProjectBookPanel primaryIntake={!canContinue} />
    </>
  );
}

function ProjectWorkbench({ snapshot }: { snapshot: TaskSnapshot }) {
  const taskId = snapshot.task.taskId;
  const copy = PAGE_COPY.project;
  const assignment = snapshot.projectAssignment;
  const submitted = assignment.status === 'submitted';
  // ERP 写入开始后项目归属不能再改；此前随时可以改派（改派使整单确认失效）。
  const locked = snapshot.erp.status !== 'idle';
  const canAct = SUBMIT_STEP_KINDS.has(snapshot.step.kind) && !locked;
  // 报销信息核对不匹配时，处置就是在本页改派后重新提交；材料包缺项在整单明细确认页处理。
  const catalogMismatch = snapshot.catalog.status === 'mismatch';
  const preparationBlocked = snapshot.preparation.status === 'blocked';
  const autoRunning = (snapshot.stage === 'catalog' || snapshot.stage === 'preparation') && !catalogMismatch && !preparationBlocked;
  const { lines } = snapshot;

  const [purpose, setPurpose] = useState(assignment.purpose ?? '');
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [onlyUnassigned, setOnlyUnassigned] = useState(false);
  const [query, setQuery] = useState('');
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const closeAdd = useCallback(() => setAddOpen(false), []);
  const { busy, error, run, clearError } = useAction(taskId);

  // 显示服务端记下的本次归属：只读（ERP 已开始）时是已提交的那一份，否则是正在编辑的 working。
  const current = byLine(locked ? assignment.assignments : assignment.working);
  const visible = onlyUnassigned ? lines.filter((line) => !current[line.lineId]) : lines;
  const groups = groupByCategory(visible);
  const allVisibleSelected = visible.length > 0 && visible.every((line) => selected.has(line.lineId));
  const used = new Set(assignment.usage.map((entry) => entry.number));
  const shownProjects = assignment.projects.filter((project) => !used.has(project.number) && matches(project, query));
  const assignedCount = lines.filter((line) => current[line.lineId]).length;
  // 提交按钮只看表单是否填完（每条明细都已归属、事由非空）：这是 #105 要求的输入校验，不是业务判定；
  // 项目能否用、归属是否成立仍由服务端在提交时判定。
  const complete = assignedCount === lines.length && lines.length > 0 && purpose.trim().length > 0;

  const toggle = (lineIds: readonly string[], on: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      for (const lineId of lineIds) {
        if (on) next.add(lineId);
        else next.delete(lineId);
      }
      return next;
    });
  };

  const toggleOnlyUnassigned = () => {
    setOnlyUnassigned((value) => !value);
    setSelected(new Set());
  };

  const assignSelected = async (number: string, onlyEmpty: boolean) => {
    setConflict(null);
    clearError();
    const lineIds = lines.map((line) => line.lineId).filter((lineId) => selected.has(lineId));
    const outcome = await run((adapter) => adapter.assignProjectLines(taskId, { lineIds, projectNumber: number, onlyUnassigned: onlyEmpty }, snapshot.step.stepToken));
    if (outcome.ok) setSelected(new Set());
  };

  // 冲突检测拿已勾选明细在服务端记下的本次归属与目标项目比较，只用来决定是否先弹出三选一提示。
  const assign = (project: Target) => {
    const conflicts = [...selected].filter((lineId) => {
      const existing = current[lineId];
      return existing !== undefined && existing.projectNumber !== project.number;
    });
    if (conflicts.length > 0) setConflict({ project, count: conflicts.length });
    else void assignSelected(project.number, false);
  };

  const cancelConflict = useCallback(() => setConflict(null), []);

  const submit = async () => {
    const projects: Record<string, string> = {};
    for (const item of assignment.working) projects[item.lineId] = item.projectNumber;
    const outcome = await run((adapter) => adapter.submitProjectAssignment(taskId, { purpose: purpose.trim(), projects }, snapshot.step.stepToken));
    if (outcome.ok) navigate(taskHash(taskId, 'review'));
  };

  const assignButton = (project: Target) => (
    <button
      className="btn btn-secondary btn-sm"
      type="button"
      aria-label={`归入 ${project.number} ${project.name}`}
      disabled={!canAct || busy || selected.size === 0}
      onClick={() => assign(project)}
    >
      归入
    </button>
  );

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
                disabled={locked}
                placeholder="如：上海产品评审出差"
                onChange={(event) => setPurpose(event.target.value)}
              />
            </div>
            <p className="caption">常驻城市：{assignment.homeCity ?? '未确认'}</p>
          </div>
        </div>
      </div>

      {locked ? (
        <div className="notice notice-info" role="status">
          已开始写入报销系统，项目归属不能再修改。
        </div>
      ) : catalogMismatch ? (
        <div className="notice notice-err" role="alert">
          报销信息核对发现项目不匹配：{snapshot.catalog.problems.map((problem) => problem.reason).join('；')}。请把相关明细改派到其他项目后重新提交，提交后会自动重新核对。
        </div>
      ) : submitted ? (
        <div className={preparationBlocked ? 'notice notice-warn' : 'notice notice-ok'} role="status">
          {preparationBlocked
            ? '项目归属已提交。材料包还有缺项，请在整单明细确认页处理。'
            : autoRunning
              ? '项目归属已提交，正在核对报销信息并准备报销材料。'
              : '项目归属已提交。改派项目或修改事由会使整单明细确认失效，需要重新确认。'}
          {pageAllowed(snapshot.stage, 'review') ? (
            <div className="btn-row">
              <a className="btn btn-secondary" href={taskHash(taskId, 'review')}>
                去整单明细确认
              </a>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="project-split">
        <section className="panel" aria-label="费用明细">
          <div className="assign-toolbar">
            <label className="check">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                disabled={locked || visible.length === 0}
                onChange={() => toggle(visible.map((line) => line.lineId), !allVisibleSelected)}
              />
              全选当前明细
            </label>
            <label className="check">
              <input type="checkbox" checked={onlyUnassigned} disabled={locked} onChange={toggleOnlyUnassigned} />
              仅未归属
            </label>
            <span className="caption" role="status">
              已选 {selected.size} 条
            </span>
          </div>
          {groups.length > 0 ? (
            groups.map((group) => {
              const ids = group.lines.map((line) => line.lineId);
              const all = ids.every((lineId) => selected.has(lineId));
              const some = !all && ids.some((lineId) => selected.has(lineId));
              return (
                <section key={group.label} className="assign-group" aria-label={group.label}>
                  <h2 className="assign-group-head">
                    <label className="check">
                      <input
                        type="checkbox"
                        aria-label={`选择${group.label}`}
                        checked={all}
                        ref={(box) => {
                          if (box) box.indeterminate = some;
                        }}
                        disabled={locked}
                        onChange={() => toggle(ids, !all)}
                      />
                      {group.label}
                    </label>
                    <span className="caption">{group.lines.length} 条</span>
                  </h2>
                  <ul className="expense-cards">
                    {group.lines.map((line) => (
                      <LineCard
                        key={line.lineId}
                        line={line}
                        project={current[line.lineId] ?? null}
                        checked={selected.has(line.lineId)}
                        disabled={locked}
                        onToggle={() => toggle([line.lineId], !selected.has(line.lineId))}
                      />
                    ))}
                  </ul>
                </section>
              );
            })
          ) : (
            <p className="empty caption">所有明细都已归属。</p>
          )}
        </section>

        <aside className="panel project-aside" role="complementary" aria-label="项目工作台">
          <h2>本次已归入</h2>
          {assignment.usage.length > 0 ? (
            <ul className="project-options" aria-label="本次已归入">
              {assignment.usage.map((entry) => (
                <li key={entry.number} className={entry.selectable ? undefined : 'locked'}>
                  <div>
                    <div className="name">{entry.name}</div>
                    <div className="caption">
                      <span className="mono">{entry.number}</span> ·{' '}
                      <span data-testid={`usage-${entry.number}`}>
                        {entry.lineCount} 条 · {entry.grossTotal} 元
                      </span>
                    </div>
                  </div>
                  {entry.selectable ? assignButton(entry) : <span className="badge badge-warn">已锁定</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="caption project-empty">暂无</p>
          )}

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
                <li key={project.number}>
                  <div>
                    <div className="name">{project.name}</div>
                    <div className="mono caption">{project.number}</div>
                  </div>
                  {assignButton(project)}
                </li>
              ))}
            </ul>
          )}
          <p className="caption">先在左边勾选明细，再点项目的「归入」。</p>
          {/* 就地新增（对 Skill 的小增强，README 注明）：弹层里是项目簿维护面板，勾选的明细不丢；
              新项目随服务端推送的快照出现在上面的列表里。 */}
          <button className="btn btn-secondary btn-sm add-project" type="button" disabled={locked} onClick={() => setAddOpen(true)}>
            {PROJECT_BOOK_COPY.addProject}
          </button>
        </aside>
      </div>

      <section className="panel assign-footer" aria-label="提交项目归属">
        <p data-testid="assign-summary">
          已归属 <span className="mono">{assignedCount}</span> / <span className="mono">{lines.length}</span> 条 · 合计{' '}
          <span className="mono">{snapshot.confirmation.grossTotal ?? ''}</span> 元
        </p>
        <div className="btn-row">
          {!locked && !complete ? <span className="caption">{PROJECT_ASSIGNMENT_ERRORS.incomplete}</span> : null}
          <ActionError message={error} />
          <button className="btn btn-primary" type="button" disabled={!canAct || busy || !complete || conflict !== null} onClick={() => void submit()}>
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
          onExtra={() => void assignSelected(conflict.project.number, true)}
          onConfirm={() => void assignSelected(conflict.project.number, false)}
          onCancel={cancelConflict}
        >
          <p className="lead">
            要归入 {conflict.project.number} {conflict.project.name}。「只处理未归属」只给还没有项目的明细归入；「确认覆盖」把已勾选的明细全部改为这个项目。
          </p>
        </ConfirmDialog>
      ) : null}

      {addOpen ? (
        <ConfirmDialog title={PROJECT_BOOK_COPY.addProject} confirmLabel={PROJECT_BOOK_COPY.addDialogDone} wide single focusCancel={false} onConfirm={closeAdd} onCancel={closeAdd}>
          <ProjectBookPanel primaryIntake autoFocus />
        </ConfirmDialog>
      ) : null}
    </>
  );
}

// 明细卡片（内核 project-workbench.mjs）：日期范围 · 城市，路线，脱敏票号，当前归属，价税合计。
// 没有城市的（如长途交通）显示费用类别；没有路线的（如住宿）显示说明。
function LineCard({
  line,
  project,
  checked,
  disabled,
  onToggle,
}: {
  line: Line;
  project: ProjectLineAssignment | null;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const dates = line.endDate && line.endDate !== line.date ? `${line.date} 至 ${line.endDate}` : line.date;
  return (
    <li className="expense-card" data-testid={`line-card-${line.no}`}>
      <input type="checkbox" aria-label={`选择明细 No.${line.no}`} checked={checked} disabled={disabled} onChange={onToggle} />
      <div className="expense-body">
        <strong>
          <span className="mono">No.{line.no}</span> · <span className="mono">{dates}</span> · {line.city ?? line.category.label}
        </strong>
        <p>{line.route ?? line.description}</p>
        {line.maskedNumber ? <p className="caption mono">{line.maskedNumber}</p> : null}
        <p className="expense-project" data-testid={`project-of-${line.no}`}>
          {project ? (
            <>
              <span className="mono">{project.projectNumber}</span> · {project.projectName}
            </>
          ) : (
            <span className="badge">未归属</span>
          )}
        </p>
      </div>
      <strong className="num">{line.grossAmount} 元</strong>
    </li>
  );
}
