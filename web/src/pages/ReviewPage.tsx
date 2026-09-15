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
  type Line,
  type TaskSnapshot,
  STAGE_DEFAULT_PAGE,
} from '@baox/contract';
import { formatDateTime } from '../format';
import { navigate, taskHash } from '../router';
import { ActionBar } from '../shell/ActionBar';
import { ActionError } from '../shell/ActionError';
import { PageHeader } from '../shell/PageHeader';
import { useAction } from '../shell/useAction';
import { useReopenUpload } from '../shell/useReopenUpload';
import { PAGE_COPY, REVIEW_ORDER_NOTE } from './page-copy';

// 整单明细确认页：Skill 的唯一一次整单确认（preparation_confirmation），在项目归属、报销信息核对与材料准备之后。
// 表格形状照内核 preparationConfirmationTable（next.mjs:513-559）：No. 加 13 列，按服务端给出的 lines[] 顺序（内核分类排序）逐行列出，
// 无组标题、无合计行、不排序，表内不展示文件名、完整发票号与参考材料；材料包文件清单在摘要条里（默认收起，#114 要求），
// 文件名只出现在这一节，类别名由服务端给出（不用「参考材料」字样）。
// 只能确认，不在表内修改：有不对的地方回到对应步骤修改。确认绑定项目归属，改派项目会使确认失效（提示由服务端给出）。
// 提交项目归属后服务端自动做报销信息核对与材料准备（进度照内核话术）：核对不匹配时显示不匹配表，唯一处置是回到项目归属改派；
// 材料包有缺项时显示缺项表，「确认」不可用，可排除服务端标明的相关材料。
// 「确认整单明细」带快照里的摘要与 stepToken；确认后在摘要条下方、表格上方出现并列的「去打印」「去报销」（首屏内，不进吸底栏）：
// 去打印只是进入打印稿页；去报销请服务端启动专用浏览器，登录后自动写入，没有「开始填报」。
// 「追加材料」先二次确认，再请服务端使确认失效并回到上传页。支付截图在打印稿页补充，不在这里。

// 常驻城市：到第一次写入报销系统之前都可以改；改了会重新划分本地与外地市内交通，确认随之失效（服务端判定）。
function HomeCityField({ snapshot, locked }: { snapshot: TaskSnapshot; locked: boolean }) {
  const taskId = snapshot.task.taskId;
  const current = snapshot.task.homeCity ?? '';
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(current);
  const action = useAction(taskId);
  const save = async () => {
    const outcome = await action.run((adapter) => adapter.setTaskHomeCity(taskId, value.trim(), snapshot.step.stepToken));
    if (outcome.ok) setEditing(false);
  };
  if (!editing) {
    return (
      <div className="app-summary-field" data-testid="review-home-city">
        <span className="app-summary-key">常驻城市</span>
        <span className="app-summary-value">{current || '未确认'}</span>
        {!locked ? (
          <Button
            kind="ghost"
            size="sm"
            onClick={() => {
              setValue(current);
              setEditing(true);
            }}
          >
            修改常驻城市
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="app-summary-field" role="group" aria-label="修改常驻城市">
      <TextInput id="review-home-city" labelText="常驻城市" size="sm" value={value} onChange={(event) => setValue(event.target.value)} helperText="改了会重新划分本地与外地市内交通，整单确认随之失效。" />
      <div className="app-btn-row">
        <Button size="sm" disabled={action.busy || value.trim() === ''} onClick={() => void save()}>
          保存
        </Button>
        <Button kind="ghost" size="sm" disabled={action.busy} onClick={() => setEditing(false)}>
          取消
        </Button>
      </div>
      <ActionError message={action.error} />
    </div>
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
  const erpDone = erp.status === 'done';
  const purpose = snapshot.projectAssignment.purpose;
  const packageFiles = preparation.packageFiles;

  const confirmAction = useAction(taskId);
  const claimAction = useAction(taskId);
  const excludeAction = useAction(taskId);
  const reopen = useReopenUpload(snapshot, () => navigate(taskHash(taskId, 'upload')));
  const confirming = confirmAction.busy;
  // 「确认」只在服务端给出 confirm_review 且材料包就绪时可用；有缺项或核对不匹配时不可用。
  const confirmDisabled = confirming || snapshot.lines.length === 0 || step.kind !== 'confirm_review' || preparation.status !== 'ready' || catalogMismatch;
  const exclude = (materialId: string) => excludeAction.run((adapter) => adapter.excludeMaterial(taskId, materialId, step.stepToken));

  const confirm = () => confirmAction.run((adapter) => adapter.confirmReview(taskId, confirmation.digest ?? '', step.stepToken));
  // 去报销：请服务端开始 ERP 写入（启动浏览器；登录后自动写入），成功后进入 ERP 填报页看进度。
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

      {/* 摘要条：数字全部来自快照（服务端给出的条数、张数与价税合计），页面不计算。材料包清单默认收起。 */}
      <div className="app-summary bleed" role="group" aria-label="确认摘要">
        <div className="app-summary-field app-grow" data-testid="review-purpose">
          <span className="app-summary-key">报销事由</span>
          <span className="app-summary-value">{purpose ?? '未填写'}</span>
        </div>
        <HomeCityField snapshot={snapshot} locked={erpStarted} />
        {confirmation.lineCount > 0 ? (
          <div className="app-summary-field">
            <span className="app-summary-key">明细</span>
            <span className="app-summary-value">{confirmation.lineCount} 条</span>
          </div>
        ) : null}
        {confirmation.invoiceCount > 0 ? (
          <div className="app-summary-field">
            <span className="app-summary-key">发票</span>
            <span className="app-summary-value">{confirmation.invoiceCount} 张</span>
          </div>
        ) : null}
        {packageFiles.length > 0 ? (
          <section className="app-summary-field" aria-label="材料包">
            <details className="app-pkg">
              <summary>
                <Folder />
                材料包 {packageFiles.length} 份文件
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
          </section>
        ) : null}
        {confirmation.grossTotal ? (
          <div className="app-summary-field app-summary-total">
            <span className="app-summary-key">价税合计</span>
            <span className="app-summary-value">{confirmation.grossTotal}</span>
          </div>
        ) : null}
      </div>

      {confirmed ? (
        // 确认后下一步就在眼前：两栏入口紧跟摘要条，排在整单明细表之前。
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
                启动专用浏览器，你登录报销系统后自动导入发票、写入 {confirmation.lineCount} 行明细、保存草稿并严格回读，中途不再确认。
                {erpDone && erp.draftNo ? `已完成，草稿 ${erp.draftNo}。` : ''}
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
              {/* 上一次去报销在写入前就停下了（服务端给出原因）：报销系统没有被改动，可以直接再去报销。 */}
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
                <Button kind="ghost" size="md" href={taskHash(taskId, 'project')}>
                  修改项目归属
                </Button>
              ) : null}
              {!autoNotice ? (
                <>
                  <Button kind="ghost" size="md" href={taskHash(taskId, 'pending')}>
                    回到待确认项
                  </Button>
                  <Button kind="primary" size="md" disabled={confirmDisabled} onClick={() => void confirm()}>
                    确认整单明细
                  </Button>
                </>
              ) : null}
            </>
          }
          error={confirmAction.error}
        />
      ) : null}

      {reopen.dialog}
    </>
  );
}
