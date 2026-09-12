import type { Line, Material, TaskSnapshot } from '../contract/snapshot';
import { STAGE_DEFAULT_PAGE, type TaskStage } from '../contract/stage';
import { formatDateTime } from '../format';
import { navigate, taskHash } from '../router';
import { ActionError } from '../shell/ActionError';
import { useAction } from '../shell/useAction';
import { useReopenUpload } from '../shell/useReopenUpload';
import { PAGE_COPY } from './page-copy';

// 整单明细确认页：Skill 的唯一一次整单确认（preparation_confirmation），在项目归属、报销信息核对与材料准备之后。
// 候选明细按服务端给出的统一业务序号列出（内核分类排序），同一发票的多段以左侧色条归组；合计来自快照。
// 确认绑定项目归属：确认后改派项目会使确认失效（提示由服务端给出）。
// 勾选「我已核对整单明细」即确认（带快照里的摘要与 stepToken）；确认后出现并列的「去打印」「去报销」：
// 去打印只是进入打印稿页；去报销请服务端启动专用浏览器，登录后自动写入，没有「开始填报」。
// 「追加材料」先二次确认，再请服务端使确认失效并回到上传页。支付截图在打印稿页补充，不在这里。

// 提交项目归属后服务端自动执行的两步：显示进度，确认暂不可用。
const AUTO_STEP_NOTICE: Partial<Record<TaskStage, string>> = {
  catalog: '正在核对报销信息（项目与费用项目）。完成后在这里确认整单明细。',
  preparation: '正在准备报销材料。完成后在这里确认整单明细。',
};

type Group = { groupId: string; lines: Line[]; voucher: Material | null };

// 服务端已按统一业务序号排好、同一发票的行相邻；这里只把相邻同组的行收拢成 tbody。
function groupLines(snapshot: TaskSnapshot): Group[] {
  const byId = new Map(snapshot.materials.map((material) => [material.materialId, material]));
  const groups: Group[] = [];
  for (const line of snapshot.lines) {
    const last = groups[groups.length - 1];
    if (last && last.groupId === line.groupId) last.lines.push(line);
    else groups.push({ groupId: line.groupId, lines: [line], voucher: byId.get(line.voucherMaterialId) ?? null });
  }
  return groups;
}

function groupLabel(group: Group): string {
  const first = group.lines[0];
  const last = group.lines[group.lines.length - 1];
  if (!first || !last) return '';
  const nos = first.no === last.no ? `No.${first.no}` : `No.${first.no}-${last.no}`;
  return `${nos} · ${group.voucher?.fileName ?? first.voucherMaterialId}`;
}

function LineRow({ line, first, group, snapshot }: { line: Line; first: boolean; group: Group; snapshot: TaskSnapshot }) {
  const byId = new Map(snapshot.materials.map((material) => [material.materialId, material]));
  const references = line.referenceMaterialIds.map((id) => byId.get(id)?.fileName ?? id);
  return (
    <tr className={first ? 'group-start' : undefined} data-group={line.groupId}>
      <td className="group-bar" aria-hidden="true" />
      <td className="mono">{line.no}</td>
      <td className="mono">
        {line.date}
        {line.endDate ? <div className="caption">至 {line.endDate}</div> : null}
      </td>
      <td>{line.category.label}</td>
      <td>{line.description}</td>
      <td>
        {first ? (
          <>
            <span className="mono">{group.voucher?.fileName ?? line.voucherMaterialId}</span>
            <div className="caption">
              {line.invoiceType}
              {references.length > 0 ? ` · 参考材料：${references.join('、')}` : ''}
            </div>
          </>
        ) : (
          <span className="muted">同上</span>
        )}
      </td>
      <td className="num secondary">{line.netAmount}</td>
      <td className="num secondary">{line.taxAmount}</td>
      <td className="num gross">{line.grossAmount}</td>
    </tr>
  );
}

export function ReviewPage({ snapshot }: { snapshot: TaskSnapshot }) {
  const taskId = snapshot.task.taskId;
  const copy = PAGE_COPY.review;
  const { confirmation, erp, stage, step } = snapshot;
  const confirmed = confirmation.status === 'confirmed';
  const groups = groupLines(snapshot);
  const excluded = snapshot.materials.filter((material) => material.status === 'excluded');
  const autoNotice = AUTO_STEP_NOTICE[stage] ?? null;
  const erpStarted = erp.status !== 'idle';
  const erpDone = erp.status === 'done';
  const purpose = snapshot.projectAssignment.purpose;

  const confirmAction = useAction(taskId);
  const claimAction = useAction(taskId);
  const reopen = useReopenUpload(snapshot, () => navigate(taskHash(taskId, 'upload')));
  const confirming = confirmAction.busy;

  const confirm = () => confirmAction.run((adapter) => adapter.confirmReview(taskId, confirmation.digest ?? '', step.stepToken));
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
        </div>
      </div>

      {confirmation.status === 'invalidated' && confirmation.notice ? (
        <div className="notice notice-warn" role="status">
          {confirmation.notice}
        </div>
      ) : null}

      <section className="panel table">
        <table className="data lines" aria-label="候选明细">
          <thead>
            <tr>
              <th className="group-bar" aria-hidden="true" />
              <th>No.</th>
              <th>日期</th>
              <th>费用类别</th>
              <th>说明</th>
              <th>材料来源</th>
              <th className="num secondary">不含税</th>
              <th className="num secondary">税额</th>
              <th className="num">价税合计</th>
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.groupId} className="line-group" aria-label={groupLabel(group)}>
              {group.lines.map((line, index) => (
                <LineRow key={line.lineId} line={line} first={index === 0} group={group} snapshot={snapshot} />
              ))}
            </tbody>
          ))}
          <tfoot>
            <tr>
              <td className="group-bar" aria-hidden="true" />
              <td colSpan={7}>
                合计 · {confirmation.invoiceCount} 张发票 · {confirmation.lineCount} 行
              </td>
              <td className="num gross" data-testid="gross-total">
                {confirmation.grossTotal ?? ''}
              </td>
            </tr>
          </tfoot>
        </table>
      </section>

      {excluded.length > 0 ? (
        <p className="caption excluded-note">
          未进入明细：{excluded.map((material) => `${material.fileName}（${material.checkText}）`).join('；')}
        </p>
      ) : null}

      <section className="panel" aria-label="整单确认">
        <div className="btn-row">
          <span className="caption" data-testid="review-purpose">
            报销事由：{purpose ?? '未填写'}。项目归属随整单确认一起生效，改派项目会使确认失效。
          </span>
          {!erpStarted ? (
            <a className="btn btn-tertiary btn-sm" href={taskHash(taskId, 'project')}>
              修改项目归属
            </a>
          ) : null}
        </div>
        {confirmed ? (
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
                  启动专用浏览器，你登录 ERP 后自动导入发票、写入 {confirmation.lineCount} 行明细、保存草稿并严格回读，中途不再确认。
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
        ) : autoNotice ? (
          <p className="caption loading" role="status">
            {autoNotice}
          </p>
        ) : (
          <>
            <label className="check">
              <input
                type="checkbox"
                checked={confirming}
                disabled={confirming || snapshot.lines.length === 0 || step.kind !== 'confirm_review'}
                onChange={() => void confirm()}
              />
              我已核对整单明细
            </label>
            <p className="caption check-caption">勾选即确认：以上 {confirmation.lineCount} 行与原件一致，项目归属如上。确认后出现「去打印」与「去报销」。</p>
            <ActionError message={confirmAction.error} />
          </>
        )}
      </section>

      {reopen.dialog}
    </>
  );
}
