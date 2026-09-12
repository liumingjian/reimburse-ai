import { useTaskList } from '../adapter/context';
import { PROJECT_BOOK_COPY } from '../contract/project-book';
import { startupComplete } from '../contract/task-list';
import { TASKS_HASH } from '../router';
import { AppShell } from '../shell/AppShell';
import { ProjectBookPanel } from './ProjectBookPanel';

// 全局页面 `#/projects`「个人项目簿」：顶栏与任务侧栏都有入口，不在启动门内。
// 启动没完成（没登录报销系统或身份没登记）时照常打开并说明原因；维护动作由服务端拒绝并给出原因。
export function ProjectBookPage() {
  const taskList = useTaskList();
  const incomplete = taskList.data !== null && !startupComplete(taskList.data);
  return (
    <AppShell nav="projects">
      <div className="page-head">
        <div>
          <h1>{PROJECT_BOOK_COPY.title}</h1>
          <p className="lead">{PROJECT_BOOK_COPY.lead}</p>
        </div>
      </div>
      {incomplete ? (
        <div className="notice notice-warn" role="note">
          {PROJECT_BOOK_COPY.startupIncomplete}
          <div className="btn-row">
            <a className="btn btn-secondary btn-sm" href={TASKS_HASH}>
              {PROJECT_BOOK_COPY.toStartup}
            </a>
          </div>
        </div>
      ) : null}
      <ProjectBookPanel />
    </AppShell>
  );
}
