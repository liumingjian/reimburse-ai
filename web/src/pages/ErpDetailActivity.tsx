import type { TaskSnapshot } from '@baox/contract';

export function ErpDetailActivity({ activity, running }: { activity: TaskSnapshot['erp']['detailActivity']; running: boolean }) {
  if (!activity) return null;
  return (
    <section className="app-block" aria-label="当前明细" data-testid="erp-detail-activity">
      <p>{running ? '最近上报位置' : '停止前最后上报位置'}：{activity.no === null ? '明细' : `第 ${activity.no} 条明细`}{activity.summary ? `，${activity.summary}` : ''}</p>
      <p>{running ? '' : '当时：'}{activity.label}。本步骤第 {activity.attempt} 次尝试。</p>
      <p className="app-caption">开始于 {new Date(activity.startedAt).toLocaleString('zh-CN')}；最后上报于 {new Date(activity.reportedAt).toLocaleString('zh-CN')}。这是已记录的位置，不代表该条材料有误。</p>
      {activity.fromPreviousRun ? <p className="app-caption">这是上一次填写停止的位置；自动换新单尚未开始填写就已停止。</p> : null}
    </section>
  );
}
