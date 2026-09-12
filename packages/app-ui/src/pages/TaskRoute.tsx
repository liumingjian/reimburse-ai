import { useEffect } from 'react';
import { useAppStore, useTask } from '../adapter/context';
import { STAGE_DEFAULT_PAGE, pageAllowed, type TaskPage } from '../contract/stage';
import type { TaskSnapshot } from '../contract/snapshot';
import { TASKS_HASH, navigate, taskHash } from '../router';
import { AppShell } from '../shell/AppShell';
import { Sidebar } from '../shell/Sidebar';
import { InventoryPage } from './InventoryPage';
import { PAGE_COPY } from './page-copy';
import { PendingPage } from './PendingPage';
import { ProjectPage } from './ProjectPage';
import { ReviewPage } from './ReviewPage';
import { UploadPage } from './UploadPage';

export { PAGE_COPY } from './page-copy';

// 已实现的页面在这里分发；其余页面先放骨架，由后续票填充。
function PageBody({ page, snapshot }: { page: TaskPage; snapshot: TaskSnapshot }) {
  if (page === 'upload') return <UploadPage snapshot={snapshot} />;
  if (page === 'inventory') return <InventoryPage snapshot={snapshot} />;
  if (page === 'pending') return <PendingPage snapshot={snapshot} />;
  if (page === 'review') return <ReviewPage snapshot={snapshot} />;
  if (page === 'project') return <ProjectPage snapshot={snapshot} />;
  return <PageSkeleton page={page} snapshot={snapshot} />;
}

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
  // 还没有任何被接收的材料：先去上传。有材料但盘点没开始，则按「阶段不可跳过」处理。
  if (snapshot.materials.length === 0) {
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
      {pageAllowed(snapshot.stage, page) ? <PageBody page={page} snapshot={snapshot} /> : <GuardPage snapshot={snapshot} />}
    </AppShell>
  );
}
