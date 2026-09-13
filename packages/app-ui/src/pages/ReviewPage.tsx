import {
  CATALOG_MISMATCH_COLUMNS,
  CATALOG_PREPARATION_COPY,
  CONFIRMATION_NO_COLUMN,
  CONFIRMATION_TABLE_COLUMNS,
  PREPARATION_PROBLEM_COLUMNS,
  type Line,
  type TaskSnapshot,
} from '../contract/snapshot';
import { STAGE_DEFAULT_PAGE } from '../contract/stage';
import { formatDateTime } from '../format';
import { navigate, taskHash } from '../router';
import { ActionError } from '../shell/ActionError';
import { useAction } from '../shell/useAction';
import { useReopenUpload } from '../shell/useReopenUpload';
import { PAGE_COPY, REVIEW_ORDER_NOTE } from './page-copy';

// 整单明细确认页：Skill 的唯一一次整单确认（preparation_confirmation），在项目归属、报销信息核对与材料准备之后。
// 表格形状照内核 preparationConfirmationTable（next.mjs:513-559）：No. 加 13 列，按服务端给出的 lines[] 顺序（内核分类排序）逐行列出，
// 无组标题、无合计行，表内不展示文件名、完整发票号与参考材料；表下是材料包文件清单（单独一节，#114 要求），
// 文件名只出现在这一节，类别名由服务端给出（不用「参考材料」字样）。
// 只能确认，不在表内修改：有不对的地方回到对应步骤修改。确认绑定项目归属，改派项目会使确认失效（提示由服务端给出）。
// 提交项目归属后服务端自动做报销信息核对与材料准备（进度照内核话术）：核对不匹配时显示不匹配表，唯一处置是回到项目归属改派；
// 材料包有缺项时显示缺项表，「确认」不可用，可排除服务端标明的相关材料。
// 「确认」带快照里的摘要与 stepToken；确认后出现并列的「去打印」「去报销」：
// 去打印只是进入打印稿页；去报销请服务端启动专用浏览器，登录后自动写入，没有「开始填报」。
// 「追加材料」先二次确认，再请服务端使确认失效并回到上传页。支付截图在打印稿页补充，不在这里。

// 两步正在进行时的进度提示：确认暂不可用。
function autoStepNotice(snapshot: TaskSnapshot): string | null {
  const { stage, catalog, preparation } = snapshot;
  if (stage === 'catalog' && catalog.status === 'running') return CATALOG_PREPARATION_COPY.catalogRunning;
  if (stage === 'preparation' && preparation.status === 'pending') return CATALOG_PREPARATION_COPY.preparationRunning;
  return null;
}

const NUMERIC_COLUMNS: ReadonlySet<string> = new Set(['费用金额', '税额', '总额']);

// 金额列右对齐；总额列固定在右侧（No. 固定在左侧），中间的列横向滚动。
const STICKY_END_COLUMN = CONFIRMATION_TABLE_COLUMNS[CONFIRMATION_TABLE_COLUMNS.length - 1];
function columnClass(label: string): string | undefined {
  const classes = [NUMERIC_COLUMNS.has(label) ? 'num' : '', label === STICKY_END_COLUMN ? 'sticky-end' : ''].filter(Boolean);
  return classes.length > 0 ? classes.join(' ') : undefined;
}

// 「编码 / 名称」单元格，照内核 [code, name].filter(Boolean).join(' / ')。
const codeAndName = (code: string | null, name: string | null) => [code, name].filter(Boolean).join(' / ');

