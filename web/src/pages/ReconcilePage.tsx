import { Button, InlineNotification } from '@carbon/react';
import { Renew, WarningAlt } from '@carbon/icons-react';
import { type ActionOutcome, type AppAdapter, HUMAN_REVIEW_NOTICE, type Reconcile, REFILL_COPY, type TaskSnapshot } from '@baox/contract';
import { navigate, taskHash } from '../router';
import { ActionBar } from '../shell/ActionBar';
import { PageHeader } from '../shell/PageHeader';
import { SummaryBar, SummaryField } from '../shell/SummaryBar';
import { useAction } from '../shell/useAction';
import { PAGE_COPY } from './page-copy';
import { ReadbackTable } from './ReadbackTable';

// 对账页：写入中止后停在这里。页面只说一件事：顶部一条错误通知（写入结果不确定，副标题是中止原因）；
// 事实（单据编号、对账中断点、处置状态、建议处置、对账结果句）放进摘要条；逐行比对照旧；
// 唯一要做的处置放在吸底操作栏里，左边写后果（含人工核对固定句），右边放按钮。
// 处置只渲染服务端此刻接受的那些（snapshot.allowedActions 里的 reconcile、refill、hand_off）：原地等待有两条出路，wait = 重新对账（只读报销系统再判定一次）、
// refill = 重新去报销（重开一张单据从头走一遍）；转人工 = 终止后续写入。
// 建议的那个（reconcile.actionCode）是主按钮，后果说明也按它写：建议原地等待时通常两个按钮都在，但主张的是先去看再对账。
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
  // 处置按钮只看服务端 taskPolicy 此刻接受的动作（snapshot.allowedActions）：对账作业在跑、已转人工时一个也没有。
  const allowWait = snapshot.allowedActions.includes('reconcile');
  const allowHandOff = snapshot.allowedActions.includes('hand_off');
  // 重新去报销：发票已导入、明细还没写、报销系统里还没有单据编号时服务端给出的出路。页面只照服务端说的渲染。
  const allowRefill = snapshot.allowedActions.includes('refill');
  // 建议的处置：两个按钮都在时，它是主按钮，后果说明也按它写。
  const suggestHandOff = reconcile.actionCode === 'hand_off';
  const { busy, error, run } = useAction(taskId);

  const act = async (action: (adapter: AppAdapter) => Promise<ActionOutcome>) => {
    const outcome = await run(action);
    if (!outcome.ok) return;
    // 重新去报销开的是一份新的去报销，落在去报销页；其余处置要么留在本页，要么走到完成页。
    if (outcome.snapshot.stage === 'done') navigate(taskHash(taskId, 'done'));
    else if (outcome.snapshot.stage === 'erp') navigate(taskHash(taskId, 'erp'));
  };

  return (
    <>
      <PageHeader title={copy.title} lead={copy.lead} />

      {/* 写入中止（erp.status 为 aborted，契约：对账阶段就是写入结果不确定后的停顿）就说「写入结果不确定」；
          中止原因是副标题，服务端没给时只写标题。 */}
      {erp.status === 'aborted' ? (
        <section className="app-abort" aria-label="中止原因">
          <InlineNotification
            kind="error"
            role="alert"
            lowContrast
            hideCloseButton
            statusIconDescription="错误"
            title="写入结果不确定"
            {...(erp.abortReason ? { subtitle: erp.abortReason } : {})}
          />
        </section>
      ) : null}

      {/* 报销系统自己的原话（逐字，不改写）和写入停下时的裁剪截图。 */}
      {reconcile.capture ? (
        <section className="app-erp-capture" aria-label="报销系统原文">
          {reconcile.capture.erpText.length > 0 ? (
            <ul className="app-reconcile-reasons">
              {reconcile.capture.erpText.map((text) => (
                <li key={text} data-testid="erp-text">
                  {text}
                </li>
              ))}
            </ul>
          ) : null}
          {reconcile.capture.screenshotUrl ? <img src={reconcile.capture.screenshotUrl} alt="报销系统截图" style={{ maxWidth: '100%' }} /> : null}
        </section>
      ) : null}

      <SummaryBar label="对账摘要">
        <SummaryField label="单据编号" value={reconcile.draftNo ?? '尚未读到单据编号'} mono testId="reconcile-draft-no" />
        <SummaryField label="对账中断点" value={reconcile.bucket ?? '尚未判定'} testId="reconcile-bucket" />
        <SummaryField label="处置状态" value={STATUS_LABEL[reconcile.status]} testId="reconcile-status" />
        <SummaryField label="建议处置" value={reconcile.action ?? '尚未判定'} />
        {reconcile.banner ? <SummaryField label="对账结果" value={reconcile.banner} wide testId="reconcile-banner" /> : null}
      </SummaryBar>
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

      {handedOff || (!allowWait && !allowHandOff && !allowRefill) ? null : (
        // 吸底操作栏（与整单明细确认同一种）：左边写后果，右边放服务端允许的处置按钮。应用不自动改写报销系统，也不重试写入。
        <ActionBar
          label="处置"
          consequenceProps={{ className: 'app-reconcile-consequence' }}
          consequence={
            <>
              <WarningAlt />
              <div>
                <p>
                  <strong>{suggestHandOff ? '转人工后任务标记为人工处理，保留对账记录，之后不再自动写入报销系统。' : allowRefill ? REFILL_COPY.consequence : '请先在报销系统中查看，再点重新对账。应用只读报销系统，不写入。'}</strong>
                </p>
                {reconcile.humanReview ? <p data-testid="human-review">{HUMAN_REVIEW_NOTICE}</p> : null}
              </div>
            </>
          }
          actions={
            <>
              {allowWait ? (
                <Button kind={suggestHandOff ? 'secondary' : 'primary'} renderIcon={Renew} disabled={busy} onClick={() => void act((adapter) => adapter.reconcile(taskId, step.stepToken))}>
                  {reconcile.bucket === null ? '开始对账' : '重新对账'}
                </Button>
              ) : null}
              {allowRefill ? (
                <Button kind="primary" renderIcon={Renew} disabled={busy} onClick={() => void act((adapter) => adapter.refill(taskId, step.stepToken))}>
                  {REFILL_COPY.button}
                </Button>
              ) : null}
              {allowHandOff ? (
                <Button kind={suggestHandOff ? 'primary' : 'secondary'} disabled={busy} onClick={() => void act((adapter) => adapter.handOff(taskId, step.stepToken))}>
                  转人工
                </Button>
              ) : null}
            </>
          }
          error={error}
        />
      )}
    </>
  );
}
