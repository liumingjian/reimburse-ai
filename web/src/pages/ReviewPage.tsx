import { useState } from 'react';
import {
  Button,
  InlineNotification,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TextInput,
  Toggletip,
  ToggletipButton,
  ToggletipContent,
} from '@carbon/react';
import { ChevronDown, Folder, Information, Launch, Printer } from '@carbon/icons-react';
import {
  CATALOG_MISMATCH_COLUMNS,
  CATALOG_PREPARATION_COPY,
  CONFIRMATION_NO_COLUMN,
  CONFIRMATION_TABLE_COLUMNS,
  PREPARATION_PROBLEM_COLUMNS,
  PROJECT_DEADLINE_WARNING_COPY,
  type Line,
  type TaskSnapshot,
  STAGE_DEFAULT_PAGE,
} from '@baox/contract';
import { formatDateTime } from '../format';
import { navigate, taskHash } from '../router';
import { ActionBar } from '../shell/ActionBar';
import { ActionError } from '../shell/ActionError';
import { ConfirmDialog } from '../shell/Dialog';
import { PageHeader } from '../shell/PageHeader';
import { SummaryBar, SummaryField } from '../shell/SummaryBar';
import { useAction } from '../shell/useAction';
import { useReopenUpload } from '../shell/useReopenUpload';
import { PAGE_COPY, REVIEW_ORDER_NOTE } from './page-copy';
import { DeadlineWarningList } from './DeadlineWarningList';

// 整单明细确认页：Skill 的唯一一次整单确认（preparation_confirmation），在项目归属、报销信息核对与材料准备之后。
// 表格形状照内核 preparationConfirmationTable（next.mjs:513-559）：No. 加 13 列，按服务端给出的 lines[] 顺序（内核分类排序）逐行列出，
// 无组标题、无合计行、不排序，表内不展示文件名、完整发票号与参考材料；材料包文件清单在摘要条里（默认收起，#114 要求），
// 文件名只出现在这一节，类别名由服务端给出（不用「参考材料」字样）。
// 只能确认，不在表内修改：有不对的地方回到对应步骤修改。确认绑定项目归属，改派项目会使确认失效（提示由服务端给出）。
// 提交项目归属后服务端自动做报销信息核对与材料准备（进度照内核话术）：核对不匹配时显示不匹配表，唯一处置是回到项目归属改派；
// 材料包有缺项时显示缺项表，「确认」不可用，可排除服务端标明的相关材料。
// The server starts 去报销 after confirmation. The paired extension opens the task's ERP tab; filling ends at an
// attended handoff, where the employee saves and submits the form.
// 「追加材料」先二次确认，再请服务端使确认失效并回到上传页。支付截图在打印稿页补充，不在这里。

// 常驻城市：到第一次写入报销系统之前都可以改；改了会重新划分本地与外地市内交通，确认随之失效（服务端判定）。
// The summary bar only shows it; 修改常驻城市 sits with the page's other edit actions and opens this dialog.
function HomeCityDialog({ snapshot, onClose }: { snapshot: TaskSnapshot; onClose: () => void }) {
  const taskId = snapshot.task.taskId;
  const [value, setValue] = useState(snapshot.task.homeCity ?? '');
  const action = useAction(taskId);
  const save = async () => {
    if (value.trim() === '') return;
    const outcome = await action.run((adapter) => adapter.setTaskHomeCity(taskId, value.trim(), snapshot.step.stepToken));
    if (outcome.ok) onClose();
  };
  return (
    <ConfirmDialog title="修改常驻城市" confirmLabel="保存" focusCancel={false} busy={action.busy} error={action.error} onConfirm={() => void save()} onCancel={onClose}>
      <TextInput
        id="review-home-city"
        labelText="常驻城市"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        helperText="改了会重新划分本地与外地市内交通，整单确认随之失效。"
        data-modal-primary-focus
      />
    </ConfirmDialog>
  );
}

// 两步正在进行时的进度提示：确认暂不可用。
function autoStepNotice(snapshot: TaskSnapshot): string | null {
  const { stage, catalog, preparation } = snapshot;
  if (stage === 'catalog' && catalog.status === 'running') return CATALOG_PREPARATION_COPY.catalogRunning;
  if (stage === 'preparation' && preparation.status === 'pending') return CATALOG_PREPARATION_COPY.preparationRunning;
  return null;
}

