import { useState } from 'react';
import { useAppStore } from '../adapter/context';
import { ActionError, failureMessage } from '../shell/ActionError';
import type { ActionOutcome, AppAdapter } from '../contract/adapter';
import type { ErpStep, TaskSnapshot } from '../contract/snapshot';
import { taskHash } from '../router';
import { PAGE_COPY } from './page-copy';

// ERP 填报页：按服务端给出的步骤顺序显示进度。页面只做两件事：「开始填报」与「我已登录，继续」，都回传当前 stepToken。
// 「我已登录，继续」只是请服务端再探测一次；登录是否成立、何时往下走由服务端决定（也可能自己探测到后推进）。

const STATUS_LABEL: Readonly<Record<ErpStep['status'], string>> = {
  todo: '',
  running: '进行中',
  waiting: '等待你操作',
  done: '完成',
  failed: '已中止',
};

export function ErpPage({ snapshot }: { snapshot: TaskSnapshot }) {
  const store = useAppStore();
  const taskId = snapshot.task.taskId;
  const copy = PAGE_COPY.erp;
  const { erp, step } = snapshot;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: (adapter: AppAdapter) => Promise<ActionOutcome>) => {
    setBusy(true);
    setError(null);
    const outcome = await store.act(taskId, action);
    setBusy(false);
    setError(failureMessage(outcome));
  };

  const start = () => run((adapter) => adapter.startErpWrite(taskId, step.stepToken));
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

      <section className="panel" aria-label="填报进度">
        {erp.steps.length === 0 ? (
          <p className="caption">还没有填报进度。</p>
        ) : (
          <ol className="steps erp-steps">
            {erp.steps.map((item, index) => (
              <li key={item.key} className={item.status} aria-label={item.title}>
                <span className="dot" aria-hidden="true">
                  {item.status === 'done' ? '✓' : index + 1}
                </span>
                <div>
                  <div className="step-title">{item.title}</div>
                  <div className="desc">{item.description}</div>
                  {item.status === 'waiting' && waitingLogin ? (
                    <div className="login-prompt">
                      <p>请在专用浏览器窗口里用本人账号登录 ERP，完成后回到这里。</p>
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
            ))}
          </ol>
        )}
      </section>

      <section className="panel" aria-label="填报操作">
        {step.kind === 'start_erp_write' ? (
          <div className="btn-row">
            <button className="btn btn-primary btn-lg" type="button" disabled={busy} onClick={() => void start()}>
              开始填报
            </button>
            <span className="caption">只保存草稿，不提交审批。中途任何不一致都会停下来对账。</span>
          </div>
        ) : erp.status === 'done' ? (
          <>
            <div className="notice notice-ok" role="status">
              草稿 <span className="mono">{erp.draftNo}</span> 已保存，严格回读：{snapshot.readback.summary}。
            </div>
            <a className="btn btn-primary" href={taskHash(taskId, 'done')}>
              查看完成结果
            </a>
          </>
        ) : erp.status === 'aborted' ? (
          <>
            <div className="notice notice-err" role="alert">
              ERP 填报已停止：{erp.abortReason}
            </div>
            {snapshot.stage === 'reconcile' ? (
              <a className="btn btn-primary" href={taskHash(taskId, 'reconcile')}>
                进入对账
              </a>
            ) : null}
          </>
        ) : (
          <p className="caption">进行中，请不要关闭专用浏览器窗口。</p>
        )}
        <ActionError message={error} />
      </section>
    </>
  );
}
