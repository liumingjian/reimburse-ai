import { useEffect } from 'react';
import { useAppStore, useTask } from '../adapter/context';
import { STAGE_DEFAULT_PAGE, pageAllowed, type TaskPage } from '../contract/stage';
import type { TaskSnapshot } from '../contract/snapshot';
import { TASKS_HASH, navigate, taskHash } from '../router';
import { AppShell } from '../shell/AppShell';
import { Sidebar } from '../shell/Sidebar';

// 各任务页面的标题与导语（沿用原型）。本票只放骨架，页面内容由后续票填充。
export const PAGE_COPY: Readonly<Record<TaskPage, { title: string; lead: string }>> = {
  upload: { title: '上传材料', lead: '把这次出差的发票、行程单、结账单、车票照片一起拖进来。支付截图不在这里上传。' },
  inventory: { title: '材料盘点', lead: '每份材料由对应规则认领。二维码核对、配对和金额守恒的结果在「校验」列。' },
  pending: { title: '待确认项', lead: '对照原件补填或作出选择。' },
  review: { title: '整单明细确认', lead: '候选明细按统一业务序号排列。打印稿页序与 ERP 明细行共用这个序号。' },
  print: { title: '打印稿预览', lead: '每张主要报销凭证一页 A4。页眉是业务序号、日期、费用类别与价税合计。' },
  project: { title: '项目归属', lead: '为每条候选明细指定项目号，并填写报销事由。' },
  erp: { title: 'ERP 填报', lead: '导入发票、写入明细、保存草稿、严格回读。' },
  done: { title: '完成', lead: '草稿已保存并回读一致。接下来去 ERP 提交审批，把打印稿交给财务。' },
  reconcile: { title: '对账', lead: '写入结果不确定。应用已停止写入并与 ERP 对账，不会重放。' },
};

function PageSkeleton({ page, snapshot }: { page: TaskPage; snapshot: TaskSnapshot }) {
  const copy = PAGE_COPY[page];
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{copy.title}</h1>
          <p className="lead">{copy.lead}</p>
        </div>
      </div>
      <section className="panel">
        <p className="caption">
          {snapshot.task.name} · 页面内容待实现。
        </p>
      </section>
    </>
  );
}

function GuardPage({ snapshot }: { snapshot: TaskSnapshot }) {
  const target = taskHash(snapshot.task.taskId, STAGE_DEFAULT_PAGE[snapshot.stage]);
  if (snapshot.stage === 'upload') {
    return (
      <>
        <div className="page-head">
          <div>
            <h1>还没有上传材料</h1>
            <p className="lead">先上传材料，再进入后续阶段。</p>
          </div>
        </div>
        <a className="btn btn-primary" href={target}>
          去上传
        </a>
      </>
    );
  }
  return (
    <>
      <div className="page-head">
        <div>
          <h1>还不能进入这一步</h1>
          <p className="lead">阶段不可跳过，请按顺序完成前面的步骤。</p>
        </div>
      </div>
      <a className="btn btn-primary" href={target}>
        回到当前阶段
      </a>
    </>
  );
}

export function TaskRoute({ taskId, page }: { taskId: string; page: TaskPage | null }) {
  const store = useAppStore();
  const entry = useTask(taskId);
  const snapshot = entry.snapshot;

  // `#/task/:id` 不带页面时，落到该任务当前阶段的默认页面。
  useEffect(() => {
    if (page === null && snapshot) navigate(taskHash(taskId, STAGE_DEFAULT_PAGE[snapshot.stage]), true);
  }, [page, snapshot, taskId]);

  if (entry.status === 'error') {
    return (
      <AppShell nav="tasks">
        <div className="page-head">
          <div>
            <h1>任务加载失败</h1>
            <p className="lead">{entry.error}</p>
          </div>
        </div>
        <div className="btn-row">
          <button className="btn btn-secondary" type="button" onClick={() => void store.refreshTask(taskId)}>
            重试
          </button>
          <a className="btn btn-tertiary" href={TASKS_HASH}>
            返回任务列表
          </a>
        </div>
      </AppShell>
    );
  }

  if (!snapshot || page === null) {
    return (
      <AppShell nav="tasks">
        <p className="caption loading">正在加载任务…</p>
      </AppShell>
    );
  }

  return (
    <AppShell nav="tasks" sidebar={<Sidebar snapshot={snapshot} page={page} />}>
      {entry.notice ? (
        <div className="notice notice-info" role="status">
          {entry.notice}
          <div className="btn-row">
            <button className="btn btn-tertiary btn-sm" type="button" onClick={() => store.clearNotice(taskId)}>
              知道了
            </button>
          </div>
        </div>
      ) : null}
      {pageAllowed(snapshot.stage, page) ? <PageSkeleton page={page} snapshot={snapshot} /> : <GuardPage snapshot={snapshot} />}
    </AppShell>
  );
}
