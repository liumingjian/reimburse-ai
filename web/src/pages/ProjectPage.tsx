import { useCallback, useState, type KeyboardEvent } from 'react';
import { Button, Checkbox, ContentSwitcher, IconButton, InlineNotification, Search, Switch, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tag, TextInput } from '@carbon/react';
import { Add, View } from '@carbon/icons-react';
import {
  PROJECT_ASSIGNMENT_ERRORS,
  PROJECT_CONFLICT_COPY,
  PROJECT_DEADLINE_WARNING_COPY,
  PURPOSE_MAX_LENGTH,
  PROJECT_BOOK_COPY,
  PROJECT_RESELECT_COPY,
  PROJECT_SOURCE_LABEL,
  type Line,
  type ProjectLineAssignment,
  type ProjectSource,
  type TaskSnapshot,
  pageAllowed,
} from '@baox/contract';
import { navigate, taskHash } from '../router';
import { ActionBar } from '../shell/ActionBar';
import { ConfirmDialog } from '../shell/Dialog';
import { FieldGroup } from '../shell/FieldGroup';
import { PageHeader } from '../shell/PageHeader';
import { StatusTag } from '../shell/StatusTag';
import { useAction } from '../shell/useAction';
import { PAGE_COPY } from './page-copy';
import { ProjectBookPanel } from './ProjectBookPanel';
import { DeadlineWarningList } from './DeadlineWarningList';
import { LodgingPreview } from './LodgingPreview';
import { DiningPreview } from './DiningPreview';


// 项目归属页：待确认项处理完之后、整单确认之前（Skill 的 project_unassigned → select-task），两条路径都要经过。
// 提交后服务端自动做报销信息核对与材料准备，再进入整单确认；确认绑定项目归属，确认后在这里改派会使确认失效。
// ERP 写入开始后只读。Shape follows the workbench prototype (92b61a7 variant B, re-confirmed by the user on
// prototype/project-assign-interaction variant A): tick lines on the left, then click a project on the right. No modal.
// - 左边明细按费用类别分组（服务端给出的 lines 顺序即内核分类排序），组标题带复选框和条数，可按类别全选；
//   每条明细是一行紧凑的表格行（日期范围、城市、路线与脱敏票号、当前归属、价税合计），各组共用同一套列宽，与顶部表头对齐。
// - A sticky selection bar sits above the table: select-all, the 全部 / 未归属 (all / unassigned) filter, and a status
//   line that says what to do next (tick lines, then click a project) or what the last assignment did.
// - The right-hand 归入项目 (assign to project) panel is sticky between the step bar and the action bar. Its head
//   (search) stays put and only the project list scrolls. Every project is itself the drop target: clicking it assigns
//   the ticked lines, with no apply button. Projects used here come first (本次已归入) with line count and amount from
//   the server; the rest follow in project-book order. Until lines are ticked the projects are disabled and the head
//   says so. Enter in the search assigns to the only matching project.
// - If a ticked line already has another project, the page first asks 只处理未归属 (only unassigned) / 确认覆盖
//   (overwrite) / 取消 (cancel). 新增项目 (add project) opens the project-book panel; the ticked lines are kept.
// The page header holds the reimbursement purpose (报销事由); the home city is read-only. Submitting lives in the
// sticky action bar.

type Target = { number: string; name: string };
type Conflict = { lineIds: string[]; project: Target; count: number };
// One project in the panel. `usage` is set for projects this assignment already uses (from the server);
// `selectable` is false for a used project that left the allowed list (已锁定, locked): kept lines stay, new ones cannot go in.
type Option = Target & { source: ProjectSource; usage: { lineCount: number; grossTotal: string } | null; selectable: boolean };

function byLine(items: readonly ProjectLineAssignment[]): Readonly<Record<string, ProjectLineAssignment>> {
  return Object.fromEntries(items.map((item) => [item.lineId, item]));
}

