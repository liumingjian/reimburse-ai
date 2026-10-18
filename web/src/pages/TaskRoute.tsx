import { useEffect } from 'react';
import { Button, InlineNotification } from '@carbon/react';
import { useAppStore, useTask } from '../adapter/context';
import { STAGE_DEFAULT_PAGE, pageAllowed, type TaskPage, type TaskSnapshot } from '@baox/contract';
import { TASKS_HASH, navigate, taskHash } from '../router';
import { ActionGroup } from '../shell/ActionGroup';
import { AppShell } from '../shell/AppShell';
import { PageHeader } from '../shell/PageHeader';
import { StepBar } from '../shell/StepBar';
import { DonePage } from './DonePage';
import { ErpPage } from './ErpPage';
import { InventoryPage } from './InventoryPage';
import { PendingPage } from './PendingPage';
import { PrintPage } from './PrintPage';
import { ProjectPage } from './ProjectPage';
import { ReconcilePage } from './ReconcilePage';
import { ReviewPage } from './ReviewPage';
import { UploadPage } from './UploadPage';

export { PAGE_COPY } from './page-copy';

// 任务页面分发：每个页面都有实现（switch 穷尽 TaskPage）。
function PageBody({ page, snapshot }: { page: TaskPage; snapshot: TaskSnapshot }) {
  switch (page) {
    case 'upload':
      return <UploadPage snapshot={snapshot} />;
    case 'inventory':
      return <InventoryPage snapshot={snapshot} />;
    case 'pending':
      return <PendingPage snapshot={snapshot} />;
    case 'review':
      return <ReviewPage snapshot={snapshot} />;
    case 'print':
      return <PrintPage snapshot={snapshot} />;
    case 'project':
      return <ProjectPage snapshot={snapshot} />;
    case 'erp':
      return <ErpPage snapshot={snapshot} />;
    case 'done':
      return <DonePage snapshot={snapshot} />;
    case 'reconcile':
      return <ReconcilePage snapshot={snapshot} />;
  }
}

function GuardPage({ snapshot, page }: { snapshot: TaskSnapshot; page: TaskPage }) {
  const target = taskHash(snapshot.task.taskId, STAGE_DEFAULT_PAGE[snapshot.stage]);
  // 去报销在写入前就停下时，任务退回上一阶段，用户正看着的这一页随之关上。是这一次去报销把人送到这里的，
  // 所以说出停下的原因，而不是一句「阶段不可跳过」。
  if (page === 'erp' && snapshot.erp.status !== 'running' && snapshot.erp.abortReason) {
    return (
      <>
        <PageHeader title="这次去报销停下了" lead={snapshot.erp.abortReason} />
        <ActionGroup>
          <Button size="md" href={target}>
            回到当前阶段
          </Button>
        </ActionGroup>
      </>
    );
  }
  // 还没有任何被接收的材料：先去上传。有材料但盘点没开始，则按「阶段不可跳过」处理。
  if (snapshot.materials.length === 0) {
    return (
      <>
        <PageHeader title="还没有上传材料" lead="先上传材料，再进入后续阶段。" />
        <ActionGroup>
          <Button size="md" href={target}>
            去上传
          </Button>
        </ActionGroup>
      </>
    );
  }
  return (
    <>
      <PageHeader title="还不能进入这一步" lead="阶段不可跳过，请按顺序完成前面的步骤。" />
      <ActionGroup>
        <Button size="md" href={target}>
          回到当前阶段
        </Button>
      </ActionGroup>
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
        <PageHeader title="任务加载失败" lead={entry.error} />
        <ActionGroup>
          <Button kind="ghost" size="md" href={TASKS_HASH}>
            返回任务列表
          </Button>
          <Button kind="secondary" size="md" onClick={() => void store.refreshTask(taskId)}>
            重试
          </Button>
        </ActionGroup>
      </AppShell>
    );
  }

  if (!snapshot || page === null) {
    return (
      <AppShell nav="tasks">
        <p className="app-loading">正在加载任务…</p>
      </AppShell>
    );
  }

  return (
    <AppShell nav="tasks" stepBar={<StepBar snapshot={snapshot} page={page} />}>
      {entry.notice ? (
        // Carbon 的 InlineNotification 里不能放可交互元素：「知道了」放在提示右侧。
        <div className="app-notice">
          <InlineNotification kind="info" role="status" lowContrast hideCloseButton statusIconDescription="提示" title={entry.notice} />
          <Button kind="ghost" size="sm" onClick={() => store.clearNotice(taskId)}>
            知道了
          </Button>
        </div>
      ) : null}
      {pageAllowed(snapshot, page) ? <PageBody page={page} snapshot={snapshot} /> : <GuardPage snapshot={snapshot} page={page} />}
    </AppShell>
  );
}
