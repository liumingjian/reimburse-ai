import { Button, InlineNotification, Tag } from '@carbon/react';
import { CheckmarkFilled, ErrorFilled, Printer } from '@carbon/icons-react';
import { HUMAN_REVIEW_NOTICE, SAVE_COMPLETED_NOTICE, type TaskSnapshot } from '@baox/contract';
import { TASKS_HASH, taskHash } from '../router';
import { ActionError } from '../shell/ActionError';
import { PageHeader } from '../shell/PageHeader';
import { StatusTag } from '../shell/StatusTag';
import { useAction } from '../shell/useAction';
import { PAGE_COPY } from './page-copy';
import { ReadbackTable } from './ReadbackTable';

// 完成页：草稿号与逐条回读表。只有服务端判定回读全部一致（readback.status = matched）才显示完成态与固定句
// 「报销草稿已保存。请打开报销系统检查，是否提交由你决定。」（user-interaction-contract.md:70，逐字不改）。
// 严格回读不一致时任务也停在这里，但不算完成：差异行按服务端逐行判定着色并可展开；对账结果是转人工（human_review）时显示固定句，
// 当前待答 step 是 hand_off 且允许转人工时出现「转人工」，转人工后显示已转人工（终态）。

const MISMATCH_LEAD = '草稿已保存，但严格回读与本地确认不一致。这份草稿不算完成。';

export function DonePage({ snapshot }: { snapshot: TaskSnapshot }) {
  const taskId = snapshot.task.taskId;
  const copy = PAGE_COPY.done;
  const { erp, readback, reconcile, step } = snapshot;
  const matched = readback.status === 'matched';
  const mismatched = readback.status === 'mismatched';
  const handedOff = reconcile.status === 'handed_off';
  const canHandOff = step.kind === 'hand_off' && reconcile.allowedActions.includes('hand_off');
  const { busy, error, run } = useAction(taskId);

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

      {/* 摘要条：草稿号与严格回读结论都来自服务端。 */}
      <div className="app-summary bleed" role="group" aria-label="写入结果">
        <div className="app-summary-field">
          <span className="app-summary-key">草稿号</span>
          <span className="app-summary-value app-code" data-testid="draft-no">
            {erp.draftNo ?? '尚无'}
          </span>
        </div>
        {/* 这次写入登录的报销系统账号与账套：只是记录，从不与应用账号比对。 */}
        {erp.erpAccount ? (
          <div className="app-summary-field">
            <span className="app-summary-key">报销系统账号</span>
            <span className="app-summary-value" data-testid="erp-account">{`${erp.erpAccount.displayName}（${erp.erpAccount.account}）· 账套 ${erp.erpAccount.tenant}`}</span>
          </div>
        ) : null}
        {readback.summary ? (
          <div className="app-summary-field">
            <span className="app-summary-key">严格回读</span>
            <span className="app-summary-value">
              <Tag type={matched ? 'green' : 'red'} renderIcon={matched ? CheckmarkFilled : ErrorFilled}>
                {readback.summary}
              </Tag>
            </span>
          </div>
        ) : null}
        {handedOff ? (
          <div className="app-summary-field">
            <span className="app-summary-key">处置</span>
            <span className="app-summary-value">
              <StatusTag tone="warning">已转人工</StatusTag>
            </span>
          </div>
        ) : null}
        <div className="app-summary-field app-grow" />
      </div>

      <div className="app-notices">
        {matched ? (
          <InlineNotification kind="success" role="status" lowContrast hideCloseButton statusIconDescription="成功">
            <span data-testid="save-completed">{SAVE_COMPLETED_NOTICE}</span>
          </InlineNotification>
        ) : mismatched ? (
          <InlineNotification
            kind="error"
            role="alert"
            lowContrast
            hideCloseButton
            statusIconDescription="错误"
            title={`回读与本地确认不一致：${readback.summary ?? ''}。这份草稿不算完成，不要直接在报销系统里提交审批。`}
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

      {readback.rows.length > 0 ? <ReadbackTable label="逐条回读" rows={readback.rows} localTotal={readback.localTotal} erpTotal={readback.erpTotal} /> : null}

      {canHandOff ? (
        <section className="app-block" aria-label="转人工">
          <h2 className="app-section-title">转人工</h2>
          <p className="app-lead">应用不会自动改写报销系统里的行，也不会重试写入。转人工后任务标记为人工处理，保留回读记录，之后不再自动写入报销系统。</p>
          <div className="app-btn-row app-block-actions">
            <Button disabled={busy} onClick={() => void run((adapter) => adapter.handOff(taskId, step.stepToken))}>
              转人工
            </Button>
            <ActionError message={error} />
          </div>
        </section>
      ) : null}
    </>
  );
}