// Search: every space-separated word must hit the project number or name, as a substring or with its characters in
// order, so an abbreviation like 浦发 finds 上海浦东发展银行. Returns the matched character positions, or null.
export function projectHits(text: string, query: string): ReadonlySet<number> | null {
  const hay = text.toLowerCase();
  const marks = new Set<number>();
  for (const word of query.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    const at = hay.indexOf(word);
    if (at >= 0) {
      for (let index = 0; index < word.length; index += 1) marks.add(at + index);
      continue;
    }
    let from = 0;
    for (const char of word) {
      const found = hay.indexOf(char, from);
      if (found < 0) return null;
      marks.add(found);
      from = found + 1;
    }
  }
  return marks;
}

function matches(project: Target, query: string): boolean {
  return projectHits(`${project.number} ${project.name}`, query) !== null;
}

// Marks the searched characters in a project number or name.
function Highlight({ text, query }: { text: string; query: string }) {
  const marks = query.trim() ? projectHits(text, query) : null;
  if (!marks || marks.size === 0) return <>{text}</>;
  return (
    <>
      {[...text].map((char, index) =>
        marks.has(index) ? (
          <mark key={index} className="app-search-hit">
            {char}
          </mark>
        ) : (
          char
        ),
      )}
    </>
  );
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

// 各组的明细表共用一套列宽（table-layout: fixed），与顶部的表头对齐。
function AssignColumns() {
  return (
    <colgroup>
      <col className="app-col-pick" />
      <col className="app-col-date" />
      <col className="app-col-place" />
      <col className="app-col-route" />
      <col className="app-col-project" />
      <col className="app-col-amount" />
    </colgroup>
  );
}

// 搜索框的 onChange 在点清除按钮时也会触发，这里只取输入框的值。
function searchValue(event: unknown): string {
  const target = typeof event === 'object' && event !== null && 'target' in event ? (event.target as HTMLInputElement | null) : null;
  return target?.value ?? '';
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
      <PageHeader
        title={PROJECT_BOOK_COPY.gateTitle}
        lead={PROJECT_BOOK_COPY.gateLead}
        actions={
          <div className="app-gate-continue">
            {/* 每屏一个主按钮：可以继续时它是主按钮，录入按钮降为次要；此前录入按钮是主按钮。 */}
            <Button kind={canContinue ? 'primary' : 'secondary'} disabled={!canContinue} onClick={onContinue}>
              {PROJECT_BOOK_COPY.gateContinue}
            </Button>
            {canContinue ? null : <span className="app-caption">{PROJECT_BOOK_COPY.gateContinueHint}</span>}
          </div>
        }
      />
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
  // 「归入」与提交是否可用只看服务端此刻接受的动作（snapshot.allowedActions），页面不自己推 step 与冻结规则。
  const canAct = snapshot.allowedActions.includes('submit_project_assignment');
  // 报销信息核对不匹配时，处置就是在本页改派后重新提交；材料包缺项在整单明细确认页处理。
  const catalogMismatch = snapshot.catalog.status === 'mismatch';
  const preparationBlocked = snapshot.preparation.status === 'blocked';
  const autoRunning = (snapshot.stage === 'catalog' || snapshot.stage === 'preparation') && !catalogMismatch && !preparationBlocked;
  const { lines } = snapshot;

  const [purpose, setPurpose] = useState(assignment.purpose ?? '');
  const [purposeTouched, setPurposeTouched] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [onlyUnassigned, setOnlyUnassigned] = useState(false);
  const [query, setQuery] = useState('');
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [deadlineConfirmation, setDeadlineConfirmation] = useState(false);
  const [adding, setAdding] = useState(false);
  // What the last assignment did, shown in the selection bar until lines are ticked again.
  const [lastAssigned, setLastAssigned] = useState<string | null>(null);
  const closeAdd = useCallback(() => setAdding(false), []);
  const { busy, error, run, clearError } = useAction(taskId);

  // 显示服务端记下的本次归属：只读（ERP 已开始）时是已提交的那一份，否则是正在编辑的 working。
  const current = byLine(locked ? assignment.assignments : assignment.working);
  const visible = onlyUnassigned ? lines.filter((line) => !current[line.lineId]) : lines;
  const groups = groupByCategory(visible);
  const allVisibleSelected = visible.length > 0 && visible.every((line) => selected.has(line.lineId));
  const used = new Set(assignment.usage.map((entry) => entry.number));
  const sourceOf = (number: string): ProjectSource => assignment.projects.find((project) => project.number === number)?.source ?? 'personal';
  // Used projects first (including locked ones, so their lines stay explained), then the rest in project-book order.
  const options: Option[] = [
    ...assignment.usage.map((entry) => ({
      number: entry.number,
      name: entry.name,
      source: sourceOf(entry.number),
      usage: { lineCount: entry.lineCount, grossTotal: entry.grossTotal },
      selectable: entry.selectable,
    })),
    ...assignment.projects.filter((project) => !used.has(project.number)).map((project) => ({ ...project, usage: null, selectable: true })),
  ];
  const shown = options.filter((option) => matches(option, query));
  const shownUsed = shown.filter((option) => option.usage !== null);
  const shownRest = shown.filter((option) => option.usage === null);
  const nothingSelected = selected.size === 0;
  const canAssign = canAct && !busy && !nothingSelected && conflict === null;
  const assignedCount = lines.filter((line) => current[line.lineId]).length;
  // 提交按钮只看表单是否填完（每条明细都已归属、事由非空）：这是 #105 要求的输入校验，不是业务判定；
  // 项目能否用、归属是否成立仍由服务端在提交时判定。
  const complete = assignedCount === lines.length && lines.length > 0 && purpose.trim().length > 0;
  const unchanged = submitted && purpose.trim() === assignment.purpose && assignment.working.length === assignment.assignments.length && assignment.working.every((item) =>
    assignment.assignments.some((saved) => saved.lineId === item.lineId && saved.projectNumber === item.projectNumber && saved.projectSource === item.projectSource));

  const toggle = (lineIds: readonly string[], on: boolean) => {
    setLastAssigned(null);
    setSelected((previous) => {
      const next = new Set(previous);
      for (const lineId of lineIds) {
        if (on) next.add(lineId);
        else next.delete(lineId);
      }
      return next;
    });
  };

  const filterUnassigned = (on: boolean) => {
    if (on === onlyUnassigned) return;
    setOnlyUnassigned(on);
    setSelected(new Set());
  };

  const assignLines = async (lineIds: string[], project: Target, onlyEmpty: boolean) => {
    setConflict(null);
    clearError();
    const outcome = await run((adapter) => adapter.assignProjectLines(taskId, { lineIds, projectNumber: project.number, onlyUnassigned: onlyEmpty }, snapshot.step.stepToken));
    if (outcome.ok) {
      setSelected(new Set());
      setLastAssigned(`已归入 ${project.number} ${project.name}`);
    }
  };

  // 冲突检测拿已勾选明细在服务端记下的本次归属与目标项目比较，只用来决定是否先弹出三选一提示。
  const assign = (project: Option) => {
    if (!canAssign || !project.selectable) return;
    const lineIds = lines.map((line) => line.lineId).filter((lineId) => selected.has(lineId));
    const conflicts = lineIds.filter((lineId) => {
      const existing = current[lineId];
      return existing !== undefined && existing.projectNumber !== project.number;
    });
    if (conflicts.length > 0) setConflict({ lineIds, project, count: conflicts.length });
    else void assignLines(lineIds, project, false);
  };

  // Enter in the search box assigns the ticked lines when exactly one selectable project matches.
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    const candidates = shown.filter((option) => option.selectable);
    if (candidates.length === 1) assign(candidates[0]!);
  };

  const cancelConflict = useCallback(() => setConflict(null), []);

  const submit = async (acceptDeadlineWarnings = false) => {
    setPurposeTouched(true);
    if (!purpose.trim()) return;
    if (unchanged) {
      navigate(taskHash(taskId, 'review'));
      return;
    }
    const projects: Record<string, string> = {};
    for (const item of assignment.working) projects[item.lineId] = item.projectNumber;
    const outcome = await run((adapter) => adapter.submitProjectAssignment(taskId, { purpose: purpose.trim(), projects, acceptDeadlineWarnings }, snapshot.step.stepToken));
    if (outcome.ok) {
      setDeadlineConfirmation(false);
      navigate(taskHash(taskId, 'review'));
    }
  };

  const requestSubmit = () => {
    clearError();
    if (unchanged) void submit();
    else if (assignment.deadlineWarnings.length > 0) setDeadlineConfirmation(true);
    else void submit();
  };

  const submittedText = preparationBlocked
    ? '项目归属已提交。材料包还有缺项，请在整单明细确认页处理。'
    : autoRunning
      ? '项目归属已提交，正在核对报销信息并准备报销材料。'
      : '项目归属已提交。改派项目或修改事由会使整单明细确认失效，需要重新确认。';

  const selectionStatus = locked ? '项目归属已锁定' : nothingSelected ? (lastAssigned ?? '勾选明细后，点右侧项目归入') : `已选 ${selected.size} 条，点右侧项目归入`;
  const panelStatus = locked ? '不能再修改' : nothingSelected ? '先勾选左侧明细' : `已选 ${selected.size} 条`;

  const projectItem = (option: Option) => (
    <li key={option.number}>
      <button
        type="button"
        className="app-project-target"
        disabled={!canAssign || !option.selectable}
        aria-describedby="assign-panel-status"
        onClick={() => assign(option)}
      >
        <span className="app-project-target-name">
          <Highlight text={option.name} query={query} />
        </span>
        <span className="app-project-target-meta">
          <span className="app-code">
            <Highlight text={option.number} query={query} />
          </span>
          <Tag type={option.source === 'public' ? 'teal' : 'gray'} size="sm">
            {PROJECT_SOURCE_LABEL[option.source]}
          </Tag>
          {/* 条数与金额来自服务端，页面不计算。 */}
          {option.usage ? (
            <span className="app-caption" data-testid={`usage-${option.number}`}>
              {option.usage.lineCount} 条 / {option.usage.grossTotal} 元
            </span>
          ) : null}
          {/* A project deleted from the project book: lines already assigned keep it, but it cannot take new lines. */}
          {option.selectable ? null : <StatusTag tone="locked">已锁定</StatusTag>}
        </span>
      </button>
    </li>
  );

  return (
    <>
      <PageHeader title={copy.title} lead={copy.lead}>
        <span className="app-head-fields">
          <TextInput
            id="purpose"
            className="app-purpose"
            labelText="报销事由（必填）"
            aria-label="报销事由"
            invalid={purposeTouched && !purpose.trim()}
            invalidText="请填写报销事由，不能只输入空格。"
            value={purpose}
            maxLength={PURPOSE_MAX_LENGTH}
            required
            disabled={locked}
            placeholder="如：上海产品评审出差"
            onChange={(event) => { setPurpose(event.target.value); setPurposeTouched(true); }}
            onBlur={() => setPurposeTouched(true)}
          />
          {/* 常驻城市在新建任务时确认，这里只读；做成带标签的只读字段，与报销事由上下对齐。 */}
          <TextInput id="home-city" className="app-home-city" labelText="常驻城市" value={assignment.homeCity ?? '未确认'} readOnly />
        </span>
      </PageHeader>

      {locked ? (
        <InlineNotification kind="info" role="status" lowContrast hideCloseButton statusIconDescription="提示" title="已开始写入报销系统，项目归属不能再修改。" />
      ) : catalogMismatch ? (
        <InlineNotification
          kind="error"
          role="alert"
          lowContrast
          hideCloseButton
          statusIconDescription="错误"
          title={`报销信息核对发现项目不匹配：${snapshot.catalog.problems.map((problem) => problem.reason).join('；')}。请把相关明细改派到其他项目后重新提交，提交后会自动重新核对。`}
        />
      ) : submitted ? (
        <div className="app-notice">
          <InlineNotification
            kind={preparationBlocked ? 'warning' : 'success'}
            role="status"
            lowContrast
            hideCloseButton
            statusIconDescription={preparationBlocked ? '注意' : '成功'}
            title={submittedText}
          />
          {pageAllowed(snapshot, 'review') ? (
            <Button kind="tertiary" size="sm" href={taskHash(taskId, 'review')}>
              去整单明细确认
            </Button>
          ) : null}
        </div>
      ) : null}

      {assignment.deadlineWarnings.length > 0 ? (
        <InlineNotification kind="warning" role="alert" lowContrast hideCloseButton statusIconDescription="注意" title={PROJECT_DEADLINE_WARNING_COPY.title}>
          <p>{PROJECT_DEADLINE_WARNING_COPY.notice}</p>
          <DeadlineWarningList warnings={assignment.deadlineWarnings} />
        </InlineNotification>
      ) : null}

      {/* #194: projects removed or deactivated before submission. The server already took these lines out of the
          draft; the user picks a project for them again. */}
      {!locked && assignment.reselect.length > 0 ? (
        <InlineNotification kind="warning" role="alert" lowContrast hideCloseButton statusIconDescription="注意" title={PROJECT_RESELECT_COPY.title(assignment.reselect.length)}>
          <ul className="app-reselect" data-testid="project-reselect">
            {assignment.reselect.map((item) => (
              <li key={item.lineId}>{PROJECT_RESELECT_COPY.line(lines.find((line) => line.lineId === item.lineId)?.no ?? 0, item.projectNumber, item.projectName)}</li>
            ))}
          </ul>
        </InlineNotification>
      ) : null}

      <div className="app-project-split bleed">
        <section className="app-assign-main" aria-label="费用明细">
          {/* Sticky selection bar under the step bar: select-all, the filter, and what to do next. */}
          <div className={nothingSelected ? 'app-assign-toolbar' : 'app-assign-toolbar is-selecting'} role="group" aria-label="明细选择与筛选">
            <Checkbox
              id="assign-select-all"
              labelText="全选当前明细"
              checked={allVisibleSelected}
              disabled={locked || visible.length === 0}
              onChange={() => toggle(visible.map((line) => line.lineId), !allVisibleSelected)}
            />
            {/* Filtering is not row selection: like the task list it uses a ContentSwitcher (全部 all / 未归属 unassigned). */}
            <ContentSwitcher aria-label="明细筛选" selectedIndex={onlyUnassigned ? 1 : 0} onChange={(data: { index?: number }) => filterUnassigned(data.index === 1)}>
              <Switch name="all" text="全部" disabled={locked} />
              <Switch name="unassigned" text="未归属" disabled={locked} />
            </ContentSwitcher>
            <span className="app-assign-status" role="status" data-testid="assign-selection">
              {selectionStatus}
            </span>
            {nothingSelected ? null : (
              <Button kind="ghost" size="sm" onClick={() => setSelected(new Set())}>
                取消选择
              </Button>
            )}
          </div>
          {groups.length > 0 ? (
            <>
              {/* 表头只画一次（各组的表共用列宽）；读屏从每组表格的名称与单元格读出内容。 */}
              <Table className="app-assign-table app-assign-colhead" size="sm" aria-hidden="true">
                <AssignColumns />
                <TableHead>
                  <TableRow>
                    <TableHeader className="app-no">No.</TableHeader>
                    <TableHeader>日期</TableHeader>
                    <TableHeader>城市</TableHeader>
                    <TableHeader>路线 / 说明</TableHeader>
                    <TableHeader>项目</TableHeader>
                    <TableHeader className="app-num">价税合计</TableHeader>
                  </TableRow>
                </TableHead>
              </Table>
              {groups.map((group) => {
                const ids = group.lines.map((line) => line.lineId);
                const all = ids.every((lineId) => selected.has(lineId));
                const some = !all && ids.some((lineId) => selected.has(lineId));
                return (
                  <section key={group.label} className="app-assign-group" aria-label={group.label}>
                    <h2 className="app-assign-group-head">
                      <Checkbox
                        id={`assign-group-${group.label}`}
                        labelText={`选择${group.label}`}
                        hideLabel
                        checked={all}
                        indeterminate={some}
                        disabled={locked}
                        onChange={() => toggle(ids, !all)}
                      />
                      <span>{group.label}</span>
                      <span className="app-caption">{group.lines.length} 条</span>
                    </h2>
                    <Table className="app-assign-table" size="sm" aria-label={`${group.label}明细`}>
                      <AssignColumns />
                      <TableBody>
                        {group.lines.map((line) => (
                          <LineRow
                            key={line.lineId}
                            line={line}
                            snapshot={snapshot}
                            project={current[line.lineId] ?? null}
                            checked={selected.has(line.lineId)}
                            disabled={locked}
                            onToggle={() => toggle([line.lineId], !selected.has(line.lineId))}
                          />
                        ))}
                      </TableBody>
                    </Table>
                  </section>
                );
              })}
            </>
          ) : (
            <p className="app-caption app-assign-empty">所有明细都已归属。</p>
          )}
        </section>

        {/* The projects are the drop targets: clicking one assigns the ticked lines. Pinned beside the table. */}
        <aside className="app-project-panel" role="complementary" aria-label="归入项目">
          <div className="app-project-panel-head">
            <div className="app-project-panel-title">
              <h2>归入项目</h2>
              <span className="app-caption" id="assign-panel-status">
                {panelStatus}
              </span>
            </div>
            <Search
              size="md"
              labelText="查找项目"
              placeholder="搜项目号或名称"
              closeButtonLabelText="清除查找"
              value={query}
              onChange={(event: unknown) => setQuery(searchValue(event))}
              onKeyDown={onSearchKey}
            />
          </div>
          <div className="app-project-panel-list">
            {options.length === 0 ? (
              <p className="app-caption app-project-empty">{PROJECT_ASSIGNMENT_ERRORS.bookEmpty}</p>
            ) : shown.length === 0 ? (
              <p className="app-caption app-project-empty" role="status">
                没有匹配的项目
              </p>
            ) : (
              <>
                {shownUsed.length > 0 ? (
                  <>
                    <h3 className="app-project-panel-group">本次已归入</h3>
                    <ul className="app-project-targets" aria-label="本次已归入">
                      {shownUsed.map(projectItem)}
                    </ul>
                  </>
                ) : null}
                {shownRest.length > 0 ? (
                  <>
                    <h3 className="app-project-panel-group">可选项目</h3>
                    <ul className="app-project-targets" aria-label="可选项目">
                      {shownRest.map(projectItem)}
                    </ul>
                  </>
                ) : null}
              </>
            )}
          </div>
          <div className="app-project-panel-foot">
            {/* In-place add (a small enhancement over the Skill, noted in the README): opens the project-book panel; the
                ticked lines are kept. A new project shows up in the list with the next snapshot the server pushes. */}
            <Button kind="ghost" size="sm" renderIcon={Add} disabled={locked} onClick={() => setAdding(true)}>
              {PROJECT_BOOK_COPY.addProject}
            </Button>
          </div>
        </aside>
      </div>

      {/* 吸底操作栏：左边已归属条数与服务端给出的整单合计（不是已归属部分的合计），右边唯一的主按钮。
          合计取 projectAssignment.grossTotal，不是 confirmation.grossTotal：后者绑的是整单确认，
          归属提交之前一直是 null，读它会让这里只剩一个「元」。 */}
      <ActionBar
        label="提交项目归属"
        consequenceProps={{ 'data-testid': 'assign-summary' }}
        consequence={
          <FieldGroup
            label="归属进度"
            fields={[
              { label: '已归属', value: `${assignedCount} / ${lines.length} 条` },
              { label: '整单合计', value: `${snapshot.projectAssignment.grossTotal} 元` },
            ]}
          />
        }
        caption={!locked && !complete ? PROJECT_ASSIGNMENT_ERRORS.incomplete : null}
        actions={
          <Button disabled={!canAct || busy || !complete || conflict !== null} onClick={requestSubmit}>
            {unchanged ? '继续' : '确认项目归属'}
          </Button>
        }
        error={error}
      />

      {conflict ? (
        <ConfirmDialog
          title={PROJECT_CONFLICT_COPY.title(conflict.count)}
          confirmLabel={PROJECT_CONFLICT_COPY.overwrite}
          cancelLabel={PROJECT_CONFLICT_COPY.cancel}
          extraLabel={PROJECT_CONFLICT_COPY.onlyEmpty}
          onExtra={() => void assignLines(conflict.lineIds, conflict.project, true)}
          onConfirm={() => void assignLines(conflict.lineIds, conflict.project, false)}
          onCancel={cancelConflict}
        >
          <p>
            要归入 {conflict.project.number} {conflict.project.name}。「只处理未归属」只给还没有项目的明细归入；「确认覆盖」把已勾选的明细全部改为这个项目。
          </p>
        </ConfirmDialog>
      ) : null}

      {deadlineConfirmation ? (
        <ConfirmDialog
          title={PROJECT_DEADLINE_WARNING_COPY.title}
          confirmLabel={PROJECT_DEADLINE_WARNING_COPY.continue}
          busy={busy}
          error={error}
          onConfirm={() => void submit(true)}
          onCancel={() => {
            clearError();
            setDeadlineConfirmation(false);
          }}
        >
          <p>{PROJECT_DEADLINE_WARNING_COPY.notice}</p>
          <DeadlineWarningList warnings={assignment.deadlineWarnings} />
        </ConfirmDialog>
      ) : null}

      {adding ? (
        <ConfirmDialog title={PROJECT_BOOK_COPY.addProject} confirmLabel={PROJECT_BOOK_COPY.addDialogDone} wide single focusCancel={false} onConfirm={closeAdd} onCancel={closeAdd}>
          <ProjectBookPanel primaryIntake autoFocus />
        </ConfirmDialog>
      ) : null}
    </>
  );
}

