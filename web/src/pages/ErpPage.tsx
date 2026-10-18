import { useEffect, useRef, type ComponentType } from 'react';
import { Button, InlineNotification, ProgressBar } from '@carbon/react';
import { CheckmarkFilled, ErrorFilled, InProgress, Renew, WarningAltFilled } from '@carbon/icons-react';
import { DRAFT_HANDOVER_NOTICE, ERP_EXTERNAL_WAIT_COPY, ERP_SAVED_OUTCOME_NOTICE, HANDOVER_COMPLETED_NOTICE, type ErpStep, type TaskSnapshot, STAGE_DEFAULT_PAGE } from '@baox/contract';
import { useAppStore } from '../adapter/context';
import { navigate, taskHash } from '../router';
import { ActionGroup } from '../shell/ActionGroup';
import { ActionError } from '../shell/ActionError';
import { PageHeader } from '../shell/PageHeader';
import { useAction } from '../shell/useAction';
import { DraftReview, UnverifiedDraftReview } from './DraftReview';
import { PAGE_COPY } from './page-copy';

// The page renders the server's recorded ERP read state. Refresh reads that state only; it never dispatches another
// fill. The employee can only confirm a detected login or cancel while those actions are allowed by the server.

const STATUS_LABEL: Readonly<Record<ErpStep['status'], string>> = {
  todo: '',
  running: '进行中',
  waiting: '等待你登录',
  done: '完成',
  failed: '已中止',
};

const STATUS_ICON: Readonly<Record<ErpStep['status'], ComponentType | null>> = {
  todo: null,
  running: InProgress,
  waiting: WarningAltFilled,
  done: CheckmarkFilled,
  failed: ErrorFilled,
};

// Stopped: aborted, or idle with the reason it stopped before writing.
function progressStatus(erp: TaskSnapshot['erp']): 'active' | 'finished' | 'error' {
  if (erp.status === 'aborted' || (erp.status === 'idle' && erp.abortReason)) return 'error';
  return erp.status === 'done' ? 'finished' : 'active';
}

