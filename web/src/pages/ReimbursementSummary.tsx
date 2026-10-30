import { useState } from 'react';
import type { SummaryInput } from '@baox/contract';
import { Button, TextInput } from '@carbon/react';
import type { ReimbursementSummary as Summary, SummaryPrintInformation, TaskSnapshot } from '@baox/contract';
import { useAction } from '../shell/useAction';
import { ActionError } from '../shell/ActionError';

function GeneratedSummary({ summary, snapshot }: { summary: Extract<Summary, { status: 'generated' }>; snapshot: TaskSnapshot }) {
  const action = useAction(snapshot.task.taskId);
  const { reimbursementDate, name, department, billIdentifier, businessTripIdentifier } = summary.data;
  const saved = { reimbursementDate, name, department, billIdentifier, businessTripIdentifier };
  const [draft, setDraft] = useState<SummaryPrintInformation>(saved);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const fields = [
    ['reimbursementDate', '报销日期', 'date'], ['billIdentifier', '报销单号（选填）', 'text'],
    ['businessTripIdentifier', '出差单号（选填）', 'text'], ['name', '打印姓名', 'text'], ['department', '打印部门', 'text'],
  ] as const;
  return <>
    <form onSubmit={event => {
      event.preventDefault();
      const printInformation = { ...draft, name: draft.name.trim(), department: draft.department.trim(), billIdentifier: draft.billIdentifier.trim(), businessTripIdentifier: draft.businessTripIdentifier.trim() };
      setDraft(printInformation);
      void action.run(adapter => adapter.generateReimbursementSummary(snapshot.task.taskId, printInformation));
    }}>
      <p>打印信息仅用于本次报销汇总表。修改后保存即可更新预览和 Excel。</p>
      {fields.map(([field, label, type]) => <TextInput key={field} id={`summary-${field}`} labelText={label} type={type} value={draft[field]} required={field !== 'billIdentifier' && field !== 'businessTripIdentifier'} onChange={event => setDraft({ ...draft, [field]: event.target.value })} />)}
      <Button type="submit" disabled={!dirty || action.busy || !snapshot.allowedActions.includes('summary')}>保存打印信息</Button>
      <ActionError message={action.error} />
    </form>
    {dirty ? <p>打印信息尚未保存，请保存后预览或下载。</p> : <>
      <a className="cds--btn cds--btn--primary" href={summary.url} download={summary.fileName}>下载报销汇总表 Excel</a>
      <img src={summary.previewUrl} alt={`报销汇总表预览：${summary.data.name}，${summary.data.department}，报销日期 ${summary.data.reimbursementDate}，报销单号 ${summary.data.billIdentifier}，出差单号 ${summary.data.businessTripIdentifier}，合计 ${summary.data.total} 元`} style={{ display: 'block', width: '100%', maxWidth: 900, marginTop: 24, border: '1px solid #ccc' }} />
    </>}
  </>;
}

export function ReimbursementSummary({ snapshot }: { snapshot: TaskSnapshot }) {
  const action = useAction(snapshot.task.taskId);
  const summary = snapshot.reimbursementSummary;
  if (!summary) return null;
  return <section className="app-block" aria-label="报销汇总表">
    <h2>报销汇总表</h2>
    {summary.status === 'unavailable' ? <>
      <ul>{summary.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
      {summary.inputs?.map(input => <SummaryResolutionField key={`${summary.confirmationRevision}:${input.kind}:${input.kind === 'voucher-count' ? input.voucherMaterialId : input.lineId}`} input={input} disabled={action.busy || !snapshot.allowedActions.includes('summary')} save={value => action.run(adapter => adapter.resolveReimbursementSummary(snapshot.task.taskId, { confirmationRevision: summary.confirmationRevision!, voucherCounts: input.kind === 'voucher-count' ? [{ voucherMaterialId: input.voucherMaterialId, category: value }] : [], stayDays: input.kind === 'stay-days' ? [{ lineId: input.lineId, days: Number(value) }] : [] }))} />)}
      <ActionError message={action.error} />
    </> : <>
      <p>将整单确认的金额汇总到财务表单，下载 Excel 后打印。</p>
      <Button kind="secondary" disabled={action.busy || !snapshot.allowedActions.includes('summary')} onClick={() => void action.run(adapter => adapter.generateReimbursementSummary(snapshot.task.taskId))}>{summary.status === 'generated' ? '重新生成报销汇总表' : '生成报销汇总表'}</Button>
      <ActionError message={action.error} />
    </>}
    {summary.status === 'generated' ? <GeneratedSummary key={summary.url} summary={summary} snapshot={snapshot} /> : null}
  </section>;
}

function SummaryResolutionField({ input, disabled, save }: { input: SummaryInput; disabled: boolean; save: (value: string) => Promise<unknown> }) {
  const [value, setValue] = useState('');
  const label = input.kind === 'voucher-count' ? `${input.label}：张数归属` : `${input.label}（${input.date}）：同日住宿天数`;
  return <form onSubmit={event => { event.preventDefault(); void save(value); }} style={{ marginBottom: 16 }}>
    <label>{label}{input.kind === 'voucher-count' ? <select aria-label={label} required value={value} onChange={event => setValue(event.target.value)}><option value="">请选择</option>{input.categories.map(category => <option key={category}>{category}</option>)}</select> : <input aria-label={label} type="number" min={0} step={1} required value={value} onChange={event => setValue(event.target.value)} />}</label>
    <Button type="submit" kind="secondary" disabled={disabled || !value}>确认{input.kind === 'voucher-count' ? '张数归属' : '住宿天数'}</Button>
  </form>;
}
