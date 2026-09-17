import { useCallback, useState } from 'react';
import {
  Button,
  Checkbox,
  ComposedModal,
  ContentSwitcher,
  InlineNotification,
  ModalBody,
  ModalFooter,
  ModalHeader,
  RadioButton,
  RadioButtonGroup,
  Search,
  Switch,
  Table,
  TableBatchAction,
  TableBatchActions,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableToolbar,
  TableToolbarContent,
  Tag,
  TextInput,
} from '@carbon/react';
import { Add } from '@carbon/icons-react';
import {
  PROJECT_ASSIGNMENT_ERRORS,
  PROJECT_CONFLICT_COPY,
  PURPOSE_MAX_LENGTH,
  PROJECT_BOOK_COPY,
  PROJECT_RESELECT_COPY,
  PROJECT_SOURCE_LABEL,
  type Line,
  type ProjectLineAssignment,
  type ProjectSource,
  type StepKind,
  type TaskSnapshot,
  pageAllowed,
} from '@baox/contract';
import { navigate, taskHash } from '../router';
import { ActionBar } from '../shell/ActionBar';
import { ConfirmDialog, DIALOG_CLOSE_LABEL } from '../shell/Dialog';
import { FieldGroup } from '../shell/FieldGroup';
import { PageHeader } from '../shell/PageHeader';
import { StatusTag } from '../shell/StatusTag';
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
//   每条明细是一行紧凑的表格行（日期范围、城市、路线与脱敏票号、当前归属、价税合计），各组共用同一套列宽，与顶部表头对齐。
// - The right-hand summary (本次归属, this assignment) is read-only: the projects this assignment uses, with project
//   number, line count and amount (from the server; the page computes nothing). No buttons.
//   Below 1280px it moves under the line table, so the table keeps readable column widths.
// Carbon batch-action mode (#138): once lines are selected, the table toolbar turns into the batch action bar
// (已选 N 条, 归入项目 assign to project, 取消 cancel). With nothing selected there is no way to assign.
// 归入项目 opens the project modal: a search plus a single-choice list of selectable projects only (the snapshot
// only lists selectable ones), with projects already used here first and their line counts.
// From the modal the user can open the 新增项目 (add project) panel; the selected lines and the chosen project are
// kept. On confirm the server changes the assignment being edited (working).
// If a selected line already has another project, the page first asks 只处理未归属 (only unassigned) / 确认覆盖
// (overwrite) / 取消 (cancel). The page header holds the reimbursement purpose (报销事由); the home city is
// read-only. Submitting lives in the sticky action bar.

type Target = { number: string; name: string };
type Conflict = { project: Target; count: number };
// One entry in the project modal: projects already used here carry the server's line count; the rest carry null.
// `source` says which book offers it (个人 personal / 公共 public, #194).
type Option = Target & { lineCount: number | null; source: ProjectSource };
// At most one modal at a time: the project modal and the 新增项目 (add project) panel take turns (never stacked);
// closing the panel returns to the project modal.
type Modal = 'none' | 'pick' | 'add';