export function ErpPage({ snapshot }: { snapshot: TaskSnapshot }) {
  const taskId = snapshot.task.taskId;
  const copy = PAGE_COPY.erp;
  const { erp, step, stage } = snapshot;
  const store = useAppStore();
  const { busy, error, run } = useAction(taskId);

  // Follow the server-selected task stage after a terminal result. This component does not infer a result from steps.
  const previousStatus = useRef(erp.status);
  useEffect(() => {
    const was = previousStatus.current;
    previousStatus.current = erp.status;
    if (was !== 'aborted' && erp.status === 'aborted' && stage !== 'erp') navigate(taskHash(taskId, STAGE_DEFAULT_PAGE[stage]), true);
  }, [erp.status, stage, taskId]);

  const confirmLogin = () => run((adapter) => adapter.confirmLogin(taskId, step.stepToken));
  const cancel = async () => {
    const outcome = await run((adapter) => adapter.cancelErpWrite(taskId, step.stepToken));
    if (outcome.ok) navigate(taskHash(taskId, 'review'));
  };
  // The two writes of the login pause are the task policy's to allow (snapshot.allowedActions); refresh only reads.
  const waitingLogin = erp.externalWait === 'employee_login' && snapshot.allowedActions.includes('confirm_login');
  const canCancel = snapshot.allowedActions.includes('cancel_erp_write');
  const canRefresh = erp.allowedActions.includes('refresh');
  const writing = erp.status !== 'idle' && erp.status !== 'done' && erp.status !== 'aborted';
  const completedNotice = erp.outcome === 'filled' ? HANDOVER_COMPLETED_NOTICE : erp.outcome === 'drafted' ? DRAFT_HANDOVER_NOTICE : erp.outcome === 'saved' ? ERP_SAVED_OUTCOME_NOTICE : null;

  return (
    <>
      <PageHeader
        title={copy.title}
        lead={copy.lead}
        actions={
          <>
            {canRefresh ? (
              <Button kind="secondary" renderIcon={Renew} onClick={() => void store.refreshTask(taskId)}>
                刷新状态
              </Button>
            ) : null}
            {snapshot.confirmation.status === 'confirmed' ? <Button kind="secondary" href={taskHash(taskId, 'print')}>去打印</Button> : null}
          </>
        }
      />

      {writing ? (
        <InlineNotification
          className="app-erp-writing"
          kind="warning"
          role="status"
          lowContrast
          hideCloseButton
          statusIconDescription="注意"
          title={erp.externalWait === 'none' ? '正在根据已记录的状态显示进度。' : ERP_EXTERNAL_WAIT_COPY[erp.externalWait]}
          subtitle="应用不会替你点保存或提交审批；刷新状态只会读取已经记录的进度。"
        />
      ) : null}

      {erp.rerunNotice ? (
        <InlineNotification data-testid="erp-rerun-notice" kind="info" role="status" lowContrast hideCloseButton statusIconDescription="说明" title={erp.rerunNotice} />
      ) : null}

      <section className="app-block" aria-label="填报进度">
        {erp.progress ? (
          // 去报销进度: the server's words and share of steps done; the page adds no estimate of its own. A run that
          // stopped keeps its bar where it stopped, marked as failed; a finished one is marked finished.
          <div className="app-erp-progress" data-testid="erp-progress">
            <div className="app-erp-progress-head" aria-hidden="true">
              <span data-testid="erp-progress-label">{erp.progress.label}</span>
              <span data-testid="erp-progress-percent">{erp.progress.percent}%</span>
            </div>
            <ProgressBar label={erp.progress.label} hideLabel value={erp.progress.percent} max={100} size="small" status={progressStatus(erp)} />
          </div>
        ) : null}
        {erp.steps.length === 0 ? (
          <p className="app-caption">还没有填报进度。</p>
        ) : (
          <ol className="app-steps">
            {erp.steps.map((item, index) => {
              const Icon = STATUS_ICON[item.status];
              return (
                <li key={item.key} className={`is-${item.status}`} aria-label={item.title}>
                  <span className="app-step-dot" aria-hidden="true">
                    {Icon ? <Icon /> : <span className="app-step-num">{index + 1}</span>}
                  </span>
                  <div>
                    <div className="step-title">{item.title}</div>
                    <div className="desc">{item.description}</div>
                    {item.status === 'waiting' && waitingLogin ? (
                      <div className="app-login-prompt">
                        <p>请在为这次报销打开的报销系统标签页里用本人账号登录，完成后回到这里。</p>
                        {erp.loginNotice ? (
                          <InlineNotification kind="warning" role="status" lowContrast hideCloseButton statusIconDescription="注意" title={erp.loginNotice} />
                        ) : null}
                        <ActionGroup caption="应用检测到登录后才会往下走；取消不会改动报销系统。">
                          {canCancel ? (
                            <Button kind="ghost" size="md" disabled={busy} onClick={() => void cancel()}>
                              取消去报销
                            </Button>
                          ) : null}
                          <Button size="md" disabled={busy} onClick={() => void confirmLogin()}>
                            我已登录，继续
                          </Button>
                        </ActionGroup>
                      </div>
                    ) : null}
                  </div>
                  <span className="status">{STATUS_LABEL[item.status]}</span>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section className="app-block" aria-label="填报操作">
        {erp.status === 'idle' ? (
          <p className="app-caption">还没有开始。整单明细确认后，在确认页点「去报销」。</p>
        ) : erp.status === 'done' ? (
          <>
            {completedNotice ? (
              <InlineNotification
                kind="success"
                role="status"
                lowContrast
                hideCloseButton
                statusIconDescription="成功"
              >
                <span data-testid={erp.outcome === 'saved' ? 'saved-outcome' : 'handover-completed'}>{completedNotice}</span>
              </InlineNotification>
            ) : null}
            {erp.review ? <DraftReview review={erp.review} /> : null}
            <ActionGroup>
              <Button size="md" href={taskHash(taskId, 'done')}>
                查看完成结果
              </Button>
            </ActionGroup>
          </>
        ) : erp.status === 'aborted' ? (
          <>
            <InlineNotification kind="error" role="alert" lowContrast hideCloseButton statusIconDescription="错误" title={`写入报销系统已停止：${erp.abortReason ?? ''}`} />
            {erp.review ? <UnverifiedDraftReview review={erp.review} /> : null}
            {stage === 'reconcile' || stage === 'done' ? (
              <ActionGroup>
                <Button size="md" href={taskHash(taskId, stage)}>
                  {stage === 'reconcile' ? '进入对账' : '查看回读结果'}
                </Button>
              </ActionGroup>
            ) : null}
          </>
        ) : null}
        <ActionError message={error} />
      </section>
    </>
  );
}