const NUMERIC_COLUMNS: ReadonlySet<string> = new Set(['费用金额', '税额', '总额']);
// 长文字列吸收剩余宽度并允许换行（中文只在「编码 / 名称」之间断开）；其余列按内容收紧、不折行。
// 项目号与费用项目是「编码 / 名称」一对，折成两行难读：它们按内容定宽不折行，窄窗口时整张表横向滚动。
const WRAP_COLUMNS: ReadonlySet<string> = new Set(['出发点', '目的地', '费用分类']);

// 金额列右对齐；表比容器宽时整张表横向滚动，No. 固定在左、总额固定在右。
const STICKY_END_COLUMN = CONFIRMATION_TABLE_COLUMNS[CONFIRMATION_TABLE_COLUMNS.length - 1];
function columnClass(label: string): string {
  return [NUMERIC_COLUMNS.has(label) ? 'app-num' : WRAP_COLUMNS.has(label) ? 'app-wrap' : 'app-nowrap', label === STICKY_END_COLUMN ? 'app-sticky-end app-gross' : '']
    .filter(Boolean)
    .join(' ');
}

function headClass(label: string): string {
  return [NUMERIC_COLUMNS.has(label) ? 'app-num' : '', label === STICKY_END_COLUMN ? 'app-sticky-end' : '', label.includes('/') ? 'app-wrap-head' : ''].filter(Boolean).join(' ');
}

// 表头「住宿地/城市」比内容宽：窗口紧时在「/」后换成两行，宽时仍是一行。
function headLabel(label: string) {
  const [before, after] = label.split('/');
  if (after === undefined) return label;
  return (
    <>
      {before}/<wbr />
      {after}
    </>
  );
}

// 「编码 / 名称」单元格，照内核 [code, name].filter(Boolean).join(' / ')。视觉上编码用等宽灰字、与名称分开，文字仍是「编码 / 名称」。
type Cell = { text: string; code?: string; name?: string };
function codeAndName(code: string | null, name: string | null): Cell {
  const text = [code, name].filter(Boolean).join(' / ');
  return code && name ? { text, code, name } : { text };
}

// 一行的 13 个单元格，顺序与 CONFIRMATION_TABLE_COLUMNS 一致。结束日期照内核取 endDate ?? date（交通类与起始日期相同）。
function cellsOf(line: Line): readonly Cell[] {
  return [
    { text: line.invoiceLabel },
    codeAndName(line.projectCode, line.projectName),
    { text: line.date },
    { text: line.endDate ?? line.date },
    { text: line.city ?? '' },
    { text: line.origin ?? '' },
    { text: line.destination ?? '' },
    { text: line.category.label },
    codeAndName(line.expenseItemCode, line.expenseItemName),
    { text: line.invoiceType },
    { text: line.netAmount },
    { text: line.taxAmount },
    { text: line.grossAmount },
  ];
}

function CellText({ cell }: { cell: Cell }) {
  if (!cell.code) return <>{cell.text}</>;
  return (
    <>
      <span className="app-item-code">{`${cell.code} /`}</span> {cell.name}
    </>
  );
}