// Chinese copy for Carbon's batch action bar (defaults are English: "items selected", "Cancel").
function batchText(id: string, args?: { totalSelected?: number }): string {
  if (id === 'carbon.table.batch.cancel') return '取消';
  return `已选 ${args?.totalSelected ?? 0} 条`;
}

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
  const [modal, setModal] = useState<Modal>('none');
  // Project number picked in the project modal (single choice); kept across a trip to the add-project panel.
  const [pickedNumber, setPickedNumber] = useState<string | null>(null);
  const closeAdd = useCallback(() => setModal('pick'), []);
  const { busy, error, run, clearError } = useAction(taskId);

  // 显示服务端记下的本次归属：只读（ERP 已开始）时是已提交的那一份，否则是正在编辑的 working。
  const current = byLine(locked ? assignment.assignments : assignment.working);
  const visible = onlyUnassigned ? lines.filter((line) => !current[line.lineId]) : lines;
  const groups = groupByCategory(visible);
  const allVisibleSelected = visible.length > 0 && visible.every((line) => selected.has(line.lineId));
  const used = new Set(assignment.usage.map((entry) => entry.number));
  // The modal lists selectable projects only: those already used here (and still selectable) first, with line counts;
  // the rest in project-book order. Locked projects cannot take new lines, so they are not listed.
  const sourceOf = (number: string): ProjectSource => assignment.projects.find((project) => project.number === number)?.source ?? 'personal';
  const options: Option[] = [
    ...assignment.usage.filter((entry) => entry.selectable).map((entry) => ({ number: entry.number, name: entry.name, lineCount: entry.lineCount, source: sourceOf(entry.number) })),
    ...assignment.projects.filter((project) => !used.has(project.number)).map((project) => ({ number: project.number, name: project.name, lineCount: null, source: project.source })),
  ];
  const shownOptions = options.filter((option) => matches(option, query));
  // The picked project, if it still matches the search; otherwise nothing is picked.
  const pickedOption = shownOptions.find((option) => option.number === pickedNumber) ?? null;
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

  const filterUnassigned = (on: boolean) => {
    if (on === onlyUnassigned) return;
    setOnlyUnassigned(on);
    setSelected(new Set());
  };

  const assignSelected = async (number: string, onlyEmpty: boolean) => {
    setConflict(null);
    clearError();
    const lineIds = lines.map((line) => line.lineId).filter((lineId) => selected.has(lineId));
    const outcome = await run((adapter) => adapter.assignProjectLines(taskId, { lineIds, projectNumber: number, onlyUnassigned: onlyEmpty }, snapshot.step.stepToken));
    if (outcome.ok) setSelected(new Set());
  };

  const openPicker = () => {
    setQuery('');
    setPickedNumber(null);
    setModal('pick');
  };

  // 冲突检测拿已勾选明细在服务端记下的本次归属与目标项目比较，只用来决定是否先弹出三选一提示。
  const assign = (project: Target) => {
    setModal('none');
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

  const submittedText = preparationBlocked
    ? '项目归属已提交。材料包还有缺项，请在整单明细确认页处理。'
    : autoRunning
      ? '项目归属已提交，正在核对报销信息并准备报销材料。'
      : '项目归属已提交。改派项目或修改事由会使整单明细确认失效，需要重新确认。';

  return (
    <>
      <PageHeader title={copy.title} lead={copy.lead}>
        <span className="app-head-fields">
          <TextInput
            id="purpose"
            className="app-purpose"
            labelText="报销事由"
            value={purpose}
            maxLength={PURPOSE_MAX_LENGTH}
            required
            disabled={locked}
            placeholder="如：上海产品评审出差"
            onChange={(event) => setPurpose(event.target.value)}
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
          {pageAllowed(snapshot.stage, 'review') ? (
            <Button kind="tertiary" size="sm" href={taskHash(taskId, 'review')}>
              去整单明细确认
            </Button>
          ) : null}
        </div>
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
          {/* Carbon table toolbar: normally one row with select-all, the filter and the selected count; once lines are
              selected the batch action bar covers that row (已选 N 条, 归入项目, 取消).
              While the batch action bar is not shown Carbon gives it aria-hidden, so screen readers and role queries skip it. */}
          <TableToolbar aria-label="明细工具栏">
            <TableBatchActions
              role="region"
              aria-label="批量操作"
              shouldShowBatchActions={selected.size > 0}
              totalSelected={selected.size}
              onCancel={() => setSelected(new Set())}
              translateWithId={batchText}
            >
              <TableBatchAction renderIcon={Add} iconDescription="归入项目" disabled={!canAct || busy} onClick={openPicker}>
                归入项目
              </TableBatchAction>
            </TableBatchActions>
            <TableToolbarContent className="app-assign-toolbar" role="group" aria-label="明细选择与筛选" aria-hidden={selected.size > 0}>
              <Checkbox
                id="assign-select-all"
                labelText="全选当前明细"
                checked={allVisibleSelected}
                disabled={locked || visible.length === 0}
                onChange={() => toggle(visible.map((line) => line.lineId), !allVisibleSelected)}
              />
              {/* Filtering is not row selection: like the task list it uses a ContentSwitcher (全部 all / 未归属 unassigned),
                  not a checkbox, sized to its content. */}
              <ContentSwitcher aria-label="明细筛选" size="sm" selectedIndex={onlyUnassigned ? 1 : 0} onChange={(data: { index?: number }) => filterUnassigned(data.index === 1)}>
                <Switch name="all" text="全部" disabled={locked} />
                <Switch name="unassigned" text="未归属" disabled={locked} />
              </ContentSwitcher>
              <span className="app-caption app-assign-count">已选 {selected.size} 条</span>
            </TableToolbarContent>
          </TableToolbar>
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

        {/* Read-only summary of the projects this assignment uses; every number comes from the server. Picking a project
            happens in the 归入项目 (assign to project) modal. */}
        <aside className="app-project-aside" role="complementary" aria-label="本次归属">
          <h2 className="app-aside-title">本次归属</h2>
          {assignment.usage.length > 0 ? (
            <ul className="app-project-options" aria-label="本次归属的项目">
              {assignment.usage.map((entry) => (
                <li key={entry.number} className={entry.selectable ? undefined : 'is-locked'}>
                  <div>
                    <div className="name">{entry.name}</div>
                    {/* 条数与金额来自服务端，页面不计算；用字段组代替中点串。 */}
                    <div data-testid={`usage-${entry.number}`}>
                      <FieldGroup
                        label={`${entry.name}的归入情况`}
                        fields={[
                          { label: '项目号', value: <span className="app-code">{entry.number}</span> },
                          { label: '条数', value: `${entry.lineCount} 条` },
                          { label: '价税合计', value: `${entry.grossTotal} 元` },
                        ]}
                      />
                    </div>
                  </div>
                  {/* A project deleted from the project book: lines already assigned keep it, but it cannot take new lines
                      (the modal does not list it). */}
                  {entry.selectable ? null : <StatusTag tone="locked">已锁定</StatusTag>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="app-caption app-project-empty">暂无</p>
          )}
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
          <Button disabled={!canAct || busy || !complete || conflict !== null} onClick={() => void submit()}>
            确认项目归属
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
          onExtra={() => void assignSelected(conflict.project.number, true)}
          onConfirm={() => void assignSelected(conflict.project.number, false)}
          onCancel={cancelConflict}
        >
          <p>
            要归入 {conflict.project.number} {conflict.project.name}。「只处理未归属」只给还没有项目的明细归入；「确认覆盖」把已勾选的明细全部改为这个项目。
          </p>
        </ConfirmDialog>
      ) : null}

      {modal === 'pick' ? (
        <ComposedModal open size="sm" aria-label="归入项目" preventCloseOnClickOutside={false} onClose={() => setModal('none')}>
          <ModalHeader title="归入项目" label={`已选 ${selected.size} 条明细`} iconDescription={DIALOG_CLOSE_LABEL} />
          <ModalBody>
            <Search
              size="md"
              labelText="查找项目"
              placeholder="查找项目号或名称"
              closeButtonLabelText="清除查找"
              value={query}
              data-modal-primary-focus
              onChange={(event: unknown) => setQuery(searchValue(event))}
            />
            {options.length === 0 ? (
              <p className="app-caption app-project-empty">{PROJECT_ASSIGNMENT_ERRORS.bookEmpty}</p>
            ) : shownOptions.length === 0 ? (
              <p className="app-caption app-project-empty" role="status">
                没有匹配的可选项目
              </p>
            ) : (
              <RadioButtonGroup
                className="app-project-picker"
                name="assign-project"
                legendText="选择项目"
                orientation="vertical"
                valueSelected={pickedOption?.number ?? ''}
                onChange={(value: unknown) => setPickedNumber(String(value))}
              >
                {shownOptions.map((option) => (
                  <RadioButton
                    key={option.number}
                    id={`assign-project-${option.number}`}
                    value={option.number}
                    labelText={
                      <span className="app-picker-option">
                        <span className="name">{option.name}</span>
                        <span className="app-code app-caption">{option.number}</span>
                        <Tag type={option.source === 'public' ? 'teal' : 'gray'} size="sm">
                          {PROJECT_SOURCE_LABEL[option.source]}
                        </Tag>
                        {/* Projects already used here show their line count (from the server). */}
                        {option.lineCount !== null ? <span className="app-caption">本次 {option.lineCount} 条</span> : null}
                      </span>
                    }
                  />
                ))}
              </RadioButtonGroup>
            )}
            {/* In-place add (a small enhancement over the Skill, noted in the README): swaps to the project-book panel and
                returns here on close, keeping the selected lines and the picked project. A new project shows up in the list
                with the next snapshot the server pushes. Disabled once ERP writing has started, like every edit here. */}
            <Button kind="ghost" size="sm" renderIcon={Add} disabled={locked} onClick={() => setModal('add')}>
              {PROJECT_BOOK_COPY.addProject}
            </Button>
          </ModalBody>
          <ModalFooter>
            <Button kind="secondary" onClick={() => setModal('none')}>
              取消
            </Button>
            <Button disabled={!pickedOption || !canAct || busy} onClick={() => (pickedOption ? assign(pickedOption) : undefined)}>
              确认归入
            </Button>
          </ModalFooter>
        </ComposedModal>
      ) : null}

      {modal === 'add' ? (
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
    <TableRow className={checked ? 'app-row-selected' : ''} data-testid={`line-card-${line.no}`}>
      <TableCell className="app-no app-pick-no">
        <span className="app-pick-label">
          <Checkbox id={`pick-${line.lineId}`} labelText={`选择明细 No.${line.no}`} hideLabel checked={checked} disabled={disabled} onChange={onToggle} />
          <span className="app-muted">No.{line.no}</span>
        </span>
      </TableCell>
      <TableCell className="app-nowrap">{dates}</TableCell>
      <TableCell>{line.city ?? line.category.label}</TableCell>
      <TableCell className="app-wrap">
        {line.route ?? line.description}
        {line.maskedNumber ? <div className="app-caption app-code">{line.maskedNumber}</div> : null}
      </TableCell>
      <TableCell data-testid={`project-of-${line.no}`}>
        {project ? (
          <>
            <span className="app-code">{project.projectNumber}</span> / {project.projectName}
          </>
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
