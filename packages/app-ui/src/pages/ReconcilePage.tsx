import { Button, InlineNotification } from '@carbon/react';
import { Renew, WarningAlt } from '@carbon/icons-react';
import type { ActionOutcome, AppAdapter } from '../contract/adapter';
import { HUMAN_REVIEW_NOTICE, type Reconcile, type TaskSnapshot } from '../contract/snapshot';
import { navigate, taskHash } from '../router';
import { ActionError } from '../shell/ActionError';
import { PageHeader } from '../shell/PageHeader';
import { useAction } from '../shell/useAction';
import { PAGE_COPY } from './page-copy';
import { ReadbackTable } from './ReadbackTable';

// 对账页：写入中止后停在这里。页面只说一件事：顶部一条错误通知（写入结果不确定，副标题是中止原因）；
// 事实（草稿号、对账中断点、处置状态、建议处置、对账结果句）放进摘要条；逐行比对照旧；
// 唯一要做的处置放在吸底操作栏里，左边写后果（含人工核对固定句），右边放按钮。
// 处置只渲染服务端允许的那些（reconcile.allowedActions）：原地等待 = 重新对账（只读报销系统再判定一次）；转人工 = 终止后续写入。
// 结论和一致、不一致的行数全部来自服务端（reconcile.banner），页面不自己数行、不重试写入、不改报销系统。

const STATUS_LABEL: Readonly<Record<Reconcile['status'], string>> = {
  none: '无',
  pending: '等待你处置',
  waiting: '原地等待',
  handed_off: '已转人工',
};

export function ReconcilePage({ snapshot }: { snapshot: TaskSnapshot }) {
  const taskId = snapshot.task.taskId;
  const copy = PAGE_COPY.reconcile;
  const { erp, reconcile, step } = snapshot;
  const handedOff = reconcile.status === 'handed_off';
  const canAct = step.kind === 'reconcile';
  const allowWait = reconcile.allowedActions.includes('wait');
  const allowHandOff = reconcile.allowedActions.includes('hand_off');
  const { busy, error, run } = useAction(taskId);

  const act = async (action: (adapter: AppAdapter) => Promise<ActionOutcome>) => {
    const outcome = await run(action);
    if (outcome.ok && outcome.snapshot.stage === 'done') navigate(taskHash(taskId, 'done'));
  };

  return (
    <>
      <PageHeader title={copy.title} lead={copy.lead} />

      {erp.abortReason ? (
        <section className="app-abort" aria-label="中止原因">
          <InlineNotification kind="error" role="alert" lowContrast hideCloseButton statusIconDescription="错误" title="写入结果不确定" subtitle={erp.abortReason} />
        </section>
      ) : null}

      <dl className="app-summary bleed" aria-label="对账摘要">
        <div className="app-summary-field">
          <dt className="app-summary-key">草稿号</dt>
          <dd className="app-summary-value app-code" data-testid="reconcile-draft-no">
            {reconcile.draftNo ?? '尚未读到草稿'}
          </dd>
        </div>
        <div className="app-summary-field">
          <dt className="app-summary-key">对账中断点</dt>
          <dd className="app-summary-value" data-testid="reconcile-bucket">
            {reconcile.bucket ?? '尚未判定'}
          </dd>
        </div>
        <div className="app-summary-field">
          <dt className="app-summary-key">处置状态</dt>
          <dd className="app-summary-value" data-testid="reconcile-status">
            {STATUS_LABEL[reconcile.status]}
          </dd>
        </div>
        <div className="app-summary-field">
          <dt className="app-summary-key">建议处置</dt>
          <dd className="app-summary-value">{reconcile.action ?? '尚未判定'}</dd>
        </div>
        {reconcile.banner ? (
          <div className="app-summary-field app-grow">
            <dt className="app-summary-key">对账结果</dt>
            <dd className="app-summary-value" data-testid="reconcile-banner">
              {reconcile.banner}
            </dd>
          </div>
        ) : null}
      </dl>
      {reconcile.reasons.length > 0 ? (
        <ul className="app-reconcile-reasons" aria-label="对账原因">
          {reconcile.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}

      {reconcile.rows.length > 0 ? (
        <ReadbackTable label="逐行比对" rows={reconcile.rows} localTotal={snapshot.readback.localTotal} erpTotal={snapshot.readback.erpTotal} />
      ) : (
        <p className="app-caption">还没有读到可以逐行比对的报销系统明细。</p>
      )}

      {handedOff || (!allowWait && !allowHandOff) ? null : (
        // 吸底操作栏（与整单明细确认同一种）：左边写后果，右边放服务端允许的处置按钮。应用不自动改写报销系统，也不重试写入。
        <section className="app-action-bar" aria-label="处置">
          <div className="app-consequence app-reconcile-consequence">
            <WarningAlt />
            <div>
              <p>
                <strong>{allowHandOff ? '转人工后任务标记为人工处理，保留对账记录，之后不再自动写入报销系统。' : '请先在报销系统中查看，再点重新对账。应用只读报销系统，不写入。'}</strong>
              </p>
              {reconcile.humanReview ? <p data-testid="human-review">{HUMAN_REVIEW_NOTICE}</p> : null}
            </div>
          </div>
          {allowWait ? (
            <Button kind={allowHandOff ? 'secondary' : 'primary'} size="md" renderIcon={Renew} disabled={busy || !canAct} onClick={() => void act((adapter) => adapter.reconcile(taskId, step.stepToken))}>
              重新对账
            </Button>
          ) : null}
          {allowHandOff ? (
            <Button kind="primary" size="md" disabled={busy || !canAct} onClick={() => void act((adapter) => adapter.handOff(taskId, step.stepToken))}>
              转人工
            </Button>
          ) : null}
          <ActionError message={error} />
        </section>
      )}
    </>
  );
}
