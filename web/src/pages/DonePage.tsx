import { Button, InlineNotification, Tag } from '@carbon/react';
import { CheckmarkFilled, ErrorFilled, Printer } from '@carbon/icons-react';
import { DRAFT_HANDOVER_NOTICE, ERP_SAVED_OUTCOME_NOTICE, HUMAN_REVIEW_NOTICE, type TaskSnapshot } from '@baox/contract';
import { TASKS_HASH, taskHash } from '../router';
import { ActionGroup } from '../shell/ActionGroup';
import { PageHeader } from '../shell/PageHeader';
import { SummaryBar, SummaryField } from '../shell/SummaryBar';
import { StatusTag } from '../shell/StatusTag';
import { useAction } from '../shell/useAction';
import { DraftReview } from './DraftReview';
import { PAGE_COPY } from './page-copy';
import { ReadbackTable } from './ReadbackTable';

// The server distinguishes a filled handoff from a later observed save. Neither result implies submission, approval,
// or payment. The page renders that result and the server's strict read-back unchanged.

const MISMATCH_LEAD = '严格回读与本地确认不一致，单据没有交接给你。这次去报销不算完成。';

export function DonePage({ snapshot }: { snapshot: TaskSnapshot }) {
  const taskId = snapshot.task.taskId;
  const copy = PAGE_COPY.done;
  const { erp, readback, reconcile, step } = snapshot;
  const matched = readback.status === 'matched';
  const mismatched = readback.status === 'mismatched';
  const handedOff = reconcile.status === 'handed_off';
  const canHandOff = snapshot.allowedActions.includes('hand_off');
  const { busy, error, errorLink, run } = useAction(taskId);
  const completedNotice = erp.outcome === 'drafted' ? DRAFT_HANDOVER_NOTICE : erp.outcome === 'saved' ? ERP_SAVED_OUTCOME_NOTICE : null;

  return (
    <>
      <PageHeader
        title={copy.title}
        lead={mismatched ? MISMATCH_LEAD : copy.lead}
        actions={
          <>
            <Button kind="secondary" href={taskHash(taskId, 'print')} renderIcon={Printer}>
              打印稿
            </Button>
            <Button kind={mismatched ? 'secondary' : 'primary'} href={TASKS_HASH}>
              返回任务列表
            </Button>
          </>
        }
      />

      <SummaryBar label="写入结果">
        <SummaryField label="单据编号" value={erp.draftNo ?? '尚无'} mono testId="draft-no" />
        {erp.erpAccount ? (
          <>
            <SummaryField label="报销系统账号" value={`${erp.erpAccount.displayName}（${erp.erpAccount.account}）`} testId="erp-account" />
            <SummaryField label="账套" value={erp.erpAccount.tenant} testId="erp-tenant" />
          </>
        ) : null}
        {readback.summary ? (
          <SummaryField
            label="严格回读"
            value={
              <Tag type={matched ? 'green' : 'red'} renderIcon={matched ? CheckmarkFilled : ErrorFilled}>
                {readback.summary}
              </Tag>
            }
          />
        ) : null}
        {handedOff ? <SummaryField label="处置" value={<StatusTag tone="warning">已转人工</StatusTag>} /> : null}
      </SummaryBar>

      <div className="app-notices">
        {matched && completedNotice ? (
          <InlineNotification kind="success" role="status" lowContrast hideCloseButton statusIconDescription="成功">
            <span data-testid={erp.outcome === 'saved' ? 'saved-outcome' : 'handover-completed'}>{completedNotice}</span>
          </InlineNotification>
        ) : mismatched ? (
          <InlineNotification
            kind="error"
            role="alert"
            lowContrast
            hideCloseButton
            statusIconDescription="错误"
            title={`回读与本地确认不一致：${readback.summary ?? ''}。这次去报销不算完成，不要直接在报销系统里保存或提交审批。`}
          />
        ) : null}
        {reconcile.humanReview ? (
          <InlineNotification kind="warning" role="status" lowContrast hideCloseButton statusIconDescription="注意">
            <span data-testid="human-review">{HUMAN_REVIEW_NOTICE}</span>
          </InlineNotification>
        ) : null}
        {reconcile.banner ? (
          <InlineNotification
            kind={handedOff || matched ? 'info' : 'warning'}
            role="status"
            lowContrast
            hideCloseButton
            statusIconDescription={handedOff || matched ? '提示' : '注意'}
            title={reconcile.banner}
          />
        ) : null}
        {mismatched && reconcile.reasons.length > 0 ? (
          <ul className="app-reconcile-reasons">
            {reconcile.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : null}
      </div>

      {erp.review ? <DraftReview review={erp.review} /> : null}

      {readback.rows.length > 0 ? <ReadbackTable label="逐条回读" rows={readback.rows} localTotal={readback.localTotal} erpTotal={readback.erpTotal} /> : null}

      {canHandOff ? (
        <section className="app-block" aria-label="转人工">
          <h2 className="app-section-title">转人工</h2>
          <p className="app-lead">应用不会自动改写报销系统里的行，也不会重试写入。转人工后任务标记为人工处理，保留回读记录，之后不再自动写入报销系统。</p>
          <ActionGroup className="app-block-actions" error={error} errorLink={errorLink}>
            <Button size="md" disabled={busy} onClick={() => void run((adapter) => adapter.handOff(taskId, step.stepToken))}>
              转人工
            </Button>
          </ActionGroup>
        </section>
      ) : null}
    </>
  );
}