// 一行的 13 个单元格，顺序与 CONFIRMATION_TABLE_COLUMNS 一致。结束日期照内核取 endDate ?? date（交通类与起始日期相同）。
function cellsOf(line: Line): readonly string[] {
  return [
    line.invoiceLabel,
    codeAndName(line.projectCode, line.projectName),
    line.date,
    line.endDate ?? line.date,
    line.city ?? '',
    line.origin ?? '',
    line.destination ?? '',
    line.category.label,
    codeAndName(line.expenseItemCode, line.expenseItemName),
    line.invoiceType,
    line.netAmount,
    line.taxAmount,
    line.grossAmount,
  ];
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

  const confirmAction = useAction(taskId);
  const claimAction = useAction(taskId);
  const excludeAction = useAction(taskId);
  const reopen = useReopenUpload(snapshot, () => navigate(taskHash(taskId, 'upload')));
  const confirming = confirmAction.busy;
  // 「确认」只在服务端给出 confirm_review 且材料包就绪时可用；有缺项或核对不匹配时不可用。
  const confirmDisabled = confirming || snapshot.lines.length === 0 || step.kind !== 'confirm_review' || preparation.status !== 'ready' || catalogMismatch;
  const exclude = (materialId: string) => excludeAction.run((adapter) => adapter.excludeMaterial(taskId, materialId, step.stepToken));

  const confirm =() => confirmAction.run((adapter) => adapter.confirmReview(taskId, confirmation.digest ?? '', step.stepToken));
  // 去报销：请服务端开始 ERP 写入（启动浏览器；登录后自动写入），成功后进入 ERP 填报页看进度。
  const claim = async () => {
    const outcome = await claimAction.run((adapter) => adapter.startErpWrite(taskId, step.stepToken));
    if (outcome.ok) navigate(taskHash(taskId, 'erp'));
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{copy.title}</h1>
          <p className="lead">{copy.lead}</p>
          <details className="explain">
            <summary>说明</summary>
            <p>{REVIEW_ORDER_NOTE}</p>
            <p data-testid="confirm-only">
              整单明细只能确认，不能在表里修改。有不对的地方，请回到对应的步骤修改：项目号或报销事由回到项目归属，明细内容回到待确认项。
            </p>
          </details>
        </div>
      </div>
      <p className="caption page-meta" data-testid="review-purpose">
        报销事由：{purpose ?? '未填写'}
      </p>

      {confirmation.status === 'invalidated' && confirmation.notice ? (
        <div className="notice notice-warn" role="status">
          {confirmation.notice}
        </div>
      ) : null}

      <section className="panel table confirm-table-wrap">
        <table className="data confirm-table" aria-label="整单明细">
          <thead>
            <tr>
              <th className="sticky-start">{CONFIRMATION_NO_COLUMN}</th>
              {CONFIRMATION_TABLE_COLUMNS.map((label) => (
                <th key={label} className={columnClass(label)}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {snapshot.lines.map((line, row) => {
              // 同一分类里与上一行相同的文字单元格变淡（值照常在）；金额列不变淡。
              const previous = snapshot.lines[row - 1];
              const above = previous && previous.category.code === line.category.code ? cellsOf(previous) : null;
              return (
                <tr key={line.lineId} data-testid={`confirm-row-${line.no}`}>
                  <td className="mono sticky-start">{line.no}</td>
                  {cellsOf(line).map((value, index) => {
                    const label = CONFIRMATION_TABLE_COLUMNS[index] ?? '';
                    const same = value !== '' && !NUMERIC_COLUMNS.has(label) && above?.[index] === value;
                    const className = [columnClass(label), same ? 'same-above' : ''].filter(Boolean).join(' ');
                    return (
                      <td key={label} className={className || undefined}>
                        {value}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {catalogMismatch ? (
        <section className="panel" aria-label="报销信息核对">
          <div className="notice notice-err" role="alert">
            {CATALOG_PREPARATION_COPY.catalogMismatch}
            {!erpStarted ? (
              <div className="btn-row">
                <a className="btn btn-secondary" href={taskHash(taskId, 'project')}>
                  回到项目归属改派
                </a>
              </div>
            ) : null}
          </div>
          <table className="data" aria-label="不匹配项">
            <thead>
              <tr>
                {CATALOG_MISMATCH_COLUMNS.map((label) => (
                  <th key={label}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {catalog.problems.map((problem, index) => (
                <tr key={`${problem.subject}-${index}`}>
                  <td className="mono">{index + 1}</td>
                  <td>{problem.subject}</td>
                  <td>{problem.reference ?? ''}</td>
                  <td>{problem.reason}</td>
                  <td>{problem.resolver}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {preparationBlocked ? (
        <section className="panel" aria-label="材料包缺项">
          <div className="notice notice-warn" role="alert">
            {CATALOG_PREPARATION_COPY.preparationBlocked}
          </div>
          <table className="data" aria-label="准备缺项">
            <thead>
              <tr>
                {PREPARATION_PROBLEM_COLUMNS.map((label) => (
                  <th key={label}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preparation.problems.map((problem, index) => (
                <tr key={problem.problemId}>
                  <td className="mono">{index + 1}</td>
                  <td>{problem.missing}</td>
                  <td>{problem.subject}</td>
                  <td>{problem.resolver}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="btn-row">
            {preparation.problems.map((problem) =>
              problem.excludableMaterialId ? (
                <button
                  key={problem.problemId}
                  className="btn btn-secondary btn-sm"
                  type="button"
                  disabled={excludeAction.busy || step.kind !== 'resolve_preparation'}
                  onClick={() => void exclude(problem.excludableMaterialId ?? '')}
                >
                  排除 {problem.subject}
                </button>
              ) : null,
            )}
            <span className="caption">排除后这份材料不关联明细、也不进入材料包，系统会重新准备核对材料。</span>
          </div>
          <ActionError message={excludeAction.error} />
        </section>
      ) : null}

      {preparation.packageFiles.length > 0 ? (
        <section className="panel" aria-label="材料包">
          <details className="disclosure">
            <summary>材料包 {preparation.packageFiles.length} 份文件</summary>
            <p className="caption package-note" data-testid="package-files">
              {CATALOG_PREPARATION_COPY.packageReady(preparation.packageFiles.length)}
            </p>
            <ul className="package-files" aria-label="材料包文件">
              {preparation.packageFiles.map((file) => (
                <li key={file.path}>
                  <span className="caption">{file.kindLabel}</span> <span className="file-name">{file.path}</span>
                </li>
              ))}
            </ul>
          </details>
        </section>
      ) : null}

      {confirmed ? (
        <section className="panel" aria-label="整单确认">
          <div className="btn-row">
            <span className="caption">项目归属随整单确认一起生效，改派项目会使确认失效。</span>
            {!erpStarted ? (
              <a className="btn btn-tertiary btn-sm" href={taskHash(taskId, 'project')}>
                修改项目归属
              </a>
            ) : null}
          </div>
          <>
            <div className="notice notice-ok" role="status">
              整单明细已确认{confirmation.confirmedAt ? `（${formatDateTime(confirmation.confirmedAt)}）` : ''}。下面两个按钮基于同一份确认数据，先后随意、可重复。
            </div>
            <div className="two-actions">
              <div className="action-card">
                <h3>去打印</h3>
                <p>生成合并 PDF：每张发票一页 A4，发票在上、证明材料在下。住宿发票的支付截图在打印稿页补充。</p>
                <a className="btn btn-primary btn-lg" href={taskHash(taskId, 'print')}>
                  去打印
                </a>
              </div>
              <div className="action-card">
                <h3>去报销</h3>
                <p>
                  启动专用浏览器，你登录报销系统后自动导入发票、写入 {confirmation.lineCount} 行明细、保存草稿并严格回读，中途不再确认。
                  {erpDone && erp.draftNo ? `已完成，草稿 ${erp.draftNo}。` : ''}
                </p>
                {erpDone ? (
                  <a className="btn btn-primary btn-lg" href={taskHash(taskId, 'done')}>
                    查看结果
                  </a>
                ) : erpStarted ? (
                  <a className="btn btn-primary btn-lg" href={taskHash(taskId, STAGE_DEFAULT_PAGE[stage])}>
                    查看填报进度
                  </a>
                ) : (
                  <button className="btn btn-primary btn-lg" type="button" disabled={claimAction.busy} onClick={() => void claim()}>
                    去报销
                  </button>
                )}
                <ActionError message={claimAction.error} />
              </div>
            </div>
            <div className="btn-row after-actions">
              <button className="btn btn-tertiary" type="button" disabled={erpStarted} onClick={reopen.open}>
                追加材料
              </button>
              <span className="caption">追加材料会形成新的盘点版本，并使这次确认失效。</span>
            </div>
          </>
        </section>
      ) : (
        // 吸底操作栏：左边一句话，右边按钮（「确认」是唯一的主按钮）。
        <section className="panel action-bar" aria-label="整单确认">
          {autoNotice ? (
            <p className="bar-text loading" role="status">
              {autoNotice}
            </p>
          ) : (
            <p className="bar-text">确认后项目归属一并生效</p>
          )}
          <div className="btn-row">
            {!autoNotice ? (
              <>
                <button className="btn btn-primary" type="button" disabled={confirmDisabled} onClick={() => void confirm()}>
                  确认
                </button>
                <a className="btn btn-tertiary btn-sm" href={taskHash(taskId, 'pending')}>
                  回到待确认项
                </a>
              </>
            ) : null}
            {!erpStarted ? (
              <a className="btn btn-tertiary btn-sm" href={taskHash(taskId, 'project')}>
                修改项目归属
              </a>
            ) : null}
          </div>
          <ActionError message={confirmAction.error} />
        </section>
      )}

      {reopen.dialog}
    </>
  );
}
