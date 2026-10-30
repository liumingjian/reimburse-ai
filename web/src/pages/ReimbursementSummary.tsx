import { Button } from '@carbon/react';
import type { TaskSnapshot } from '@baox/contract';
import { useAction } from '../shell/useAction';
import { ActionError } from '../shell/ActionError';

export function ReimbursementSummary({ snapshot }: { snapshot: TaskSnapshot }) {
  const action = useAction(snapshot.task.taskId);
  const summary = snapshot.reimbursementSummary;
  if (!summary) return null;
  return <section className="app-block" aria-label="报销汇总表">
    <h2>报销汇总表</h2>
    {summary.status === 'unavailable' ? <ul>{summary.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul> : <>
      <p>将整单确认的金额汇总到财务表单，下载 Excel 后打印。</p>
      <Button kind="secondary" disabled={action.busy || !snapshot.allowedActions.includes('summary')} onClick={() => void action.run(adapter => adapter.generateReimbursementSummary(snapshot.task.taskId))}>{summary.status === 'generated' ? '重新生成报销汇总表' : '生成报销汇总表'}</Button>
      <ActionError message={action.error} />
    </>}
    {summary.status === 'generated' ? <>
      <a className="cds--btn cds--btn--primary" href={summary.url} download={summary.fileName}>下载报销汇总表 Excel</a>
      <img src={summary.previewUrl} alt={`报销汇总表预览：${summary.data.name}，${summary.data.department}，合计 ${summary.data.total} 元`} style={{ display: 'block', width: '100%', maxWidth: 900, marginTop: 24, border: '1px solid #ccc' }} />
    </> : null}
  </section>;
}
