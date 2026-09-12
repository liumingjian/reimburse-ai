import { useEffect, useMemo, type ReactNode } from 'react';
import { AppProvider, useTaskList } from './adapter/context';
import { AppStore } from './adapter/store';
import type { AppAdapter } from './contract/adapter';
import { PROJECT_BOOK_COPY } from './contract/project-book';
import { startupComplete } from './contract/task-list';
import { VALIDATE_SNAPSHOTS } from './env';
import { ProjectBookPage } from './pages/ProjectBookPage';
import { StartupPage, StartupPending } from './pages/StartupPage';
import { TaskListPage } from './pages/TaskListPage';
import { PAGE_COPY, TaskRoute } from './pages/TaskRoute';
import { navigate, useRoute, type Route } from './router';

function titleOf(route: Route): string {
  switch (route.kind) {
    case 'tasks':
      return '报销任务';
    case 'new':
      return '新建报销任务';
    case 'projects':
      return PROJECT_BOOK_COPY.title;
    case 'task':
      return route.page ? PAGE_COPY[route.page].title : '报销任务';
    case 'redirect':
      return '报销任务';
  }
}

function Routes() {
  const route = useRoute();
  useEffect(() => {
    if (route.kind === 'redirect') navigate(route.to, true);
  }, [route]);
  useEffect(() => {
    document.title = `baox · ${titleOf(route)}`;
    window.scrollTo(0, 0);
  }, [route]);
  switch (route.kind) {
    // `#/tasks/new` 是新建任务弹层的深链：同一个任务列表页，弹层打开（同一位置同一组件，切换时不重新挂载）。
    case 'tasks':
      return <TaskListPage newTask={false} />;
    case 'new':
      return <TaskListPage newTask />;
    case 'projects':
      return <ProjectBookPage />;
    case 'task':
      return <TaskRoute key={route.taskId} taskId={route.taskId} page={route.page} />;
    case 'redirect':
      return null;
  }
}

// 启动门：任务列表接口给出的登录会话与身份绑定没到位时，任务列表、新建弹层与任务页一律换成启动页（路由不变，完成后原地进入）。
// 列表因本地服务连不上而读不到时照旧渲染路由：全页横幅已经说明服务没在运行，动作一律失败，恢复后列表读到再按启动状态把门。
// 个人项目簿页面不在门内（全局页面，随时可进）：启动没完成时它照常打开，说明原因，维护动作由服务端拒绝并给出原因。
function StartupGate({ children }: { children: ReactNode }) {
  const taskList = useTaskList();
  const route = useRoute();
  const data = taskList.data;
  if (route.kind === 'projects') return children;
  if (data) return startupComplete(data) ? children : <StartupPage taskList={data} />;
  // 判 offline 标记而不是 status：重试期间 status 在 offline 与 loading 之间来回，标记一直保留。若按 status 判，loading 时会卸下路由，
  // 失败后重新挂上的任务列表页在挂载时又立刻重读，形成不经定时器的微任务死循环，饿死重试定时器（#111 单测卡死的根因）。
  if (taskList.offline) return children;
  return <StartupPending error={taskList.status === 'error' ? taskList.error : null} />;
}

export function App({ adapter }: { adapter: AppAdapter }) {
  const store = useMemo(() => new AppStore(adapter, { validate: VALIDATE_SNAPSHOTS }), [adapter]);
  return (
    <AppProvider store={store}>
      <StartupGate>
        <Routes />
      </StartupGate>
    </AppProvider>
  );
}
