import { Button, InlineNotification } from '@carbon/react';
import { useTaskList } from '../adapter/context';
import { PROJECT_BOOK_COPY } from '../contract/project-book';
import { startupComplete } from '../contract/task-list';
import { TASKS_HASH } from '../router';
import { AppShell } from '../shell/AppShell';
import { PageHeader } from '../shell/PageHeader';
import { ProjectBookPanel } from './ProjectBookPanel';

// 全局页面 `#/projects`「个人项目簿」：顶栏有入口，不在启动门内。
// 启动没完成（没登录报销系统或身份没登记）时照常打开并说明原因；维护动作由服务端拒绝并给出原因。
export function ProjectBookPage() {
  const taskList = useTaskList();
  const incomplete = taskList.data !== null && !startupComplete(taskList.data);
  return (
    <AppShell nav="projects">
      <PageHeader title={PROJECT_BOOK_COPY.title} lead={PROJECT_BOOK_COPY.lead} />
      {incomplete ? (
        <div className="app-notice app-block-row" role="note">
          <InlineNotification kind="warning" role="status" lowContrast hideCloseButton statusIconDescription="注意" title={PROJECT_BOOK_COPY.startupIncomplete} />
          <Button kind="tertiary" size="sm" href={TASKS_HASH}>
            {PROJECT_BOOK_COPY.toStartup}
          </Button>
        </div>
      ) : null}
      <ProjectBookPanel />
    </AppShell>
  );
}