export function ReviewPage({ snapshot }: { snapshot: TaskSnapshot }) {
  const taskId = snapshot.task.taskId;
  const copy = PAGE_COPY.review;
  const { confirmation, erp, stage, step, catalog, preparation } = snapshot;
  const confirmed = confirmation.status === 'confirmed';
  const autoNotice = autoStepNotice(snapshot);
  const catalogMismatch = catalog.status === 'mismatch';
  const preparationBlocked = preparation.status === 'blocked';
  const erpStarted = erp.status !== 'idle';
  const erpDone = erp.outcome === 'filled' || erp.outcome === 'saved';
  const purpose = snapshot.projectAssignment.purpose;
  const packageFiles = preparation.packageFiles;
  const deadlineWarnings = snapshot.projectAssignment.deadlineWarnings;

  const confirmAction = useAction(taskId);
  const claimAction = useAction(taskId);
  const excludeAction = useAction(taskId);
  const reopen = useReopenUpload(snapshot, () => navigate(taskHash(taskId, 'upload')));
  const confirming = confirmAction.busy;
  const [deadlineConfirmation, setDeadlineConfirmation] = useState(false);
  const [editingCity, setEditingCity] = useState(false);
  // 「确认」只在服务端此刻接受 confirm_review（snapshot.allowedActions）且材料包就绪时可用；有缺项或核对不匹配时不可用。
  const confirmDisabled = confirming || snapshot.lines.length === 0 || !snapshot.allowedActions.includes('confirm_review') || preparation.status !== 'ready' || catalogMismatch;
  const exclude = (materialId: string) => excludeAction.run((adapter) => adapter.excludeMaterial(taskId, materialId, step.stepToken));

  const confirm = async (acceptDeadlineWarnings = false) => {
    const outcome = await confirmAction.run((adapter) => adapter.confirmReview(taskId, confirmation.digest ?? '', step.stepToken, acceptDeadlineWarnings));
    if (outcome.ok) setDeadlineConfirmation(false);
  };
  const requestConfirm = () => {
    confirmAction.clearError();
    if (deadlineWarnings.length > 0) setDeadlineConfirmation(true);
    else void confirm();
  };
  const claim = async () => {
    const outcome = await claimAction.run((adapter) => adapter.startErpWrite(taskId, step.stepToken));
    if (outcome.ok) navigate(taskHash(taskId, 'erp'));
  };

  return (
    <>
      <PageHeader title={copy.title} lead={copy.lead}>
        <Toggletip align="bottom">
          <ToggletipButton label="说明">
            <Information />
          </ToggletipButton>
          <ToggletipContent>
            <p data-testid="confirm-only">
              整单明细只能确认，不能在表里修改。有不对的地方，请回到对应的步骤修改：项目号或报销事由回到项目归属，明细内容回到待确认项。
            </p>
          </ToggletipContent>
        </Toggletip>
      </PageHeader>

      {confirmation.status === 'invalidated' && confirmation.notice ? (
        <InlineNotification className="app-notice-block" kind="warning" role="status" lowContrast hideCloseButton statusIconDescription="注意" title={confirmation.notice} />
      ) : null}

      {!confirmed && deadlineWarnings.length > 0 ? (
        <InlineNotification kind="warning" role="alert" lowContrast hideCloseButton statusIconDescription="注意" title={PROJECT_DEADLINE_WARNING_COPY.title}>
          <p>{PROJECT_DEADLINE_WARNING_COPY.notice}</p>
          <DeadlineWarningList warnings={deadlineWarnings} />
        </InlineNotification>
      ) : null}

      {/* 摘要条：数字全部来自快照（服务端给出的条数、张数与价税合计），页面不计算。材料包清单默认收起。 */}
      <SummaryBar label="确认摘要">
        <SummaryField label="报销事由" value={purpose ?? '未填写'} wide testId="review-purpose" />
        <SummaryField label="常驻城市" value={snapshot.task.homeCity || '未确认'} testId="review-home-city" />
        {confirmation.lineCount > 0 ? <SummaryField label="明细" value={`${confirmation.lineCount} 条`} /> : null}
        {confirmation.invoiceCount > 0 ? <SummaryField label="发票" value={`${confirmation.invoiceCount} 张`} /> : null}
        {packageFiles.length > 0 ? (
          <SummaryField
            label="材料包"
            value={
              <details className="app-pkg">
                <summary>
                  <Folder />
                  {packageFiles.length} 份文件
                  <ChevronDown className="app-chevron" />
                </summary>
                <div className="app-pkg-panel">
                  <p className="app-caption" data-testid="package-files">
                    {CATALOG_PREPARATION_COPY.packageReady(packageFiles.length)}
                  </p>
                  <ul className="app-pkg-files" aria-label="材料包文件">
                    {packageFiles.map((file) => (
                      <li key={file.path}>
                        <span className="app-caption">{file.kindLabel}</span> <span>{file.path}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </details>
            }
          />
        ) : null}
        {confirmation.grossTotal ? <SummaryField label="价税合计" value={confirmation.grossTotal} total /> : null}
      </SummaryBar>

      {confirmed ? (
        <section className="app-block app-review-done" aria-label="整单确认">
          <InlineNotification
            kind="success"
            role="status"
            lowContrast
            hideCloseButton
            statusIconDescription="成功"
            title={`整单明细已确认${confirmation.confirmedAt ? `（${formatDateTime(confirmation.confirmedAt)}）` : ''}。下面两个按钮基于同一份确认数据，先后随意、可重复。`}
          />
          <div className="app-two-actions bleed">
            <div className="app-action-card">
              <h3>去打印</h3>
              <p>生成合并 PDF：每张发票一页 A4，发票在上、证明材料在下。住宿发票的支付截图在打印稿页补充。</p>
              <Button href={taskHash(taskId, 'print')} renderIcon={Printer}>
                去打印
              </Button>
            </div>
            <div className="app-action-card">
              <h3>去报销</h3>
              <p>
                已配对的浏览器扩展会为这次报销打开报销系统标签页。你登录后，应用自动导入发票、写入 {confirmation.lineCount} 行明细并严格回读。完成时只表示单据已填好并交接给你；请你在报销系统里核对、保存并提交。
                {erpDone ? '已交接，去完成页查看回读结果。' : ''}
              </p>
              {erpDone ? (
                <Button href={taskHash(taskId, 'done')}>查看结果</Button>
              ) : erpStarted ? (
                <Button href={taskHash(taskId, STAGE_DEFAULT_PAGE[stage])}>查看填报进度</Button>
              ) : (
                <Button renderIcon={Launch} disabled={claimAction.busy} onClick={() => void claim()}>
                  去报销
                </Button>
              )}
              {!erpStarted && erp.abortReason ? (
                <p className="app-caption" role="status" data-testid="erp-abort-reason">
                  {erp.abortReason}
                </p>
              ) : null}
              <ActionError message={claimAction.error} />
            </div>
          </div>
          <div className="app-btn-row app-after-actions">
            {!erpStarted ? (
              <Button kind="ghost" size="sm" onClick={() => setEditingCity(true)}>
                修改常驻城市
              </Button>
            ) : null}
            <span className="app-caption">改常驻城市会重新划分本地与外地市内交通，并使这次确认失效。</span>
          </div>
          <div className="app-btn-row app-after-actions">
            {!erpStarted ? (
              <Button kind="ghost" size="sm" href={taskHash(taskId, 'project')}>
                修改项目归属
              </Button>
            ) : null}
            <span className="app-caption">改派项目会使这次确认失效。</span>
          </div>
          <div className="app-btn-row app-after-actions">
            <Button kind="ghost" size="sm" disabled={erpStarted} onClick={reopen.open}>
              追加材料
            </Button>
            <span className="app-caption">追加材料会形成新的盘点版本，并使这次确认失效。</span>
          </div>
        </section>
      ) : null}

      <div className="bleed app-table app-review-table">
        <Table aria-label="整单明细" size="md">
          <TableHead>
            <TableRow>
              <TableHeader className="app-no app-sticky-start">{CONFIRMATION_NO_COLUMN}</TableHeader>
              {CONFIRMATION_TABLE_COLUMNS.map((label) => (
                <TableHeader key={label} className={headClass(label)}>
                  {headLabel(label)}
                </TableHeader>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {snapshot.lines.map((line, row) => {
              // 同一分类里与上一行相同的文字单元格变淡（值照常在）；金额列不变淡。
              const previous = snapshot.lines[row - 1];
              const above = previous && previous.category.code === line.category.code ? cellsOf(previous) : null;
              return (
                <TableRow key={line.lineId} data-testid={`confirm-row-${line.no}`}>
                  <TableCell className="app-no app-sticky-start">{line.no}</TableCell>
                  {cellsOf(line).map((cell, index) => {
                    const label = CONFIRMATION_TABLE_COLUMNS[index] ?? '';
                    const same = cell.text !== '' && !NUMERIC_COLUMNS.has(label) && above?.[index]?.text === cell.text;
                    return (
                      <TableCell key={label} className={same ? `${columnClass(label)} app-same-above` : columnClass(label)}>
                        <CellText cell={cell} />
                      </TableCell>
                    );
                  })}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <p className="app-table-note">
        <Information />
        {REVIEW_ORDER_NOTE}颜色变淡的格子与上一行相同。
      </p>

      {catalogMismatch ? (
        <section className="app-block" aria-label="报销信息核对">
          <InlineNotification kind="error" role="alert" lowContrast hideCloseButton statusIconDescription="错误" title={CATALOG_PREPARATION_COPY.catalogMismatch} />
          {!erpStarted ? (
            <div className="app-btn-row app-block-row">
              <Button kind="tertiary" size="sm" href={taskHash(taskId, 'project')}>
                回到项目归属改派
              </Button>
            </div>
          ) : null}
          <div className="bleed app-table">
            <Table aria-label="不匹配项">
              <TableHead>
                <TableRow>
                  {CATALOG_MISMATCH_COLUMNS.map((label) => (
                    <TableHeader key={label}>{label}</TableHeader>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {catalog.problems.map((problem, index) => (
                  <TableRow key={`${problem.subject}-${index}`}>
                    <TableCell className="app-nowrap">{index + 1}</TableCell>
                    <TableCell>{problem.subject}</TableCell>
                    <TableCell>{problem.reference ?? ''}</TableCell>
                    <TableCell>{problem.reason}</TableCell>
                    <TableCell className="app-nowrap">{problem.resolver}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      ) : null}

      {preparationBlocked ? (
        <section className="app-block" aria-label="材料包缺项">
          <InlineNotification kind="warning" role="alert" lowContrast hideCloseButton statusIconDescription="注意" title={CATALOG_PREPARATION_COPY.preparationBlocked} />
          <div className="bleed app-table">
            <Table aria-label="准备缺项">
              <TableHead>
                <TableRow>
                  {PREPARATION_PROBLEM_COLUMNS.map((label) => (
                    <TableHeader key={label}>{label}</TableHeader>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {preparation.problems.map((problem, index) => (
                  <TableRow key={problem.problemId}>
                    <TableCell className="app-nowrap">{index + 1}</TableCell>
                    <TableCell>{problem.missing}</TableCell>
                    <TableCell>{problem.subject}</TableCell>
                    <TableCell className="app-nowrap">{problem.resolver}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="app-btn-row app-block-actions">
            {preparation.problems.map((problem) =>
              problem.excludableMaterialId ? (
                <Button
                  key={problem.problemId}
                  kind="secondary"
                  size="sm"
                  disabled={excludeAction.busy || step.kind !== 'resolve_preparation'}
                  onClick={() => void exclude(problem.excludableMaterialId ?? '')}
                >
                  排除 {problem.subject}
                </Button>
              ) : null,
            )}
            <span className="app-caption">排除后这份材料不关联明细、也不进入材料包，系统会重新准备核对材料。</span>
          </div>
          <ActionError message={excludeAction.error} />
        </section>
      ) : null}

      {!confirmed ? (
        // 吸底操作栏：横跨整个工作区、贴在视口底边；左边一句后果说明（不重复页头导语），右边按钮。
        // 按钮分量：「确认整单明细」是唯一的主按钮、在最右；两个往回走的操作都是 ghost。
        <ActionBar
          label="整单确认"
          consequenceProps={autoNotice ? { role: 'status' } : {}}
          consequence={
            autoNotice ? (
              autoNotice
            ) : (
              <>
                <Information />
                <strong>确认后即可去打印、去报销</strong>
              </>
            )
          }
          actions={
            <>
              {!erpStarted ? (
                <>
                  <Button kind="ghost" size="md" onClick={() => setEditingCity(true)}>
                    修改常驻城市
                  </Button>
                  <Button kind="ghost" size="md" href={taskHash(taskId, 'project')}>
                    修改项目归属
                  </Button>
                </>
              ) : null}
              {!autoNotice ? (
                <>
                  <Button kind="ghost" size="md" href={taskHash(taskId, 'pending')}>
                    回到待确认项
                  </Button>
                  <Button kind="primary" size="md" disabled={confirmDisabled} onClick={requestConfirm}>
                    确认整单明细
                  </Button>
                </>
              ) : null}
            </>
          }
          error={confirmAction.error}
        />
      ) : null}

      {deadlineConfirmation ? (
        <ConfirmDialog
          title={PROJECT_DEADLINE_WARNING_COPY.title}
          confirmLabel={PROJECT_DEADLINE_WARNING_COPY.continue}
          busy={confirmAction.busy}
          error={confirmAction.error}
          onConfirm={() => void confirm(true)}
          onCancel={() => {
            confirmAction.clearError();
            setDeadlineConfirmation(false);
          }}
        >
          <p>{PROJECT_DEADLINE_WARNING_COPY.notice}</p>
          <DeadlineWarningList warnings={deadlineWarnings} />
        </ConfirmDialog>
      ) : null}

      {editingCity ? <HomeCityDialog snapshot={snapshot} onClose={() => setEditingCity(false)} /> : null}
      {reopen.dialog}
    </>
  );
}
