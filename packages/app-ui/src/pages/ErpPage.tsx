import { useEffect, useRef, type ComponentType } from 'react';
import { Button, InlineNotification } from '@carbon/react';
import { CheckmarkFilled, ErrorFilled, InProgress, WarningAltFilled } from '@carbon/icons-react';
import type { ErpStep, TaskSnapshot } from '../contract/snapshot';
import { STAGE_DEFAULT_PAGE } from '../contract/stage';
import { navigate, taskHash } from '../router';
import { ActionError } from '../shell/ActionError';
import { PageHeader } from '../shell/PageHeader';
import { useAction } from '../shell/useAction';
import { PAGE_COPY } from './page-copy';

// ERP 填报页：按服务端给出的步骤顺序显示进度。写入由整单确认页的「去报销」启动，这里没有「开始填报」：
// 检测到登录后服务端自动导入、写入、保存并回读（内核 erp_write_pending 自动执行，交互契约不追加保存确认）。
// 页面只做一件事：「我已登录，继续」（回传当前 stepToken），它只是请服务端再探测一次；登录是否成立、何时往下走由服务端决定。
// 版式：竖排步骤清单，每步一个状态图标加状态文字（颜色只是第二通道）；等待登录的一步里嵌登录说明与按钮，Carbon 的进度指示放不下，手写。

const STATUS_LABEL: Readonly<Record<ErpStep['status'], string>> = {
  todo: '',
  running: '进行中',
  waiting: '等待你操作',
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

export function ErpPage({ snapshot }: { snapshot: TaskSnapshot }) {
  const taskId = snapshot.task.taskId;
  const copy = PAGE_COPY.erp;
  const { erp, step, stage } = snapshot;
  const { busy, error, run } = useAction(taskId);

  // 写入在本页停下时跟随服务端给出的阶段换页（替换历史记录）：保存步中止 → 对账页，严格回读不一致 → 完成页。
  // 这只是按服务端阶段跟随路由，不是页面自己判定；直接打开一个已经停下的任务的本页不跳转，底部链接作为后备入口保留。
  const previousStatus = useRef(erp.status);
  useEffect(() => {
    const was = previousStatus.current;
    previousStatus.current = erp.status;
    if (was !== 'aborted' && erp.status === 'aborted' && stage !== 'erp') navigate(taskHash(taskId, STAGE_DEFAULT_PAGE[stage]), true);
  }, [erp.status, stage, taskId]);

  const confirmLogin = () => run((adapter) => adapter.confirmLogin(taskId, step.stepToken));
  const waitingLogin = step.kind === 'erp_login';

  return (
    <>
      <PageHeader
        title={copy.title}
        lead={copy.lead}
        actions={
          <Button kind="ghost" href={taskHash(taskId, 'review')}>
            返回确认页
          </Button>
        }
      />

      <section className="app-block" aria-label="填报进度">
        {erp.steps.length === 0 ? (
          <p className="app-caption">还没有填报进度。</p>
        ) : (
          <ol className="app-steps">
            {erp.steps.map((item, index) => {
              const Icon = STATUS_ICON[item.status];
              return (
                <li key={item.key} className={`is-${item.status}`} aria-label={item.title}>
                  <span className="app-step-dot" aria-hidden="true">
                    {Icon ? <Icon /> : index + 1}
                  </span>
                  <div>
                    <div className="step-title">{item.title}</div>
                    <div className="desc">{item.description}</div>
                    {item.status === 'waiting' && waitingLogin ? (
                      <div className="app-login-prompt">
                        <p>请在专用浏览器窗口里用本人账号登录报销系统，完成后回到这里。</p>
                        {erp.loginNotice ? (
                          <InlineNotification kind="warning" role="status" lowContrast hideCloseButton statusIconDescription="注意" title={erp.loginNotice} />
                        ) : null}
                        <div className="app-btn-row">
                          <Button disabled={busy} onClick={() => void confirmLogin()}>
                            我已登录，继续
                          </Button>
                          <span className="app-caption">应用检测到登录后才会往下走。</span>
                        </div>
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
            <InlineNotification
              kind="success"
              role="status"
              lowContrast
              hideCloseButton
              statusIconDescription="成功"
            >
              <span>
                草稿 <span className="app-code">{erp.draftNo}</span> 已保存，严格回读：{snapshot.readback.summary}。
              </span>
            </InlineNotification>
            <Button href={taskHash(taskId, 'done')}>查看完成结果</Button>
          </>
        ) : erp.status === 'aborted' ? (
          <>
            <InlineNotification kind="error" role="alert" lowContrast hideCloseButton statusIconDescription="错误" title={`写入报销系统已停止：${erp.abortReason ?? ''}`} />
            {stage === 'reconcile' ? (
              <Button href={taskHash(taskId, 'reconcile')}>进入对账</Button>
            ) : stage === 'done' ? (
              <Button href={taskHash(taskId, 'done')}>查看回读结果</Button>
            ) : null}
          </>
        ) : (
          <p className="app-caption">进行中，请不要关闭专用浏览器窗口。只保存草稿，不提交审批；中途任何不一致都会停下来对账。</p>
        )}
        <ActionError message={error} />
      </section>
    </>
  );
}
