import { useEffect, useRef } from 'react';
import type { ErpStep, TaskSnapshot } from '../contract/snapshot';
import { STAGE_DEFAULT_PAGE } from '../contract/stage';
import { navigate, taskHash } from '../router';
import { ActionError } from '../shell/ActionError';
import { Icon, type IconName } from '../shell/Icon';
import { useAction } from '../shell/useAction';
import { PAGE_COPY } from './page-copy';

// ERP 填报页：按服务端给出的步骤顺序显示进度。写入由整单确认页的「去报销」启动，这里没有「开始填报」：
// 检测到登录后服务端自动导入、写入、保存并回读（内核 erp_write_pending 自动执行，交互契约不追加保存确认）。
// 页面只做一件事：「我已登录，继续」（回传当前 stepToken），它只是请服务端再探测一次；登录是否成立、何时往下走由服务端决定。
// 版式：Carbon 进度指示的竖排形式，每步一个状态图标加状态文字（颜色只是第二通道）。

const STATUS_LABEL: Readonly<Record<ErpStep['status'], string>> = {
  todo: '',
  running: '进行中',
  waiting: '等待你操作',
  done: '完成',
  failed: '已中止',
};

const STATUS_ICON: Readonly<Record<ErpStep['status'], IconName | null>> = {
  todo: null,
  running: 'in-progress',
  waiting: 'warning--alt--filled',
  done: 'checkmark--filled',
  failed: 'error--filled',
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
      <div className="page-head">
        <div>
          <h1>{copy.title}</h1>
          <p className="lead">{copy.lead}</p>
        </div>
        <div className="actions">
          <a className="btn btn-tertiary" href={taskHash(taskId, 'review')}>
            返回确认页
          </a>
        </div>
      </div>

      <section className="block" aria-label="填报进度">
        {erp.steps.length === 0 ? (
          <p className="caption">还没有填报进度。</p>
        ) : (
          <ol className="steps erp-steps">
            {erp.steps.map((item, index) => {
              const icon = STATUS_ICON[item.status];
              return (
                <li key={item.key} className={item.status} aria-label={item.title}>
                  <span className="dot" aria-hidden="true">
                    {icon ? <Icon name={icon} /> : index + 1}
                  </span>
                  <div>
                    <div className="step-title">{item.title}</div>
                    <div className="desc">{item.description}</div>
                    {item.status === 'waiting' && waitingLogin ? (
                      <div className="login-prompt">
                        <p>请在专用浏览器窗口里用本人账号登录报销系统，完成后回到这里。</p>
                        {erp.loginNotice ? (
                          <div className="notice notice-warn" role="status">
                            {erp.loginNotice}
                          </div>
                        ) : null}
                        <div className="btn-row">
                          <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void confirmLogin()}>
                            我已登录，继续
                          </button>
                          <span className="caption">应用检测到登录后才会往下走。</span>
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

      <section className="block" aria-label="填报操作">
        {erp.status === 'idle' ? (
          <p className="caption">还没有开始。整单明细确认后，在确认页点「去报销」。</p>
        ) : erp.status === 'done' ? (
          <>
            <div className="notice notice-ok" role="status">
              草稿 <span className="code">{erp.draftNo}</span> 已保存，严格回读：{snapshot.readback.summary}。
            </div>
            <a className="btn btn-primary" href={taskHash(taskId, 'done')}>
              查看完成结果
            </a>
          </>
        ) : erp.status === 'aborted' ? (
          <>
            <div className="notice notice-err" role="alert">
              写入报销系统已停止：{erp.abortReason}
            </div>
            {stage === 'reconcile' ? (
              <a className="btn btn-primary" href={taskHash(taskId, 'reconcile')}>
                进入对账
              </a>
            ) : stage === 'done' ? (
              <a className="btn btn-primary" href={taskHash(taskId, 'done')}>
                查看回读结果
              </a>
            ) : null}
          </>
        ) : (
          <p className="caption">进行中，请不要关闭专用浏览器窗口。只保存草稿，不提交审批；中途任何不一致都会停下来对账。</p>
        )}
        <ActionError message={error} />
      </section>
    </>
  );
}