// 明细行（内核 project-workbench.mjs 的明细卡片，改成一行）：No.、日期范围、城市（没有城市的如长途交通显示费用类别）、
// 路线（没有路线的如住宿显示说明）与脱敏票号、当前归属、价税合计。
function LineRow({
  line,
  snapshot,
  project,
  checked,
  disabled,
  onToggle,
}: {
  line: Line;
  snapshot: TaskSnapshot;
  project: ProjectLineAssignment | null;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const lodging = snapshot.lodgingEvidence.find((evidence) => evidence.materialId === line.voucherMaterialId);
  const preview = lodging ? { label: '住宿材料', Component: LodgingPreview } : line.category.code === 'hospitality' ? { label: '餐饮材料', Component: DiningPreview } : null;
  const dates = line.endDate && line.endDate !== line.date ? `${line.date} 至 ${line.endDate}` : line.date;
  return (
    <TableRow className={checked ? 'app-row-selected' : ''} data-testid={`line-card-${line.no}`}>
      <TableCell className="app-no app-pick-no">
        <span className="app-pick-label">
          <Checkbox id={`pick-${line.lineId}`} labelText={`选择明细 No.${line.no}`} hideLabel checked={checked} disabled={disabled} onChange={onToggle} />
          <span className="app-muted">No.{line.no}</span>
        </span>
      </TableCell>
      <TableCell className="app-nowrap">{lodging ? `${lodging.fields.checkIn?.value ?? '入住未提供'} 至 ${lodging.fields.checkOut?.value ?? '离店未提供'}` : dates}</TableCell>
      <TableCell>{lodging ? lodging.fields.location?.value ?? '住宿地未提供' : line.city ?? line.category.label}</TableCell>
      <TableCell className="app-wrap">
        {lodging ? lodging.fields.hotelName?.value ?? '酒店名称未提供' : line.route ?? line.description}
        {preview ? <><IconButton className="app-inline-icon" kind="ghost" size="sm" label={`查看${preview.label} No.${line.no}`} align="top" onClick={() => setPreviewOpen(true)}><View /></IconButton>{previewOpen ? <ConfirmDialog title={`${preview.label} No.${line.no}`} confirmLabel="关闭预览" single wide onConfirm={() => setPreviewOpen(false)} onCancel={() => setPreviewOpen(false)}><preview.Component snapshot={snapshot} materialId={line.voucherMaterialId} /></ConfirmDialog> : null}</> : null}
        {line.maskedNumber ? <div className="app-caption app-code">{line.maskedNumber}</div> : null}
      </TableCell>
      <TableCell data-testid={`project-of-${line.no}`}>
        {project ? (
          <span className="app-project-of" title={`${project.projectNumber} / ${project.projectName}`}>
            <span className="app-code">{project.projectNumber}</span> / {project.projectName}
          </span>
        ) : (
          <Tag type="gray" size="sm">
            未归属
          </Tag>
        )}
      </TableCell>
      <TableCell className="app-num">{line.grossAmount} 元</TableCell>
    </TableRow>
  );
}
