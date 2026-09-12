import { useRef, type ChangeEvent } from 'react';
import { PAYMENT_SCREENSHOT_ACCEPT_ATTRIBUTE, type Line, type Material, type PaymentScreenshot, type TaskSnapshot } from '../contract/snapshot';
import { formatDateTime } from '../format';
import { navigate, taskHash } from '../router';
import { ActionError } from '../shell/ActionError';
import { useAction } from '../shell/useAction';
import { useReopenUpload } from '../shell/useReopenUpload';
import { PAGE_COPY } from './page-copy';

// 整单明细确认页：候选明细按统一业务序号列出，同一发票的多段以左侧色条归组；合计来自快照。
// 勾选「我已核对整单明细」即确认（带快照里的摘要与 stepToken）；确认后出现并列的「去打印」「去报销」。
// 住宿发票行可补充 / 移除支付截图（只进打印稿）；「追加材料」先二次确认，再请服务端使确认失效并回到上传页。

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

function ScreenshotCell({
  line,
  voucherName,
  screenshot,
  busy,
  onAdd,
  onRemove,
}: {
  line: Line;
  voucherName: string;
  screenshot: PaymentScreenshot | null;
  busy: boolean;
  onAdd: (line: Line, file: File) => void;
  onRemove: (screenshot: PaymentScreenshot) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) onAdd(line, file);
  };
  return (
    <div className="caption screenshot-row">
      {screenshot ? (
        <>
          <span>支付截图：{screenshot.fileName}</span>
          <button className="btn btn-tertiary btn-sm" type="button" disabled={busy} onClick={() => onRemove(screenshot)}>
            移除
          </button>
        </>
      ) : (
        <>
          <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={() => inputRef.current?.click()}>
            补充支付截图
          </button>
          <span className="muted">仅用于打印稿</span>
        </>
      )}
      <input ref={inputRef} type="file" accept={PAYMENT_SCREENSHOT_ACCEPT_ATTRIBUTE} aria-label={`选择支付截图：${voucherName}`} onChange={onChange} />
    </div>
  );
}

function LineRow({
  line,
  first,
  group,
  snapshot,
  busy,
  onAddScreenshot,
  onRemoveScreenshot,
}: {
  line: Line;
  first: boolean;
  group: Group;
  snapshot: TaskSnapshot;
  busy: boolean;
  onAddScreenshot: (line: Line, file: File) => void;
  onRemoveScreenshot: (screenshot: PaymentScreenshot) => void;
}) {
  const byId = new Map(snapshot.materials.map((material) => [material.materialId, material]));
  const references = line.referenceMaterialIds.map((id) => byId.get(id)?.fileName ?? id);
  const screenshot = snapshot.paymentScreenshots.find((shot) => shot.voucherMaterialId === line.voucherMaterialId) ?? null;
  return (
    <tr className={first ? 'group-start' : undefined} data-group={line.groupId}>
      <td className="group-bar" aria-hidden="true" />
      <td className="mono">{line.no}</td>
      <td className="mono">
        {line.date}
        {line.endDate ? <div className="caption">至 {line.endDate}</div> : null}
      </td>
      <td>{line.category.label}</td>
      <td>
        {line.description}
        {first && line.acceptsPaymentScreenshot ? (
          <ScreenshotCell line={line} voucherName={group.voucher?.fileName ?? line.voucherMaterialId} screenshot={screenshot} busy={busy} onAdd={onAddScreenshot} onRemove={onRemoveScreenshot} />
        ) : null}
      </td>
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
  const { confirmation } = snapshot;
  const confirmed = confirmation.status === 'confirmed';
  const groups = groupLines(snapshot);
  const excluded = snapshot.materials.filter((material) => material.status === 'excluded');

  const confirmAction = useAction(taskId);
  const screenshotAction = useAction(taskId);
  const reopen = useReopenUpload(snapshot, () => navigate(taskHash(taskId, 'upload')));
  const confirming = confirmAction.busy;
  const screenshotBusy = screenshotAction.busy;

  const confirm = () => confirmAction.run((adapter) => adapter.confirmReview(taskId, confirmation.digest ?? '', snapshot.step.stepToken));
  const addScreenshot = (line: Line, file: File) => screenshotAction.run((adapter) => adapter.addPaymentScreenshot(taskId, line.voucherMaterialId, file));
  const removeScreenshot = (screenshot: PaymentScreenshot) => screenshotAction.run((adapter) => adapter.removePaymentScreenshot(taskId, screenshot.screenshotId));

  const erpDone = snapshot.erp.status === 'done';

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
                <LineRow
                  key={line.lineId}
                  line={line}
                  first={index === 0}
                  group={group}
                  snapshot={snapshot}
                  busy={screenshotBusy}
                  onAddScreenshot={(target, file) => void addScreenshot(target, file)}
                  onRemoveScreenshot={(shot) => void removeScreenshot(shot)}
                />
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
        {screenshotAction.error ? (
          <p className="error table-error" role="alert">
            {screenshotAction.error}
          </p>
        ) : null}
      </section>

      {excluded.length > 0 ? (
        <p className="caption excluded-note">
          未进入明细：{excluded.map((material) => `${material.fileName}（${material.checkText}）`).join('；')}
        </p>
      ) : null}

      <section className="panel" aria-label="整单确认">
        {confirmed ? (
          <>
            <div className="notice notice-ok" role="status">
              整单明细已确认{confirmation.confirmedAt ? `（${formatDateTime(confirmation.confirmedAt)}）` : ''}。下面两个按钮基于同一份确认数据，先后随意、可重复。
            </div>
            <div className="two-actions">
              <div className="action-card">
                <h3>去打印</h3>
                <p>生成合并 PDF：每张发票一页 A4，发票在上、证明材料在下。</p>
                <a className="btn btn-primary btn-lg" href={taskHash(taskId, 'print')}>
                  去打印
                </a>
              </div>
              <div className="action-card">
                <h3>去报销</h3>
                <p>
                  先为每条明细指定项目，再在专用浏览器里导入发票、写入 {confirmation.lineCount} 行明细、保存草稿并严格回读。
                  {erpDone && snapshot.erp.draftNo ? `已完成，草稿 ${snapshot.erp.draftNo}。` : ''}
                </p>
                <a className="btn btn-primary btn-lg" href={taskHash(taskId, erpDone ? 'done' : 'project')}>
                  {erpDone ? '查看结果' : '去报销'}
                </a>
              </div>
            </div>
            <div className="btn-row after-actions">
              <button className="btn btn-tertiary" type="button" disabled={erpDone} onClick={reopen.open}>
                追加材料
              </button>
              <span className="caption">追加材料会形成新的盘点版本，并使这次确认失效。</span>
            </div>
          </>
        ) : (
          <>
            <label className="check">
              <input type="checkbox" checked={confirming} disabled={confirming || snapshot.lines.length === 0} onChange={() => void confirm()} />
              我已核对整单明细
            </label>
            <p className="caption check-caption">勾选即确认：以上 {confirmation.lineCount} 行与原件一致。确认后出现「去打印」与「去报销」。</p>
            <ActionError message={confirmAction.error} />
          </>
        )}
      </section>

      {reopen.dialog}
    </>
  );
}
